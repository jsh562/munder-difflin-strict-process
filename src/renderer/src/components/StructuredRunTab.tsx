import { useMemo } from 'react';
import {
  type StructuredRunView,
  type StructuredTurn,
  type StructuredToolCall,
  type TokenUsage,
  type TruncatedPayload,
  type TranscriptEntry,
  type NoticeKind,
  type EntryStatus,
  DEFAULT_TRUNCATE_BYTES,
  TRUNCATION_INDICATOR
} from './foldEvents';
import { toolSummaryLine } from './toolSummary';
import { useAgentSpans, useFleetTelemetry, type ToolSpan, type AgentUsageSample } from '@/hooks/useTelemetry';

/**
 * E008 / T027–T028 (FR-005/FR-012/FR-029/FR-034) — the OPT-IN structured tab: the
 * run presented as turns → tool calls (name, input, result/output, duration,
 * success/failure status) plus token usage per turn and per run.
 *
 * It renders a `StructuredRunView` (the SAME `{ turns, runTokenUsage }` projection the
 * pure `foldEvents` core produces). For a NATIVE desk that view is consumed straight
 * from `useNativeAgentEvents` — the exact view-model the transcript already folded — so
 * toggling between the transcript and this tab REUSES the already-folded view-models
 * and never re-folds the stream (FR-034). The fold owns truncation: every
 * `toolInput`/`result` arrives as a `TruncatedPayload{truncated,display,full,fullBytes}`
 * already bounded to the 8 KB display threshold (FR-029), so this component renders
 * `.display` + a truncation indicator and never re-truncates the raw payload (the full
 * value stays retained on the view-model).
 *
 * Token usage is DISPLAY PASSTHROUGH (FR-012, Principle II): the numbers come straight
 * off the view-model; cost is NEVER recomputed here. `usd: null` renders as UNPRICED
 * (a parity marker), never as `$0` — an unpriced/unknown-model desk is not free.
 *
 * Two data sources, ONE renderer (AD-005 — the structured tab is available for native
 * AND Claude, derived from the AgentEvent stream):
 *   - NATIVE: `useNativeAgentEvents(agentId).structured` — the folded AgentEvent run,
 *     passed in by the panel so the transcript + this tab share one fold (FR-034).
 *   - CLAUDE: the run is derived from the EXISTING renderer telemetry already on the
 *     `telemetry:event` stream — Claude tool spans (`useAgentSpans`) + token usage
 *     (`useFleetTelemetry`) — mapped into the SAME `StructuredRunView` shape (a flat
 *     single-turn projection; Claude's turn boundaries are coarser than native's).
 *     This keeps the Claude PTY render path BYTE-FOR-BYTE UNCHANGED (FR-009/FR-035):
 *     no new IPC, no Claude AgentEvent subscription, no PTY-path edit — only the
 *     additive structured projection of telemetry the renderer already receives.
 */

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

export interface StructuredRunTabProps {
  /** The agent whose run to present. Used for the Claude telemetry derivation and
   *  for the header label. */
  agentId: string;
  /** Which data source backs this tab:
   *   - `'native'` (default): the caller passes the folded `structured` view from
   *     `useNativeAgentEvents` so the transcript + this tab share ONE fold (FR-034).
   *   - `'claude'`: the tab derives its `StructuredRunView` from the EXISTING renderer
   *     telemetry (tool spans + token usage), keeping the Claude PTY path untouched. */
  source?: 'native' | 'claude';
  /** REQUIRED for `source: 'native'` — the already-folded run view from the panel's
   *  single `useNativeAgentEvents` call (do NOT re-fold here, FR-034). Ignored for
   *  `source: 'claude'`, which derives its own view from telemetry. */
  structured?: StructuredRunView;
  /** Native-only: whether the initial persisted-run backfill is still loading (lets
   *  the tab distinguish "loading the run" from "loaded, genuinely empty"). Passed
   *  through from the panel's `useNativeAgentEvents`. Defaults to false. */
  loading?: boolean;
  /** Edge-to-edge mode for the sidebar host: no outer chrome (mirrors the sibling
   *  transcript/PTY views so the panel frames all three the same). */
  embedded?: boolean;
}

/**
 * The opt-in structured run view (turns → tool calls + token usage).
 *
 * @param agentId   the agent to present (Claude telemetry key + header label).
 * @param source    `'native'` (folded `structured` prop) or `'claude'` (telemetry).
 * @param structured the folded view-model for a native desk (reused, never re-folded).
 * @param loading   native backfill-in-progress flag (default false).
 * @param embedded  edge-to-edge (no outer chrome), for the sidebar host.
 */
export function StructuredRunTab({
  agentId,
  source = 'native',
  structured,
  loading = false,
  embedded
}: StructuredRunTabProps) {
  if (source === 'claude') {
    return <ClaudeStructuredRunTab agentId={agentId} embedded={embedded} />;
  }
  return (
    <StructuredRunBody
      agentId={agentId}
      view={structured ?? EMPTY_VIEW}
      loading={loading}
      sourceLabel="native"
      embedded={embedded}
    />
  );
}

/** An empty fold view — used as the native fallback when no `structured` prop is
 *  supplied (defensive: the tab still renders a coherent empty state). */
const EMPTY_VIEW: StructuredRunView = { turns: [], runTokenUsage: null, notices: [] };

// ────────────────────────────────────────────────────────────────────────────
// Claude source (Option B) — derive a StructuredRunView from EXISTING telemetry
// ────────────────────────────────────────────────────────────────────────────

/**
 * Claude structured tab: derive the `StructuredRunView` from the renderer telemetry
 * the app ALREADY receives on `telemetry:event` (FR-035, AD-005 Option B). No Claude
 * AgentEvent subscription, no new IPC, no PTY-path change — the Claude default PTY view
 * stays byte-for-byte unchanged (FR-009).
 *
 * Mapping (telemetry → `StructuredRunView`):
 *   - Each `ToolSpan` → one `StructuredToolCall`. Spans carry no input payload and an
 *     `error` string only on failure, so `input` is an empty (non-truncated) payload
 *     and `output`/`error` are populated only when the span failed. A telemetry span is
 *     always a completed call (it is emitted on `tool_result`), so status is `resolved`.
 *     Truncation still runs through the SAME fold threshold (FR-029) for parity.
 *   - The latest `AgentUsageSample` → the run-level `TokenUsage` (display passthrough;
 *     `usd: null` stays unpriced, FR-012). Claude's turn boundaries are not available
 *     from telemetry, so the projection is a single coarse turn (acceptable for Claude
 *     per the task's design note).
 */
function ClaudeStructuredRunTab({ agentId, embedded }: { agentId: string; embedded?: boolean }) {
  const spans = useAgentSpans(agentId);
  const { samples } = useFleetTelemetry();
  const sample = samples[agentId];

  // Build the view-model from telemetry. Memoized on the telemetry inputs so a toggle
  // (which changes nothing here) does no work; only new spans/usage rebuild it.
  const view = useMemo(() => claudeViewFromTelemetry(spans, sample), [spans, sample]);

  return (
    <StructuredRunBody
      agentId={agentId}
      view={view}
      loading={false}
      sourceLabel="claude"
      embedded={embedded}
    />
  );
}

/** Map Claude renderer telemetry (`ToolSpan[]` + latest `AgentUsageSample`) into the
 *  shared `StructuredRunView` shape. Pure + deterministic over its inputs. */
function claudeViewFromTelemetry(
  spans: ToolSpan[],
  sample: AgentUsageSample | undefined
): StructuredRunView {
  const runTokenUsage = sample ? usageFromSample(sample) : null;
  // Claude api_error telemetry lands as a `tool:'api_error'` span (useTelemetry):
  // derive inline notices from those so the Claude structured tab surfaces api-error
  // notices CONSISTENTLY with the native transcript/structured treatment (T032/FR-007/
  // FR-019). Telemetry carries no retryable signal, so it is left undefined (rendered
  // as terminal/unknown) and consecutive duplicates collapse to one entry with a count
  // (FR-019), mirroring the fold's dedup.
  const notices = claudeNoticesFromSpans(spans);
  if (spans.length === 0) {
    return { turns: [], runTokenUsage, notices };
  }
  const toolCalls: StructuredToolCall[] = spans.map((s) => {
    const failed = !s.success || s.tool === 'api_error';
    const output = s.error !== undefined ? displayPayload(s.error) : undefined;
    return {
      // Telemetry has no tool-call id; the per-span index keeps keys stable + unique.
      toolCallId: `${s.ts}-${s.tool}`,
      name: s.tool,
      // Spans carry no input payload — an empty, non-truncated placeholder.
      input: displayPayload(undefined),
      output,
      success: !failed,
      durationMs: s.durationMs,
      error: s.error,
      // A telemetry span is emitted on `tool_result` — it is always a completed call.
      status: 'resolved'
    };
  });
  const turn: StructuredTurn = {
    index: 0,
    toolCalls,
    tokenUsage: runTokenUsage,
    status: 'resolved'
  };
  return { turns: [turn], runTokenUsage, notices };
}

/** Derive inline `api-error` notice entries from Claude telemetry api_error spans,
 *  applying the SAME consecutive-duplicate collapse rule as the fold (FR-019): a run of
 *  identical messages collapses into ONE entry carrying a `count`; any non-matching
 *  span between two identical ones breaks the run. Order-preserving + deterministic. */
function claudeNoticesFromSpans(spans: ToolSpan[]): TranscriptEntry[] {
  const notices: TranscriptEntry[] = [];
  let lastMessage: string | null = null;
  for (const s of spans) {
    if (s.tool !== 'api_error') {
      // A non-api_error span breaks the consecutive run.
      lastMessage = null;
      continue;
    }
    const message = s.error ?? 'api error';
    const last = notices[notices.length - 1];
    if (last && lastMessage === message) {
      last.count = (last.count ?? 1) + 1;
      continue;
    }
    notices.push(makeNotice(`claude-notice-${s.ts}`, s.ts, 'api-error', message));
    lastMessage = message;
  }
  return notices;
}

/** Build a notice `TranscriptEntry` for the Claude telemetry branch, mirroring the
 *  shape the fold emits (so `NoticeRow` renders both identically). */
function makeNotice(
  id: string,
  ts: number,
  noticeKind: NoticeKind,
  message: string
): TranscriptEntry {
  return { id, type: 'notice', ts, seq: 0, noticeKind, message, status: 'resolved', count: 1 };
}

/** Copy a telemetry `AgentUsageSample` into the display `TokenUsage` shape — pure
 *  passthrough, no cost recompute; `usd: null` preserved as unpriced (FR-012). */
function usageFromSample(s: AgentUsageSample): TokenUsage {
  return {
    input: s.input,
    output: s.output,
    cacheRead: s.cacheRead,
    cacheCreation: s.cacheCreation,
    usd: s.usd, // may be null — unpriced, never coerced to 0
    model: s.model
  };
}

/** Build a (never-truncated) display payload for a small/absent value so the Claude
 *  branch renders through the SAME `TruncatedPayload` contract as the fold. (A large
 *  error string still gets truncated for display below via `truncateForDisplay`.) */
function displayPayload(value: unknown): TruncatedPayload {
  return truncateForDisplay(value, DEFAULT_TRUNCATE_BYTES);
}

// ────────────────────────────────────────────────────────────────────────────
// Shared body — renders a StructuredRunView (turns → tool calls + token usage)
// ────────────────────────────────────────────────────────────────────────────

function StructuredRunBody({
  agentId,
  view,
  loading,
  sourceLabel,
  embedded
}: {
  agentId: string;
  view: StructuredRunView;
  loading: boolean;
  sourceLabel: 'native' | 'claude';
  embedded?: boolean;
}) {
  const empty = view.turns.length === 0;
  return (
    <div
      style={{
        background: 'var(--cth-paper-100)',
        boxShadow: embedded ? 'none' : 'var(--cth-panel-border-terminal)',
        padding: embedded ? 0 : 8,
        height: '100%',
        width: '100%',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      {/* Header band — mirrors the transcript shell so the structured tab frames the
          same (FR-023). Labeled by source so the projection's origin is unambiguous. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontFamily: 'var(--cth-font-ui)',
          fontSize: 13,
          color: 'var(--cth-ink-500)',
          borderBottom: '1px dashed var(--cth-ink-300)',
          paddingBottom: 4,
          marginBottom: 4,
          paddingLeft: embedded ? 8 : 0,
          paddingRight: embedded ? 8 : 0,
          paddingTop: embedded ? 6 : 0
        }}
      >
        structured · {sourceLabel} · {agentId}
      </div>

      <div
        role="region"
        aria-label="structured run view"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          fontFamily: 'var(--cth-font-mono)',
          fontSize: 14,
          lineHeight: '20px',
          color: 'var(--cth-ink-900)',
          padding: '4px 8px 8px'
        }}
      >
        {/* Run-level token usage — the per-run cumulative figure (FR-036). */}
        <RunUsageBar usage={view.runTokenUsage} />

        {/* Inline notices — the SAME degradation/api-error notices the transcript
            carries (FR-007/FR-019). For a native desk these are threaded straight off
            the shared fold (`view.notices`, no re-fold — FR-034); for Claude they are
            derived from telemetry api_error spans. Rendered with the SAME label/accent/
            count treatment as the transcript's `NoticeRow`, persistent inline feed
            entries (never toasts, FR-020). They never abort the run (FR-008). */}
        <NoticeList notices={view.notices} />

        {empty ? (
          <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-500)', padding: 8 }}>
            {loading
              ? 'Loading run…'
              : 'No structured activity yet — no turns or tool calls have been recorded.'}
          </div>
        ) : (
          view.turns.map((turn) => <TurnBlock key={turn.index} turn={turn} />)
        )}
      </div>
    </div>
  );
}

// ── Run-level token usage band ──────────────────────────────────────────────

/** The per-run cumulative token usage (FR-036) — display passthrough (FR-012). */
function RunUsageBar({ usage }: { usage: TokenUsage | null }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 14,
        flexWrap: 'wrap',
        alignItems: 'baseline',
        padding: '4px 8px',
        marginBottom: 6,
        background: 'var(--cth-cream-100)',
        boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
        fontFamily: 'var(--cth-font-mono)',
        fontSize: 12
      }}
    >
      <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-500)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        run
      </span>
      <TokenUsageInline usage={usage} />
    </div>
  );
}

// ── Inline notices (T032, FR-007/FR-019/FR-020) ─────────────────────────────
// The SAME notice treatment as `NativeTranscriptView.NoticeRow`: a bordered, accented,
// labeled container that is visually DISTINCT from the tool-call/turn content, exposed
// to assistive technology (`role="status"`), and carries the repeat `count` when the
// fold collapsed consecutive duplicates (FR-019). Persistent inline feed entries (not
// toasts, FR-020). Kept structurally parallel to the transcript so the two views read
// the same for the same notice.

function NoticeList({ notices }: { notices: TranscriptEntry[] }) {
  if (notices.length === 0) return null;
  return (
    <div style={{ marginBottom: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
      {notices.map((n) => (
        <NoticeRow key={n.id} entry={n} />
      ))}
    </div>
  );
}

/** Accent colour per notice category — kept in sync with the transcript's `NoticeRow`. */
function noticeAccent(kind: NoticeKind): string {
  return kind === 'api-error'
    ? 'var(--cth-coral)'
    : kind === 'needs-input'
    ? 'var(--cth-status-waiting)'
    : 'var(--cth-peach)';
}

/** Category label — for api-error it distinguishes RETRYABLE vs TERMINAL where the flag
 *  is known (FR-008), matching the transcript's wording exactly. */
function noticeLabel(entry: TranscriptEntry): string {
  const kind = entry.noticeKind ?? 'degradation';
  if (kind === 'api-error') {
    return entry.retryable === true
      ? 'api error · retryable'
      : entry.retryable === false
      ? 'api error · terminal'
      : 'api error';
  }
  if (kind === 'needs-input') return 'needs input';
  return 'capability degraded';
}

/** ARIA live-region role for an inline notice (T034, FR-025) — IDENTICAL to the
 *  transcript's `noticeAriaRole`: a TERMINAL api-error (`retryable === false`) is
 *  critical/blocking → `role="alert"` (assertive); every other notice is non-critical →
 *  `role="status"` (polite). So the structured tab announces a notice the SAME way the
 *  transcript does (FR-020 consistency). */
function noticeAriaRole(entry: TranscriptEntry): 'alert' | 'status' {
  return entry.noticeKind === 'api-error' && entry.retryable === false ? 'alert' : 'status';
}

function NoticeRow({ entry }: { entry: TranscriptEntry }) {
  const kind = entry.noticeKind ?? 'degradation';
  const accent = noticeAccent(kind);
  const label = noticeLabel(entry);
  const count = entry.count ?? 1;
  return (
    <div
      role={noticeAriaRole(entry)}
      style={{
        fontFamily: 'var(--cth-font-ui)',
        fontSize: 13,
        background: 'var(--cth-cream-100)',
        boxShadow: `inset 2px 0 0 ${accent}, inset 0 0 0 1px var(--cth-ink-300)`,
        padding: '4px 8px'
      }}
    >
      <span style={{ color: accent, textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: 11, marginRight: 6 }}>
        {label}
      </span>
      <span style={{ color: 'var(--cth-ink-900)' }}>{entry.message}</span>
      {count > 1 && (
        <span
          aria-label={`repeated ${count} times`}
          style={{
            marginLeft: 6,
            fontSize: 11,
            color: 'var(--cth-ink-500)',
            background: 'var(--cth-paper-200)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
            padding: '0 4px'
          }}
        >
          ×{count}
        </span>
      )}
    </div>
  );
}

// ── One turn: tool calls + per-turn token usage ─────────────────────────────

function TurnBlock({ turn }: { turn: StructuredTurn }) {
  const interrupted = turn.status === 'interrupted';
  return (
    <div
      style={{
        marginBottom: 10,
        boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
        background: 'var(--cth-paper-200)'
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
          flexWrap: 'wrap',
          padding: '4px 8px',
          background: 'var(--cth-cream-200)',
          boxShadow: 'inset 0 -1px 0 var(--cth-ink-300)'
        }}
      >
        <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-500)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          turn {turn.index + 1}
        </span>
        <TurnStatusBadge status={turn.status} />
        <span style={{ color: 'var(--cth-ink-300)', fontSize: 12 }}>
          {turn.toolCalls.length} tool call{turn.toolCalls.length === 1 ? '' : 's'}
        </span>
      </div>

      <div style={{ padding: '4px 8px' }}>
        {turn.toolCalls.length === 0 ? (
          <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-300)', padding: '2px 0' }}>
            no tool calls in this turn
          </div>
        ) : (
          turn.toolCalls.map((call) => <ToolCallRow key={call.toolCallId} call={call} />)
        )}

        {/* Per-turn token usage = the cumulative sample at this turn's close (FR-036).
            null ⇒ "no usage reported" (never a fabricated 0). */}
        <div
          style={{
            marginTop: 6,
            paddingTop: 4,
            borderTop: '1px dashed var(--cth-ink-300)',
            display: 'flex',
            gap: 12,
            flexWrap: 'wrap',
            alignItems: 'baseline'
          }}
        >
          <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-500)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            tokens
          </span>
          <TokenUsageInline usage={turn.tokenUsage} />
        </div>
      </div>

      {interrupted && (
        <div
          role="status"
          style={{
            padding: '2px 8px 4px',
            fontFamily: 'var(--cth-font-ui)',
            fontSize: 11,
            color: 'var(--cth-status-blocked)'
          }}
        >
          turn interrupted before it closed
        </div>
      )}
    </div>
  );
}

/** One tool call row — name, status, duration, then input/output payload lines. The
 *  fold already produced display-truncated `TruncatedPayload`s (FR-029); we render
 *  `.display` + a truncation indicator and NEVER re-truncate the raw payload. */
function ToolCallRow({ call }: { call: StructuredToolCall }) {
  const failed = call.status === 'resolved' && call.success === false;
  const badge =
    call.status === 'pending'
      ? { text: 'running…', color: 'var(--cth-status-working)' }
      : call.status === 'interrupted'
      ? { text: 'interrupted', color: 'var(--cth-status-blocked)' }
      : failed
      ? { text: 'failed', color: 'var(--cth-coral)' }
      : { text: 'ok', color: 'var(--cth-mint)' };

  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
        padding: '3px 0',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word'
      }}
    >
      <span style={{ color: 'var(--cth-sky)', width: 18, flexShrink: 0, textAlign: 'center', userSelect: 'none' }} aria-hidden>
        ⚙
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--cth-ink-900)', fontWeight: 600 }}>{call.name}</span>
          <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: badge.color }}>
            {badge.text}
          </span>
          {call.status === 'resolved' && call.durationMs !== undefined && (
            <span style={{ color: 'var(--cth-ink-300)', fontSize: 12 }}>· {fmtDur(call.durationMs)}</span>
          )}
        </div>
        {(() => {
          // Human-readable summary line (same vocabulary as the transcript), shown only
          // when it adds something beyond the raw tool name already rendered above.
          const line = toolSummaryLine(call.name, call.input.full);
          if (!line || line === call.name) return null;
          return (
            <div style={{ color: 'var(--cth-ink-500)', fontSize: 13, marginTop: 1 }}>
              {line.length > 100 ? `${line.slice(0, 100)}…` : line}
            </div>
          );
        })()}
        <PayloadLine label="in" payload={call.input} />
        {call.output && <PayloadLine label="out" payload={call.output} error={failed} />}
      </div>
    </div>
  );
}

/** One labeled, display-truncated payload line (tool input/output). The view-model's
 *  payload is already display-truncated (FR-029) — render `.display`, surface the
 *  full-size affordance from `fullBytes`, and keep the full payload retained. */
function PayloadLine({
  label,
  payload,
  error
}: {
  label: string;
  payload?: TruncatedPayload;
  error?: boolean;
}) {
  if (!payload) return null;
  const text = displayString(payload.display);
  // An empty placeholder input (Claude spans carry none) renders nothing for `in`.
  if (label === 'in' && text.length === 0 && !payload.truncated) return null;
  return (
    <div style={{ marginTop: 2, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
      <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-300)', flexShrink: 0, width: 22, textTransform: 'uppercase' }}>
        {label}
      </span>
      <span style={{ flex: 1, minWidth: 0, color: error ? 'var(--cth-coral)' : 'var(--cth-ink-500)' }}>
        {text}
        {payload.truncated && (
          <span style={{ color: 'var(--cth-ink-300)', fontFamily: 'var(--cth-font-ui)', fontSize: 11 }}>
            {' '}
            ({fmtBytes(payload.fullBytes)} total)
          </span>
        )}
      </span>
    </div>
  );
}

/** Inline token-usage figures — display passthrough (FR-012). `null` ⇒ "no usage
 *  reported" (never a fabricated 0). `usd: null` ⇒ unpriced marker (never `$0`). */
function TokenUsageInline({ usage }: { usage: TokenUsage | null }) {
  if (!usage) {
    return <span style={{ color: 'var(--cth-ink-300)' }}>no usage reported</span>;
  }
  return (
    <>
      <span style={{ color: 'var(--cth-ink-700)' }}>in {fmtTokens(usage.input)}</span>
      <span style={{ color: 'var(--cth-ink-700)' }}>out {fmtTokens(usage.output)}</span>
      <span style={{ color: 'var(--cth-sky)' }}>cache {fmtTokens(usage.cacheRead)}</span>
      <span style={{ color: 'var(--cth-ink-500)' }}>create {fmtTokens(usage.cacheCreation)}</span>
      <span style={{ color: 'var(--cth-ink-900)', fontWeight: 600 }}>
        {usage.usd != null ? `$${usage.usd.toFixed(2)}` : '$— unpriced'}
      </span>
      {usage.model && <span style={{ color: 'var(--cth-ink-500)' }}>{usage.model}</span>}
    </>
  );
}

/** Status badge for a turn. */
function TurnStatusBadge({ status }: { status: EntryStatus }) {
  const map: Record<EntryStatus, { text: string; color: string }> = {
    pending: { text: 'in progress', color: 'var(--cth-status-working)' },
    resolved: { text: 'done', color: 'var(--cth-mint)' },
    interrupted: { text: 'interrupted', color: 'var(--cth-status-blocked)' }
  };
  const badge = map[status];
  return (
    <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: badge.color, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
      {badge.text}
    </span>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Truncation (T028, FR-029) — reuses the fold's threshold/indicator for parity.
// For the NATIVE source the fold already produced `TruncatedPayload`s, so this only
// runs for the Claude telemetry derivation (whose payloads are not fold-produced).
// ────────────────────────────────────────────────────────────────────────────

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

/** Serialize an arbitrary payload to a string for measurement + preview, throw-free
 *  (mirrors the fold's `serializeForDisplay`). */
function serializeForDisplay(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

/** Build a `TruncatedPayload` using the SAME threshold + indicator as the fold (FR-029)
 *  so the Claude branch truncates identically to the native transcript. Display only —
 *  `full` retains the complete original. */
function truncateForDisplay(value: unknown, limitBytes: number): TruncatedPayload {
  const serialized = serializeForDisplay(value);
  const encoder = textEncoder();
  const bytes = encoder.encode(serialized);
  const fullBytes = bytes.length;
  if (fullBytes <= limitBytes) {
    return { truncated: false, display: value, full: value, fullBytes };
  }
  const indicatorBytes = encoder.encode(TRUNCATION_INDICATOR).length;
  const budget = Math.max(0, limitBytes - indicatorBytes);
  const slice = bytes.subarray(0, budget);
  let preview = textDecoder().decode(slice);
  if (preview.endsWith('�')) preview = preview.slice(0, -1);
  return { truncated: true, display: preview + TRUNCATION_INDICATOR, full: value, fullBytes };
}

// ── Small formatting helpers (match the transcript's affordances) ───────────

/** Render a (possibly non-string) display payload as text. */
function displayString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function fmtDur(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
