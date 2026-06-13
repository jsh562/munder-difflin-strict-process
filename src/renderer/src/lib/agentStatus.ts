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
