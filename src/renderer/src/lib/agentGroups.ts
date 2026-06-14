import type { Agent, AgentRole } from '@/store/store';

/** Group key for the leading cross-project "FLOOR" cluster (god + prep assistant). */
export const FLOOR_GROUP = '__floor__';

/** The roles a desk EFFECTIVELY holds, applying the same defaults the rest of the app uses when
 *  `roles` is unset: the god defaults to integrator+reviewer, a plain desk to worker, and the
 *  send-only assistant to none. Pure. */
export function effectiveRoles(a: Agent): AgentRole[] {
  if (a.isAssistant) return [];
  return a.roles ?? (a.isGod ? ['integrator', 'reviewer'] : ['worker']);
}

export interface AgentGroup {
  /** FLOOR_GROUP for god/assistant; otherwise the project (cwd basename). */
  key: string;
  /** Display label — "FLOOR" or the project name. */
  label: string;
  agents: Agent[];
}

/**
 * Group desks for the strip: a leading FLOOR group (god + assistant — the cross-project
 * orchestration desks), then one group per PROJECT (`agent.project`), projects sorted
 * alphabetically. Agents keep their input order within a group. Pure + total.
 */
export function groupAgents(agents: Agent[]): AgentGroup[] {
  const floor = agents.filter((a) => a.isGod || a.isAssistant);
  const byProject = new Map<string, Agent[]>();
  for (const a of agents) {
    if (a.isGod || a.isAssistant) continue;
    const key = a.project || '(no project)';
    const arr = byProject.get(key);
    if (arr) arr.push(a); else byProject.set(key, [a]);
  }
  const groups: AgentGroup[] = [];
  if (floor.length) groups.push({ key: FLOOR_GROUP, label: 'FLOOR', agents: floor });
  for (const key of [...byProject.keys()].sort((a, b) => a.localeCompare(b))) {
    groups.push({ key, label: key, agents: byProject.get(key)! });
  }
  return groups;
}

/**
 * Count desks per role within a group — a multi-role desk counts under EACH role it holds (that's
 * "agents per role"). Only roles actually held appear (so the header chips stay compact + adapt to
 * standard vs SDDP mode). Pure.
 */
export function roleCounts(agents: Agent[]): Partial<Record<AgentRole, number>> {
  const counts: Partial<Record<AgentRole, number>> = {};
  for (const a of agents) {
    for (const r of effectiveRoles(a)) counts[r] = (counts[r] ?? 0) + 1;
  }
  return counts;
}

/** The desks (within a group) that hold `role` — the "which agents per role" drill-down behind a
 *  matrix cell. Uses `effectiveRoles` so the defaults match the counts. Pure. */
export function agentsInRole(agents: Agent[], role: AgentRole): Agent[] {
  return agents.filter((a) => effectiveRoles(a).includes(role));
}
