import { useStore, type Agent } from '@/store/store';
import { isNativeRuntimeDesk } from '@/lib/runtimeKind';
import { pauseAgent, stopAgent } from '@/lib/agentControl';
// Pure phase-scope selection lives in its own store-free module (so it's unit-testable); re-export
// it here so callers can pull all fleet-scope helpers from one place.
export { assigneesForStatus } from '@/lib/phaseScope';

/**
 * Scoped operator controls — fan the per-agent primitives ([[agentControl]]) across a SET of
 * desks (fleet-wide, a project repo, a kanban lane). Looping the per-agent helpers (not a single
 * main-side kill) keeps the renderer store consistent — the `paused` map, each desk's status, and
 * `godDesired` all update exactly as they do per-desk. Callers pass the desk set; these resolve
 * it against the live store so a stale id is skipped.
 */

/** Pause/resume a specific set of desks by id (unknown ids are skipped). */
export async function pauseAgents(ids: readonly string[], on: boolean): Promise<void> {
  const have = new Set(useStore.getState().agents.map((a) => a.id));
  await Promise.all(ids.filter((id) => have.has(id)).map((id) => pauseAgent(id, on)));
}

/** Stop (kill) a specific set of desks. Pass the live Agent objects (native detection needs them);
 *  unknown/stale entries are skipped. */
export async function stopAgents(agents: readonly Agent[]): Promise<void> {
  const { agents: live, fleetDefaultModel } = useStore.getState();
  const byId = new Map(live.map((a) => [a.id, a]));
  await Promise.all(
    agents
      .map((a) => byId.get(a.id))
      .filter((a): a is Agent => !!a)
      .map((a) => stopAgent(a, isNativeRuntimeDesk(a, fleetDefaultModel)))
  );
}

/** Pause every active desk (deny tools, keep process + context — instant resume). */
export async function pauseAllAgents(): Promise<void> {
  await pauseAgents(useStore.getState().agents.map((a) => a.id), true);
}

/** Resume every active desk. */
export async function resumeAllAgents(): Promise<void> {
  await pauseAgents(useStore.getState().agents.map((a) => a.id), false);
}

/** Stop (kill) every active desk's process. Native desks revive on demand; Claude desks become
 *  restorable; the god is recorded `stopped` (by stopAgent) so the floor stays down on reload. */
export async function stopAllAgents(): Promise<void> {
  await stopAgents(useStore.getState().agents);
}
