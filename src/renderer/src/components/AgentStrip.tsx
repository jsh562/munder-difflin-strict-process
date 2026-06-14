import { useEffect, useState } from 'react';
import { PixelButton } from './PixelButton';
import { PixelBadge } from './PixelBadge';
import { Icon } from './Icon';
import { ROLE_META } from './AgentRoleControl';
import { useStore, type Agent, type AgentRole } from '@/store/store';
import { buildSpawnCommand, type HarnessConfig } from '@/store/config';
import { displayStatus, bucketCounts, CELL_BUCKET_ORDER, type CellBucket } from '@/lib/agentStatus';
import { scheduleDeskRestart } from '@/lib/restartDesk';
import { restartSigOf, deskStaleKeys } from '@/lib/restartSig';
import { groupAgents, effectiveRoles, FLOOR_GROUP, type AgentGroup } from '@/lib/agentGroups';

export interface AgentStripProps {
  /** Needed to rebuild a spawn command when a restorable agent predates the
   *  persisted `command` field. Optional so the strip renders without config. */
  config?: HarnessConfig | null;
  /** Called with the new config after the strip registers a project repo, so the parent's
   *  config (and thus the matrix's empty-repo rows + Add-Agent quick-picks) updates live. */
  onConfigChange?: (config: HarnessConfig) => void;
}

/** Last path segment (handles both separators) — a project repo's display name. */
function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

/** Status-bucket → swatch color for the per-cell mini bar + legend. `cold` (parked, revive-on-
 *  demand) reads as a hollow grey; the rest reuse the shared --cth-status-* palette. */
const BUCKET_COLOR: Record<CellBucket, string> = {
  working: 'var(--cth-status-working)',
  waiting: 'var(--cth-status-waiting)',
  blocked: 'var(--cth-status-blocked)',
  looping: 'var(--cth-status-looping)',
  compacting: 'var(--cth-status-compacting)',
  idle: 'var(--cth-status-idle)',
  cold: 'var(--cth-ink-300)'
};
const BUCKET_LABEL: Record<CellBucket, string> = {
  working: 'working', waiting: 'waiting', blocked: 'needs you',
  looping: 'looping', compacting: 'compacting', idle: 'idle', cold: 'cold'
};
/** Buckets shown in the always-on legend (the common ones). */
const LEGEND_BUCKETS: CellBucket[] = ['working', 'idle', 'waiting', 'blocked', 'cold'];

/** A matrix column. `god`/`assistant` are IDENTITY columns (always shown so a roleless god or the
 *  prep assistant is still visible); the rest are capability ROLE columns, in workflow order. */
type Col =
  | { kind: 'god'; label: string; bg: string }
  | { kind: 'assistant'; label: string; bg: string }
  | { kind: 'role'; role: AgentRole; label: string; bg: string };

/** Capability roles in WORKFLOW order (planner→…→integrate); planner/qc only in SDDP mode. */
const SDDP_ROLE_FLOW: AgentRole[] = ['planner', 'worker', 'reviewer', 'qc', 'integrator'];
const STD_ROLE_FLOW: AgentRole[] = ['worker', 'reviewer', 'integrator'];

/** An open matrix cell → the flyout listing its desks. `col: 'all'` = the row label (all desks). */
interface OpenCell { group: AgentGroup; col: Col | 'all'; rect: DOMRect; }

export function AgentStrip({ config, onConfigChange }: AgentStripProps) {
  const agents = useStore(s => s.agents);
  const restorableAgents = useStore(s => s.restorableAgents);
  const selectedId = useStore(s => s.selectedId);
  const select = useStore(s => s.select);
  const setAddAgentOpen = useStore(s => s.setAddAgentOpen);
  const openAddAgentForRepo = useStore(s => s.openAddAgentForRepo);
  const paused = useStore(s => s.paused);
  const godDesired = useStore(s => s.godDesired);
  const liveness = useStore(s => s.liveness);
  const sddpMode = useStore(s => s.sddpMode);
  const autoMode = useStore(s => s.autoMode);
  const terminalTheme = useStore(s => s.terminalTheme);
  const liveSig = restartSigOf({ sddpMode, autoMode, terminalTheme });
  const [restoring, setRestoring] = useState(false);
  const [open, setOpen] = useState<OpenCell | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  /** Respawn every worker from the previous session with its ORIGINAL agent id,
   *  cwd, model and command — the hive workspace reattaches by itself. */
  const restoreTeam = async () => {
    if (restoring) return;
    setRestoring(true);
    const prevSel = useStore.getState().selectedId;
    try {
      for (const a of [...restorableAgents]) {
        const command = (a.command ?? '').trim() || (config ? buildSpawnCommand(config, a.model) : '');
        if (!command || !a.cwd) { useStore.getState().removeRestorableAgent(a.id); continue; }
        const [exe, ...args] = command.split(/\s+/);
        const ptyId = a.ptyId ?? `pty-${a.id}`;
        const res = await window.cth.spawnPty({
          id: ptyId, cwd: a.cwd, command: exe, args, cols: 100, rows: 30,
          isolate: !!a.worktreePath,
          hive: { id: a.id, name: a.name, cwd: a.cwd, role: a.description }
        });
        if (res.ok) {
          useStore.getState().addAgent({
            ...a, ptyId, archived: false, status: 'idle', action: 'starting up',
            carrying: undefined, currentStation: 'desk', spawnSig: undefined, recentTextTs: Date.now()
          });
        } else {
          console.error('[restore] spawn failed for', a.id, res.error);
        }
      }
    } finally {
      const sel = useStore.getState();
      if (prevSel && sel.agents.some((x) => x.id === prevSel)) sel.select(prevSel);
      setRestoring(false);
    }
  };

  // Every registered project repo gets a row (empty until staffed) — the matrix doubles as a
  // projects board. Keyed by repo basename (matching agent.project).
  const registeredRepos = config?.registeredRepos ?? [];
  const groups = groupAgents(agents, registeredRepos.map(basename));
  const roleFlow = sddpMode ? SDDP_ROLE_FLOW : STD_ROLE_FLOW;

  // Resolve a group's project-repo PATH (for "add agent here"): an occupied row from its first
  // desk's cwd (the renderer record holds the repo, not the worktree); an empty registered row by
  // matching basename. null for FLOOR or an unresolvable group.
  const groupRepoPath = (g: AgentGroup): string | null =>
    g.key === FLOOR_GROUP ? null
    : g.agents[0]?.cwd ?? registeredRepos.find((r) => basename(r) === g.key) ?? null;

  const addProjectRepo = async () => {
    const res = await window.cth.chooseFolder();
    if (!res.ok || registeredRepos.includes(res.path)) return;
    const next = await window.cth.updateConfig({ registeredRepos: [...registeredRepos, res.path] });
    onConfigChange?.(next);
  };
  // Columns in WORKFLOW order: god → (planner →) worker → reviewer → (qc →) integrator → assistant.
  const cols: Col[] = [
    { kind: 'god', label: 'god', bg: 'var(--cth-lemon)' },
    ...roleFlow.map((r): Col => ({ kind: 'role', role: r, label: ROLE_META[r].abbr, bg: ROLE_META[r].on })),
    { kind: 'assistant', label: 'ast', bg: 'var(--cth-cream-200)' }
  ];
  const gridCols = `minmax(60px, max-content) repeat(${cols.length}, 30px)`;

  // god/assistant get their own (identity) columns; role columns exclude them (no double-count).
  const agentsFor = (g: AgentGroup, c: Col | 'all'): Agent[] =>
    c === 'all' ? g.agents
    : c.kind === 'god' ? g.agents.filter((a) => a.isGod)
    : c.kind === 'assistant' ? g.agents.filter((a) => a.isAssistant)
    : g.agents.filter((a) => !a.isGod && !a.isAssistant && effectiveRoles(a).includes(c.role));

  const colLabel = (c: Col | 'all') => c === 'all' ? 'all' : c.kind === 'role' ? c.role : c.kind;

  const cell = (g: AgentGroup, c: Col) => {
    const list = agentsFor(g, c);
    const count = list.length;
    if (count === 0) return <span style={{ color: 'var(--cth-ink-300)', fontSize: 11 }}>·</span>;
    const isOpen = open?.group.key === g.key && open?.col !== 'all' && open?.col.kind === c.kind &&
      (c.kind !== 'role' || (open.col.kind === 'role' && open.col.role === c.role));
    // Status mix → a thin proportional bar under the count; tooltip carries the breakdown.
    const counts = bucketCounts(list, paused, godDesired, liveness);
    const segs = CELL_BUCKET_ORDER.filter((b) => (counts[b] ?? 0) > 0);
    const breakdown = segs.map((b) => `${counts[b]} ${BUCKET_LABEL[b]}`).join(', ');
    return (
      <button
        onClick={(e) => setOpen({ group: g, col: c, rect: e.currentTarget.getBoundingClientRect() })}
        title={`${count} ${colLabel(c)} in ${g.label} — ${breakdown} — click to list`}
        style={{
          width: '100%', height: 24, border: 'none', cursor: 'pointer', padding: '1px 0 0',
          display: 'flex', flexDirection: 'column', alignItems: 'stretch', justifyContent: 'center', gap: 1,
          background: isOpen ? 'var(--cth-lemon)' : 'var(--cth-paper-100)',
          boxShadow: `inset 0 0 0 1px ${isOpen ? 'var(--cth-ink-900)' : 'var(--cth-ink-300)'}`,
          fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-900)'
        }}
      >
        <span style={{ lineHeight: '12px', textAlign: 'center' }}>{count}</span>
        <span style={{ display: 'flex', width: '100%', height: 3, gap: 0.5 }} aria-hidden>
          {segs.map((b) => (
            <span key={b} style={{ flexGrow: counts[b] ?? 0, flexBasis: 0, background: BUCKET_COLOR[b] }} />
          ))}
        </span>
      </button>
    );
  };

  const flyoutAgents = open ? agentsFor(open.group, open.col) : [];

  return (
    <div style={{
      display: 'flex', gap: 16, padding: '8px 16px', overflowX: 'auto', overflowY: 'hidden',
      borderTop: '2px solid var(--cth-ink-900)', background: 'var(--cth-cream-200)',
      height: 144, minHeight: 144, alignItems: 'stretch'
    }}>
      {/* Project × role count matrix — compact overview; desks revealed on click (flyout). */}
      <div style={{ overflowY: 'auto', overflowX: 'hidden', flexShrink: 0 }}>
        <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 3, alignItems: 'center' }}>
          {/* Header row: corner label, then each column chip (god + workflow roles + assistant). */}
          <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-500)' }}>PROJECT REPO</span>
          {cols.map((c, i) => (
            <span key={i} title={c.kind === 'god' ? 'god / orchestrator' : c.kind === 'assistant' ? 'prep assistant' : c.role} style={{
              justifySelf: 'stretch', textAlign: 'center', padding: '1px 0', height: 16,
              background: c.bg, boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)',
              fontFamily: 'var(--cth-font-ui)', fontSize: c.kind === 'role' ? 10 : 9, lineHeight: '14px', color: 'var(--cth-ink-900)'
            }}>{c.label}</span>
          ))}

          {/* One row per group: a clickable label (→ all desks) + a count per column. */}
          {groups.map((g) => [
            <button
              key={`${g.key}-label`}
              onClick={(e) => setOpen({ group: g, col: 'all', rect: e.currentTarget.getBoundingClientRect() })}
              title={`${g.agents.length} desk(s) in ${g.label} — click to list all`}
              style={{
                border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left', padding: '0 4px 0 0',
                fontFamily: 'var(--cth-font-display)', fontSize: 9, color: 'var(--cth-ink-900)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 160
              }}
            >{g.label}</button>,
            ...cols.map((c, i) => (
              <span key={`${g.key}-${i}`} style={{ justifySelf: 'stretch', textAlign: 'center' }}>{cell(g, c)}</span>
            ))
          ])}
        </div>
        {/* Status legend — what the per-cell mini bar colors mean. */}
        <div style={{ display: 'flex', gap: 8, marginTop: 5, flexWrap: 'wrap' }}>
          {LEGEND_BUCKETS.map((b) => (
            <span key={b} style={{ display: 'inline-flex', gap: 3, alignItems: 'center', fontSize: 9, color: 'var(--cth-ink-500)' }}>
              <span style={{ width: 7, height: 7, background: BUCKET_COLOR[b], boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)' }} />
              {BUCKET_LABEL[b]}
            </span>
          ))}
        </div>
      </div>

      {/* Trailing controls — restore the previous session's team + register a repo + add a desk. */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', alignSelf: 'center', flexShrink: 0 }}>
        {restorableAgents.length > 0 && (
          <span title={`Respawn from last session: ${restorableAgents.map((a: Agent) => a.name).join(', ')} — same ids, memory and inboxes reattach automatically`}>
            <PixelButton variant="primary" size="lg" onClick={restoreTeam} disabled={restoring}>
              <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                <Icon name="play" /> {restoring ? 'restoring…' : `restore team (${restorableAgents.length})`}
              </span>
            </PixelButton>
          </span>
        )}
        <PixelButton variant="secondary" size="lg" onClick={() => void addProjectRepo()}>
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <Icon name="plus" /> project repo
          </span>
        </PixelButton>
        <PixelButton variant="secondary" size="lg" onClick={() => setAddAgentOpen(true)}>
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <Icon name="plus" /> add agent
          </span>
        </PixelButton>
      </div>

      {/* Desk flyout: the agents behind the clicked count. Click one → select (sidebar detail). */}
      {open && (
        <>
          <div onClick={() => setOpen(null)} style={{ position: 'fixed', inset: 0, zIndex: 240 }} />
          <div style={{
            position: 'fixed', zIndex: 241,
            left: Math.min(open.rect.left, window.innerWidth - 240),
            bottom: window.innerHeight - open.rect.top + 4,
            width: 224, maxHeight: 280, overflowY: 'auto',
            background: 'var(--cth-paper-100)', boxShadow: '0 0 0 1.5px var(--cth-ink-900), 4px 4px 0 var(--cth-ink-900)',
            padding: 6, display: 'flex', flexDirection: 'column', gap: 3
          }}>
            <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-500)', padding: '0 2px 2px' }}>
              {open.group.label} · {colLabel(open.col)} ({flyoutAgents.length})
            </div>
            {flyoutAgents.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--cth-ink-500)', padding: '2px 4px 4px' }}>
                no desks here yet
              </div>
            )}
            {/* Staff this project repo in one click — opens Add-Agent preselected to it. */}
            {open.group.key !== FLOOR_GROUP && groupRepoPath(open.group) && (
              <PixelButton variant="secondary" size="sm" onClick={() => { openAddAgentForRepo(groupRepoPath(open.group)!); setOpen(null); }}>
                <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                  <Icon name="plus" /> add agent here
                </span>
              </PixelButton>
            )}
            {flyoutAgents.map((a) => {
              const warm = a.id in liveness ? liveness[a.id] : undefined;
              const stale = !a.isAssistant && deskStaleKeys(a.spawnSig, liveSig).length > 0;
              return (
                <button
                  key={a.id}
                  onClick={() => { select(a.id); setOpen(null); }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, padding: '3px 5px', border: 'none', cursor: 'pointer',
                    textAlign: 'left', width: '100%',
                    background: a.id === selectedId ? 'var(--cth-cream-200)' : 'transparent',
                    boxShadow: a.id === selectedId ? 'inset 0 0 0 1px var(--cth-ink-700)' : 'none'
                  }}
                >
                  {warm !== undefined && (
                    <span title={warm ? 'warm — live worker' : 'cold — wakes on delegation'} style={{
                      width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                      background: warm ? 'var(--cth-mint)' : 'transparent',
                      boxShadow: `inset 0 0 0 ${warm ? 1 : 1.5}px ${warm ? 'var(--cth-ink-900)' : 'var(--cth-ink-500)'}`
                    }} />
                  )}
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--cth-ink-900)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.name}</span>
                  {stale && (
                    <span role="button" tabIndex={-1} title="Settings changed since spawn — click to restart"
                      onClick={(e) => { e.stopPropagation(); scheduleDeskRestart(a.id); }}
                      style={{ fontSize: 10, color: 'var(--cth-coral)', cursor: 'pointer', flexShrink: 0 }}>⟳</span>
                  )}
                  <PixelBadge status={displayStatus(a, !!paused[a.id], godDesired)} />
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
