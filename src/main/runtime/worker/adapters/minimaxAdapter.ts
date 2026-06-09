/**
 * Minimax M3 native provider adapter (E006 / US2 — FR-004/005/006/011).
 *
 * Implements the `ProviderCall` seam over Minimax M3's Anthropic-compatible
 * Messages STREAMING API. Per round it:
 *  - builds an Anthropic-style streaming Messages request (`stream:true`,
 *    `messages`, `tools`, and a hoisted `system` string) and POSTs it to
 *    `${endpoint}/v1/messages` with the API key applied ONLY at the fetch boundary
 *    (FR-013 — the key never enters a turn/event/usage payload);
 *  - consumes the response with the shared `parseSseStream`;
 *  - maintains an index-keyed content-block map and dispatches on
 *    `content_block_start.content_block.type` (T014, FR-005/011):
 *      - `tool_use` opens with `id`+`name`; its `input` arrives as
 *        `input_json_delta.partial_json` fragments that are buffered and
 *        `JSON.parse`d ONLY at `content_block_stop` — never mid-stream, never from
 *        a partial buffer (HINT-002 / FR-011);
 *      - `thinking` streams `thinking_delta` (+ a trailing `signature_delta`) →
 *        emitted as thinking deltas and aggregated into `ProviderTurn.thinking`,
 *        NEVER replayed into a later request (FR-003-style);
 *      - `text` streams `text_delta` → `text-delta` events + `ProviderTurn.text`;
 *      - unknown event/block types are ignored (forward-compat, research §2);
 *  - treats `message_delta.stop_reason:'tool_use'` as continue-the-loop
 *    (`endOfTurn:false`); a no-tool stop ends the turn (`endOfTurn:true`);
 *  - normalizes usage cumulative-monotonic (T015, FR-006): `message_start.usage`
 *    seeds the input (+ first output), then the LATEST `message_delta.usage` is the
 *    round total (it is cumulative — taken, NOT added to message_start, to avoid
 *    double-counting). Absent cache fields default to 0 (never a decrease); `usd`
 *    is passed through verbatim (recompute is out of scope). The reported
 *    prompt-size `input` is what selects the registry context-length tier (SC-004) —
 *    the adapter reports the size, it does NOT recompute price.
 *
 * It is electron-free and `fetch`-injected (HINT-001) so vitest drives it in Node
 * over fabricated Anthropic-style SSE streams; the worker entry passes the real
 * `fetch`/env later. No provider SDK or wire type crosses the `ProviderCall`
 * boundary (FR-007).
 *
 * Error contract: identical to the DeepSeek adapter — on an HTTP failure or a
 * stream/JSON fault the adapter THROWS an error shaped `{ status?, retryAfter?,
 * code?, message? }` so the loop's `withReliability` (ADR-0009) classifies it; the
 * adapter does NOT retry itself.
 */
import { AGENT_EVENT_VERSION, type AgentEvent } from '../../../../shared/agentEvent';
import type {
  ChatMessage,
  ProviderCall,
  ProviderRequest,
  ProviderTurn,
  ToolUseRequest,
  UsageDelta
} from '../../../../shared/providerCall';
import { lookupCapabilities, lookupModel } from '../../../../shared/providerRegistry';
import { makeCapabilityGate, type CapabilityGate } from './capabilityGate';
// Reuse the DeepSeek adapter's injected fetch contract verbatim (PriorExports) so
// both adapters share one boundary shape — no second copy of the fetch types.
import type { FetchLike, FetchResponseLike } from './deepseekAdapter';
import { parseSseStream, type ByteStream } from './sseParser';

export type { FetchLike, FetchResponseLike } from './deepseekAdapter';

/** Injectable dependencies — all provider-specific facts arrive here, not from env. */
export interface MinimaxAdapterDeps {
  /** Injected `fetch` (HINT-001). The worker passes the real global; tests a fake. */
  fetch: FetchLike;
  /** Provider API key; read at the fetch boundary ONLY, never emitted (FR-013). */
  apiKey: string;
  /** Base endpoint, e.g. `https://api.minimax.io` (registry-provided). */
  endpoint: string;
  /** Assigned model id, e.g. `minimax-m3`. */
  model: string;
}

/** A round-local error the adapter throws; shaped for `classifyError` (reliability). */
class MinimaxAdapterError extends Error {
  /** HTTP status when the failure carried one (absent = stream/parse fault). */
  readonly status?: number;
  /** `Retry-After` hint passed through to the backoff policy. */
  readonly retryAfter?: string | number;
  /** Coarse, provider-agnostic code, e.g. `'stream-interrupted'`, `'invalid-request'`. */
  readonly code?: string;
  constructor(message: string, opts: { status?: number; retryAfter?: string | number; code?: string }) {
    super(message);
    this.name = 'MinimaxAdapterError';
    this.status = opts.status;
    this.retryAfter = opts.retryAfter;
    this.code = opts.code;
  }
}

/** The provider-agnostic context-length tier the prompt size selects (SC-004). */
export type ContextTier = 'base' | 'long';

/**
 * Select the registry context-length tier for a prompt-size `input` token count.
 * The boundary is the model's E002 price-row `contextTierThreshold` (NOT a magic
 * number) — at or below it is `'base'`, strictly above it is `'long'`. A model with
 * no tiered row (or an unknown id) has only a base tier. The adapter REPORTS the
 * tier the prompt selects; it does NOT recompute price (recompute is E002/E007,
 * FR-006).
 */
export function selectContextTier(promptInput: number, modelId: string): ContextTier {
  const threshold = contextTierThreshold(modelId);
  if (threshold == null) return 'base';
  return promptInput > threshold ? 'long' : 'base';
}

/** The model's long-context tier boundary from the registry, or null when flat. */
export function contextTierThreshold(modelId: string): number | null {
  const model = lookupModel(modelId);
  if (!model) return null;
  for (const row of model.priceRows) {
    if (typeof row.contextTierThreshold === 'number') return row.contextTierThreshold;
  }
  return null;
}

const ZERO_USAGE: UsageDelta = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

/** A non-negative integer from an arbitrary value (absent/garbage → 0); never negative (FR-006). */
function nonNegInt(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return 0;
  return Math.trunc(v);
}

/**
 * Map an Anthropic-style `usage` block onto the normalized `UsageDelta`. Anthropic
 * exposes `input_tokens`/`output_tokens` and a cache breakdown under
 * `cache_read_input_tokens` / `cache_creation_input_tokens`; absent cache fields
 * default to 0 (not a decrease). `usd` is read separately and passed through.
 */
function mapUsage(usage: unknown): UsageDelta {
  if (!usage || typeof usage !== 'object') return { ...ZERO_USAGE };
  const u = usage as Record<string, unknown>;
  return {
    input: nonNegInt(u.input_tokens),
    output: nonNegInt(u.output_tokens),
    cacheRead: nonNegInt(u.cache_read_input_tokens),
    cacheCreation: nonNegInt(u.cache_creation_input_tokens)
  };
}

/** Pull a passthrough `usd` cost out of a usage block when the provider reports one. */
function usdOf(usage: unknown): number | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, unknown>;
  const usd = u.usd ?? u.cost;
  return typeof usd === 'number' && Number.isFinite(usd) && usd >= 0 ? usd : undefined;
}

/**
 * Build the Anthropic-compatible streaming Messages request body. `system` is
 * hoisted out of the message list (Anthropic carries it as a top-level string, not
 * a message role); user/assistant messages map straight through; a `tool` message
 * becomes a `tool_result` content block on a `user` message (Anthropic's tool-reply
 * shape). Tools map to the `{name, description, input_schema}` shape.
 */
function buildBody(req: ProviderRequest, model: string, gate: CapabilityGate): string {
  // Capability gating (FR-010 / AD-005 / HINT-004): strip any unsupported capability
  // field BEFORE the optional path is built. For `minimax-m3` (NO_CAPS) all four are
  // unsupported, so any set field is dropped and noticed once per capability/session;
  // the gate never throws. `applyTo` returns a shallow copy and never mutates `req`.
  const allowed = gate.applyTo({
    ...(req.images !== undefined ? { images: req.images } : {}),
    ...(req.mcpTools !== undefined ? { mcpTools: req.mcpTools } : {}),
    ...(req.webSearch !== undefined ? { webSearch: req.webSearch } : {}),
    ...(req.caching !== undefined ? { caching: req.caching } : {})
  });

  const system = req.messages
    .filter((m) => (m.role as string) === 'system')
    .map((m) => m.content)
    .join('\n');

  const messages = req.messages
    .filter((m) => (m.role as string) !== 'system')
    .map((m) => mapMessage(m));

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true
  };
  if (system.length > 0) body.system = system;
  if (req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      input_schema: t.inputSchema ?? { type: 'object' }
    }));
  }
  // Attach ONLY the capability fields the provider supports. An unsupported field is
  // absent from `allowed` (stripped at ingress) so it never reaches the wire. Caching
  // is intentionally not serialized (it is reflected by zeroing cache-usage; see
  // consumeStream) — Anthropic-style cache_control would be omitted when unsupported.
  if (allowed.images !== undefined) body.images = allowed.images;
  if (allowed.mcpTools !== undefined) body.mcp_tools = allowed.mcpTools;
  if (allowed.webSearch !== undefined) body.web_search = allowed.webSearch;
  return JSON.stringify(body);
}

/** Map one normalized chat message onto the Anthropic Messages wire shape. */
function mapMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'tool') {
    // A tool reply is a `user` message carrying a `tool_result` content block.
    return {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: m.toolCallId ?? '', content: m.content }]
    };
  }
  return { role: m.role, content: m.content };
}

/** Normalize a Minimax/Anthropic `stop_reason` onto the provider-agnostic vocabulary. */
function normalizeStopReason(raw: string | undefined): string | undefined {
  switch (raw) {
    case 'tool_use':
      return 'tool-use';
    case 'end_turn':
      return 'end-of-turn';
    case 'max_tokens':
      return 'max-tokens';
    case 'stop_sequence':
      return 'end-of-turn';
    case 'refusal':
      return 'refusal';
    default:
      return raw ? raw : undefined;
  }
}

/** Accumulator for one streamed content block, keyed by its `index`. */
interface BlockAccumulator {
  index: number;
  type: 'text' | 'thinking' | 'tool_use' | 'unknown';
  /** tool_use only: the tool call id from `content_block_start`. */
  id?: string;
  /** tool_use only: the tool name from `content_block_start`. */
  name?: string;
  /** tool_use only: concatenated `input_json_delta.partial_json` (parsed at stop). */
  argsBuffer: string;
}

/**
 * Build a Minimax adapter as a `ProviderCall`. Each invocation runs ONE provider
 * round (the loop drives multi-round tool use by re-calling with the tool results
 * appended): it streams the response, emits normalized deltas, and returns the
 * aggregate `ProviderTurn`. `endOfTurn` is false when the round requested tools.
 */
export function makeMinimaxAdapter(deps: MinimaxAdapterDeps): ProviderCall {
  const { fetch, apiKey, endpoint, model } = deps;
  const url = `${endpoint.replace(/\/$/, '')}/v1/messages`;

  // Session-scoped capability gate (AD-005 / FR-010 / HINT-004): ONE instance per
  // adapter = one desk session, so each capability is noticed at most once per session
  // (not per turn). For `minimax-m3` the registry descriptor is NO_CAPS — all four
  // gated paths degrade. `emit` arrives per-round; the gate closes over a mutable ref
  // so a notice routes to the current round's loop emit (or nowhere if absent).
  const caps = lookupCapabilities(model);
  // Caching support decides whether cache-usage fields are reported or zeroed (FR-010
  // / SC-008): when the provider lacks caching, cache controls are omitted AND cache
  // usage is reported as 0 (never an error).
  const cachingSupported = caps.supportsCaching === true;
  let currentEmit: ((event: AgentEvent) => void) | undefined;
  const gate = makeCapabilityGate(caps, (e) => currentEmit?.(e), {
    agentId: '',
    sessionId: null,
    modelId: model
  });

  return async (req: ProviderRequest, emit?: (event: AgentEvent) => void): Promise<ProviderTurn> => {
    // Route this round's gate notices to this round's emit (one notice/cap/session).
    currentEmit = emit;
    // Build the (gated) body BEFORE the request — stripping any unsupported field and
    // emitting its single notice at request-build ingress (HINT-004); never throws.
    const requestBody = buildBody(req, model, gate);

    // The API key is constructed HERE, at the fetch boundary, and nowhere else; it
    // never enters a turn/event/usage payload (FR-013). Anthropic-compatible APIs
    // accept the key via `x-api-key` (and we mirror it on `authorization` for
    // gateways that expect a bearer) — both built only on the request headers.
    let response: FetchResponseLike;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'anthropic-version': '2023-06-01',
          'x-api-key': apiKey,
          authorization: `Bearer ${apiKey}`
        },
        body: requestBody
      });
    } catch (e) {
      // A network/transport failure (no HTTP status) → classified retryable upstream.
      throw new MinimaxAdapterError(networkMessage(e), { code: 'network' });
    }

    if (!response.ok) {
      // Surface a key-free, bounded diagnostic shaped for `classifyError` — the loop
      // decides retry vs terminal from the status (no internal retry here).
      const retryAfter = response.headers.get('retry-after') ?? undefined;
      throw new MinimaxAdapterError(`Minimax HTTP ${response.status}`, {
        status: response.status,
        retryAfter: retryAfter ?? undefined
      });
    }
    if (!response.body) {
      // OK status but no stream body — treat as a transient stream fault (retryable).
      throw new MinimaxAdapterError('Minimax response had no stream body', {
        code: 'stream-interrupted'
      });
    }

    return consumeStream(response.body, model, emit, cachingSupported);
  };
}

/**
 * Drive the Anthropic-style SSE stream to an aggregate `ProviderTurn`. Maintains an
 * index-keyed content-block map; buffers `tool_use` partial JSON and parses it ONLY
 * at `content_block_stop`; aggregates text + thinking; reads cumulative usage from
 * `message_start` then the LATEST `message_delta.usage`. Throws a reliability-shaped
 * error on an interrupted stream or an un-parseable completed tool call (FR-011).
 */
async function consumeStream(
  body: ByteStream,
  model: string,
  emit?: (event: AgentEvent) => void,
  cachingSupported = true
): Promise<ProviderTurn> {
  const env = (): { v: number; agentId: string; sessionId: string | null; ts: number } => ({
    // The loop forwards events with its own envelope context; the adapter fills the
    // version + a neutral envelope (the worker's scoped emit may overwrite ids). The
    // adapter has no desk identity — identity is the loop's concern; the adapter only
    // contributes the delta payload.
    v: AGENT_EVENT_VERSION,
    agentId: '',
    sessionId: null,
    ts: Date.now()
  });

  const blocks = new Map<number, BlockAccumulator>();
  // tool_use blocks whose `content_block_stop` arrived — finalized (JSON.parse'd)
  // AFTER the stream completes so a genuine parse error is not mistaken for a stream
  // interruption by the catch below (the DeepSeek adapter parses-on-complete the same way).
  const completedToolBlocks: BlockAccumulator[] = [];
  let text = '';
  let thinking = '';
  let thinkingStarted = false;
  let stopReason: string | undefined;
  let usage: UsageDelta = { ...ZERO_USAGE };
  let usd: number | undefined;
  let sawMessageStop = false;

  try {
    for await (const ev of parseSseStream(body)) {
      if (ev.done) break; // `[DONE]` sentinel (rare on Anthropic; tolerated).
      const data = ev.data;
      if (!data || typeof data !== 'object') continue; // heartbeat/comment/raw
      const d = data as Record<string, unknown>;
      // Anthropic names its events both via the `event:` line AND a `type` field on
      // the JSON; prefer the JSON `type` (always present), fall back to `ev.event`.
      const type = typeof d.type === 'string' ? d.type : ev.event;

      switch (type) {
        case 'message_start': {
          // Seed cumulative usage from the opening message (input + first output).
          const msg = (d.message ?? {}) as Record<string, unknown>;
          if (msg.usage && typeof msg.usage === 'object') {
            usage = mapUsage(msg.usage);
            const passUsd = usdOf(msg.usage);
            if (passUsd !== undefined) usd = passUsd;
          }
          break;
        }
        case 'content_block_start': {
          const index = nonNegInt(d.index);
          const block = (d.content_block ?? {}) as Record<string, unknown>;
          const blockType = typeof block.type === 'string' ? block.type : 'unknown';
          const acc: BlockAccumulator = {
            index,
            type:
              blockType === 'text' || blockType === 'thinking' || blockType === 'tool_use'
                ? blockType
                : 'unknown',
            argsBuffer: ''
          };
          if (acc.type === 'tool_use') {
            if (typeof block.id === 'string') acc.id = block.id;
            if (typeof block.name === 'string') acc.name = block.name;
          }
          blocks.set(index, acc);
          break;
        }
        case 'content_block_delta': {
          const index = nonNegInt(d.index);
          const acc = blocks.get(index);
          if (!acc) break; // a delta for a block we never opened — ignore (forward-compat).
          const delta = (d.delta ?? {}) as Record<string, unknown>;
          const deltaType = typeof delta.type === 'string' ? delta.type : undefined;

          if (deltaType === 'text_delta' && typeof delta.text === 'string') {
            text += delta.text;
            if (delta.text.length > 0) emit?.({ ...env(), kind: 'text-delta', text: delta.text });
          } else if (deltaType === 'thinking_delta' && typeof delta.thinking === 'string') {
            if (!thinkingStarted) {
              thinkingStarted = true;
              emit?.({ ...env(), kind: 'thinking-start' });
            }
            thinking += delta.thinking;
            if (delta.thinking.length > 0) emit?.({ ...env(), kind: 'thinking-delta', text: delta.thinking });
          } else if (deltaType === 'input_json_delta' && typeof delta.partial_json === 'string') {
            // Buffer ONLY — never JSON.parse a partial fragment mid-stream (HINT-002).
            acc.argsBuffer += delta.partial_json;
          }
          // `signature_delta` (trailing on a thinking block) carries no surfaced text.
          break;
        }
        case 'content_block_stop': {
          const index = nonNegInt(d.index);
          const acc = blocks.get(index);
          if (acc && acc.type === 'tool_use') {
            // The call is COMPLETE — record it for parse-on-complete AFTER the stream.
            completedToolBlocks.push(acc);
          }
          break;
        }
        case 'message_delta': {
          // `stop_reason` and the LATEST cumulative `usage` arrive here.
          const delta = (d.delta ?? {}) as Record<string, unknown>;
          if (typeof delta.stop_reason === 'string') stopReason = delta.stop_reason;
          if (d.usage && typeof d.usage === 'object') {
            // Anthropic's `message_delta.usage` is CUMULATIVE — take it as the round
            // total, do NOT add it to `message_start.usage` (that double-counts,
            // HINT-003 / AD-004). `input_tokens` is usually omitted here (it does not
            // change), so preserve the seeded input when the delta omits it.
            const latest = mapUsage(d.usage);
            usage = {
              input: latest.input > 0 ? latest.input : usage.input,
              output: latest.output, // cumulative output total for the round
              cacheRead: latest.cacheRead > 0 ? latest.cacheRead : usage.cacheRead,
              cacheCreation: latest.cacheCreation > 0 ? latest.cacheCreation : usage.cacheCreation
            };
            const passUsd = usdOf(d.usage);
            if (passUsd !== undefined) usd = passUsd;
          }
          break;
        }
        case 'message_stop': {
          sawMessageStop = true;
          break;
        }
        default:
          // Unknown event type — ignore (forward-compat, research §2). Never drop
          // the stream on an unexpected event.
          break;
      }
    }
  } catch (e) {
    // The stream broke mid-flight. Per the spec an interrupted stream is RETRYABLE;
    // any partially-assembled tool block is discarded (we never parsed/executed it).
    // Surface a reliability-shaped error (HINT-002 / FR-011).
    throw new MinimaxAdapterError(`Minimax stream interrupted: ${networkMessage(e)}`, {
      code: 'stream-interrupted'
    });
  }

  // If the stream named a tool-use stop but no tool block ever completed, the tool
  // stream was cut off before `content_block_stop` — discard + surface a retryable
  // error (the loop self-corrects; HINT-002 / FR-011).
  const wantedTools = stopReason === 'tool_use';
  if (wantedTools && completedToolBlocks.length === 0 && !sawMessageStop) {
    throw new MinimaxAdapterError('Minimax tool-use stop with no completed tool block', {
      code: 'stream-interrupted'
    });
  }

  // Parse each completed tool_use block's buffered input HERE and only here — outside
  // the stream try/catch, so a malformed-payload error surfaces as `invalid-request`
  // (terminal: re-requesting identical bytes cannot fix it) rather than being
  // re-classified as a retryable stream interruption (FR-011).
  const toolUses = completedToolBlocks.map((acc) => finalizeToolBlock(acc));

  // Caching-off degradation (FR-010 / SC-008): when the model lacks prompt caching
  // (minimax-m3 is NO_CAPS), report cache usage fields as 0 (not an error). Token
  // in/out usage and the context-length tier it selects are untouched.
  if (!cachingSupported) {
    usage = { ...usage, cacheRead: 0, cacheCreation: 0 };
  }

  const turn: ProviderTurn = {
    text: text.length > 0 ? text : undefined,
    thinking: thinking.length > 0 ? thinking : undefined,
    toolUses,
    usage,
    // A round whose stop_reason is `tool_use` (or that produced tool blocks) is NOT
    // end-of-turn — the loop runs the tools and re-calls with the results appended.
    endOfTurn: toolUses.length === 0 && !wantedTools,
    stopReason: normalizeStopReason(stopReason)
  };
  if (usd !== undefined) turn.usd = usd;
  return turn;
}

/**
 * Parse a COMPLETED `tool_use` block's buffered partial JSON into a
 * `ToolUseRequest`. Parsing happens HERE and only here (the block is complete). An
 * empty buffer is `{}`. A buffer that fails to parse is malformed (FR-011): we do
 * NOT emit a tool from it — we throw a terminal-shaped error the loop surfaces as an
 * `api-error` + error tool result so the model self-corrects (re-requesting the same
 * bytes cannot fix a malformed payload).
 */
function finalizeToolBlock(acc: BlockAccumulator): ToolUseRequest {
  if (!acc.name) {
    // A tool_use block with no name never opened coherently — treat as malformed.
    throw new MinimaxAdapterError('Minimax tool_use block missing name', {
      code: 'invalid-request'
    });
  }
  const raw = acc.argsBuffer.trim();
  let toolInput: unknown;
  if (raw === '') {
    toolInput = {};
  } else {
    try {
      toolInput = JSON.parse(raw);
    } catch {
      // Malformed/partial JSON at completion — NEVER execute it (HINT-002, FR-011).
      throw new MinimaxAdapterError(
        `Minimax tool '${acc.name}' returned unparseable input`,
        { code: 'invalid-request' }
      );
    }
  }
  return { toolName: acc.name, toolInput, toolCallId: acc.id ?? `toolu_${acc.index}` };
}

/** Bounded, key-free message for a transport/stream failure. */
function networkMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === 'string' ? e : 'unknown transport error';
}
