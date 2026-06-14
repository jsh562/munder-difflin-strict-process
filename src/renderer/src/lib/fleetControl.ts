import { useStore } from '@/store/store';
import { isNativeRuntimeDesk } from '@/lib/runtimeKind';
import { pauseAgent, stopAgent } from '@/lib/agentControl';

/**
 * Fleet-wide operator controls — fan the per-agent primitives ([[agentControl]]) across every
 * ACTIVE desk (the store's `agents`; archived desks are excluded by construction). Looping the
 * per-agent helpers (not a single main-side kill) keeps the renderer store consistent — the
 * `paused` map, each desk's status, and `godDesired` all update exactly as they do per-desk.
 */

/** Pause every active desk (deny tools, keep process + context — instant resume). */
export async function pauseAllAgents(): Promise<void> {
  const { agents } = useStore.getState();
  await Promise.all(agents.map((a) => pauseAgent(a.id, true)));
}

/** Resume every active desk. */
export async function resumeAllAgents(): Promise<void> {
  const { agents } = useStore.getState();
  await Promise.all(agents.map((a) => pauseAgent(a.id, false)));
}

/** Stop (kill) every active desk's process. Native desks revive on demand; Claude desks become
 *  restorable; the god is recorded `stopped` (by stopAgent) so the floor stays down on reload. */
export async function stopAllAgents(): Promise<void> {
  const { agents, fleetDefaultModel } = useStore.getState();
  await Promise.all(agents.map((a) => stopAgent(a, isNativeRuntimeDesk(a, fleetDefaultModel))));
}
