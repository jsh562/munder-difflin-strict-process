/**
 * Shared mission/instruction text for the orchestrator. Lives in `shared` so both the
 * renderer (triage button + the SCHEDULES "from template" picker) and any other consumer
 * use the SAME wording — no drift between the one-click button and the recurring schedule.
 */

/** The board-triage instruction dispatched to the god (one-click button + a schedule
 *  template). Board-wide but TODO-focused: assign + prioritize the unassigned backlog,
 *  leave in-progress work with its owner, flag stalls, and never implement. */
export const TRIAGE_PROMPT =
  'Triage the board now. ' +
  '(1) For every UNASSIGNED card in TODO: pick the best AVAILABLE worker via hive_list_agents and assign it (hive_update_task assignee) + set a sensible priority; if no suitable worker exists, say exactly which desk to spawn. ' +
  '(2) Leave ALREADY-ASSIGNED / in-progress cards with their current worker — the work lives on that worker\'s branch; for a stalled assigned card (including one sent back to "doing"), re-engage its owner with a message, do NOT reassign it. ' +
  '(3) Scan blocked / review / integrate for stalls and nudge the owner, the project\'s reviewer, or its integrator. ' +
  '(4) Keep tasks.json accurate. ' +
  'Do NOT implement anything yourself — your job is to delegate.';

/** A recurring schedule "starter" — the editable fields the SCHEDULES create form
 *  prefills. (Mirrors the editable subset of the main-process `ScheduledMission`.) */
export interface MissionTemplate {
  label: string;
  intervalMs: number;
  to: string;
  body: string;
  kind?: 'dispatch' | 'heartbeat';
}

const HOUR = 3_600_000;

/** One-click starting points for the SCHEDULES "+ from template" picker. */
export const MISSION_TEMPLATES: MissionTemplate[] = [
  {
    label: 'Triage TODOs',
    intervalMs: HOUR,
    to: 'god',
    body: TRIAGE_PROMPT
  },
  {
    label: 'Board reconcile',
    intervalMs: 6 * HOUR,
    to: 'god',
    body:
      'Reconcile the board: read hive_list_tasks and fix every stale card with hive_update_task. ' +
      'Confirm each in-progress card still has a live owner; resolve done blockers; make sure review/integrate cards have an owner working them. ' +
      'Keep tasks.json + board.md accurate. Do NOT implement — delegate.'
  },
  {
    label: 'Per-project standup',
    intervalMs: 24 * HOUR,
    to: 'god',
    body:
      'Per-project standup: for this project, summarise what each of its desks is doing and the next step, flag anything stalled or blocked, and keep its cards accurate. ' +
      '(Set a Project on this schedule so it pings that project\'s desks.)'
  }
];
