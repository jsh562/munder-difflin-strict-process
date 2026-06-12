/**
 * E008 T036 {FR-010/FR-027/FR-028} — pure transcript-virtualization windowing math.
 *
 * `NativeTranscriptView` mounts ONLY the rows in the visible window plus a fixed
 * overscan, so the mounted DOM-node count is O(visible) and NEVER grows with total
 * entry count (FR-027/SC-016). The repo's Vitest env is `node` (no jsdom), so the
 * O(visible) guarantee is proven HERE against the extracted pure helpers rather than a
 * DOM render: for a fixed viewport the window width stays the SAME bounded count whether
 * the run is 100, 1_000, or 10_000 entries — only the spacer heights above/below grow.
 *
 * Pure-node: imports ONLY the windowing helpers — no DOM/React/electron.
 */
import { describe, it, expect } from 'vitest';
import {
  ESTIMATED_ROW_HEIGHT,
  OVERSCAN,
  buildOffsets,
  rowContaining,
  visibleRange,
  mountedCount,
  type MeasurableRow
} from '../transcriptWindow';

/** Build `n` rows with stable ids (the only field the windowing reads). */
function rows(n: number): MeasurableRow[] {
  const out: MeasurableRow[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = { id: `r-${i}` };
  return out;
}

describe('T036 {FR-010/FR-027} transcriptWindow — bounded O(visible) windowing', () => {
  // ── buildOffsets: prefix-sum over measured | estimated heights ──────────────

  it('builds an ascending prefix-sum of length n+1, starting at 0', () => {
    const offsets = buildOffsets(rows(4), new Map());
    expect(offsets).toHaveLength(5);
    expect(offsets[0]).toBe(0);
    // Unmeasured rows fall back to the estimate.
    expect(offsets[4]).toBe(4 * ESTIMATED_ROW_HEIGHT);
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]).toBeGreaterThanOrEqual(offsets[i - 1]);
    }
  });

  it('uses measured heights where present, the estimate otherwise', () => {
    const heights = new Map<string, number>([
      ['r-0', 100],
      ['r-2', 40]
    ]);
    const offsets = buildOffsets(rows(3), heights);
    // r-0 = 100, r-1 = estimate, r-2 = 40.
    expect(offsets[1]).toBe(100);
    expect(offsets[2]).toBe(100 + ESTIMATED_ROW_HEIGHT);
    expect(offsets[3]).toBe(100 + ESTIMATED_ROW_HEIGHT + 40);
  });

  it('returns [0] for an empty run (total height 0)', () => {
    const offsets = buildOffsets([], new Map());
    expect(offsets).toEqual([0]);
  });

  // ── rowContaining: binary search over the offsets ───────────────────────────

  it('finds the row containing a pixel offset (clamped to [0, n-1])', () => {
    const offsets = buildOffsets(rows(10), new Map()); // each 28px
    expect(rowContaining(offsets, 0, 10)).toBe(0);
    expect(rowContaining(offsets, 27, 10)).toBe(0); // still inside row 0
    expect(rowContaining(offsets, 28, 10)).toBe(1); // top of row 1
    expect(rowContaining(offsets, 28 * 5 + 3, 10)).toBe(5);
    // Past the end clamps to the last row.
    expect(rowContaining(offsets, 1e9, 10)).toBe(9);
    // Negative clamps to the first row.
    expect(rowContaining(offsets, -50, 10)).toBe(0);
  });

  // ── visibleRange: viewport + overscan, never the whole run ──────────────────

  it('returns {0,-1} (empty slice) for an empty run', () => {
    const offsets = buildOffsets([], new Map());
    expect(visibleRange(offsets, 0, 0, 600)).toEqual({ first: 0, last: -1 });
  });

  it('windows to the viewport plus overscan at the top of the run', () => {
    const n = 1000;
    const offsets = buildOffsets(rows(n), new Map()); // 28px rows
    // A 600px viewport at the very top shows ~21-22 rows; first clamps at 0.
    const range = visibleRange(offsets, n, 0, 600);
    expect(range.first).toBe(0);
    // last = last-visible (~21) + OVERSCAN, well short of n-1.
    expect(range.last).toBeLessThan(40);
    expect(range.last).toBeGreaterThan(0);
  });

  it('windows around a mid-run scroll position with overscan on BOTH edges', () => {
    const n = 5000;
    const offsets = buildOffsets(rows(n), new Map());
    const scrollTop = 28 * 2500; // scrolled to ~row 2500
    const range = visibleRange(offsets, n, scrollTop, 600);
    // first is overscan-padded BELOW the first visible row.
    const firstVisible = rowContaining(offsets, scrollTop, n);
    const lastVisible = rowContaining(offsets, scrollTop + 600, n);
    expect(range.first).toBe(firstVisible - OVERSCAN);
    expect(range.last).toBe(lastVisible + OVERSCAN);
    // It is a small window in the MIDDLE — neither edge touches 0 or n-1.
    expect(range.first).toBeGreaterThan(0);
    expect(range.last).toBeLessThan(n - 1);
  });

  it('clamps the window to [0, n-1] at the bottom of the run', () => {
    const n = 800;
    const offsets = buildOffsets(rows(n), new Map());
    const total = offsets[n];
    const range = visibleRange(offsets, n, total - 600, 600);
    expect(range.last).toBe(n - 1); // cannot exceed the last row
    expect(range.first).toBeGreaterThanOrEqual(0);
  });

  // ── THE core guarantee: mounted count is bounded, independent of n ──────────

  it('mounted-node count is BOUNDED and does NOT grow with total entry count (FR-027/SC-016)', () => {
    const VIEWPORT = 600;
    // A scroll position that is MID-RUN for EVERY size below (row ~30, far from both the
    // top clamp and the bottom clamp even for the smallest n=100 run), so the window is
    // never clamped at an edge — isolating the "size is a function of the viewport, not
    // of n" property.
    const SCROLL = 28 * 30;
    const counts = [100, 1_000, 10_000, 50_000].map((n) => {
      const offsets = buildOffsets(rows(n), new Map());
      const range = visibleRange(offsets, n, SCROLL, VIEWPORT);
      return mountedCount(range);
    });
    // Every size mounts the SAME bounded count (viewport rows + 2·overscan) — the count
    // is a function of the viewport, not of n.
    const [first, ...rest] = counts;
    rest.forEach((c) => expect(c).toBe(first));
    // And it is small: ~ (600/28) + 2·6 ≈ 33 rows, NOWHERE near tens of thousands.
    expect(first).toBeLessThanOrEqual(Math.ceil(VIEWPORT / ESTIMATED_ROW_HEIGHT) + 2 * OVERSCAN + 2);
    expect(first).toBeLessThan(50);
  });

  it('the window width is bounded by viewport rows + 2·OVERSCAN for any scroll position', () => {
    const n = 20_000;
    const VIEWPORT = 600;
    const offsets = buildOffsets(rows(n), new Map());
    const maxRows = Math.ceil(VIEWPORT / ESTIMATED_ROW_HEIGHT) + 2 * OVERSCAN + 2;
    // Sweep across the whole run; the mounted count never blows up.
    for (let scrollTop = 0; scrollTop <= offsets[n]; scrollTop += 28 * 1000) {
      const range = visibleRange(offsets, n, scrollTop, VIEWPORT);
      expect(mountedCount(range)).toBeLessThanOrEqual(maxRows);
      expect(range.first).toBeGreaterThanOrEqual(0);
      expect(range.last).toBeLessThanOrEqual(n - 1);
    }
  });

  it('is deterministic — same inputs yield the same window', () => {
    const offsets = buildOffsets(rows(2000), new Map());
    const a = visibleRange(offsets, 2000, 12345, 600);
    const b = visibleRange(offsets, 2000, 12345, 600);
    expect(a).toEqual(b);
  });
});
