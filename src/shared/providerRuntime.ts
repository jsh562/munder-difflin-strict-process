/**
 * ProviderRuntime port (E001 / ADR-0001).
 *
 * One provider-agnostic interface representing a single running agent, whatever
 * vendor powers it. The Claude adapter wraps today's node-pty + Claude Code hook
 * runtime behind this port; native DeepSeek/Minimax adapters (E006) implement the
 * same port over their SDK loops. No provider-specific type may appear here — that
 * is what keeps every downstream consumer decoupled from the vendor (TR-007).
 */
import type { AgentEvent } from './agentEvent';

/** Per-provider/model capability flags. In E001 the accessor returns the empty
 *  descriptor below; real capability DATA is owned by the registry (E002). */
export interface CapabilityDescriptor {
  supportsImages: boolean;
  supportsMcpTools: boolean;
  supportsWebSearch: boolean;
  supportsCaching: boolean;
}

/** Placeholder returned by `capabilities()` until E002 populates real data. */
export const EMPTY_CAPABILITY_DESCRIPTOR: CapabilityDescriptor = {
  supportsImages: false,
  supportsMcpTools: false,
  supportsWebSearch: false,
  supportsCaching: false
};

/** Input the operator (or the autonomy loop) sends into a running agent. */
export interface AgentInput {
  /** `operator` = typed input; `steer` = mid-run guidance; `drain` = inbox
   *  continuation injected at end-of-turn by the hive autonomy loop. */
  kind: 'operator' | 'steer' | 'drain';
  text: string;
}

/**
 * Cumulative usage snapshot returned by `getUsage()`. Field set is identical to
 * the locked `AgentUsageSample` (src/main/usage.ts) so the cost seam stays the
 * single source of truth; adapters map their provider usage onto this shape.
 */
export interface UsageSnapshot {
  agentId: string;
  sessionId: string | null;
  ts: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  model: string | null;
  /** Registry-computed cost passed through from the seam (`AgentUsageSample.usd`).
   *  `null` = unpriced (unknown model) — billed by no one, never read as 0
   *  (FR-006/FR-014). Never recomputed here (FR-002). */
  usd: number | null;
}

export type AgentEventListener = (e: AgentEvent) => void;
export type Unsubscribe = () => void;

export interface ProviderRuntime {
  /** Begin or attach the agent runtime. */
  start(): Promise<void>;
  /** Graceful end-of-work stop (vs `kill`). */
  stop(graceful: boolean): Promise<void>;
  /** Force-terminate the underlying process. */
  kill(): void;
  /** Operator input / steer injection / drain continuation. */
  send(input: AgentInput): void;
  /** Cumulative usage snapshot, or null when unknown. */
  getUsage(): UsageSnapshot | null;
  /** Subscribe to the normalized event stream; returns an unsubscribe. */
  subscribe(listener: AgentEventListener): Unsubscribe;
  /** Capability descriptor accessor (empty placeholder in E001). */
  capabilities(): CapabilityDescriptor;
}
