import type { Agent, GodDesired } from '@/store/store';
import type { StatusKind } from '@/components/PixelBadge';

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
