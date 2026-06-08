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
import { AgentEventBus } from './eventBus';

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
}

export class NativeAgentWorker implements ProviderRuntime {
  private readonly bus = new AgentEventBus();
  private transport: WorkerTransport | null = null;
  private lastUsage: UsageSnapshot | null = null;
  private started = false;

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
      case 'ready':
      case 'idle':
      case 'exit':
        break;
    }
  }
}
