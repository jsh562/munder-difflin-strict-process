/**
 * ClaudeAdapter (E001 / ADR-0001) — implements the provider-agnostic
 * ProviderRuntime port over the EXISTING Claude runtime: node-pty bytes + Claude
 * Code hook payloads. It ingests those provider-specific signals and emits the
 * normalized AgentEvent stream; provider specifics (the hook shape below) live
 * here in the adapter and never reach src/shared (TR-007).
 *
 * E001 wires this additively alongside the untouched hooks.ts IPC path, so the
 * running app's behavior is unchanged (TR-005). getUsage delegates to the locked
 * UsageProvider seam — usd is a passthrough, never recomputed (AD-004).
 */
import {
  AGENT_EVENT_VERSION,
  isMonotonicTokenUsage,
  type AgentEvent,
  type TokenUsageEvent
} from '../../shared/agentEvent';
import {
  EMPTY_CAPABILITY_DESCRIPTOR,
  type AgentEventListener,
  type AgentInput,
  type CapabilityDescriptor,
  type ProviderRuntime,
  type UsageSnapshot,
  type Unsubscribe
} from '../../shared/providerRuntime';
import { AgentEventBus } from './eventBus';

/** The subset of a Claude Code hook payload the adapter maps (mirrors the
 *  HookPayload shape in hooks.ts). Provider-specific — confined to the adapter. */
export interface ClaudeHookSignal {
  hook_event_name?: string;
  agent_id?: string | null;
  session_id?: string;
  tool_name?: string;
  tool_input?: unknown;
  stop_hook_active?: boolean;
  notification_type?: string;
  message?: string;
  source?: string;
}

export interface UsageReader {
  getAgentUsage(agentId: string): UsageSnapshot | null;
}

export interface ClaudeAdapterDeps {
  agentId: string;
  /** Current Claude session id, when known. */
  getSessionId?: () => string | null;
  /** The locked usage seam (StubUsageProvider / OTel provider). */
  usage?: UsageReader;
  /** Write operator/continuation input into the PTY (PtyManager.write). */
  ptyWrite?: (text: string) => void;
  /** Force-terminate the PTY (PtyManager.kill). */
  ptyKill?: () => void;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

export class ClaudeAdapter implements ProviderRuntime {
  private readonly bus = new AgentEventBus();
  private toolSeq = 0;
  private openToolCallId: string | null = null;
  private lastUsage: TokenUsageEvent | null = null;

  constructor(private readonly deps: ClaudeAdapterDeps) {}

  // ── ProviderRuntime ──────────────────────────────────────────────────────
  async start(): Promise<void> {
    /* The Claude PTY lifecycle is owned by PtyManager; nothing to start here. */
  }

  async stop(graceful: boolean): Promise<void> {
    if (!graceful) this.deps.ptyKill?.();
    /* graceful stop is driven by the agent's own end-of-turn; no-op here. */
  }

  kill(): void {
    this.deps.ptyKill?.();
  }

  send(input: AgentInput): void {
    this.deps.ptyWrite?.(input.text);
  }

  getUsage(): UsageSnapshot | null {
    return this.deps.usage?.getAgentUsage(this.deps.agentId) ?? null;
  }

  subscribe(listener: AgentEventListener): Unsubscribe {
    return this.bus.subscribe(listener);
  }

  capabilities(): CapabilityDescriptor {
    return EMPTY_CAPABILITY_DESCRIPTOR;
  }

  // ── Signal ingestion (additive observer of the existing runtime) ──────────
  /** Map a Claude Code hook payload to normalized events and emit them. */
  ingestHook(sig: ClaudeHookSignal): void {
    for (const event of this.mapHook(sig)) this.bus.emit(event);
  }

  /** A chunk of PTY output → a text-delta event. */
  ingestText(text: string): void {
    if (!text) return;
    this.bus.emit({ ...this.env(), kind: 'text-delta', text });
  }

  /**
   * Pull a cumulative usage snapshot from the seam and emit a token-usage event.
   * A non-monotonic sample (any cumulative field decreased) is dropped, never
   * emitted, so the breaker's velocity diff stays correct (TR-003).
   */
  emitUsage(): void {
    const u = this.getUsage();
    if (!u) return;
    const event: TokenUsageEvent = {
      ...this.env(),
      kind: 'token-usage',
      input: u.input,
      output: u.output,
      cacheRead: u.cacheRead,
      cacheCreation: u.cacheCreation,
      model: u.model,
      usd: u.usd
    };
    if (!isMonotonicTokenUsage(this.lastUsage, event)) return;
    this.lastUsage = event;
    this.bus.emit(event);
  }

  // ── internals ─────────────────────────────────────────────────────────────
  private env(): { v: number; agentId: string; sessionId: string | null; ts: number } {
    return {
      v: AGENT_EVENT_VERSION,
      agentId: this.deps.agentId,
      sessionId: this.deps.getSessionId?.() ?? null,
      ts: (this.deps.now ?? Date.now)()
    };
  }

  private mapHook(sig: ClaudeHookSignal): AgentEvent[] {
    const e = this.env();
    switch (sig.hook_event_name) {
      case 'UserPromptSubmit':
        return [{ ...e, kind: 'turn-start' }];
      case 'PreToolUse': {
        const toolCallId = `${sig.tool_name ?? 'tool'}#${++this.toolSeq}`;
        this.openToolCallId = toolCallId;
        return [
          {
            ...e,
            kind: 'tool-start',
            toolName: sig.tool_name ?? 'unknown',
            toolInput: sig.tool_input ?? null,
            toolCallId
          }
        ];
      }
      case 'PostToolUse': {
        const toolCallId = this.openToolCallId ?? `${sig.tool_name ?? 'tool'}#${this.toolSeq}`;
        this.openToolCallId = null;
        return [{ ...e, kind: 'tool-end', toolCallId, success: true, durationMs: 0 }];
      }
      case 'Stop':
      case 'SubagentStop':
        return [{ ...e, kind: 'stop', reason: sig.message ?? 'stop', stopActive: !!sig.stop_hook_active }];
      case 'Notification': {
        const needsInput =
          sig.notification_type === 'idle' ||
          (sig.message ?? '').toLowerCase().includes('waiting for your input');
        return [
          needsInput
            ? { ...e, kind: 'needs-input', message: sig.message ?? '' }
            : { ...e, kind: 'notification', message: sig.message ?? '' }
        ];
      }
      default:
        return [];
    }
  }
}
