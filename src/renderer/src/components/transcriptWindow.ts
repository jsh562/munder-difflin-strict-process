/**
 * PURE transcript-virtualization math (E008 / T018 extracted in T036).
 *
 * `NativeTranscriptView` virtualizes its run: it mounts ONLY the rows in the visible
 * window plus a small fixed overscan, so the mounted DOM-node count is O(visible) and
 * NEVER grows with total entry count (FR-010/FR-027/SC-016). The geometry that decides
 * which rows mount is pure arithmetic — a prefix-sum of row heights and a binary search
 * over it — so it is factored out HERE, away from the DOM shell, for two reasons:
 *
 *   1. It can be UNIT-TESTED in the node Vitest environment (no jsdom, no DOM render) —
 *      the repo's test env is `node` (vitest.config.ts), so a DOM render test is not
 *      available; this pure helper is the testable form of the O(visible) guarantee.
 *   2. The component stays a thin shell that drives this math, keeping the windowing
 *      logic in one place that is provably bounded.
 *
 * PURITY: no React, no DOM, no ambient clock/random — same inputs ⇒ same output. The
 * caller supplies the measured-height map (or relies on the estimate) and the live
 * viewport geometry; this module returns numbers only.
 */

// ── Virtualization tuning ───────────────────────────────────────────────────

/** Initial per-row height guess before a row has been measured (px). Refined to the
 *  real measured height once a row mounts, so the scroll geometry self-corrects. */
export const ESTIMATED_ROW_HEIGHT = 28;

/** Rows rendered above + below the visible window so a fast scroll/flick does not
 *  reveal blank space before the next frame mounts the entering rows. The mounted-node
 *  bound is therefore (visible rows) + 2·OVERSCAN — a FIXED additive buffer, not a
 *  function of total entry count. */
export const OVERSCAN = 6;

/** A scroll is considered "at the bottom" within this slack (px) — tolerates sub-pixel
 *  rounding + the in-progress indicator's own height so stick-to-bottom stays engaged
 *  while streaming. */
export const STICK_THRESHOLD = 24;

/** The minimal row shape the windowing needs: a stable id to key its measured height. */
export interface MeasurableRow {
  id: string;
}

/** An inclusive visible window `[first, last]` of row indices to mount. `first` is 0 and
 *  `last` is -1 (an empty slice) when there are no rows. */
export interface VisibleRange {
  first: number;
  last: number;
}

/**
 * Build the prefix-sum offsets for `rows`: `offsets[i]` is the top px of row `i` and
 * `offsets[n]` is the total content height. A row's height comes from `heights` (its
 * measured height) or falls back to `ESTIMATED_ROW_HEIGHT` until it has been measured.
 *
 * O(n) arithmetic over numbers (NOT DOM) — n is the full run, but this never mounts a
 * node, so the rendered/mounted cost stays O(visible) via `visibleRange` below.
 *
 * @param rows    the full ordered run (only `.id` is read).
 * @param heights measured-height map keyed by row id (missing ⇒ estimate).
 * @returns an array of length `rows.length + 1` of ascending top offsets.
 */
export function buildOffsets(
  rows: readonly MeasurableRow[],
  heights: ReadonlyMap<string, number>
): number[] {
  const out = new Array<number>(rows.length + 1);
  out[0] = 0;
  for (let i = 0; i < rows.length; i++) {
    const h = heights.get(rows[i].id) ?? ESTIMATED_ROW_HEIGHT;
    out[i + 1] = out[i] + h;
  }
  return out;
}

/**
 * Lower-bound binary search over the ascending prefix-sum `offsets`: returns the index
 * of the row that CONTAINS pixel `value` (the largest `i` with `offsets[i] <= value`),
 * clamped to `[0, n-1]`. O(log n).
 */
export function rowContaining(offsets: readonly number[], value: number, n: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid + 1] <= value) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(n - 1, Math.max(0, lo));
}

/**
 * Compute the BOUNDED visible row window from the scroll geometry (T036, FR-027).
 *
 * From `scrollTop` and the viewport `height` we binary-search the first and last rows
 * intersecting the viewport, then pad each edge by the FIXED `OVERSCAN`. The returned
 * `[first, last]` is therefore at most `(rows in viewport) + 2·OVERSCAN` wide — its size
 * is a function of the viewport, NOT of `n`. This is the O(visible) guarantee: for runs
 * of hundreds or thousands of entries the window (and so the mounted-node count) stays
 * the same bounded width; only the spacer heights above/below grow.
 *
 * @param offsets    prefix-sum offsets from `buildOffsets` (length `n + 1`).
 * @param n          total row count.
 * @param scrollTop  current scroll position (px from the top).
 * @param height     viewport (client) height (px).
 * @returns the inclusive `[first, last]` row window to mount; `{0,-1}` when `n === 0`.
 */
export function visibleRange(
  offsets: readonly number[],
  n: number,
  scrollTop: number,
  height: number
): VisibleRange {
  if (n <= 0) return { first: 0, last: -1 };
  const top = scrollTop;
  const bottom = top + (height || 0);
  const firstVisible = rowContaining(offsets, top, n);
  const lastVisible = rowContaining(offsets, bottom, n);
  return {
    first: Math.max(0, firstVisible - OVERSCAN),
    last: Math.min(n - 1, lastVisible + OVERSCAN)
  };
}

/** The number of rows the window `[first, last]` mounts — used by tests to assert the
 *  mounted-node count is bounded (independent of total entry count). */
export function mountedCount(range: VisibleRange): number {
  return Math.max(0, range.last - range.first + 1);
}
