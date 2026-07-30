import { useEffect, useRef, useState } from 'react';
import type { AgentEvent } from '@shared/agentEvent';
import {
  foldEvents,
  type TranscriptEntry,
  type StructuredRunView
} from '@/components/foldEvents';

/**
 * E008 / T011 — the renderer subscription hook for a native agent's normalized
 * `AgentEvent` stream (FR-001/FR-039/FR-042/FR-022).
 *
 * Lifecycle on mount (and on every `agentId` change):
 *   1. BACKFILL — replay the agent's PERSISTED run log via
 *      `cth.loadNativeEvents(agentId)` (FR-042). This is the durable re-open path:
 *      after a panel close/reopen or an app restart the full prior run is rebuilt
 *      from the JSONL the main bridge committed (T026 verifies this).
 *   2. SUBSCRIBE — attach `cth.onAgentEvent(agentId, cb)` for LIVE events the
 *      bridge forwards AFTER the backfill (FR-001). Subscription is opened BEFORE
 *      the backfill resolves so no event that lands mid-backfill is lost; live
 *      events are buffered and merged in once the backfill array is in place.
 *
 * Replay == live determinism (FR-039): both the replayed and the live events are
 * accumulated into ONE `AgentEvent[]` and that SAME array is fed through the SAME
 * pure `foldEvents(...)`. The fold is the single source of the view-models, so a
 * "replay then live" sequence reconstructs the identical transcript a purely-live
 * fold would — there is no separate live/replay code path here.
 *
 * Mid-stream framing (FR-011/FR-033): while the run is still streaming we fold with
 * `streamEnded: false`, so open tool calls stay `pending` (NOT `interrupted`) and an
 * in-progress turn stays open. `foldEvents` itself flips to end-of-stream resolution
 * the moment a terminal `stop` event appears in the accumulated array, so the caller
 * does not have to detect completion — passing `false` is always safe.
 *
 * This hook runs in the RENDERER: it touches `window.cth` + React only, with NO
 * node/electron imports. The actual projection logic lives in the pure, electron-free
 * `foldEvents` core; this hook is just accumulate + subscribe + fold.
 *
 * Coalescing (T019, FR-026/FR-028): live `text-delta` bursts can arrive far faster
 * than the display refreshes. Instead of re-folding synchronously on EVERY appended
 * event (one React commit per delta), incoming events are accumulated into the same
 * `eventsRef` array and a SINGLE refold is scheduled on the next animation frame
 * (`requestAnimationFrame`, ~16 ms / ~60 fps). N deltas landing within one frame
 * therefore produce ONE fold + ONE commit, so 5–15 concurrent panels stay responsive.
 * This is purely a SCHEDULING change: the same accumulate-then-fold shape is preserved,
 * the same whole-array `foldEvents(...)` runs, and the returned view-models are
 * identical to a synchronous fold — replay == live (FR-039) still holds because the
 * coalescing only batches WHEN the fold runs, never WHAT it folds. The backfill still
 * folds synchronously (an immediate commit) so a re-opened run paints without a frame
 * of latency.
 */

export interface NativeAgentEventsView {
  /** Ordered transcript entries (assistant-text / tool-call / thinking / notice),
   *  consumed by `NativeTranscriptView` (T016). */
  entries: TranscriptEntry[];
  /** Turns → tool calls → token usage projection, consumed by `StructuredRunTab`
   *  (T027). Same fold as `entries`, so the two views never diverge. */
  structured: StructuredRunView;
  /** Count of raw `AgentEvent`s folded so far (backfill + live). Useful for
   *  empty-state / "no activity yet" affordances and lightweight debugging. */
  eventCount: number;
  /** True until the initial backfill replay has resolved (or failed). Lets a view
   *  distinguish "still loading the persisted run" from "loaded, genuinely empty". */
  loading: boolean;
}

/**
 * Subscribe to ONE native agent's `AgentEvent` stream, backfill its persisted run,
 * and expose the folded transcript + structured view-models.
 *
 * @param agentId the native agent whose run log to replay + stream. Re-running with a
 *                new id tears down the prior subscription and starts a fresh backfill.
 * @returns the folded `{ entries, structured, eventCount, loading }` view (see
 *          `NativeAgentEventsView`).
 */
export function useNativeAgentEvents(agentId: string): NativeAgentEventsView {
  // The single accumulated stream (backfill events first, then live appends), held in
  // a ref so the subscription callback always appends to the latest array without
  // re-binding the listener. State holds the folded projection the component renders.
  const eventsRef = useRef<AgentEvent[]>([]);
  const [view, setView] = useState<{
    entries: TranscriptEntry[];
    structured: StructuredRunView;
    eventCount: number;
  }>(() => emptyFold());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    // Fresh accumulation per agent — an agent change must NOT inherit a prior run's
    // events. Reset both the ref and the rendered projection immediately.
    eventsRef.current = [];
    setView(emptyFold());
    setLoading(true);

    // Handle of any pending coalesced refold frame (null = none scheduled). A burst
    // of live events shares ONE scheduled frame: the first event schedules it, later
    // events in the same frame just accumulate onto `eventsRef` and find it already
    // scheduled — so ≤1 fold/commit per frame (FR-026/FR-028).
    let frame: number | null = null;

    /** Re-fold the WHOLE accumulated array (replay == live: one array, one fold).
     *  `streamEnded: false` keeps open tools `pending` mid-stream; `foldEvents`
     *  upgrades to end-of-stream resolution itself once a `stop` event is present. */
    const refold = (): void => {
      if (!alive) return; // guard: never setState after unmount / agent change
      const events = eventsRef.current;
      const { entries, structured } = foldEvents(events, { streamEnded: false });
      setView({ entries, structured, eventCount: events.length });
    };

    /** Schedule a single coalesced refold on the next animation frame. Idempotent
     *  within a frame: if a frame is already pending, additional calls are no-ops, so
     *  N events accumulated since the last commit collapse into ONE fold + ONE commit.
     *  Falls back to a synchronous refold where `requestAnimationFrame` is unavailable
     *  (e.g. a non-DOM test host), preserving correctness if not the batching. */
    const scheduleRefold = (): void => {
      if (!alive || frame !== null) return;
      if (typeof requestAnimationFrame !== 'function') {
        refold();
        return;
      }
      frame = requestAnimationFrame(() => {
        frame = null;
        refold();
      });
    };

    /** Append one live event and schedule a coalesced re-project. Defensive: ignore a
     *  falsy payload. The append is synchronous (no event is ever lost); only the
     *  fold/commit is deferred to the frame boundary. */
    const onEvent = (e: AgentEvent): void => {
      if (!alive || !e) return;
      eventsRef.current = [...eventsRef.current, e];
      scheduleRefold();
    };

    // Open the LIVE subscription BEFORE awaiting the backfill so events arriving
    // during replay are not dropped — they accumulate onto the (initially empty)
    // array and are reconciled when the backfill prepends the persisted history.
    const off = window.cth.onAgentEvent?.(agentId, onEvent);

    // BACKFILL: replay the persisted run, then PREPEND it ahead of anything the live
    // subscription buffered while we waited. `loadNativeEvents` degrades to a
    // best-effort array and never throws, but we still guard the promise defensively.
    window.cth
      .loadNativeEvents?.(agentId)
      .then((backfill) => {
        if (!alive) return;
        const persisted = Array.isArray(backfill) ? backfill : [];
        // Persisted events come first (older), then whatever live events landed
        // during the await — preserving overall arrival/`ts` order the fold expects.
        eventsRef.current = [...persisted, ...eventsRef.current];
        setLoading(false);
        // Backfill paints immediately (a re-opened run should not wait a frame); any
        // already-scheduled live frame is superseded by this synchronous fold.
        if (frame !== null) {
          cancelAnimationFrame(frame);
          frame = null;
        }
        refold();
      })
      .catch(() => {
        // No persisted run / replay failed — fall back to a live-only stream.
        if (!alive) return;
        setLoading(false);
        if (frame !== null) {
          cancelAnimationFrame(frame);
          frame = null;
        }
        refold();
      });

    // Cleanup: stop folding, cancel any pending frame, + drop the subscription on
    // unmount / agentId change.
    return () => {
      alive = false;
      if (frame !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(frame);
      }
      frame = null;
      off?.();
    };
  }, [agentId]);

  return {
    entries: view.entries,
    structured: view.structured,
    eventCount: view.eventCount,
    loading
  };
}

/** The folded projection of an empty stream — used as the initial / reset state so
 *  a component always has a well-formed `{ entries, structured }` to render. */
function emptyFold(): {
  entries: TranscriptEntry[];
  structured: StructuredRunView;
  eventCount: number;
} {
  const { entries, structured } = foldEvents([], { streamEnded: false });
  return { entries, structured, eventCount: 0 };
}
