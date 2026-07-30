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
  '(2) Any implementation card assigned to YOU (the god): reassign it to a worker — you orchestrate, you do not code. ' +
  '(3) Leave ALREADY-ASSIGNED / in-progress cards with their current worker — the work lives on that worker\'s branch; for a stalled assigned card (including one sent back to "doing"), re-engage its owner with a message, do NOT reassign it. ' +
  '(4) Scan blocked / review / integrate for stalls and nudge the owner, the project\'s reviewer, or its integrator. ' +
  '(5) Keep tasks.json accurate. ' +
  'Do NOT implement anything yourself — your job is to delegate.';

/** Reconcile MISASSIGNED cards (the kanban "fix assignments" button + a schedule template):
 *  the assignee is gone, lacks the role the card needs, or has moved off the card's project. */
export const ORPHAN_TRIAGE_PROMPT =
  'Fix misassigned cards on the board. Call hive_list_agents (each desk\'s roles, repo, and whether it is archived/running) and hive_list_tasks. ' +
  'A card is MISASSIGNED if its assignee is archived/inactive, OR (for a todo/doing/blocked card) holds neither the worker nor integrator role, OR is no longer on the card\'s project (its repo no longer matches the card\'s project). ' +
  'For each misassigned card: reassign it (hive_update_task assignee) to an AVAILABLE capable desk — the right role, on that project. ' +
  'If no suitable desk exists, OR the current assignee is inactive / lacks the permission, UNASSIGN the card (set assignee to "" and status "todo") and state exactly which desk to spawn. ' +
  'Do NOT implement anything yourself — only reassign/unassign.';

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
    label: 'Fix assignments',
    intervalMs: 6 * HOUR,
    to: 'god',
    body: ORPHAN_TRIAGE_PROMPT
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
