import { useCallback, useEffect, useRef, useState } from 'react';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { PixelBadge } from './PixelBadge';
import { Icon } from './Icon';
import { useStore } from '@/store/store';
import { assigneesForStatus, pauseAgents, stopAgents } from '@/lib/fleetControl';
import { TRIAGE_PROMPT, ORPHAN_TRIAGE_PROMPT } from '@shared/missionTemplates';

/** A card on the task kanban. Mirrors HiveTask in the main/preload process —
 *  re-declared locally so the renderer doesn't reach into the preload package
 *  (same convention as store/config.ts). Structurally compatible with
 *  window.cth.hiveWriteTasks. */
export interface HiveComment {
  by: string;
  at: string;
  text: string;
}

/** SDDP: one gated step in a feature's lifecycle, on the feature "epic" card (mirrors
 *  FeatureMilestone in won-agent-core). */
export interface FeatureMilestone {
  key: string;
  label: string;
  subAgent?: string;
  gateArtifact: string;
  status: 'pending' | 'active' | 'done';
  /** Per-step operator control of the host engine (default 'auto'); set from the pill. */
  control?: 'auto' | 'paused' | 'stopped' | 'manual';
}

/** SDDP host engine's live per-feature status (mirrors FeatureEngineStatus; from pipeline:status). */
export interface FeatureEngineStatus {
  step: string | null;
  state: 'running' | 'waiting' | 'paused' | 'stopped' | 'manual' | 'blocked' | 'done';
  message?: string;
}

export interface HiveTask {
  id: string;
  title: string;
  description?: string;
  assignee?: string;
  status: 'todo' | 'doing' | 'blocked' | 'review' | 'integrate' | 'done';
  dependsOn: string[];
  /** Task id(s) this card is waiting on while `blocked` (shown as "blocked by"). */
  blockedBy?: string[];
  /** Attributed feedback thread (newest last). */
  comments?: HiveComment[];
  /** Project repo the card belongs to (stamped on assign) — for off-project detection. */
  project?: string;
  /** SDDP: the feature folder this card belongs to (its specs/<feature>/ dir). */
  feature?: string;
  /** SDDP: the ordered milestone checklist on a feature "epic" card (the gated pipeline). */
  milestones?: FeatureMilestone[];
  priority: number;
  createdAt: string;
}

type Status = HiveTask['status'];

/** SDDP: a feature's on-disk marker state (mirrors FeatureStatus in won-agent-core/preload). */
interface FeatureStatus {
  feature: string;
  hasSpec: boolean;
  hasClarifications: boolean;
  hasPlan: boolean;
  hasTasks: boolean;
  completed: boolean;
  qcPassed: boolean;
}

/** The SDDP lifecycle phases, in order — the kanban's feature phase tracker. */
const SDDP_PHASES = ['Specify', 'Clarify', 'Plan', 'Tasks', 'Implement', 'QC', 'Integrate'] as const;
type FeaturePhase = (typeof SDDP_PHASES)[number];

/** Current phase from the on-disk markers (mirrors won-agent-core's featurePhase derivation).
 *  Clarify is folded into the Plan window; `hasClarifications` is shown separately. */
function featurePhase(s: FeatureStatus): FeaturePhase {
  if (s.qcPassed) return 'Integrate';
  if (s.completed) return 'QC';
  if (s.hasTasks) return 'Implement';
  if (s.hasPlan) return 'Tasks';
  if (s.hasSpec) return 'Plan';
  return 'Specify';
}

const COLUMNS: { key: Status; label: string; accent: string }[] = [
  { key: 'todo',      label: 'TODO',      accent: 'var(--cth-sky)' },
  { key: 'doing',     label: 'DOING',     accent: 'var(--cth-lemon)' },
  { key: 'blocked',   label: 'BLOCKED',   accent: 'var(--cth-coral)' },
  // The worker→reviewer hand-off lane: a worker moves a finished card here; a reviewer
  // reads it (read-only) and either approves it to INTEGRATE or sends it back to DOING.
  { key: 'review',    label: 'REVIEW',    accent: 'var(--cth-lilac)' },
  // The reviewer→integrator lane: an integrator merges the branch and signs it off to DONE.
  { key: 'integrate', label: 'INTEGRATE', accent: 'var(--cth-peach)' },
  { key: 'done',      label: 'DONE',      accent: 'var(--cth-mint)' }
];

const POLL_MS = 5000;

function shortId(): string {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Deterministic fallback id derived from a task's content (djb2 → base36).
 *  Used for tasks lacking a valid string id so re-parsing tasks.json on every
 *  5s poll yields the SAME id — no React key churn / card remount. Unlike
 *  shortId() (random, for brand-new tasks), this never changes across polls. */
function stableId(seed: string): string {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = (((h << 5) + h) ^ seed.charCodeAt(i)) | 0;
  return `t-${(h >>> 0).toString(36)}`;
}

/** Normalize whatever hive:tasks returns into a typed task array. */
function parseTasks(raw: unknown): HiveTask[] {
  const list = (raw && typeof raw === 'object' && Array.isArray((raw as { tasks?: unknown }).tasks))
    ? (raw as { tasks: unknown[] }).tasks
    : [];
  return list
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map((t, i) => ({
      id: typeof t.id === 'string' && t.id
        ? t.id
        : stableId(`${typeof t.title === 'string' ? t.title : ''}|${typeof t.createdAt === 'string' ? t.createdAt : ''}|${i}`),
      title: typeof t.title === 'string' ? t.title : '(untitled)',
      description: typeof t.description === 'string' ? t.description : undefined,
      assignee: typeof t.assignee === 'string' ? t.assignee : undefined,
      status: (['todo', 'doing', 'blocked', 'review', 'integrate', 'done'] as const).includes(t.status as Status)
        ? (t.status as Status) : 'todo',
      dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.filter((d): d is string => typeof d === 'string') : [],
      blockedBy: Array.isArray(t.blockedBy) ? t.blockedBy.filter((d): d is string => typeof d === 'string') : undefined,
      comments: Array.isArray(t.comments)
        ? (t.comments as unknown[])
            .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
            .map((c) => ({
              by: typeof c.by === 'string' ? c.by : '?',
              at: typeof c.at === 'string' ? c.at : '',
              text: typeof c.text === 'string' ? c.text : ''
            }))
            .filter((c) => c.text)
        : undefined,
      project: typeof t.project === 'string' ? t.project : undefined,
      feature: typeof t.feature === 'string' ? t.feature : undefined,
      milestones: Array.isArray(t.milestones)
        ? (t.milestones as unknown[])
            .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
            .map((m) => ({
              key: typeof m.key === 'string' ? m.key : '',
              label: typeof m.label === 'string' ? m.label : (typeof m.key === 'string' ? m.key : '?'),
              subAgent: typeof m.subAgent === 'string' ? m.subAgent : undefined,
              gateArtifact: typeof m.gateArtifact === 'string' ? m.gateArtifact : '',
              status: (['pending', 'active', 'done'] as const).includes(m.status as FeatureMilestone['status'])
                ? (m.status as FeatureMilestone['status']) : 'pending',
              control: (['auto', 'paused', 'stopped', 'manual'] as const).includes(m.control as NonNullable<FeatureMilestone['control']>)
                ? (m.control as FeatureMilestone['control']) : undefined
            }))
            .filter((m) => m.key)
        : undefined,
      priority: typeof t.priority === 'number' ? t.priority : 3,
      createdAt: typeof t.createdAt === 'string' ? t.createdAt : new Date().toISOString()
    }));
}

/**
 * Task kanban over hive/tasks.json. Polls every 5s, lets the human add tasks
 * (assignee from the live roster, priority, dependsOn), and "assign" a card —
 * which pre-fills the Floor tab's dispatch box and switches to it.
 */
export function TasksKanban({ onAssign }: { onAssign: (prefill: string) => void }) {
  const agents = useStore((s) => s.agents);
  const archivedAgents = useStore((s) => s.archivedAgents);
  const sddpMode = useStore((s) => s.sddpMode);
  const [tasks, setTasks] = useState<HiveTask[]>([]);
  // SDDP: per-feature on-disk phase (keyed by feature folder), for the phase tracker banner.
  const [featureStatuses, setFeatureStatuses] = useState<Record<string, FeatureStatus | null>>({});
  // SDDP: the host engine's live per-feature step status (running/waiting/paused/blocked), for the pills.
  const [engineStatus, setEngineStatus] = useState<Record<string, FeatureEngineStatus>>({});
  const [adding, setAdding] = useState(false);
  // Transient confirmation after dispatching the god a board triage.
  const [triageMsg, setTriageMsg] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  // Jump-to-blocker: a transient highlight + scroll-into-view when a "blocked by" chip is
  // clicked. Card DOM nodes register here by task id.
  const [flashId, setFlashId] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const jumpTo = useCallback((tid: string) => {
    cardRefs.current.get(tid)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    setFlashId(tid);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashId(null), 1600);
  }, []);

  const refresh = useCallback(async () => {
    let list: HiveTask[];
    try { list = parseTasks(await window.cth.hiveTasks()); } catch { return; /* keep last good */ }
    setTasks(list);
    // SDDP: refresh each distinct feature's on-disk phase (the feature's repo = its cards'
    // stamped project). Skipped entirely in standard mode so the board is unchanged.
    if (!sddpMode) return;
    const feats = new Map<string, string | null>();
    for (const t of list) if (t.feature && !feats.has(t.feature)) feats.set(t.feature, t.project ?? null);
    if (feats.size === 0) { setFeatureStatuses({}); return; }
    try {
      const entries = await Promise.all(
        [...feats].map(async ([f, repo]) =>
          [f, await window.cth.hiveFeatureStatus(repo, f).catch(() => null)] as const)
      );
      setFeatureStatuses(Object.fromEntries(entries));
    } catch { /* keep last good */ }
    // The host engine's live per-feature step status (in-memory; for the pill monitor).
    try { setEngineStatus(((await window.cth.pipelineStatus?.()) ?? {}) as Record<string, FeatureEngineStatus>); } catch { /* keep last good */ }
  }, [sddpMode]);

  useEffect(() => {
    refresh();
    timer.current = setInterval(refresh, POLL_MS);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [refresh]);

  const persist = useCallback(async (next: HiveTask[]) => {
    setTasks(next); // optimistic
    try { await window.cth.hiveWriteTasks(next); } catch { refresh(); }
  }, [refresh]);

  const addTask = useCallback((t: HiveTask) => {
    persist([...tasks, t]);
    setAdding(false);
  }, [tasks, persist]);

  const moveTask = useCallback((id: string, status: Status) => {
    // Moving out of 'blocked' also clears its blockers (parity with the agent tool).
    persist(tasks.map((t) => (t.id === id ? { ...t, status, blockedBy: status === 'blocked' ? t.blockedBy : undefined } : t)));
  }, [tasks, persist]);

  const setBlockedBy = useCallback((id: string, ids: string[]) => {
    persist(tasks.map((t) => (t.id === id ? { ...t, blockedBy: ids.length ? ids : undefined } : t)));
  }, [tasks, persist]);

  // SDDP per-step control: set a milestone's `control` on the epic card (the engine reads it on its
  // next trigger). Rides the same writeTasks→poll loop as every other board mutation.
  const setMilestoneControl = useCallback((epicId: string, stepKey: string, control: NonNullable<FeatureMilestone['control']>) => {
    persist(tasks.map((t) => (t.id === epicId && t.milestones
      ? { ...t, milestones: t.milestones.map((m) => (m.key === stepKey ? { ...m, control } : m)) }
      : t)));
  }, [tasks, persist]);

  const titleFor = (tid: string): string => tasks.find((t) => t.id === tid)?.title ?? tid;

  const assign = useCallback((t: HiveTask) => {
    const desc = t.description?.trim() ? t.description.trim() : '(no description)';
    onAssign(`Task: ${t.title}\nContext: ${desc}\n`);
  }, [onAssign]);

  const nameFor = (id?: string): string | undefined =>
    id ? (agents.find((a) => a.id === id)?.name ?? id) : undefined;

  // Dispatch a prompt to the god (Michael) via the same path the Floor tab uses, with a
  // transient confirmation. Shared by both triage buttons.
  const dispatchGod = useCallback(async (subject: string, body: string) => {
    try {
      const r = await window.cth.hiveSend({ to: 'god', act: 'request', subject, body }, 'human');
      setTriageMsg(r.ok ? 'sent to Michael' : `failed: ${r.error ?? '?'}`);
    } catch {
      setTriageMsg('failed');
    }
    setTimeout(() => setTriageMsg(null), 4000);
  }, []);
  const triage = useCallback(() => dispatchGod('Triage board', TRIAGE_PROMPT), [dispatchGod]);
  const fixAssignments = useCallback(() => dispatchGod('Fix assignments', ORPHAN_TRIAGE_PROMPT), [dispatchGod]);

  // Why a card's assignee no longer fits (drives the coral orphan chip): inactive (archived
  // or gone), lacking an edit role for a lane it must work, or moved off the card's project.
  // Null = fine / unassigned / done. The "fix assignments" button asks the god to reconcile.
  const normRepo = (p: string) => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
  const orphanReason = useCallback((t: HiveTask): string | null => {
    if (!t.assignee || t.status === 'done') return null;
    const active = agents.find((a) => a.id === t.assignee);
    if (!active) return archivedAgents.some((a) => a.id === t.assignee) ? 'assignee inactive' : 'assignee gone';
    if (t.status === 'todo' || t.status === 'doing' || t.status === 'blocked') {
      const roles = active.roles ?? (active.isGod ? ['integrator', 'reviewer'] : ['worker']);
      if (!roles.includes('worker') && !roles.includes('integrator')) return 'no edit role';
    }
    if (t.project && normRepo(active.cwd) !== normRepo(t.project)) return 'off-project';
    return null;
  }, [agents, archivedAgents]);

  // Fleet health: a lane with cards but NO active desk that can handle it — the "cards rot in
  // integrate because no live integrator" case. Mirrors the hive's routing (the god counts only
  // if it actually holds the role). Surfaced so the operator revives/assigns instead of waiting.
  const hasActiveRole = (role: 'reviewer' | 'integrator'): boolean =>
    agents.some((a) => (a.roles ?? (a.isGod ? ['integrator', 'reviewer'] : ['worker'])).includes(role));
  const laneGaps = ([
    { status: 'review' as Status, role: 'reviewer' as const },
    { status: 'integrate' as Status, role: 'integrator' as const }
  ]).map((g) => ({ ...g, count: tasks.filter((t) => t.status === g.status).length }))
    .filter((g) => g.count > 0 && !hasActiveRole(g.role));

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--cth-paper-200)' }}>
      {/* Toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', flexShrink: 0,
        borderBottom: '1px solid var(--cth-ink-300)'
      }}>
        <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 9, color: 'var(--cth-ink-500)' }}>
          {tasks.length} task{tasks.length === 1 ? '' : 's'}
        </span>
        {triageMsg && (
          <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-500)' }}>{triageMsg}</span>
        )}
        {/* Ask Michael to reconcile MISASSIGNED cards (inactive / no-edit-role / off-project
            assignees) — reassign to a capable desk or unassign + flag. Count shown when > 0. */}
        {(() => {
          const orphans = tasks.filter((t) => orphanReason(t)).length;
          return (
            <PixelButton
              variant="secondary"
              size="sm"
              onClick={fixAssignments}
              style={{ marginLeft: 'auto' }}
            >
              <span
                title="Ask Michael to fix misassigned cards: reassign to a capable desk, or unassign if the assignee is inactive / lacks the role / is off-project"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: orphans > 0 ? 'var(--cth-coral)' : undefined }}
              >
                <Icon name="bell" /> fix assignments{orphans > 0 ? ` (${orphans})` : ''}
              </span>
            </PixelButton>
          );
        })()}
        {/* Ask Michael to triage the backlog (assign + prioritize TODOs, flag stalls). */}
        <PixelButton
          variant="secondary"
          size="sm"
          onClick={triage}
        >
          <span
            title="Ask Michael to review the board: assign + prioritize TODO cards and flag stalls (he won't implement)"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            <Icon name="sparkle" /> triage
          </span>
        </PixelButton>
        <PixelButton
          variant={adding ? 'secondary' : 'primary'}
          size="sm"
          onClick={() => setAdding((v) => !v)}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Icon name={adding ? 'x' : 'plus'} /> {adding ? 'cancel' : 'add task'}
          </span>
        </PixelButton>
      </div>

      {/* Fleet-health line: cards stuck in a lane with no active role-holder (e.g. "no active
          integrator"). The hive also escalates this to god + human; here it's a glance for the
          operator to revive a desk or assign the role (role toggle / restore team / add agent). */}
      {laneGaps.length > 0 && (
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: 12, padding: '6px 10px', flexShrink: 0,
          background: 'var(--cth-coral-light)', boxShadow: 'inset 0 -1px 0 var(--cth-coral)'
        }}>
          {laneGaps.map((g) => (
            <span key={g.status} style={{ fontSize: 11, lineHeight: '15px', color: 'var(--cth-ink-900)' }}>
              ⚠ {g.count} in {g.status} · <b>no active {g.role}</b> — revive one or give an active desk the {g.role} role
            </span>
          ))}
        </div>
      )}

      {adding && (
        <AddTaskForm
          agents={agents}
          existing={tasks}
          sddpMode={sddpMode}
          onCancel={() => setAdding(false)}
          onCreate={addTask}
        />
      )}

      {/* SDDP feature phase tracker — one banner per feature on the board, showing its
          lifecycle phase derived from the real specs/<feature>/ markers. Only in SDDP mode. */}
      {sddpMode && (() => {
        const feats: string[] = [];
        for (const t of tasks) if (t.feature && !feats.includes(t.feature)) feats.push(t.feature);
        if (feats.length === 0) return null;
        return (
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 5, padding: '7px 10px', flexShrink: 0,
            borderBottom: '1px solid var(--cth-ink-300)', background: 'var(--cth-cream-100)'
          }}>
            {feats.map((f) => {
              const epic = tasks.find((t) => t.feature === f && t.milestones && t.milestones.length > 0) ?? null;
              return (
                <FeatureBanner
                  key={f}
                  feature={f}
                  status={featureStatuses[f] ?? null}
                  cardCount={tasks.filter((t) => t.feature === f).length}
                  milestones={epic?.milestones ?? null}
                  epicId={epic?.id ?? null}
                  engine={engineStatus[f] ?? null}
                  onSetControl={setMilestoneControl}
                />
              );
            })}
          </div>
        );
      })()}

      {/* Columns */}
      <div style={{
        flex: 1, minHeight: 0, display: 'flex', gap: 8, padding: 10, overflowX: 'auto'
      }}>
        {COLUMNS.map((col) => {
          const cards = tasks.filter((t) => t.status === col.key);
          // Per-phase pause/stop targets the desks ASSIGNED to cards in this lane right now
          // (transient — a phase belongs to cards, not desks).
          const laneAssignees = assigneesForStatus(cards, col.key);
          return (
            <div key={col.key} style={{
              flex: '1 1 0', minWidth: 170, display: 'flex', flexDirection: 'column',
              background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px 4px',
                background: col.accent, boxShadow: 'inset 0 -1px 0 var(--cth-ink-900)',
                fontFamily: 'var(--cth-font-display)', fontSize: 9, color: 'var(--cth-ink-900)'
              }}>
                {col.label}
                {laneAssignees.length > 0 && (
                  <span style={{ display: 'inline-flex', gap: 3 }}>
                    <button
                      title={`Pause the ${laneAssignees.length} desk(s) holding a card in ${col.label}`}
                      onClick={() => void pauseAgents(laneAssignees, true)}
                      style={phaseBtnStyle}
                    >⏸</button>
                    <button
                      title={`Stop the ${laneAssignees.length} desk(s) holding a card in ${col.label}`}
                      onClick={() => void stopAgents(agents.filter((a) => laneAssignees.includes(a.id)))}
                      style={phaseBtnStyle}
                    >⏹</button>
                  </span>
                )}
                <span style={{ marginLeft: 'auto', fontSize: 11, fontFamily: 'var(--cth-font-ui)' }}>{cards.length}</span>
              </div>
              <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {cards.length === 0 && (
                  <div style={{ fontSize: 12, color: 'var(--cth-ink-300)', textAlign: 'center', padding: '8px 0' }}>—</div>
                )}
                {cards.map((t) => (
                  <TaskCard
                    key={t.id}
                    task={t}
                    assigneeName={nameFor(t.assignee)}
                    nameFor={nameFor}
                    orphanReason={orphanReason(t)}
                    flashing={flashId === t.id}
                    blockers={(t.blockedBy ?? []).map((bid) => ({ id: bid, title: titleFor(bid) }))}
                    otherTasks={tasks.filter((x) => x.id !== t.id).map((x) => ({ id: x.id, title: x.title }))}
                    registerRef={(el) => { if (el) cardRefs.current.set(t.id, el); else cardRefs.current.delete(t.id); }}
                    onMove={(s) => moveTask(t.id, s)}
                    onAssign={() => assign(t)}
                    onJump={jumpTo}
                    onSetBlockedBy={(ids) => setBlockedBy(t.id, ids)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Card ────────────────────────────────────────────────────────────────────

function TaskCard({ task, assigneeName, nameFor, orphanReason, flashing, blockers, otherTasks, registerRef, onMove, onAssign, onJump, onSetBlockedBy }: {
  task: HiveTask;
  assigneeName?: string;
  nameFor: (id?: string) => string | undefined;
  orphanReason: string | null;
  flashing?: boolean;
  blockers: { id: string; title: string }[];
  otherTasks: { id: string; title: string }[];
  registerRef: (el: HTMLDivElement | null) => void;
  onMove: (s: Status) => void;
  onAssign: () => void;
  onJump: (id: string) => void;
  onSetBlockedBy: (ids: string[]) => void;
}) {
  const pr = Math.max(1, Math.min(5, task.priority));
  const [pickingBlocker, setPickingBlocker] = useState(false);
  const blockedSet = new Set(task.blockedBy ?? []);
  return (
    <div ref={registerRef} style={{
      padding: 7, background: 'var(--cth-paper-100)',
      boxShadow: flashing ? 'inset 0 0 0 2px var(--cth-lemon), 0 0 0 2px var(--cth-lemon)' : 'inset 0 0 0 1px var(--cth-ink-700)',
      transition: 'box-shadow 200ms', display: 'flex', flexDirection: 'column', gap: 5
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
        <PriorityDots level={pr} />
        <span style={{
          flex: 1, minWidth: 0, fontFamily: 'var(--cth-font-ui)', fontSize: 13,
          lineHeight: '16px', color: 'var(--cth-ink-900)'
        }}>{task.title}</span>
      </div>

      {/* Orphaned assignment: the assignee no longer fits (inactive / no edit role / off-project).
          "fix assignments" asks the god to reassign or unassign these. */}
      {orphanReason && (
        <div
          title="This card's assignee no longer fits — use 'fix assignments' to reassign or unassign it."
          style={{
            alignSelf: 'flex-start', padding: '1px 6px 0',
            background: 'var(--cth-coral-light)', boxShadow: 'inset 0 0 0 1px var(--cth-coral)',
            fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-900)'
          }}
        >⚠ {orphanReason}</div>
      )}

      {/* Blocked-by: a coral chip per blocker; clicking jumps to that card. */}
      {blockers.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: 'var(--cth-coral)' }}>⛔ blocked by</span>
          {blockers.map((b) => (
            <button
              key={b.id}
              onClick={() => onJump(b.id)}
              title={`Jump to "${b.title}"`}
              style={{
                maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                padding: '1px 6px 0', border: 'none', cursor: 'pointer',
                background: 'var(--cth-coral-light)', boxShadow: 'inset 0 0 0 1px var(--cth-coral)',
                fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-900)'
              }}
            >{b.title}</button>
          ))}
        </div>
      )}

      {/* Comment thread (reviewer feedback / test results) — newest 2, author + text. */}
      {task.comments && task.comments.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {task.comments.slice(-2).map((c, i) => (
            <div key={i} style={{
              padding: '3px 6px 2px', background: 'var(--cth-lilac-light)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', fontSize: 11, lineHeight: '15px',
              color: 'var(--cth-ink-900)'
            }}>
              <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-700)' }}>
                {(nameFor(c.by) ?? c.by).toUpperCase()}
              </span>
              <span style={{ marginLeft: 4 }}>{c.text}</span>
            </div>
          ))}
          {task.comments.length > 2 && (
            <span style={{ fontSize: 10, color: 'var(--cth-ink-300)' }}>+{task.comments.length - 2} earlier</span>
          )}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
        {assigneeName
          ? <PixelBadge status="working" label={assigneeName} />
          : <span style={{ fontSize: 11, color: 'var(--cth-ink-300)' }}>unassigned</span>}
        {task.dependsOn.length > 0 && (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 3, padding: '1px 6px 0',
            background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
            fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-700)'
          }} title={`Depends on ${task.dependsOn.length} task(s)`}>
            <Icon name="arrow-right" /> {task.dependsOn.length}
          </span>
        )}
        {task.status === 'blocked' && otherTasks.length > 0 && (
          <button
            onClick={() => setPickingBlocker((v) => !v)}
            title="Set what this card is blocked by"
            style={{
              padding: '1px 6px 0', border: 'none', cursor: 'pointer',
              background: pickingBlocker ? 'var(--cth-coral-light)' : 'var(--cth-cream-200)',
              boxShadow: `inset 0 0 0 1px ${pickingBlocker ? 'var(--cth-coral)' : 'var(--cth-ink-300)'}`,
              fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-700)'
            }}
          >blockers</button>
        )}
      </div>

      {pickingBlocker && (
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: 4, maxHeight: 84, overflowY: 'auto', padding: 4,
          background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
        }}>
          {otherTasks.map((o) => {
            const on = blockedSet.has(o.id);
            return (
              <button
                key={o.id}
                onClick={() => {
                  const next = on ? (task.blockedBy ?? []).filter((x) => x !== o.id) : [...(task.blockedBy ?? []), o.id];
                  onSetBlockedBy(next);
                }}
                title={o.title}
                style={{
                  maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  padding: '2px 7px 1px', border: 'none', cursor: 'pointer',
                  background: on ? 'var(--cth-coral)' : 'var(--cth-cream-200)',
                  boxShadow: `inset 0 0 0 1px ${on ? 'var(--cth-ink-900)' : 'var(--cth-ink-300)'}`,
                  fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-900)'
                }}
              >{o.title}</button>
            );
          })}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <select
          value={task.status}
          onChange={(e) => onMove(e.target.value as Status)}
          style={{
            flex: 1, padding: '2px 4px', background: 'var(--cth-paper-100)', border: 'none',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', fontFamily: 'var(--cth-font-ui)',
            fontSize: 11, color: 'var(--cth-ink-900)', cursor: 'pointer'
          }}
        >
          {COLUMNS.map((c) => (<option key={c.key} value={c.key}>{c.label.toLowerCase()}</option>))}
        </select>
        <PixelButton variant="secondary" size="sm" onClick={onAssign}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            <Icon name="arrow-right" /> assign
          </span>
        </PixelButton>
      </div>
    </div>
  );
}

// ─── SDDP feature phase banner ─────────────────────────────────────────────────

/** One feature's lifecycle tracker: the phase ladder (Specify → … → Integrate) with the
 *  current phase highlighted and completed phases ticked, derived from the on-disk markers.
 *  `status` null ⇒ the feature dir hasn't been created yet ("not started"). */
function FeatureBanner({ feature, status, cardCount, milestones, epicId, engine, onSetControl }: {
  feature: string;
  status: FeatureStatus | null;
  cardCount: number;
  milestones?: FeatureMilestone[] | null;
  epicId?: string | null;
  engine?: FeatureEngineStatus | null;
  onSetControl?: (epicId: string, stepKey: string, control: NonNullable<FeatureMilestone['control']>) => void;
}) {
  const phase = status ? featurePhase(status) : null;
  const reachedIdx = phase ? SDDP_PHASES.indexOf(phase) : -1;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span
          title={status ? `phase: ${phase}` : 'no specs/<feature>/ found yet — run Specify'}
          style={{ fontFamily: 'var(--cth-font-display)', fontSize: 9, color: 'var(--cth-ink-900)' }}
        >▸ {feature}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
          {SDDP_PHASES.map((p, i) => {
            const done = reachedIdx >= 0 && i < reachedIdx;
            const current = i === reachedIdx;
            return (
              <span key={p} style={{
                padding: '1px 6px 0', fontFamily: 'var(--cth-font-ui)', fontSize: 11,
                background: current ? 'var(--cth-lemon)' : done ? 'var(--cth-mint)' : 'var(--cth-cream-200)',
                boxShadow: `inset 0 0 0 1px ${current ? 'var(--cth-ink-900)' : 'var(--cth-ink-300)'}`,
                color: current || done ? 'var(--cth-ink-900)' : 'var(--cth-ink-500)'
              }}>{done ? '✓ ' : current ? '▶ ' : ''}{p}</span>
            );
          })}
        </span>
        {status?.hasClarifications && (
          <span title="spec.md has a ## Clarifications section" style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>clarified</span>
        )}
        <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{cardCount} card{cardCount === 1 ? '' : 's'}</span>
        {!status && <span style={{ fontSize: 11, color: 'var(--cth-ink-300)' }}>not started</span>}
      </div>
      {/* The feature epic card's milestone checklist (the gated sub-agent pipeline) — each pill shows
          its status + the host engine's live state, and (on the active step / any non-auto step) a
          control affordance: pause / stop (abort) / switch to manual / resume. */}
      {milestones && milestones.length > 0 && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', paddingLeft: 2 }}>
          {milestones.map((m) => {
            const ctrl = m.control ?? 'auto';
            const isActive = m.status === 'active';
            const eng = isActive && engine && engine.step === m.key ? engine.state : null;
            const bg = ctrl === 'stopped' ? 'var(--cth-coral)'
              : ctrl === 'manual' ? 'var(--cth-sky)'
              : ctrl === 'paused' ? 'var(--cth-cream-200)'
              : eng === 'blocked' ? 'var(--cth-coral)'
              : m.status === 'active' ? 'var(--cth-lemon)'
              : m.status === 'done' ? 'var(--cth-mint)' : 'var(--cth-cream-200)';
            const glyph = m.status === 'done' ? '✓ '
              : ctrl === 'paused' ? '⏸ ' : ctrl === 'stopped' ? '⏹ ' : ctrl === 'manual' ? '✋ '
              : m.status === 'active' ? '▶ ' : '· ';
            const engNote = eng === 'running' ? ' ⟳' : eng === 'blocked' ? ' ⚠' : eng === 'waiting' ? ' …' : '';
            const showCtl = !!onSetControl && !!epicId && (isActive || ctrl !== 'auto');
            const set = (c: NonNullable<FeatureMilestone['control']>) => { if (epicId) onSetControl?.(epicId, m.key, c); };
            const ctlBtn = (label: string, c: NonNullable<FeatureMilestone['control']>, t: string) => (
              <span role="button" title={t} onClick={() => set(c)}
                style={{ cursor: 'pointer', padding: '0 3px', fontSize: 10, color: 'var(--cth-ink-700)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)' }}>{label}</span>
            );
            return (
              <span key={m.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                <span title={`${m.label} — gate: specs/${feature}/${m.gateArtifact}${m.subAgent ? ` · ${m.subAgent}` : ''} · control: ${ctrl}${eng ? ` · engine: ${eng}${engine?.message ? ` (${engine.message})` : ''}` : ''}`} style={{
                  padding: '0 5px', fontFamily: 'var(--cth-font-ui)', fontSize: 10,
                  background: bg,
                  boxShadow: `inset 0 0 0 1px ${m.status === 'active' ? 'var(--cth-ink-900)' : 'var(--cth-ink-300)'}`,
                  color: m.status === 'pending' && ctrl === 'auto' ? 'var(--cth-ink-500)' : 'var(--cth-ink-900)'
                }}>{glyph}{m.label}{engNote}</span>
                {showCtl && (ctrl === 'auto'
                  ? <>{ctlBtn('⏸', 'paused', 'pause this step')}{ctlBtn('⏹', 'stopped', 'stop (abort the running sub-agent)')}{ctlBtn('✋', 'manual', 'switch to manual — a desk/human does this step')}</>
                  : ctlBtn('▶', 'auto', 'resume (back to auto)'))}
              </span>
            );
          })}
        </span>
      )}
    </div>
  );
}

function PriorityDots({ level }: { level: number }) {
  // 1 = lowest, 5 = highest. Warmer fill as priority climbs.
  const color = level >= 4 ? 'var(--cth-coral)' : level === 3 ? 'var(--cth-lemon)' : 'var(--cth-mint)';
  return (
    <span title={`Priority ${level}/5`} style={{ display: 'inline-flex', gap: 1, flexShrink: 0, marginTop: 2 }}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} style={{
          width: 4, height: 8,
          background: i <= level ? color : 'var(--cth-cream-200)',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
        }} />
      ))}
    </span>
  );
}

// ─── Add-task form ─────────────────────────────────────────────────────────--

function AddTaskForm({ agents, existing, sddpMode, onCancel, onCreate }: {
  agents: { id: string; name: string; isGod?: boolean }[];
  existing: HiveTask[];
  sddpMode: boolean;
  onCancel: () => void;
  onCreate: (t: HiveTask) => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assignee, setAssignee] = useState('');
  const [priority, setPriority] = useState(3);
  const [deps, setDeps] = useState<string[]>([]);
  const [feature, setFeature] = useState('');

  const submit = () => {
    if (!title.trim()) return;
    onCreate({
      id: shortId(),
      title: title.trim(),
      description: description.trim() || undefined,
      assignee: assignee || undefined,
      status: 'todo',
      dependsOn: deps,
      feature: sddpMode && feature.trim() ? feature.trim() : undefined,
      priority,
      createdAt: new Date().toISOString()
    });
  };

  const toggleDep = (id: string) => {
    setDeps((d) => (d.includes(id) ? d.filter((x) => x !== id) : [...d, id]));
  };

  return (
    <div style={{ padding: '0 10px 8px', flexShrink: 0 }}>
      <PixelPanel variant="inset" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); }}
          placeholder="Task title…"
          style={inputStyle}
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder="Description / context (optional)"
          style={{ ...inputStyle, resize: 'none', fontFamily: 'var(--cth-font-mono)' }}
        />
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={labelStyle}>assignee</label>
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)} style={selectStyle}>
            <option value="">unassigned</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}{a.isGod ? ' (god)' : ''}</option>
            ))}
          </select>
          <label style={labelStyle}>priority</label>
          <select value={String(priority)} onChange={(e) => setPriority(Number(e.target.value))} style={selectStyle}>
            {[1, 2, 3, 4, 5].map((p) => (<option key={p} value={p}>{p}</option>))}
          </select>
          {sddpMode && (
            <>
              <label style={labelStyle}>feature</label>
              <input
                value={feature}
                onChange={(e) => setFeature(e.target.value)}
                placeholder="00001-feature-name"
                style={{ ...selectStyle, width: 150 }}
                title="SDDP: the specs/<feature>/ folder this card belongs to (gates its lifecycle)"
              />
            </>
          )}
        </div>

        {existing.length > 0 && (
          <div>
            <div style={{ ...labelStyle, marginBottom: 4 }}>depends on</div>
            <div style={{
              display: 'flex', flexWrap: 'wrap', gap: 4, maxHeight: 84, overflowY: 'auto',
              padding: 4, background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
            }}>
              {existing.map((t) => {
                const on = deps.includes(t.id);
                return (
                  <button
                    key={t.id}
                    onClick={() => toggleDep(t.id)}
                    title={t.title}
                    style={{
                      maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      padding: '2px 7px 1px', border: 'none', cursor: 'pointer',
                      background: on ? 'var(--cth-sky)' : 'var(--cth-cream-200)',
                      boxShadow: `inset 0 0 0 1px ${on ? 'var(--cth-ink-900)' : 'var(--cth-ink-300)'}`,
                      fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-900)'
                    }}
                  >{t.title}</button>
                );
              })}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 6 }}>
          <PixelButton variant="primary" size="sm" onClick={submit} disabled={!title.trim()}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <Icon name="check" /> create
            </span>
          </PixelButton>
          <PixelButton variant="ghost" size="sm" onClick={onCancel}>cancel</PixelButton>
        </div>
      </PixelPanel>
    </div>
  );
}

const phaseBtnStyle: React.CSSProperties = {
  border: 'none', cursor: 'pointer', background: 'transparent', padding: '0 2px',
  fontSize: 11, lineHeight: '11px', color: 'var(--cth-ink-700)'
};

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '6px 8px', background: 'var(--cth-paper-100)', border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)', fontFamily: 'var(--cth-font-ui)',
  fontSize: 13, lineHeight: '17px', color: 'var(--cth-ink-900)', outline: 'none', boxSizing: 'border-box'
};

const selectStyle: React.CSSProperties = {
  padding: '3px 6px', background: 'var(--cth-paper-100)', border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)', fontFamily: 'var(--cth-font-ui)',
  fontSize: 12, color: 'var(--cth-ink-900)', cursor: 'pointer'
};

const labelStyle: React.CSSProperties = {
  fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-500)'
};
