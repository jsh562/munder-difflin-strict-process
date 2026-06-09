/**
 * Normalized AgentEvent contract (E001 / ADR-0002).
 *
 * One versioned, provider-agnostic event vocabulary that every ProviderRuntime
 * adapter emits and every downstream consumer (avatars, telemetry, breaker, hive)
 * reads. Provider-specific signal shapes (Claude hook payloads, DeepSeek/Minimax
 * SDK streams) are normalized INSIDE adapters — they never reach this contract.
 *
 * Versioning rule (TR-006): additive only. New event kinds or fields may be
 * ADDED; an existing kind/field is never removed or renamed. Consumers ignore
 * unknown kinds/fields instead of breaking. Bump AGENT_EVENT_VERSION on additions.
 */

export const AGENT_EVENT_VERSION = 1;

/** Envelope carried by every event. */
export interface AgentEventBase {
  /** Contract version the emitter wrote against (AGENT_EVENT_VERSION). */
  v: number;
  agentId: string;
  sessionId: string | null;
  /** Epoch millis. */
  ts: number;
  kind: string;
}

export interface TurnStartEvent extends AgentEventBase { kind: 'turn-start'; }
export interface TurnEndEvent extends AgentEventBase { kind: 'turn-end'; }
export interface ThinkingStartEvent extends AgentEventBase { kind: 'thinking-start'; text?: string; }
export interface ThinkingDeltaEvent extends AgentEventBase { kind: 'thinking-delta'; text?: string; }
export interface TextDeltaEvent extends AgentEventBase { kind: 'text-delta'; text: string; }

export interface ToolStartEvent extends AgentEventBase {
  kind: 'tool-start';
  toolName: string;
  toolInput: unknown;
  toolCallId: string;
}
export interface ToolEndEvent extends AgentEventBase {
  kind: 'tool-end';
  toolCallId: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

/**
 * Cumulative, MONOTONIC token usage (TR-003). Field set mirrors the locked
 * `AgentUsageSample` cost seam (src/main/usage.ts). `usd` is a passthrough — it
 * is never recomputed here (provider-accurate recompute is ADR-0005 / E002).
 */
export interface TokenUsageEvent extends AgentEventBase {
  kind: 'token-usage';
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  model: string | null;
  /** Passthrough of the seam's registry-computed cost. `null` = unpriced
   *  (unknown model); excluded from billed totals, never 0 (FR-006/FR-014). */
  usd: number | null;
}

export interface ApiErrorEvent extends AgentEventBase {
  kind: 'api-error';
  /** E001 emits this flag only; acting on it (retry/backoff) is E009 / ADR-0009. */
  retryable: boolean;
  message: string;
}

export interface StopEvent extends AgentEventBase {
  kind: 'stop';
  reason: string;
  /** `stop_hook_active`-equivalent guard: true when this stop was produced by a
   *  prior drain turn, so the hive autonomy loop does not re-drain forever. */
  stopActive: boolean;
}

export interface NeedsInputEvent extends AgentEventBase { kind: 'needs-input'; message: string; }
export interface NotificationEvent extends AgentEventBase { kind: 'notification'; message: string; }

export type AgentEvent =
  | TurnStartEvent
  | TurnEndEvent
  | ThinkingStartEvent
  | ThinkingDeltaEvent
  | TextDeltaEvent
  | ToolStartEvent
  | ToolEndEvent
  | TokenUsageEvent
  | ApiErrorEvent
  | StopEvent
  | NeedsInputEvent
  | NotificationEvent;

export type AgentEventKind = AgentEvent['kind'];

/** The closed v1 event-kind set. New kinds are appended additively (TR-006). */
export const KNOWN_AGENT_EVENT_KINDS: readonly AgentEventKind[] = [
  'turn-start',
  'turn-end',
  'thinking-start',
  'thinking-delta',
  'text-delta',
  'tool-start',
  'tool-end',
  'token-usage',
  'api-error',
  'stop',
  'needs-input',
  'notification'
];

export function isKnownAgentEventKind(kind: string): kind is AgentEventKind {
  return (KNOWN_AGENT_EVENT_KINDS as readonly string[]).includes(kind);
}

/** The cumulative numeric token fields that must never decrease. `usd` is
 *  handled separately because it may be `null` (unpriced — unknown model,
 *  FR-006), which is monotonicity-neutral, not a decrease. */
const CUMULATIVE_TOKEN_FIELDS = ['input', 'output', 'cacheRead', 'cacheCreation'] as const;

/**
 * TR-003 guard: a token-usage sample is monotonic relative to the prior sample
 * for the same session when no cumulative field decreased. Returns true when
 * `prev` is null (first sample is trivially monotonic). A `null` `usd` on either
 * side is treated as monotonicity-neutral (an unpriced sample is not a billed
 * value and must not be judged a cumulative decrease, FR-006/FR-014).
 */
export function isMonotonicTokenUsage(
  prev: TokenUsageEvent | null,
  next: TokenUsageEvent
): boolean {
  if (!prev) return true;
  if (!CUMULATIVE_TOKEN_FIELDS.every((f) => next[f] >= prev[f])) return false;
  // usd: only a real decrease between two priced values breaks monotonicity.
  if (prev.usd != null && next.usd != null && next.usd < prev.usd) return false;
  return true;
}
