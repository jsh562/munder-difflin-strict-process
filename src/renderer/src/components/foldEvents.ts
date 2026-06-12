/**
 * PURE fold core (E008 / T007–T010) — the single deterministic projection that turns
 * a native agent's normalized `AgentEvent` stream into the two renderer view-models
 * the panel draws: the ordered TRANSCRIPT (assistant text / tool calls / thinking /
 * notices) and the STRUCTURED run view (turns → tool calls → token usage).
 *
 * WHY one fold for both projections: the live transcript and the persisted-replay
 * transcript MUST be byte-for-event identical (FR-039/SC-022). Folding the same
 * `AgentEvent[]` through the same code path — whether the events came off the live
 * IPC bus or off the replayed JSONL — is what makes replay deterministic and
 * idempotent. So this module is the ONE place ordering, tool pairing, coalescing,
 * interrupted-resolution, and token projection are decided.
 *
 * PURITY CONTRACT (hard constraints):
 *   - NO electron / React / DOM imports — only `AgentEvent` from the shared contract.
 *     This lets Vitest run the suite in Node (T012/T013), no jsdom, no IPC.
 *   - Deterministic + idempotent: same input ⇒ same output, every time. No `Date.now`,
 *     no `Math.random`, no ambient clock. Every timestamp comes off the events.
 *   - The input array is NEVER mutated and never reordered. Entries are emitted in
 *     ARRIVAL order (the order events appear in the array, which the bridge/replay
 *     guarantee is `ts`/append order, FR-039/C4) — out-of-order events (e.g. a final
 *     `token-usage` after streamed text) do not reorder already-emitted entries.
 *   - The source `AgentEvent`/usage shapes are NOT altered (FR-014) — we DERIVE
 *     view-models; we never write back into the events.
 *
 * What lives where (by task):
 *   T007 — tool pairing by `toolCallId` (orphan `tool-end` dropped), pending/resolved.
 *   T008 — coalesce contiguous `text-delta`; thinking-only turn → collapsed thinking;
 *          empty/no-op turn → NO entry.
 *   T009 — token-usage "set-not-sum" cumulative-monotonic projection (per turn + run),
 *          decrease-clamp, `usd: null` kept as null (unpriced, never coerced to 0).
 *   T010 — end-of-stream resolution: still-`pending` tools + the unfinished turn flip
 *          to `interrupted`, bounded to tracked open entries (O(open), not O(run));
 *          8 KB DISPLAY-ONLY truncation of large `toolInput`/`result` (full payload
 *          retained in the view-model).
 */
import type { AgentEvent, TokenUsageEvent } from '../../../shared/agentEvent';

// ────────────────────────────────────────────────────────────────────────────
// View-model types (the contract the views + tests assert against)
// ────────────────────────────────────────────────────────────────────────────

/** Terminal state of a tool call (and of a turn). Strictly one of three:
 *  `pending`     — `tool-start` seen, no matching `tool-end` yet (mid-stream).
 *  `resolved`    — matching `tool-end` arrived (success/failure + duration known).
 *  `interrupted` — stream ended/aborted with the entry still open (FR-011/C6). */
export type EntryStatus = 'pending' | 'resolved' | 'interrupted';

/** The four transcript entry categories. Each is visually distinct (FR-003/FR-017);
 *  thinking is DISTINCT from assistant text and never merged into it. */
export type TranscriptEntryType = 'assistant-text' | 'tool-call' | 'thinking' | 'notice';

/** Inline-notice category (FR-007/FR-008). `degradation` ← `notification`,
 *  `api-error` ← `api-error` (retryable flag carried), `needs-input` ← `needs-input`. */
export type NoticeKind = 'degradation' | 'api-error' | 'needs-input';

/** A display-truncated payload: a large `toolInput`/`result` is truncated FOR DISPLAY
 *  ONLY (FR-029) — `display` holds the bounded preview + a clear indicator, while
 *  `full` retains the complete original value (no payload-level eviction). When a
 *  payload is under threshold, `truncated` is false and `display` === the original. */
export interface TruncatedPayload {
  /** True when the serialized payload exceeded the display threshold and `display`
   *  is a bounded preview. False ⇒ `display` is the full value, untouched. */
  truncated: boolean;
  /** Display-safe value: the original when not truncated, else a bounded preview
   *  string ending in a clear truncation indicator (`TRUNCATION_INDICATOR`). */
  display: unknown;
  /** The complete, untruncated original value — always retained (FR-029). */
  full: unknown;
  /** Serialized byte length of the full payload (for "… (N of M bytes)" affordances). */
  fullBytes: number;
}

/** One folded transcript entry (the ordered list the transcript view renders).
 *  Fields are populated per `type`; absent fields are simply `undefined`. */
export interface TranscriptEntry {
  /** Stable identity for keying/virtualization. Derived deterministically from the
   *  entry's first event (no random/clock) so replay reproduces identical ids. */
  id: string;
  type: TranscriptEntryType;
  /** Arrival timestamp of the entry's first contributing event (ordering anchor). */
  ts: number;
  /** Index (in the source array) of the entry's first contributing event — the
   *  deterministic tiebreaker that preserves arrival order across equal `ts`. */
  seq: number;

  // ── assistant-text / thinking ──
  /** Coalesced text: the full assistant answer (assistant-text) or the full thinking
   *  block (thinking), joined from contiguous deltas. */
  text?: string;
  /** thinking only: default-collapsed per FR-017 (the view honours this initial
   *  state; the operator can expand). Always `true` on a freshly folded thinking entry. */
  collapsed?: boolean;

  // ── tool-call ──
  /** The `toolCallId` this entry is keyed by (tool-call only) — pairing is STRICTLY
   *  on this id, never name/ordinal (FR-044/C6). */
  toolCallId?: string;
  toolName?: string;
  /** tool-call input, display-truncated when large (full payload retained). */
  toolInput?: TruncatedPayload;
  /** tool-call result/output, display-truncated when large (full payload retained). */
  result?: TruncatedPayload;
  /** tool-call: success on `tool-end` (undefined while pending/interrupted). */
  success?: boolean;
  /** tool-call: duration from `tool-end` (undefined while pending/interrupted). */
  durationMs?: number;
  /** tool-call: optional error string from a failed `tool-end`. */
  error?: string;

  // ── notice ──
  /** notice only: which category of notice this is. */
  noticeKind?: NoticeKind;
  /** notice only: plain notice text (api-error/notification/needs-input message). */
  message?: string;
  /** notice only (api-error): retryable vs terminal where known (FR-008). */
  retryable?: boolean;
  /** notice only: how many CONSECUTIVE identical notices (same `noticeKind` +
   *  `message`) this single entry stands for (FR-019/FR-020). Always ≥ 1: a lone
   *  notice carries `1`; a run of N repeats collapses into ONE entry carrying `N`,
   *  so repeated notices never flood the transcript. A DIFFERENT notice in between
   *  breaks the run (a later identical notice starts a fresh entry at `1`). */
  count?: number;

  // ── status (tool-call + turn-bound entries) ──
  /** Lifecycle status. `tool-call`: pending→resolved→interrupted. Other entry types
   *  are emitted already-settled and carry `resolved`. */
  status: EntryStatus;
}

/** Cumulative token-usage snapshot (display passthrough — NEVER recomputed, FR-012).
 *  Shape mirrors `TokenUsageEvent` fields; `usd`/`model` may be null. A turn with no
 *  sample carries `null` (rendered as "no usage reported", never a fabricated 0). */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  /** Passthrough USD; `null` = unpriced (never read as 0, never recomputed). */
  usd: number | null;
  model: string | null;
}

/** A structured-view tool call (mirrors the transcript `tool-call` lifecycle, but in
 *  the turn → tool-calls projection). Same pairing/interrupted rules. */
export interface StructuredToolCall {
  toolCallId: string;
  name: string;
  input: TruncatedPayload;
  output?: TruncatedPayload;
  success?: boolean;
  durationMs?: number;
  error?: string;
  status: EntryStatus;
}

/** One turn in the structured run view. */
export interface StructuredTurn {
  /** 0-based turn ordinal in arrival order. */
  index: number;
  /** Tool calls observed within this turn (in arrival order). */
  toolCalls: StructuredToolCall[];
  /** Latest cumulative token-usage sample observed AT this turn's close (FR-036).
   *  `null` ⇒ no `token-usage` sample fell in this turn ("no usage reported"). */
  tokenUsage: TokenUsage | null;
  /** Turn lifecycle: `resolved` once `turn-end` arrived, else `interrupted` at
   *  end-of-stream when the turn never closed (FR-044). `pending` while still open
   *  mid-stream (the caller passed `streamEnded: false`). */
  status: EntryStatus;
}

/** The full structured run view: turns plus the run-level token usage (latest
 *  cumulative sample overall) and the raw priced/unpriced flag. */
export interface StructuredRunView {
  turns: StructuredTurn[];
  /** Latest cumulative token-usage sample overall (per-run figure, FR-036). `null`
   *  ⇒ no sample arrived in the whole run. Clamped-monotonic (never regresses). */
  runTokenUsage: TokenUsage | null;
  /** The SAME inline notice entries the transcript carries (every `type:'notice'`
   *  entry, in arrival order), threaded onto the structured view so the structured
   *  tab can surface degradation/api-error notices CONSISTENTLY with the transcript
   *  (T032/FR-007/FR-019) WITHOUT re-folding the stream. These are the identical
   *  deduped entry objects from `entries` (same `noticeKind`/`message`/`retryable`/
   *  `count`), not a separate projection — one fold, two views (FR-034). */
  notices: TranscriptEntry[];
}

/** The single fold result: BOTH projections of the one stream, produced together so
 *  the transcript and structured tab reuse identical folded view-models (FR-034) and
 *  live == replay (FR-039). */
export interface FoldResult {
  /** Ordered transcript entries (assistant-text / tool-call / thinking / notice). */
  entries: TranscriptEntry[];
  /** Turns → tool calls → token usage projection of the same stream. */
  structured: StructuredRunView;
}

/** Options controlling end-of-stream resolution. */
export interface FoldOptions {
  /**
   * Whether the stream has ENDED (a terminal `stop` was seen, the run was aborted,
   * or this is a final/replay fold). Drives pending → interrupted:
   *   - `true`  (default): any still-open tool call / unfinished turn flips to
   *     `interrupted` (FR-011/FR-033) — correct for replay and for a settled run.
   *   - `false`: mid-stream live fold — still-open entries stay `pending` (the run
   *     is genuinely in progress, not interrupted).
   * A terminal `stop` event in the stream itself ALSO marks the stream ended, so the
   * caller does not have to pass `streamEnded: true` once `stop` has arrived.
   */
  streamEnded?: boolean;
  /** Display-truncation threshold in bytes (default 8 KB / `DEFAULT_TRUNCATE_BYTES`).
   *  Exposed for tests; production uses the default. */
  truncateBytes?: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

/** Default display-truncation threshold for `toolInput`/`result` (FR-029): 8 KB. */
export const DEFAULT_TRUNCATE_BYTES = 8 * 1024;

/** Clear, operator-visible indicator appended to a truncated display preview. */
export const TRUNCATION_INDICATOR = '… [truncated]';

// ────────────────────────────────────────────────────────────────────────────
// Truncation helper (T010, FR-029) — DISPLAY ONLY; full payload always retained
// ────────────────────────────────────────────────────────────────────────────

/** Serialize an arbitrary payload to a string for size measurement + preview, with a
 *  deterministic, throw-free fallback (a circular/unserializable value still yields a
 *  stable string so the fold never blows up). */
function serializeForDisplay(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  try {
    const json = JSON.stringify(value);
    // JSON.stringify returns undefined for functions/symbols — fall back to String().
    return json === undefined ? String(value) : json;
  } catch {
    // Circular or otherwise unserializable — last-resort stable string.
    return String(value);
  }
}

/**
 * Build a `TruncatedPayload` for a tool input/result. DISPLAY-ONLY truncation
 * (FR-029): when the serialized form exceeds `limitBytes`, `display` becomes a bounded
 * preview that ends in `TRUNCATION_INDICATOR`; `full` ALWAYS holds the complete
 * original value (no payload-level eviction). Under threshold ⇒ `display` is the
 * original value untouched and `truncated` is false.
 *
 * Byte length is measured against the UTF-8 encoding of the serialized form so the
 * threshold reflects real on-the-wire size, not JS char count. The preview is cut on
 * a UTF-8 byte boundary (never mid code point) so it stays a valid string.
 */
function truncatePayload(value: unknown, limitBytes: number): TruncatedPayload {
  const serialized = serializeForDisplay(value);
  const encoder = textEncoder();
  const bytes = encoder.encode(serialized);
  const fullBytes = bytes.length;
  if (fullBytes <= limitBytes) {
    return { truncated: false, display: value, full: value, fullBytes };
  }
  // Reserve room for the indicator so the WHOLE display preview stays within budget.
  const indicatorBytes = encoder.encode(TRUNCATION_INDICATOR).length;
  const budget = Math.max(0, limitBytes - indicatorBytes);
  const slice = bytes.subarray(0, budget);
  // Decode with `fatal: false` so a byte budget that lands mid-code-point yields a
  // replacement char rather than throwing; then strip a trailing replacement char so
  // the preview ends cleanly before the indicator.
  let preview = textDecoder().decode(slice);
  if (preview.endsWith('�')) preview = preview.slice(0, -1);
  return {
    truncated: true,
    display: preview + TRUNCATION_INDICATOR,
    full: value,
    fullBytes
  };
}

// Lazily-built, reused TextEncoder/Decoder (pure: no global mutation beyond a cached
// instance; deterministic output). Available in both Node (test) and DOM (renderer).
let _encoder: TextEncoder | null = null;
let _decoder: TextDecoder | null = null;
function textEncoder(): TextEncoder {
  if (!_encoder) _encoder = new TextEncoder();
  return _encoder;
}
function textDecoder(): TextDecoder {
  if (!_decoder) _decoder = new TextDecoder('utf-8', { fatal: false });
  return _decoder;
}

// ────────────────────────────────────────────────────────────────────────────
// Token-usage projection (T009, FR-012/FR-036) — cumulative-monotonic "set-not-sum"
// ────────────────────────────────────────────────────────────────────────────

/** Copy a `token-usage` event's fields into a `TokenUsage` snapshot (passthrough —
 *  no arithmetic, no cost recompute). `usd: null` is preserved as null. */
function usageFromEvent(e: TokenUsageEvent): TokenUsage {
  return {
    input: e.input,
    output: e.output,
    cacheRead: e.cacheRead,
    cacheCreation: e.cacheCreation,
    usd: e.usd, // may be null — kept as null, NEVER coerced to 0 (FR-036)
    model: e.model
  };
}

/**
 * Apply a new cumulative sample to the prior, "set-not-sum" with a decrease clamp
 * (FR-036/C7): a later sample REPLACES the prior cumulative value (never summed). If
 * a field DECREASED (non-monotonic sample), hold the prior maximum for THAT field
 * rather than regressing the displayed total — clamped PER FIELD. `usd: null` is
 * monotonicity-neutral (unpriced): a null on either side keeps the last known
 * non-null priced value if the prior had one, else null — never coerced to 0, never
 * recomputed.
 */
function applyUsage(prev: TokenUsage | null, next: TokenUsage): TokenUsage {
  if (!prev) return next;
  return {
    // SET, not SUM — take the new value but never below the prior max (clamp).
    input: Math.max(prev.input, next.input),
    output: Math.max(prev.output, next.output),
    cacheRead: Math.max(prev.cacheRead, next.cacheRead),
    cacheCreation: Math.max(prev.cacheCreation, next.cacheCreation),
    // usd: a decrease between two PRICED values clamps to the prior max; a null `next`
    // is unpriced (carry the prior known priced value, neutral); a null `prev` adopts
    // next. Never coerce null → 0.
    usd: clampUsd(prev.usd, next.usd),
    // model follows the latest non-null sample (carry prior when next is null).
    model: next.model ?? prev.model
  };
}

/** Clamp/carry the passthrough USD across a sample replacement (FR-036): null is
 *  monotonicity-neutral; two priced values clamp to the max (never regress). */
function clampUsd(prev: number | null, next: number | null): number | null {
  if (next == null) return prev; // unpriced sample — keep prior known value (neutral)
  if (prev == null) return next; // first priced value
  return Math.max(prev, next); // never regress a priced cumulative total
}

// ────────────────────────────────────────────────────────────────────────────
// The fold
// ────────────────────────────────────────────────────────────────────────────

/**
 * Fold an `AgentEvent[]` into BOTH renderer projections in ONE deterministic pass.
 *
 * Single pass over the events (O(events)), then an O(open) end-of-stream resolution
 * over only the entries left open (FR-033 — never a full re-scan). The input array is
 * neither mutated nor reordered; entries are emitted in arrival order.
 *
 * @param events  the ordered AgentEvent stream (live bus order or replayed JSONL).
 * @param options end-of-stream + truncation controls (see `FoldOptions`). Defaults:
 *                `streamEnded: true` (settled/replay fold), `truncateBytes: 8 KB`.
 */
export function foldEvents(events: AgentEvent[], options: FoldOptions = {}): FoldResult {
  const truncateBytes = options.truncateBytes ?? DEFAULT_TRUNCATE_BYTES;

  // Emitted, ordered transcript entries.
  const entries: TranscriptEntry[] = [];
  // Structured-view turns (built in parallel with the transcript).
  const turns: StructuredTurn[] = [];

  // ── Open-entry trackers (the O(open) set T010 flips at end-of-stream) ──
  // Pending tool calls keyed by toolCallId → BOTH their transcript entry and their
  // structured tool call, so end-of-stream resolution touches only open entries.
  const openTools = new Map<string, { entry: TranscriptEntry; struct: StructuredToolCall }>();
  // The currently-open assistant-text entry being coalesced (null between runs).
  let openText: TranscriptEntry | null = null;
  // The currently-open thinking entry being coalesced (null between runs).
  let openThinking: TranscriptEntry | null = null;
  // The current open structured turn (null outside a turn-start/turn-end pair).
  let openTurn: StructuredTurn | null = null;
  // True when `openTurn` is a REAL turn (opened by `turn-start`) vs a synthetic
  // bucket lazily created for a tool that fired outside any turn. Only a real,
  // unfinished turn is flipped to `interrupted` at end-of-stream (FR-044); a
  // synthetic bucket has no `turn-end` to await and stays `resolved`.
  let openTurnIsReal = false;

  // ── Token projection state ──
  // Running cumulative (clamped-monotonic) usage across the whole run (per-run figure).
  let runUsage: TokenUsage | null = null;
  // Latest cumulative usage observed since the current turn opened (per-turn at close).
  let pendingTurnUsage: TokenUsage | null = null;

  // A terminal `stop` in the stream forces end-of-stream resolution regardless of the
  // `streamEnded` option (the run has genuinely ended).
  let sawStop = false;

  // Closing a coalescing run when a different category of event interrupts it. The
  // contiguity rule (FR-002/FR-026): only CONSECUTIVE text-deltas coalesce; any other
  // event boundary closes the open run so a later text-delta starts a fresh entry.
  const closeOpenText = (): void => { openText = null; };
  const closeOpenThinking = (): void => { openThinking = null; };

  /**
   * Emit (or COLLAPSE) an inline notice (T033, FR-019/FR-020). Repeated identical
   * notices flood the transcript, so CONSECUTIVE duplicates — same `noticeKind` AND
   * same `message` — collapse into ONE entry carrying a `count` of how many the entry
   * stands for (the first carries `1`, each repeat bumps it). The "consecutive" run is
   * broken by ANY non-matching entry: the LAST emitted entry must itself be the same
   * notice, so a different notice (or any non-notice entry, e.g. assistant text or a
   * tool call) between two identical notices starts a fresh entry at `1`.
   *
   * Order-preserving + deterministic: when collapsing we mutate ONLY the prior notice
   * entry's `count` (its `id`/`ts`/`seq` stay anchored to the FIRST occurrence, so
   * replay reproduces identical ids); we never reorder or touch non-notice entries.
   * A notice NEVER aborts the transcript (FR-008) — the stream keeps folding after it.
   */
  const pushNotice = (
    i: number,
    ts: number,
    noticeKind: NoticeKind,
    message: string,
    retryable?: boolean
  ): void => {
    // A notice is its own category boundary: close any coalescing text/thinking run so
    // it never merges into assistant content (visually distinct, FR-019).
    closeOpenText();
    closeOpenThinking();
    const last = entries[entries.length - 1];
    if (
      last &&
      last.type === 'notice' &&
      last.noticeKind === noticeKind &&
      last.message === message &&
      last.retryable === retryable
    ) {
      // Consecutive duplicate → collapse into the prior entry (bump its count).
      last.count = (last.count ?? 1) + 1;
      return;
    }
    const entry: TranscriptEntry = {
      id: entryId('notice', i, ts),
      type: 'notice',
      ts,
      seq: i,
      noticeKind,
      message,
      status: 'resolved',
      count: 1
    };
    // Only api-error notices carry the retryable flag (undefined for the others, so the
    // dedup equality above stays exact — `undefined === undefined`).
    if (retryable !== undefined) entry.retryable = retryable;
    entries.push(entry);
  };

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    switch (ev.kind) {
      case 'turn-start': {
        // Close any coalescing run from a prior turn; open a fresh structured turn.
        // If a synthetic turn-less bucket is currently open, settle it first (a real
        // turn boundary supersedes the bucket).
        closeOpenText();
        closeOpenThinking();
        if (openTurn && !openTurnIsReal) openTurn.status = 'resolved';
        openTurn = {
          index: turns.length,
          toolCalls: [],
          tokenUsage: null,
          status: 'pending'
        };
        openTurnIsReal = true;
        turns.push(openTurn);
        pendingTurnUsage = null;
        break;
      }

      case 'turn-end': {
        // Settle in-progress assistant text + thinking; close the turn.
        closeOpenText();
        closeOpenThinking();
        if (openTurn) {
          // Per-turn usage = the latest cumulative sample observed within this turn
          // (FR-036). null ⇒ "no usage reported" — never a fabricated 0.
          openTurn.tokenUsage = pendingTurnUsage;
          openTurn.status = 'resolved';
          openTurn = null;
          openTurnIsReal = false;
        }
        pendingTurnUsage = null;
        break;
      }

      case 'thinking-start':
      case 'thinking-delta': {
        // Thinking is DISTINCT from assistant text (FR-003): an open text run is
        // closed so the two never merge. Coalesce contiguous thinking into ONE block.
        closeOpenText();
        const text = ev.text ?? '';
        if (openThinking) {
          openThinking.text = (openThinking.text ?? '') + text;
        } else {
          openThinking = {
            id: entryId('thinking', i, ev.ts),
            type: 'thinking',
            ts: ev.ts,
            seq: i,
            text,
            collapsed: true, // default-collapsed (FR-017)
            status: 'resolved'
          };
          entries.push(openThinking);
        }
        break;
      }

      case 'text-delta': {
        // Coalesce CONSECUTIVE text-deltas into ONE assistant-text entry (FR-002/
        // FR-026). A non-text event between deltas closes the run (handled in the
        // other cases), so a later delta starts a fresh entry — contiguity preserved.
        closeOpenThinking();
        if (openText) {
          openText.text = (openText.text ?? '') + ev.text;
        } else {
          openText = {
            id: entryId('text', i, ev.ts),
            type: 'assistant-text',
            ts: ev.ts,
            seq: i,
            text: ev.text,
            status: 'resolved'
          };
          entries.push(openText);
        }
        break;
      }

      case 'tool-start': {
        // A tool boundary closes any open text/thinking run (a tool entry is distinct).
        closeOpenText();
        closeOpenThinking();
        const input = truncatePayload(ev.toolInput, truncateBytes);
        const entry: TranscriptEntry = {
          id: entryId('tool', i, ev.ts),
          type: 'tool-call',
          ts: ev.ts,
          seq: i,
          toolCallId: ev.toolCallId,
          toolName: ev.toolName,
          toolInput: input,
          status: 'pending'
        };
        entries.push(entry);
        const struct: StructuredToolCall = {
          toolCallId: ev.toolCallId,
          name: ev.toolName,
          input,
          status: 'pending'
        };
        // Attach to the current turn (or a synthetic turn-less bucket if a tool fired
        // outside any turn — tolerate out-of-order/missing turn boundaries).
        ensureTurn().toolCalls.push(struct);
        // Track as OPEN, keyed STRICTLY by toolCallId (FR-044/C6). If a duplicate
        // toolCallId somehow reopens, the latest wins for resolution (last write).
        openTools.set(ev.toolCallId, { entry, struct });
        break;
      }

      case 'tool-end': {
        // Resolve the matching pending entry IN PLACE, strictly by toolCallId. An
        // ORPHAN tool-end (no matching tool-start) is DROPPED — it never creates or
        // mutates an unrelated entry (FR-044/C6).
        const open = openTools.get(ev.toolCallId);
        if (!open) break; // orphan → drop, keep folding
        // tool-end carries success/duration/error but NOT a success result payload in
        // the AgentEvent contract (FR-014): the only result-like payload it can carry
        // is `error` (on failure). We surface that as the display-truncated `result`/
        // `output` when present, and NEVER invent a result the event didn't carry.
        open.entry.status = 'resolved';
        open.entry.success = ev.success;
        open.entry.durationMs = ev.durationMs;
        open.struct.status = 'resolved';
        open.struct.success = ev.success;
        open.struct.durationMs = ev.durationMs;
        if (ev.error !== undefined) {
          const result = truncatePayload(ev.error, truncateBytes);
          open.entry.error = ev.error;
          open.entry.result = result;
          open.struct.error = ev.error;
          open.struct.output = result;
        }
        openTools.delete(ev.toolCallId); // no longer open
        break;
      }

      case 'token-usage': {
        // Cumulative-monotonic SET-not-SUM (FR-036): replace prior, clamp decreases,
        // keep usd:null as null. Tolerate arriving after streamed text — it never
        // reorders already-emitted transcript entries.
        const sample = usageFromEvent(ev);
        runUsage = applyUsage(runUsage, sample);
        pendingTurnUsage = applyUsage(pendingTurnUsage, sample);
        // If a turn is open, reflect the per-turn cumulative immediately so a turn
        // that never closes still shows its last in-turn sample at end-of-stream.
        if (openTurn) openTurn.tokenUsage = pendingTurnUsage;
        break;
      }

      case 'api-error': {
        // Inline notice; does NOT abort the transcript (FR-008). `retryable` carries
        // retryable-vs-terminal (FR-008); `pushNotice` collapses consecutive repeats
        // into one entry with a `count` (T033/FR-019).
        pushNotice(i, ev.ts, 'api-error', ev.message, ev.retryable);
        break;
      }

      case 'needs-input': {
        pushNotice(i, ev.ts, 'needs-input', ev.message);
        break;
      }

      case 'notification': {
        // Capability-degradation notices surface here (FR-007).
        pushNotice(i, ev.ts, 'degradation', ev.message);
        break;
      }

      case 'stop': {
        // Terminal signal: settle in-progress streaming + mark the stream ended so the
        // O(open) resolution below flips remaining open entries to `interrupted`.
        closeOpenText();
        closeOpenThinking();
        sawStop = true;
        break;
      }

      default: {
        // Unknown/forward-version kind (FR-045/C3): fold best-effort = ignore. A
        // future additive kind never breaks the fold; it simply contributes no entry.
        break;
      }
    }
  }

  // ── End-of-stream resolution (T010, FR-011/FR-033) ──
  // Bounded to the OPEN entries we tracked — never a full re-scan of `entries`.
  const streamEnded = options.streamEnded ?? true;
  if (streamEnded || sawStop) {
    // Every still-pending tool call → interrupted (no tool-end ever arrived).
    for (const { entry, struct } of openTools.values()) {
      entry.status = 'interrupted';
      struct.status = 'interrupted';
    }
    openTools.clear();
    // A REAL unfinished turn (turn-start with no turn-end) → interrupted, settling its
    // last-known per-turn usage. A synthetic turn-less bucket has no turn-end to await
    // and is left settled (resolved) — only real turns are "interrupted".
    if (openTurn) {
      openTurn.tokenUsage = pendingTurnUsage;
      openTurn.status = openTurnIsReal ? 'interrupted' : 'resolved';
      openTurn = null;
    }
  }

  // Thread the SAME deduped notice entries onto the structured view so the structured
  // tab surfaces them CONSISTENTLY with the transcript without re-folding (T032/FR-034).
  // These are the identical entry objects from `entries` (one fold, two views).
  const notices = entries.filter((e) => e.type === 'notice');

  return {
    entries,
    structured: { turns, runTokenUsage: runUsage, notices }
  };

  /** Lazily ensure a structured turn exists for a tool that fired outside any
   *  turn-start/turn-end pair (tolerate missing/out-of-order turn boundaries). The
   *  synthetic bucket is marked NOT-real so end-of-stream resolution leaves it
   *  settled rather than flipping it to `interrupted`. */
  function ensureTurn(): StructuredTurn {
    if (openTurn) return openTurn;
    const turn: StructuredTurn = {
      index: turns.length,
      toolCalls: [],
      tokenUsage: pendingTurnUsage,
      status: 'resolved'
    };
    turns.push(turn);
    openTurn = turn;
    openTurnIsReal = false;
    return turn;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Deterministic id derivation (no random/clock — replay reproduces identical ids)
// ────────────────────────────────────────────────────────────────────────────

/** Build a stable entry id from the entry kind, the source index of its first event,
 *  and that event's `ts`. Deterministic + collision-resistant within a run: the
 *  source index is unique per event, so two entries never share an id. */
function entryId(kind: string, index: number, ts: number): string {
  return `${kind}-${index}-${ts}`;
}
