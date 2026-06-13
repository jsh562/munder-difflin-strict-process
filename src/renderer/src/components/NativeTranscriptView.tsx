import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import type { CSSProperties } from 'react';
import { useNativeAgentEvents } from '@/hooks/useNativeAgentEvents';
import type { TranscriptEntry, TruncatedPayload } from './foldEvents';
import { STICK_THRESHOLD, buildOffsets, visibleRange } from './transcriptWindow';
import { summarizeTool } from './toolSummary';

/**
 * E008 / T016–T018 — the synthesized terminal transcript for a NATIVE agent desk
 * (DeepSeek/Minimax). It consumes the folded `AgentEvent` view-models from
 * `useNativeAgentEvents(agentId)` and draws them as an incrementally-appending,
 * terminal-styled transcript inside the SAME container framing/typography as the
 * Claude `PtyTerminalView` (visual parity, ADR-0010/AD-001) — but it is a pure
 * React/DOM component. It NEVER touches xterm/`terminalPool`: the Claude PTY path
 * stays untouched (FR-009/HINT-002).
 *
 * What this component is responsible for (by task):
 *   T016 (FR-001/FR-002/FR-018) — incremental append keyed by stable `entry.id` so a
 *     streamed text delta never re-mounts/re-lays-out prior entries and never
 *     clears-and-redraws the list; an in-progress streaming indicator that appears
 *     BEFORE the first text token of a turn and CLEARS when the turn settles.
 *   T017 (FR-003/FR-004/FR-017) — each category (assistant-text / tool-call /
 *     thinking / notice) gets a concrete observable affordance: a label/glyph + a
 *     consistent indent/container. Thinking is DEFAULT-COLLAPSED with a keyboard-
 *     focusable toggle. A tool-call renders pending→resolved in place with
 *     success/failure + duration.
 *   T018 (FR-010/FR-024/FR-027) — virtualization: only the entries in the visible
 *     window (+ a small overscan) are mounted as DOM nodes; the FULL run is retained
 *     in the hook's data (no eviction). Stick-to-bottom auto-follows the newest
 *     content ONLY while the operator is already at the bottom.
 *
 * The render-frequency coalescing (≤1 fold/commit per animation frame, FR-026/FR-028)
 * lives in the hook (T019), so this component simply renders whatever folded view it
 * is handed; bursts are already batched upstream.
 *
 * (Inline notices already fold into the `entries` as `type: 'notice'` and render here
 * via `NoticeRow`; T031 hardens their retryable-vs-terminal styling on top of this.)
 */

export interface NativeTranscriptViewProps {
  /** The native agent whose run to subscribe + replay + render. */
  agentId: string;
  /** Edge-to-edge mode for the sidebar tab: no outer chrome/border (mirrors
   *  `PtyTerminalView`'s `embedded` so the host panel frames both views the same). */
  embedded?: boolean;
}

// ── Virtualization tuning ───────────────────────────────────────────────────
// The windowing constants (ESTIMATED_ROW_HEIGHT, OVERSCAN, STICK_THRESHOLD) and the pure
// range math (buildOffsets, visibleRange) live in `./transcriptWindow` so the O(visible)
// bounding can be unit-tested in the node Vitest env without a DOM (T036/FR-027). This
// component is the DOM shell that drives those helpers; only STICK_THRESHOLD is read
// here directly (in the scroll handler), the rest are consumed by the helpers.

/**
 * The synthesized native transcript view.
 *
 * @param agentId the native agent to render.
 * @param embedded edge-to-edge (no outer chrome), for the sidebar host.
 */
export function NativeTranscriptView({ agentId, embedded }: NativeTranscriptViewProps) {
  const { entries, loading, structured } = useNativeAgentEvents(agentId);

  // A turn is "in progress" while its fold status is still `pending` (turn-start seen,
  // no turn-end/stop yet). The fold opens a pending turn at `turn-start` — BEFORE any
  // text delta — and resolves it at `turn-end`/`stop`, so this flag rises before the
  // first visible token and clears the moment the turn settles (FR-018).
  const streaming = useMemo(
    () => structured.turns.some((t) => t.status === 'pending'),
    [structured.turns]
  );

  return (
    <TranscriptShell embedded={embedded} agentId={agentId} streaming={streaming}>
      <VirtualizedTranscript
        entries={entries}
        streaming={streaming}
        emptyHint={emptyHintFor(loading, entries.length)}
      />
    </TranscriptShell>
  );
}

/** The outer terminal frame + header band — mirrors `PtyTerminalView`'s chrome so the
 *  native desk reads with the same parity (FR-023). The header is labeled "native"
 *  (not "pty") so the synthesized transcript is never mistaken for authentic bytes. */
function TranscriptShell({
  embedded,
  agentId,
  streaming,
  children
}: {
  embedded?: boolean;
  agentId: string;
  streaming: boolean;
  children: React.ReactNode;
}) {
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
        <span
          style={{
            width: 8,
            height: 8,
            background: streaming ? 'var(--cth-mint)' : 'var(--cth-ink-300)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)',
            animation: streaming ? 'cth-pulse 1200ms steps(2, end) infinite' : 'none'
          }}
        />
        native · {agentId}
      </div>
      {children}
    </div>
  );
}

/**
 * The virtualized, stick-to-bottom scroll region (T018).
 *
 * Windowing: we keep a per-entry measured-height map keyed by stable `entry.id`. Row
 * offsets are the running prefix-sum of those heights (unmeasured rows fall back to
 * `ESTIMATED_ROW_HEIGHT`); from `scrollTop`/`clientHeight` we find the first/last
 * visible row index and mount ONLY `[first-OVERSCAN, last+OVERSCAN]`, with a top/
 * bottom spacer reserving the off-screen height. So the mounted DOM-node count is
 * O(visible), independent of total run length (FR-010/FR-027) — the full run stays
 * retained in `entries` (no eviction).
 *
 * Stick-to-bottom (FR-024): a ref tracks whether the operator is currently pinned to
 * the bottom (within `STICK_THRESHOLD`). When new content grows the list we re-pin to
 * the bottom ONLY if they were already pinned; if they scrolled up we leave their
 * `scrollTop` exactly where it is (no forced auto-scroll).
 */
function VirtualizedTranscript({
  entries,
  streaming,
  emptyHint
}: {
  entries: TranscriptEntry[];
  streaming: boolean;
  emptyHint: string | null;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Measured row heights keyed by stable entry id (survives re-folds because the id is
  // derived deterministically in `foldEvents`). A `ref` (not state) so a measurement
  // never itself triggers a render loop; we bump `measureTick` only when a height
  // actually changes, to recompute the window.
  const heightsRef = useRef<Map<string, number>>(new Map());
  const [measureTick, setMeasureTick] = useState(0);

  // Whether the operator is pinned to the bottom right now. A ref so the scroll
  // handler reads/writes it without re-rendering; initialized true so a fresh panel
  // follows the stream until the operator scrolls up.
  const atBottomRef = useRef(true);

  // Viewport geometry, refreshed on scroll + resize. Held in state so the visible
  // window recomputes when either changes.
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 });

  // ── Row offsets: prefix-sum of (measured | estimated) heights ──
  // offsets[i] = top px of row i; offsets[n] = total content height. Recomputed when
  // the entry list or any measured height changes (cheap O(n); n is the full run, but
  // this is arithmetic over numbers, not DOM — the MOUNTED nodes stay O(visible)). The
  // prefix-sum math is the pure `buildOffsets` (unit-tested in T036).
  const offsets = useMemo(
    () => buildOffsets(entries, heightsRef.current),
    // measureTick participates so a height change re-derives offsets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entries, measureTick]
  );

  const totalHeight = offsets[entries.length] ?? 0;

  // ── Visible window via binary search over the prefix-sum offsets ──
  // The pure `visibleRange` returns the bounded `[first, last]` (viewport + overscan)
  // independent of total entry count — the O(visible) guarantee unit-tested in T036.
  const { first, last } = useMemo(
    () => visibleRange(offsets, entries.length, viewport.scrollTop, viewport.height),
    [entries.length, offsets, viewport]
  );

  // ── Scroll handler: refresh geometry + re-evaluate the pinned-to-bottom flag ──
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottomRef.current = distanceFromBottom <= STICK_THRESHOLD;
    setViewport({ scrollTop: el.scrollTop, height: el.clientHeight });
  }, []);

  // Track container resize so the visible window + pinned flag stay correct when the
  // panel is resized (e.g. fullscreen toggle, sidebar splitter drag).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      setViewport({ scrollTop: el.scrollTop, height: el.clientHeight });
    });
    ro.observe(el);
    // Prime the initial geometry once mounted.
    setViewport({ scrollTop: el.scrollTop, height: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // ── Stick-to-bottom: after content/height changes, re-pin ONLY if already pinned ──
  // Runs in a layout effect so the scroll position is corrected before the browser
  // paints (no visible jump). If the operator had scrolled up, we touch nothing.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight; // follow the newest content
    }
    // Re-derive geometry so the window reflects the new (possibly auto-scrolled) top.
    setViewport({ scrollTop: el.scrollTop, height: el.clientHeight });
    // Re-pin whenever the run grows or the in-progress indicator toggles height.
  }, [totalHeight, entries.length, streaming]);

  // ── Row measurement callback ref: record real heights as rows mount ──
  // Called by each mounted row with its id + DOM node; if the measured height differs
  // from what we have, store it and bump `measureTick` to recompute offsets/window.
  const measureRow = useCallback((id: string, node: HTMLElement | null) => {
    if (!node) return;
    const h = node.getBoundingClientRect().height;
    if (h <= 0) return;
    const prev = heightsRef.current.get(id);
    if (prev === undefined || Math.abs(prev - h) > 0.5) {
      heightsRef.current.set(id, h);
      setMeasureTick((t) => t + 1);
    }
  }, []);

  const slice = entries.slice(first, last + 1);
  const padTop = offsets[first] ?? 0;
  const padBottom = Math.max(0, totalHeight - (offsets[last + 1] ?? totalHeight));

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      role="log"
      aria-live="polite"
      aria-busy={streaming || undefined}
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
      {emptyHint !== null ? (
        <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-500)', padding: 8 }}>
          {emptyHint}
        </div>
      ) : (
        <>
          {/* Top spacer reserves the height of the rows scrolled off above. */}
          <div style={{ height: padTop }} aria-hidden />
          {slice.map((entry) => (
            <MeasuredRow key={entry.id} id={entry.id} measure={measureRow}>
              <TranscriptRow entry={entry} />
            </MeasuredRow>
          ))}
          {/* Bottom spacer reserves the height of the rows scrolled off below. */}
          <div style={{ height: padBottom }} aria-hidden />
          {/* In-progress indicator: rendered at the tail BEFORE any text of a still-
              open turn appears, cleared when the turn settles (FR-018). It is NOT a
              virtualized entry, so appending real entries never re-mounts it. */}
          {streaming && <StreamingIndicator />}
        </>
      )}
    </div>
  );
}

/** Wraps a row in a measuring container that reports its real rendered height back to
 *  the virtualizer via the `measure` callback ref. The callback fires on mount and on
 *  every content change of the row (e.g. a coalesced text delta growing the block). */
function MeasuredRow({
  id,
  measure,
  children
}: {
  id: string;
  measure: (id: string, node: HTMLElement | null) => void;
  children: React.ReactNode;
}) {
  const ref = useCallback(
    (node: HTMLElement | null) => measure(id, node),
    [id, measure]
  );
  // Re-measure when the row's content changes height without a remount (the same id
  // staying mounted while its text grows). A layout effect reads the post-paint size.
  const elRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (elRef.current) measure(id, elRef.current);
  });
  return (
    <div
      ref={(node) => {
        elRef.current = node;
        ref(node);
      }}
    >
      {children}
    </div>
  );
}

// ── Category affordances (T017, FR-003/FR-017) ──────────────────────────────
// Each category gets a glyph + a label + a consistent indent/container so an operator
// can identify it on inspection (FR-017). Glyphs are plain monospace marks (the design
// uses ASCII/box marks throughout the terminal aesthetic) — no icon font needed.

/** Common indent for an entry's body so all categories align under their gutter mark. */
const ENTRY_INDENT = 18;

const rowBase: CSSProperties = {
  display: 'flex',
  gap: 8,
  padding: '2px 0',
  alignItems: 'flex-start',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word'
};

const gutter: CSSProperties = {
  width: ENTRY_INDENT,
  flexShrink: 0,
  textAlign: 'center',
  userSelect: 'none'
};

/** Dispatch one folded entry to its category renderer. A stable wrapper keeps the
 *  per-category container/indent consistent. */
function TranscriptRow({ entry }: { entry: TranscriptEntry }) {
  switch (entry.type) {
    case 'assistant-text':
      return <AssistantTextRow entry={entry} />;
    case 'thinking':
      return <ThinkingRow entry={entry} />;
    case 'tool-call':
      return <ToolCallRow entry={entry} />;
    case 'notice':
      return <NoticeRow entry={entry} />;
    case 'turn-divider':
      return <TurnDividerRow entry={entry} />;
    default:
      return null;
  }
}

/** A subtle "turn N" separator so the flat transcript reads as grouped turns. */
function TurnDividerRow({ entry }: { entry: TranscriptEntry }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0 2px' }}>
      <span
        style={{
          fontFamily: 'var(--cth-font-ui)',
          fontSize: 11,
          color: 'var(--cth-ink-300)',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          userSelect: 'none'
        }}
      >
        turn {entry.turnIndex}
      </span>
      <span style={{ flex: 1, height: 1, background: 'var(--cth-ink-300)' }} aria-hidden />
    </div>
  );
}

/** Assistant answer text — the default, unadorned terminal output. Glyph `›`. */
function AssistantTextRow({ entry }: { entry: TranscriptEntry }) {
  return (
    <div style={rowBase}>
      <span style={{ ...gutter, color: 'var(--cth-ink-300)' }} aria-hidden>
        ›
      </span>
      <span style={{ flex: 1, color: 'var(--cth-ink-900)' }}>{entry.text}</span>
    </div>
  );
}

/** Thinking — a DEFAULT-COLLAPSED, labeled, keyboard-focusable block (FR-017). The
 *  toggle is a real <button> so it is tab-focusable and Enter/Space activatable now
 *  (T034 hardens the rest of a11y). The fold always hands us `collapsed: true`, so
 *  the operator's expansion is local component state keyed by entry id. */
function ThinkingRow({ entry }: { entry: TranscriptEntry }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div style={rowBase}>
      <span style={{ ...gutter, color: 'var(--cth-lilac)' }} aria-hidden>
        ✲
      </span>
      <div style={{ flex: 1 }}>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            background: 'transparent',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            fontFamily: 'var(--cth-font-ui)',
            fontSize: 12,
            color: 'var(--cth-lilac)',
            textTransform: 'uppercase',
            letterSpacing: '0.04em'
          }}
        >
          <span aria-hidden>{expanded ? '▾' : '▸'}</span>
          thinking
          {!expanded && (
            <span style={{ color: 'var(--cth-ink-300)', textTransform: 'none', letterSpacing: 0 }}>
              ({thinkingPreview(entry.text)})
            </span>
          )}
        </button>
        {expanded && (
          <div
            style={{
              marginTop: 2,
              color: 'var(--cth-ink-500)',
              fontStyle: 'italic',
              borderLeft: '2px solid var(--cth-lilac-light)',
              paddingLeft: 8
            }}
          >
            {entry.text}
          </div>
        )}
      </div>
    </div>
  );
}

/** A tool call rendered as a collapsible CARD (FR-004) — a human-readable header
 *  ("Ran `find …` ✓ 68ms") that is always visible, over a collapsible body holding the
 *  raw tool name + in/out payloads. Default-collapsed for ok calls (so the narrative
 *  reads cleanly); a FAILURE auto-expands so the error is visible without a click. The
 *  same entry id stays mounted across pending→resolved, so it never re-mounts/relocates;
 *  the header swaps its status glyph/label in place. */
function ToolCallRow({ entry }: { entry: TranscriptEntry }) {
  const status = entry.status;
  const failed = status === 'resolved' && entry.success === false;
  const { verb, detail } = summarizeTool(entry.toolName ?? '', entry.toolInput?.full);
  const detailLine = detail.replace(/\s+/g, ' ').trim();
  const detailShort = detailLine.length > 90 ? `${detailLine.slice(0, 90)}…` : detailLine;

  const icon = status === 'pending' ? '⟳' : status === 'interrupted' ? '⊘' : failed ? '✗' : '✓';
  const accent =
    status === 'pending'
      ? 'var(--cth-status-working)'
      : status === 'interrupted'
      ? 'var(--cth-status-blocked)'
      : failed
      ? 'var(--cth-coral)'
      : 'var(--cth-mint)';
  const statusText = status === 'pending' ? 'running…' : status === 'interrupted' ? 'interrupted' : failed ? 'failed' : 'ok';

  // Collapsed by default; a failure auto-expands. Because the entry stays mounted across
  // pending→resolved, a live transition INTO failed must flip the toggle too (useState's
  // initial value alone wouldn't), so an effect opens it on the failing edge.
  const [expanded, setExpanded] = useState(failed);
  const wasFailed = useRef(failed);
  useEffect(() => {
    if (failed && !wasFailed.current) setExpanded(true);
    wasFailed.current = failed;
  }, [failed]);

  return (
    <div style={rowBase}>
      <span style={{ ...gutter, color: accent }} aria-hidden>
        {icon}
      </span>
      <div style={{ flex: 1, minWidth: 0, borderLeft: `2px solid ${accent}`, paddingLeft: 8 }}>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 6,
            flexWrap: 'wrap',
            width: '100%',
            background: 'transparent',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            textAlign: 'left',
            font: 'inherit',
            color: 'var(--cth-ink-900)'
          }}
        >
          <span style={{ fontWeight: 600 }}>{verb}</span>
          {detailShort && <span style={{ color: 'var(--cth-ink-700)' }}>{detailShort}</span>}
          <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: accent }}>
            {statusText}
            {status === 'resolved' && entry.durationMs !== undefined && (
              <span style={{ color: 'var(--cth-ink-300)' }}> · {fmtDur(entry.durationMs)}</span>
            )}
          </span>
          <span aria-hidden style={{ color: 'var(--cth-ink-300)', fontSize: 12 }}>
            {expanded ? '▾' : '▸'}
          </span>
        </button>
        {expanded && (
          <div style={{ marginTop: 2 }}>
            <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-300)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              {entry.toolName}
            </div>
            <PayloadLine label="in" payload={entry.toolInput} />
            {entry.result && <PayloadLine label="out" payload={entry.result} error={failed} />}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Inline notice — degradation / api-error / needs-input (T031, FR-007/FR-008/FR-019).
 *
 * Hardening this task adds on top of the existing bordered/labeled row:
 *   - api-error distinguishes RETRYABLE vs TERMINAL from `entry.retryable` (FR-008):
 *     `true` → "api error · retryable", `false` → "api error · terminal", unknown
 *     (`undefined`) → plain "api error" (we never claim a severity the event didn't
 *     carry). A retryable error is tinted as a warning (recoverable); a terminal one
 *     uses the harder coral error accent.
 *   - a capability-degradation notice STATES WHAT DEGRADED — the upstream message is
 *     the "what" (E006/ADR-0008 owns the decision; we render its text verbatim) under
 *     a clear "capability degraded" label.
 *   - when the fold COLLAPSED consecutive duplicates it carries `entry.count`; we
 *     surface "×N" so repeats are visible without flooding (FR-019).
 *
 * It is ALWAYS inline, non-modal, visually distinct from assistant content (a bordered,
 * accented container with its own gutter mark + uppercase category label), exposed to
 * assistive technology, and it NEVER aborts the transcript — the stream keeps appending
 * entries after it (FR-008). Kept in sync with the structured tab's `NoticeRow` (same
 * labels/accents/count) so both views read the same.
 *
 * AT exposure (T034, FR-025/SC-014): a TERMINAL api-error (`retryable === false`) is the
 * one critical/blocking notice, so it is announced ASSERTIVELY via `role="alert"`; every
 * other notice (a recoverable/retryable api-error, a capability degradation, a
 * needs-input prompt) is non-critical and announced POLITELY via `role="status"`. So an
 * AT user hears the error/degradation even though it is visually inline, and a hard
 * terminal error interrupts politely-queued speech while a soft degradation does not. */
function NoticeRow({ entry }: { entry: TranscriptEntry }) {
  const kind = entry.noticeKind ?? 'degradation';
  // A retryable api-error is recoverable → warning accent; a terminal/unknown one keeps
  // the harder error accent. needs-input + degradation keep their own accents.
  const accent =
    kind === 'api-error'
      ? entry.retryable === true
        ? 'var(--cth-status-waiting)'
        : 'var(--cth-coral)'
      : kind === 'needs-input'
      ? 'var(--cth-status-waiting)'
      : 'var(--cth-peach)';
  const label = noticeLabel(entry);
  const count = entry.count ?? 1;
  return (
    <div style={{ ...rowBase, padding: '4px 0' }}>
      <span style={{ ...gutter, color: accent }} aria-hidden>
        !
      </span>
      <div
        role={noticeAriaRole(entry)}
        style={{
          flex: 1,
          minWidth: 0,
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
    </div>
  );
}

/** ARIA live-region role for an inline notice (T034, FR-025). A TERMINAL api-error
 *  (`retryable === false`) is critical/blocking → `role="alert"` (assertive: it
 *  interrupts other queued speech). Every other notice (retryable/unknown api-error,
 *  capability degradation, needs-input) is non-critical → `role="status"` (polite).
 *  Kept identical to the structured tab's `noticeAriaRole` so both views announce the
 *  same way for the same notice. */
function noticeAriaRole(entry: TranscriptEntry): 'alert' | 'status' {
  return entry.noticeKind === 'api-error' && entry.retryable === false ? 'alert' : 'status';
}

/** Category label for an inline notice. For api-error it distinguishes RETRYABLE vs
 *  TERMINAL where `entry.retryable` is known (FR-008); a capability-degradation notice
 *  reads "capability degraded" (the message states the specifics). Kept identical to the
 *  structured tab's label so the two views are consistent. */
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

/** One labeled, display-truncated payload line (tool input/output). The fold already
 *  truncated for display (FR-029); we render `display` and surface the truncation
 *  size affordance from `fullBytes`. */
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
  return (
    <div style={{ marginTop: 2, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
      <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-300)', flexShrink: 0, width: 22, textTransform: 'uppercase' }}>
        {label}
      </span>
      <span style={{ flex: 1, minWidth: 0, color: error ? 'var(--cth-coral)' : 'var(--cth-ink-500)' }}>
        {displayString(payload.display)}
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

/** The trailing in-progress indicator (FR-018). A blinking caret-style mark + label,
 *  rendered AFTER the last entry while a turn is still open. Not a virtualized entry,
 *  so it never participates in row measurement/re-mounting. */
function StreamingIndicator() {
  return (
    <div
      style={{ ...rowBase, color: 'var(--cth-ink-500)' }}
      role="status"
      aria-label="agent is working"
    >
      <span style={{ ...gutter, color: 'var(--cth-mint)' }} aria-hidden>
        ▌
      </span>
      <span
        style={{
          fontFamily: 'var(--cth-font-ui)',
          fontSize: 12,
          color: 'var(--cth-ink-500)',
          letterSpacing: '0.04em'
        }}
      >
        working
        <span style={{ animation: 'cth-blink 800ms steps(2, end) infinite' }}>…</span>
      </span>
    </div>
  );
}

// ── Small formatting helpers ────────────────────────────────────────────────

/** Empty/loading hint, or `null` when there are real entries to render. */
function emptyHintFor(loading: boolean, count: number): string | null {
  if (count > 0) return null;
  if (loading) return 'Loading run…';
  return 'No activity yet — this native desk has not emitted any events.';
}

/** Short single-line preview of a collapsed thinking block. */
function thinkingPreview(text: string | undefined): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length === 0) return 'collapsed';
  return t.length > 48 ? `${t.slice(0, 48)}…` : t;
}

/** Render a (possibly non-string) display payload as text. The fold's `display` is the
 *  original value when not truncated; stringify non-strings for the terminal line. */
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
