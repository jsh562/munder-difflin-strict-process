/**
 * DeepSeek native provider adapter (E006 / US1 — FR-001/002/003/006/011).
 *
 * Implements the `ProviderCall` seam over DeepSeek's OpenAI-compatible Chat
 * Completions STREAMING API. Per round it:
 *  - builds an OpenAI-style streaming request (`stream:true`,
 *    `stream_options:{include_usage:true}`, messages, tools) and POSTs it to
 *    `${endpoint}/chat/completions` with the bearer key applied ONLY at the fetch
 *    boundary (FR-013 — the key never enters a turn/event/usage payload);
 *  - consumes the response with the shared `parseSseStream`;
 *  - routes `delta.content`→text and `delta.reasoning_content`→thinking, emitting
 *    normalized AgentEvent deltas as the stream arrives (AD-001, FR-003) and
 *    aggregating both into the returned `ProviderTurn` — but NEVER replaying
 *    `reasoning_content` into a later request (DeepSeek 400s on replay, FR-003);
 *  - assembles streamed `tool_calls` keyed by their `index`: `id`/`type`/
 *    `function.name` appear on the first delta for an index, later deltas append
 *    `function.arguments` partial JSON; arguments are parsed ONLY when the call is
 *    complete (`finish_reason:'tool_calls'` or stream end), never from partial JSON
 *    (HINT-002, FR-002/011);
 *  - normalizes usage from the final chunk's `usage` block (present because
 *    `include_usage`) into a cumulative-monotonic `UsageDelta` (absent cache fields
 *    → 0, never negative), passing `usd` through (FR-006, HINT-003).
 *
 * It is electron-free and `fetch`-injected (HINT-001) so vitest drives it in Node
 * over fabricated SSE streams; the worker entry passes the real `fetch`/env later.
 * No provider SDK or wire type crosses the `ProviderCall` boundary (FR-007).
 *
 * Error contract: on an HTTP failure or a stream/JSON fault the adapter THROWS an
 * error shaped `{ status?, retryAfter?, code?, message? }` so the loop's
 * `withReliability` (ADR-0009) classifies it; the adapter does NOT retry itself.
 */
import { AGENT_EVENT_VERSION, type AgentEvent } from '../../../../shared/agentEvent';
import type {
  ProviderCall,
  ProviderRequest,
  ProviderTurn,
  ToolUseRequest,
  UsageDelta
} from '../../../../shared/providerCall';
import { lookupCapabilities } from '../../../../shared/providerRegistry';
import { makeCapabilityGate, type CapabilityGate } from './capabilityGate';
import { parseSseStream, type ByteStream } from './sseParser';

/** Minimal `fetch` shape the adapter needs — injected so vitest runs in Node. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  }
) => Promise<FetchResponseLike>;

/** The slice of a fetch `Response` the adapter reads (no DOM/Node types leak out). */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  /** SSE body; `parseSseStream` consumes it. Null on an empty/failed response. */
  body: ByteStream | null;
  headers: { get(name: string): string | null };
  /** Read the (error) body as text for a bounded, key-free diagnostic. */
  text(): Promise<string>;
}

/** Injectable dependencies — all provider-specific facts arrive here, not from env. */
export interface DeepseekAdapterDeps {
  /** Injected `fetch` (HINT-001). The worker passes the real global; tests a fake. */
  fetch: FetchLike;
  /** Provider API key; read at the fetch boundary ONLY, never emitted (FR-013). */
  apiKey: string;
  /** Base endpoint, e.g. `https://api.deepseek.com/v1` (registry-provided). */
  endpoint: string;
  /** Assigned model id, e.g. `deepseek-v4-flash`. */
  model: string;
}

/** A round-local error the adapter throws; shaped for `classifyError` (reliability). */
class DeepseekAdapterError extends Error {
  /** HTTP status when the failure carried one (absent = stream/parse fault). */
  readonly status?: number;
  /** `Retry-After` hint passed through to the backoff policy. */
  readonly retryAfter?: string | number;
  /** Coarse, provider-agnostic code, e.g. `'stream-interrupted'`, `'invalid-request'`. */
  readonly code?: string;
  constructor(message: string, opts: { status?: number; retryAfter?: string | number; code?: string }) {
    super(message);
    this.name = 'DeepseekAdapterError';
    this.status = opts.status;
    this.retryAfter = opts.retryAfter;
    this.code = opts.code;
  }
}

/** Accumulator for one streamed tool call, keyed by its delta `index`. */
interface ToolCallAccumulator {
  index: number;
  id?: string;
  name?: string;
  /** Concatenated `function.arguments` partial-JSON fragments (parsed at completion). */
  argsBuffer: string;
}

const ZERO_USAGE: UsageDelta = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

/** A non-negative integer from an arbitrary value (absent/garbage → 0); never negative (FR-006). */
function nonNegInt(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return 0;
  return Math.trunc(v);
}

/**
 * Map DeepSeek's terminal-chunk `usage` block onto the normalized `UsageDelta`.
 * Absent cache fields default to 0 (not a decrease); `usd` is read separately and
 * passed through unchanged (recompute is out of scope, FR-006). OpenAI-compatible
 * usage exposes `prompt_tokens`/`completion_tokens`; the cache breakdown, when
 * present, lives under `prompt_tokens_details` (`cached_tokens`).
 */
function mapUsage(usage: unknown): UsageDelta {
  if (!usage || typeof usage !== 'object') return { ...ZERO_USAGE };
  const u = usage as Record<string, unknown>;
  const details = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
  return {
    input: nonNegInt(u.prompt_tokens),
    output: nonNegInt(u.completion_tokens),
    cacheRead: nonNegInt(details.cached_tokens),
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
 * Build the OpenAI-compatible streaming request body. Tools are mapped to the
 * `{type:'function', function:{name, description, parameters}}` shape; an absent
 * schema is sent as an empty object so the provider accepts the tool.
 *
 * Capability gating (FR-010 / AD-005 / HINT-004): BEFORE any optional capability
 * path is built, each gated field on the request (`images`/`mcpTools`/`webSearch`/
 * `caching`) is checked against the model's registry descriptor via `gate`. An
 * unsupported field is STRIPPED from the outgoing body (it never reaches the
 * provider) and the gate emits exactly ONE bounded notice per capability per
 * session — never throwing. Caching is handled by the caller (it also zeroes the
 * reported cache-usage fields), so it is omitted from the body whether supported or
 * not (no DeepSeek cache-control wire field is needed; caching is request-implicit).
 */
function buildBody(req: ProviderRequest, model: string, gate: CapabilityGate): string {
  // Strip any unsupported capability field at ingress (one notice/capability/session).
  // `applyTo` reads the descriptor BEFORE the optional path and drops what is
  // unsupported, leaving a shallow copy; it never mutates `req` and never throws.
  const allowed = gate.applyTo({
    ...(req.images !== undefined ? { images: req.images } : {}),
    ...(req.mcpTools !== undefined ? { mcpTools: req.mcpTools } : {}),
    ...(req.webSearch !== undefined ? { webSearch: req.webSearch } : {}),
    ...(req.caching !== undefined ? { caching: req.caching } : {})
  });

  const messages = req.messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content };
    }
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      // Echo the assistant's tool calls so the following `tool` reply has a matching
      // `tool_call_id` — an OpenAI-compatible provider 400s on an orphaned tool reply.
      return {
        role: 'assistant',
        content: m.content,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.toolCallId,
          type: 'function',
          function: { name: tc.toolName, arguments: JSON.stringify(tc.toolInput) }
        }))
      };
    }
    return { role: m.role, content: m.content };
  });
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    // `include_usage` makes DeepSeek emit a single terminal `usage` chunk (FR-006).
    stream_options: { include_usage: true }
  };
  if (req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        parameters: t.inputSchema ?? {}
      }
    }));
  }
  // Only attach the surviving capability fields the provider actually supports. An
  // unsupported field is absent from `allowed` (stripped), so it never reaches the
  // wire. Caching is intentionally NOT serialized — DeepSeek caching is implicit and
  // the unsupported case is reflected purely by zeroing cache-usage (see consumeStream).
  if (allowed.images !== undefined) body.images = allowed.images;
  if (allowed.mcpTools !== undefined) body.mcp_tools = allowed.mcpTools;
  if (allowed.webSearch !== undefined) body.web_search = allowed.webSearch;
  return JSON.stringify(body);
}

/** Normalize a DeepSeek `finish_reason` onto the provider-agnostic stop vocabulary. */
function normalizeStopReason(raw: string | undefined): string | undefined {
  switch (raw) {
    case 'tool_calls':
      return 'tool-use';
    case 'stop':
      return 'end-of-turn';
    case 'length':
      return 'max-tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return raw ? raw : undefined;
  }
}

/**
 * Build a DeepSeek adapter as a `ProviderCall`. Each invocation runs ONE provider
 * round (the loop drives multi-round tool use by re-calling with the tool results
 * appended): it streams the response, emits normalized deltas, and returns the
 * aggregate `ProviderTurn`. `endOfTurn` is false when the round requested tools.
 */
export function makeDeepseekAdapter(deps: DeepseekAdapterDeps): ProviderCall {
  const { fetch, apiKey, endpoint, model } = deps;
  const url = `${endpoint.replace(/\/$/, '')}/chat/completions`;

  // Session-scoped capability gate (AD-005 / FR-010 / HINT-004): ONE instance per
  // adapter = one desk session, so a capability is noticed at most once per session
  // (not per turn). The gate reads the model's E002 registry descriptor BEFORE any
  // optional path. `emit` arrives per-round; the gate closes over a mutable ref so a
  // notice routes to the current round's loop emit (or nowhere if absent).
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

    // The bearer key is constructed HERE, at the fetch boundary, and nowhere else;
    // it never enters a turn/event/usage payload (FR-013).
    let response: FetchResponseLike;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          authorization: `Bearer ${apiKey}`
        },
        body: requestBody
      });
    } catch (e) {
      // A network/transport failure (no HTTP status) → classified retryable upstream.
      throw new DeepseekAdapterError(networkMessage(e), { code: 'network' });
    }

    if (!response.ok) {
      // Surface a key-free, bounded diagnostic shaped for `classifyError` — the loop
      // decides retry vs terminal from the status (no internal retry here). Include a
      // bounded slice of the provider's error body (its JSON error message — never the
      // key, which only rides the Authorization header) so the reason is visible.
      const retryAfter = response.headers.get('retry-after') ?? undefined;
      // Scrub the key BEFORE slicing — a hostile/sloppy provider could echo it in the
      // body, and FR-013/ADR-0007 forbid it reaching the surfaced error.
      let detail = '';
      try {
        const raw = await response.text();
        detail = (apiKey ? raw.split(apiKey).join('(redacted)') : raw).slice(0, 500);
      } catch { /* body unavailable */ }
      throw new DeepseekAdapterError(
        `DeepSeek HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
        { status: response.status, retryAfter: retryAfter ?? undefined }
      );
    }
    if (!response.body) {
      // OK status but no stream body — treat as a transient stream fault (retryable).
      throw new DeepseekAdapterError('DeepSeek response had no stream body', {
        code: 'stream-interrupted'
      });
    }

    return consumeStream(response.body, model, emit, cachingSupported);
  };
}

/**
 * Drive the SSE stream to an aggregate `ProviderTurn`. Accumulates text/thinking
 * deltas and index-keyed tool calls; parses tool arguments ONLY when each call is
 * complete; reads usage from the terminal chunk. Throws a reliability-shaped error
 * on an interrupted stream or an un-parseable completed tool call (FR-011).
 */
async function consumeStream(
  body: ByteStream,
  model: string,
  emit?: (event: AgentEvent) => void,
  cachingSupported = true
): Promise<ProviderTurn> {
  const env = (): { v: number; agentId: string; sessionId: string | null; ts: number } => ({
    // The loop forwards events with its own envelope context; the adapter fills the
    // version + a neutral envelope (the worker's scoped emit may overwrite ids). We
    // keep agentId/sessionId null here because the adapter has no desk identity —
    // identity is the loop's concern; the adapter only contributes the delta payload.
    v: AGENT_EVENT_VERSION,
    agentId: '',
    sessionId: null,
    ts: Date.now()
  });

  const tools = new Map<number, ToolCallAccumulator>();
  let text = '';
  let thinking = '';
  let thinkingStarted = false;
  let finishReason: string | undefined;
  let usage: UsageDelta = { ...ZERO_USAGE };
  let usd: number | undefined;
  let sawTerminalChunk = false;

  try {
    for await (const ev of parseSseStream(body)) {
      if (ev.done) {
        // `[DONE]` sentinel — the stream ended cleanly.
        break;
      }
      const chunk = ev.data;
      if (!chunk || typeof chunk !== 'object') continue; // tolerate heartbeats/raw

      const c = chunk as Record<string, unknown>;

      // The terminal `include_usage` chunk carries `usage` (often with empty choices).
      if (c.usage && typeof c.usage === 'object') {
        usage = mapUsage(c.usage);
        const passUsd = usdOf(c.usage);
        if (passUsd !== undefined) usd = passUsd;
        sawTerminalChunk = true;
      }

      const choices = Array.isArray(c.choices) ? c.choices : [];
      for (const choiceRaw of choices) {
        if (!choiceRaw || typeof choiceRaw !== 'object') continue;
        const choice = choiceRaw as Record<string, unknown>;

        if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;

        const delta = (choice.delta ?? {}) as Record<string, unknown>;

        // Reasoning → thinking (emit deltas; aggregate into the turn). Never replayed.
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
          if (!thinkingStarted) {
            thinkingStarted = true;
            emit?.({ ...env(), kind: 'thinking-start' });
          }
          thinking += delta.reasoning_content;
          emit?.({ ...env(), kind: 'thinking-delta', text: delta.reasoning_content });
        }

        // Content → text.
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          text += delta.content;
          emit?.({ ...env(), kind: 'text-delta', text: delta.content });
        }

        // Tool-call fragments — key the accumulator on `index` (HINT-002).
        const deltaToolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
        for (const tcRaw of deltaToolCalls) {
          if (!tcRaw || typeof tcRaw !== 'object') continue;
          const tc = tcRaw as Record<string, unknown>;
          const index = typeof tc.index === 'number' ? tc.index : tools.size;
          let acc = tools.get(index);
          if (!acc) {
            acc = { index, argsBuffer: '' };
            tools.set(index, acc);
          }
          // id/type/name appear on the FIRST delta for an index.
          if (typeof tc.id === 'string' && tc.id.length > 0) acc.id = tc.id;
          const fn = (tc.function ?? {}) as Record<string, unknown>;
          if (typeof fn.name === 'string' && fn.name.length > 0) acc.name = fn.name;
          // Later deltas append `function.arguments` partial JSON (never parsed yet).
          if (typeof fn.arguments === 'string') acc.argsBuffer += fn.arguments;
        }
      }
    }
  } catch (e) {
    // The stream broke mid-flight (e.g. reader rejected). Per the spec an interrupted
    // stream is RETRYABLE; any partially-assembled tool call is discarded (we never
    // parsed/executed it). Surface a reliability-shaped error (HINT-002 / FR-011).
    throw new DeepseekAdapterError(`DeepSeek stream interrupted: ${networkMessage(e)}`, {
      code: 'stream-interrupted'
    });
  }

  // Finalize tool calls — parse arguments ONLY now that each call is complete.
  const requestedTools = finishReason === 'tool_calls' || tools.size > 0;
  const toolUses = tools.size > 0 ? finalizeToolCalls(tools, finishReason, sawTerminalChunk) : [];

  // Caching-off degradation (FR-010 / SC-008): when the model lacks prompt caching,
  // report cache usage fields as 0 (not an error). Token in/out usage is untouched.
  if (!cachingSupported) {
    usage = { ...usage, cacheRead: 0, cacheCreation: 0 };
  }

  const turn: ProviderTurn = {
    text: text.length > 0 ? text : undefined,
    thinking: thinking.length > 0 ? thinking : undefined,
    toolUses,
    usage,
    // A round that requested tools is NOT end-of-turn — the loop runs the tools and
    // re-calls the adapter with the results appended (multi-round tool use).
    endOfTurn: toolUses.length === 0 && !requestedTools,
    stopReason: normalizeStopReason(finishReason)
  };
  if (usd !== undefined) turn.usd = usd;
  return turn;
}

/**
 * Parse the accumulated tool-call buffers into complete `ToolUseRequest`s. Arguments
 * are parsed HERE and only here (the call is complete). An empty buffer is treated as
 * `{}`. A buffer that fails to parse is a malformed/partial tool call (FR-011): we do
 * NOT emit a tool from it — we throw a terminal-shaped error the loop surfaces as an
 * `api-error` + error tool result so the model self-corrects (it never retries, since
 * re-requesting the same bytes will not fix a malformed payload).
 *
 * The `streamComplete` guard distinguishes a clean finish (parse and surface a bad
 * payload as a non-retryable error) from a stream that never reached `tool_calls`
 * completion (handled by the interrupted-stream path before we get here).
 */
function finalizeToolCalls(
  tools: Map<number, ToolCallAccumulator>,
  finishReason: string | undefined,
  sawTerminalChunk: boolean
): ToolUseRequest[] {
  // Stable order by index so multiple concurrent calls execute deterministically.
  const ordered = [...tools.values()].sort((a, b) => a.index - b.index);

  // If the stream ended WITHOUT a `tool_calls` finish AND without the terminal usage
  // chunk, the tool stream was cut off mid-flight — discard the incomplete call(s)
  // and surface a retryable error (the loop self-corrects; HINT-002 / FR-011).
  const completed = finishReason === 'tool_calls' || sawTerminalChunk;
  if (!completed) {
    throw new DeepseekAdapterError('DeepSeek tool-call stream ended before completion', {
      code: 'stream-interrupted'
    });
  }

  const out: ToolUseRequest[] = [];
  for (const acc of ordered) {
    if (!acc.name) {
      // A tool call with no name never completed coherently — treat as malformed.
      throw new DeepseekAdapterError('DeepSeek tool call missing function name', {
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
        // Terminal-shaped: a retry of identical bytes cannot fix the payload; the loop
        // feeds an error tool result back so the model self-corrects.
        throw new DeepseekAdapterError(
          `DeepSeek tool '${acc.name}' returned unparseable arguments`,
          { code: 'invalid-request' }
        );
      }
    }
    out.push({ toolName: acc.name, toolInput, toolCallId: acc.id ?? `call_${acc.index}` });
  }
  return out;
}

/** Bounded, key-free message for a transport/stream failure. */
function networkMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === 'string' ? e : 'unknown transport error';
}
