/**
 * NativeAgentWorker (E003 / ADR-0003) — the main-process handle that fronts one
 * native agent's worker behind the E001 `ProviderRuntime` port, so consumers
 * treat a native agent identically to a Claude agent. ELECTRON-FREE: the actual
 * utilityProcess transport is injected (`WorkerTransport`), so this is unit-
 * testable with a fake transport (SC-002); the real transport lives in
 * `electronWorkerTransport.ts`.
 */
import type { AgentEvent } from '../../shared/agentEvent';
import {
  EMPTY_CAPABILITY_DESCRIPTOR,
  type AgentEventListener,
  type AgentInput,
  type CapabilityDescriptor,
  type ProviderRuntime,
  type Unsubscribe,
  type UsageSnapshot
} from '../../shared/providerRuntime';
import type { WorkerCommand, WorkerMessage } from '../../shared/workerProtocol';
import { deriveProviderId } from '../../shared/assignment';
import { AgentEventBus } from './eventBus';

/**
 * E007 T011 {FR-008} — the telemetry forward SEAM (single-writer in main, AD-002):
 * the native worker's usage + tool spans are normalized into the loopback
 * collector's gen_ai.* branch, so a native desk reaches the SAME `AgentUsageSample`
 * + `ToolSpan` seam as a Claude desk with no downstream change (FR-011).
 *
 * A subset of `TelemetryCollector` (electron-free, injectable) so the worker stays
 * unit-testable with a fake sink. The real wiring passes the live collector in
 * `index.ts`. No OTLP exporter runs in the worker (AD-002).
 */
export interface NativeTelemetrySink {
  /** Map a native `token-usage` (cumulative) into the gen_ai usage branch. */
  ingestNativeUsage(usage: {
    agentId: string;
    sessionId: string;
    providerName: string;
    requestModel: string;
    responseModel?: string | null;
    tokens: { input: number; output: number; cacheRead: number; cacheCreation: number };
  }): boolean;
  /** Map a native `execute_tool` invocation into a ToolSpan (FR-016). */
  ingestNativeToolSpan(tool: {
    agentId: string;
    sessionId: string;
    toolName: string;
    durationMs: number;
    success: boolean;
    error?: string;
    decision?: 'accept' | 'reject';
  }): boolean;
}

/** The transport abstraction over a worker process. The electron utilityProcess
 *  implementation is injected; tests inject a fake. */
export interface WorkerTransport {
  post(cmd: WorkerCommand): void;
  onMessage(cb: (msg: WorkerMessage) => void): void;
  onExit(cb: (code: number) => void): void;
  kill(): void;
}

export type WorkerTransportFactory = (opts: { agentId: string }) => WorkerTransport;

export interface NativeAgentWorkerDeps {
  agentId: string;
  getSessionId?: () => string | null;
  transportFactory: WorkerTransportFactory;
  /** Fallback usage (e.g. the UsageProvider seam) when the worker hasn't reported. */
  usageFallback?: () => UsageSnapshot | null;
  /** Registry teardown (mirrors the PTY exit handler). */
  onExit?: (agentId: string) => void;
  /** End-of-turn autonomy: the registry routes this to `hive.drainForStop`. */
  onDrainRequest?: (agentId: string, turnId: number) => Promise<{ block: boolean; reason?: string }>;
  /**
   * E006 {FR-009} — the worker's tool-execution seam. The worker REQUESTS a tool;
   * MAIN executes it against the hive tool handlers (single-committer preserved) and
   * resolves the result. The registry routes this to the hive tool dispatcher.
   */
  onToolRequest?: (
    agentId: string,
    req: { toolCallId: string; toolName: string; toolInput: unknown }
  ) => Promise<{ content: string; success: boolean }>;
  /**
   * E007 T011 {FR-008} — the telemetry forward seam. When present, the worker's
   * native `token-usage` + tool spans are normalized into the loopback collector's
   * gen_ai.* branch (single-writer in main, AD-002). Absent ⇒ no forward (the bus
   * still emits the events for other consumers; telemetry parity just isn't wired).
   */
  telemetry?: NativeTelemetrySink;
}

export class NativeAgentWorker implements ProviderRuntime {
  private readonly bus = new AgentEventBus();
  private transport: WorkerTransport | null = null;
  private lastUsage: UsageSnapshot | null = null;
  private started = false;
  /** E007 T011/T014 — pending native tool starts by toolCallId. `tool-end` carries
   *  only the id (not the name), so the name is recovered here to build the span. */
  private readonly pendingTools = new Map<string, { toolName: string }>();

  constructor(private readonly deps: NativeAgentWorkerDeps) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const transport = this.deps.transportFactory({ agentId: this.deps.agentId });
    this.transport = transport;
    transport.onMessage((msg) => { void this.handle(msg); });
    transport.onExit(() => {
      this.started = false;
      this.transport = null;
      this.deps.onExit?.(this.deps.agentId);
    });
    transport.post({ type: 'start', agentId: this.deps.agentId, sessionId: this.deps.getSessionId?.() ?? null });
  }

  async stop(graceful: boolean): Promise<void> {
    this.transport?.post({ type: 'stop', graceful });
    if (!graceful) this.kill();
  }

  kill(): void {
    this.transport?.kill();
  }

  send(input: AgentInput): void {
    this.transport?.post({ type: 'send', input });
  }

  getUsage(): UsageSnapshot | null {
    return this.lastUsage ?? this.deps.usageFallback?.() ?? null;
  }

  subscribe(listener: AgentEventListener): Unsubscribe {
    return this.bus.subscribe(listener);
  }

  capabilities(): CapabilityDescriptor {
    return EMPTY_CAPABILITY_DESCRIPTOR;
  }

  private async handle(msg: WorkerMessage): Promise<void> {
    switch (msg.type) {
      case 'event':
        // E007 T011 {FR-008} — forward usage/tool spans into the collector's gen_ai
        // branch (single-writer in main) BEFORE the bus emit, so telemetry parity
        // lands regardless of other consumers. Never throws into the message loop.
        this.forwardTelemetry(msg.event as AgentEvent);
        this.bus.emit(msg.event as AgentEvent);
        break;
      case 'usage':
        this.lastUsage = msg.usage;
        break;
      case 'drainRequest': {
        const result = (await this.deps.onDrainRequest?.(this.deps.agentId, msg.turnId)) ?? { block: false };
        this.transport?.post({ type: 'drainResult', turnId: msg.turnId, block: result.block, reason: result.reason });
        break;
      }
      case 'toolRequest': {
        // E006 {FR-009} — MAIN executes the tool against the hive (single-committer)
        // and replies. No handler ⇒ a clean failed result so the loop self-corrects
        // (it never crashes the desk; mirrors the drain no-handler default).
        let result: { content: string; success: boolean };
        try {
          result = (await this.deps.onToolRequest?.(this.deps.agentId, {
            toolCallId: msg.toolCallId,
            toolName: msg.toolName,
            toolInput: msg.toolInput
          })) ?? { content: `no tool handler for '${msg.toolName}'`, success: false };
        } catch (e) {
          result = { content: e instanceof Error ? e.message : String(e), success: false };
        }
        this.transport?.post({
          type: 'toolResult',
          callId: msg.callId,
          toolCallId: msg.toolCallId,
          content: result.content,
          success: result.success
        });
        break;
      }
      case 'ready':
      case 'idle':
      case 'exit':
        break;
    }
  }

  /**
   * E007 T011/T014 {FR-008/016} — normalize one native AgentEvent into the gen_ai.*
   * telemetry branch (single-writer in main, AD-002). Token usage feeds
   * `ingestNativeUsage`; a tool start/end pair feeds `ingestNativeToolSpan`. Provider
   * name is DERIVED from the model via the E002 registry (never stored, DR-1). The
   * payload is least-attribute (token counts + required ids only) — NO prompt/tool
   * input, headers, or secret (FR-013). Best-effort: a forward error is isolated so
   * it can never break the worker's message loop.
   */
  private forwardTelemetry(event: AgentEvent): void {
    const sink = this.deps.telemetry;
    if (!sink) return;
    try {
      if (event.kind === 'token-usage') {
        // Provider name MANDATORY for the join (FR-015) — derive from the model;
        // an unresolvable model yields no provider, so the collector drops it
        // (semconv-drift), never attributing to an arbitrary agent.
        const providerName = deriveProviderId(event.model) ?? '';
        sink.ingestNativeUsage({
          agentId: event.agentId,
          sessionId: event.sessionId ?? '',
          providerName,
          requestModel: event.model ?? '',
          responseModel: event.model ?? null,
          tokens: {
            input: event.input,
            output: event.output,
            cacheRead: event.cacheRead,
            cacheCreation: event.cacheCreation
          }
        });
      } else if (event.kind === 'tool-start') {
        // Remember the tool name so `tool-end` (id only) can build the span.
        this.pendingTools.set(event.toolCallId, { toolName: event.toolName });
      } else if (event.kind === 'tool-end') {
        const pending = this.pendingTools.get(event.toolCallId);
        this.pendingTools.delete(event.toolCallId);
        // FR-016 fixed mapping: tool ← name; duration ← elapsed; success ← !error;
        // error ← the failure text. A failed tool yields success=false + error.
        sink.ingestNativeToolSpan({
          agentId: event.agentId,
          sessionId: event.sessionId ?? '',
          toolName: pending?.toolName ?? 'tool',
          durationMs: event.durationMs,
          success: event.success,
          ...(event.success ? {} : { error: event.error ?? '' })
        });
      }
    } catch {
      /* forward is best-effort — never break the worker message loop */
    }
  }
}
