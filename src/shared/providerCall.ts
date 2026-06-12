/**
 * ProviderCall seam (E003 / ADR-0001, ADR-0004) — the pluggable model call the
 * native agent loop invokes. E003 ships a stub; E006 implements the real
 * DeepSeek/Minimax adapters against this exact contract. Pure types, no electron.
 *
 * E006 extends this seam ADDITIVELY (AD-001): `ProviderCall` gains an optional
 * `emit` callback so a streaming adapter can push text/thinking/tool deltas as the
 * provider stream arrives (the loop forwards them as normalized AgentEvents), while
 * still returning the aggregate `ProviderTurn` for tool execution and usage. The
 * callback and the richer turn fields are OPTIONAL, so the stub and Claude paths
 * keep compiling and behaving unchanged (HINT-005, FR-007). No provider SDK/wire
 * type ever crosses this seam — it stays provider-agnostic.
 */
import type { AgentEvent } from './agentEvent';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  /** Present on a `tool` message — the tool call it answers. */
  toolCallId?: string;
  /** Present on an `assistant` message that requested tools — preserved across rounds
   *  so the follow-up request echoes the provider's required tool-call shape. Without
   *  it, an OpenAI/Anthropic-compatible provider 400s on the orphaned tool reply. */
  toolCalls?: ToolUseRequest[];
}

export interface ToolSpec {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface ToolUseRequest {
  toolName: string;
  toolInput: unknown;
  toolCallId: string;
}

/** Per-call token usage; the loop accumulates these into cumulative token-usage. */
export interface UsageDelta {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface ProviderRequest {
  messages: ChatMessage[];
  tools: ToolSpec[];
  /**
   * OPTIONAL capability-bearing fields (E006 / FR-010). A caller that wants a
   * provider capability sets the corresponding field; the adapter gates each on the
   * model's registry `CapabilityDescriptor` at request-build ingress and, when the
   * provider lacks it, STRIPS the field and emits one bounded notice per capability
   * per session (the gate never throws — AD-005 / HINT-004). All fields are additive
   * and optional, so the stub and Claude paths (which set none) behave unchanged.
   *
   * The shapes here are deliberately provider-agnostic and opaque to the seam — the
   * adapter maps a supported field onto its provider wire shape and never lets a
   * provider SDK/wire type cross back (FR-007). When unsupported they are simply
   * dropped, so their inner shape never reaches a provider.
   */
  /** Image inputs to attach (e.g. on the latest user message). Dropped when the
   *  provider lacks image support — degraded to a text-only request. */
  images?: unknown;
  /** MCP tool definitions to expose this round. Dropped when unsupported. */
  mcpTools?: unknown;
  /** Web-search tool/option to enable this round. Dropped when unsupported. */
  webSearch?: unknown;
  /** Prompt-cache controls to apply to the request. Dropped when the provider lacks
   *  caching; cache usage fields are then reported as 0 (not an error). */
  caching?: unknown;
}

export interface ProviderTurn {
  text?: string;
  toolUses: ToolUseRequest[];
  usage: UsageDelta;
  /** True when the model has finished its turn (no further tool round-trips). */
  endOfTurn: boolean;
  /**
   * Optional normalized stop reason (provider-agnostic), e.g. `'end-of-turn'`,
   * `'tool-use'`, `'max-tokens'`, `'refusal'`. Additive (HINT-005); absent on the
   * stub. The adapter maps its provider's raw stop signal onto this — the raw
   * wire value never crosses the seam (FR-007).
   */
  stopReason?: string;
  /**
   * Optional aggregate reasoning/thinking text for the turn (DeepSeek
   * `reasoning_content`, Minimax thinking blocks), normalized in-adapter. Additive;
   * surfaced as thinking and NEVER replayed into a later provider request (FR-003).
   */
  thinking?: string;
  /**
   * Optional provider-reported cost for the round, in USD, passed through verbatim
   * (FR-006) — NEVER recomputed here (provider-accurate recompute is ADR-0005 /
   * E002/E007). Additive (HINT-005); absent on the stub and when the provider does
   * not report a cost. The loop accumulates it into the cumulative `token-usage`.
   */
  usd?: number;
}

/**
 * The model call. E003 = stub; E006 = real provider adapter.
 *
 * `emit` is OPTIONAL (AD-001): a streaming adapter calls it with normalized
 * AgentEvents (text/thinking/tool deltas) as the provider stream arrives; callers
 * that do not stream simply omit it. Existing implementations that ignore the
 * second parameter keep working unchanged (HINT-005).
 */
export type ProviderCall = (
  req: ProviderRequest,
  emit?: (event: AgentEvent) => void
) => Promise<ProviderTurn>;
