/**
 * Pure helpers for phase-scoped (kanban-lane) operator actions — kept free of the store/IPC so
 * they're unit-testable in node (the `fleetControl` fan-out that consumes these touches the store).
 */

/** The distinct assignee desk ids of the cards currently in a given lane/phase — the desk set a
 *  per-phase pause/stop targets. Pure (dedup, drop unassigned). NOTE the scope is transient: a
 *  phase belongs to CARDS, not desks, so this is "whoever holds a card in this lane right now". */
export function assigneesForStatus(
  tasks: readonly { status: string; assignee?: string }[],
  status: string
): string[] {
  const ids = new Set<string>();
  for (const t of tasks) if (t.status === status && t.assignee) ids.add(t.assignee);
  return [...ids];
}
