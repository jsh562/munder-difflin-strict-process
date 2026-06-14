import type { Agent, GodDesired } from '@/store/store';
import type { StatusKind } from '@/components/PixelBadge';

/** A coarse status bucket for the matrix cell's mini status bar — collapses the richer
 *  `StatusKind` + the warm/cold liveness axis into one of a few visually-distinct groups. */
export type CellBucket = 'working' | 'waiting' | 'blocked' | 'looping' | 'compacting' | 'idle' | 'cold';

/** Stable left→right order for the status bar segments (active states first, parked last). */
export const CELL_BUCKET_ORDER: CellBucket[] = ['working', 'waiting', 'blocked', 'looping', 'compacting', 'idle', 'cold'];

/**
 * The status to DISPLAY for a desk — one derivation shared by the strip card, the
 * Command Center badge, and (for the spinner) the transcript, so they never disagree.
 *
 * Precedence: a stopped god reads idle (it's down until Start); a paused desk reads
 * "waiting" (parked — tools denied, not re-woken); otherwise the live `agent.status`
 * (which the useHive event subscription drives from the native turn-start/stop stream,
 * or the Claude hook events). `agent.status` alone is the live working/idle signal;
 * this layers the operator's pause/stop intent on top.
 */
export function displayStatus(agent: Agent, paused: boolean, godDesired: GodDesired): StatusKind {
  if (agent.isGod && godDesired === 'stopped') return 'idle';
  if (paused) return 'waiting';
  return agent.status;
}

/**
 * Reconcile a desk's stored `status` against main's AUTHORITATIVE live state (running + in-a-turn),
 * the safety net that heals a badge latched on "working" after a missed terminal event. Returns the
 * corrected status, or `null` when no change is warranted. SURGICAL: it only ever corrects the
 * working↔idle turn pair — a desk in any OTHER status (blocked / compacting / looping / waiting) is
 * left untouched, since those are driven by signals this reconcile doesn't model. A dead desk
 * (`!running`) reads idle; a live desk reads `working` iff it is mid-turn, else idle. Pure.
 */
export function reconcileTurnStatus(current: StatusKind, running: boolean, inTurn: boolean): StatusKind | null {
  if (current !== 'working' && current !== 'idle') return null; // never clobber other statuses
  const desired: StatusKind = running && inTurn ? 'working' : 'idle';
  return desired === current ? null : desired;
}

/**
 * Collapse a desk's DISPLAY status + its warm/cold liveness into one matrix bucket. Active states
 * map straight through; an otherwise-idle desk reads `cold` when it's known-parked (`warm === false`,
 * revive-on-demand) and `idle` when warm or unknown. `success`/`ghost`/anything else folds into
 * idle/cold. Pure — the matrix bar + tooltip derive from this so they never disagree with the badge.
 */
export function deskBucket(
  agent: Agent, paused: boolean, godDesired: GodDesired, warm: boolean | undefined
): CellBucket {
  const s = displayStatus(agent, paused, godDesired);
  if (s === 'working' || s === 'thinking') return 'working';
  if (s === 'waiting') return 'waiting';
  if (s === 'blocked') return 'blocked';
  if (s === 'looping') return 'looping';
  if (s === 'compacting') return 'compacting';
  // idle / success / ghost → distinguish a parked (cold) desk from a live-but-idle one.
  return warm === false ? 'cold' : 'idle';
}

/** Tally a cell's desks by bucket (only non-zero buckets are returned). `liveness` is the
 *  store's id→warm map; an id absent from it is treated as unknown (→ idle, not cold). Pure. */
export function bucketCounts(
  agents: Agent[], paused: Record<string, boolean>, godDesired: GodDesired, liveness: Record<string, boolean>
): Partial<Record<CellBucket, number>> {
  const counts: Partial<Record<CellBucket, number>> = {};
  for (const a of agents) {
    const warm = a.id in liveness ? liveness[a.id] : undefined;
    const b = deskBucket(a, !!paused[a.id], godDesired, warm);
    counts[b] = (counts[b] ?? 0) + 1;
  }
  return counts;
}
