import { useCallback, useEffect, useRef, useState } from 'react';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { PixelBadge } from './PixelBadge';
import { Icon } from './Icon';
import { useStore } from '@/store/store';

/** A card on the task kanban. Mirrors HiveTask in the main/preload process —
 *  re-declared locally so the renderer doesn't reach into the preload package
 *  (same convention as store/config.ts). Structurally compatible with
 *  window.cth.hiveWriteTasks. */
export interface HiveTask {
  id: string;
  title: string;
  description?: string;
  assignee?: string;
  status: 'todo' | 'doing' | 'blocked' | 'review' | 'done';
  dependsOn: string[];
  priority: number;
  createdAt: string;
}

type Status = HiveTask['status'];

const COLUMNS: { key: Status; label: string; accent: string }[] = [
  { key: 'todo',    label: 'TODO',    accent: 'var(--cth-sky)' },
  { key: 'doing',   label: 'DOING',   accent: 'var(--cth-lemon)' },
  { key: 'blocked', label: 'BLOCKED', accent: 'var(--cth-coral)' },
  // The worker→god hand-off lane: a worker moves a finished card here; the god verifies
  // and advances it to DONE (or reopens it).
  { key: 'review',  label: 'REVIEW',  accent: 'var(--cth-lilac)' },
  { key: 'done',    label: 'DONE',    accent: 'var(--cth-mint)' }
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
      status: (['todo', 'doing', 'blocked', 'review', 'done'] as const).includes(t.status as Status)
        ? (t.status as Status) : 'todo',
      dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.filter((d): d is string => typeof d === 'string') : [],
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
  const [tasks, setTasks] = useState<HiveTask[]>([]);
  const [adding, setAdding] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try { setTasks(parseTasks(await window.cth.hiveTasks())); } catch { /* keep last good */ }
  }, []);

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
    persist(tasks.map((t) => (t.id === id ? { ...t, status } : t)));
  }, [tasks, persist]);

  const assign = useCallback((t: HiveTask) => {
    const desc = t.description?.trim() ? t.description.trim() : '(no description)';
    onAssign(`Task: ${t.title}\nContext: ${desc}\n`);
  }, [onAssign]);

  const nameFor = (id?: string): string | undefined =>
    id ? (agents.find((a) => a.id === id)?.name ?? id) : undefined;

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
        <PixelButton
          variant={adding ? 'secondary' : 'primary'}
          size="sm"
          onClick={() => setAdding((v) => !v)}
          style={{ marginLeft: 'auto' }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Icon name={adding ? 'x' : 'plus'} /> {adding ? 'cancel' : 'add task'}
          </span>
        </PixelButton>
      </div>

      {adding && (
        <AddTaskForm
          agents={agents}
          existing={tasks}
          onCancel={() => setAdding(false)}
          onCreate={addTask}
        />
      )}

      {/* Columns */}
      <div style={{
        flex: 1, minHeight: 0, display: 'flex', gap: 8, padding: 10, overflowX: 'auto'
      }}>
        {COLUMNS.map((col) => {
          const cards = tasks.filter((t) => t.status === col.key);
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
                    onMove={(s) => moveTask(t.id, s)}
                    onAssign={() => assign(t)}
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

function TaskCard({ task, assigneeName, onMove, onAssign }: {
  task: HiveTask;
  assigneeName?: string;
  onMove: (s: Status) => void;
  onAssign: () => void;
}) {
  const pr = Math.max(1, Math.min(5, task.priority));
  return (
    <div style={{
      padding: 7, background: 'var(--cth-paper-100)',
      boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)', display: 'flex', flexDirection: 'column', gap: 5
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
        <PriorityDots level={pr} />
        <span style={{
          flex: 1, minWidth: 0, fontFamily: 'var(--cth-font-ui)', fontSize: 13,
          lineHeight: '16px', color: 'var(--cth-ink-900)'
        }}>{task.title}</span>
      </div>

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
      </div>

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

function AddTaskForm({ agents, existing, onCancel, onCreate }: {
  agents: { id: string; name: string; isGod?: boolean }[];
  existing: HiveTask[];
  onCancel: () => void;
  onCreate: (t: HiveTask) => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assignee, setAssignee] = useState('');
  const [priority, setPriority] = useState(3);
  const [deps, setDeps] = useState<string[]>([]);

  const submit = () => {
    if (!title.trim()) return;
    onCreate({
      id: shortId(),
      title: title.trim(),
      description: description.trim() || undefined,
      assignee: assignee || undefined,
      status: 'todo',
      dependsOn: deps,
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
