import { useEffect, useState } from 'react';
import { PixelButton } from './PixelButton';
import { PixelBadge } from './PixelBadge';
import { Icon } from './Icon';
import { ROLE_META } from './AgentRoleControl';
import { useStore, type Agent, type AgentRole } from '@/store/store';
import { buildSpawnCommand, type HarnessConfig } from '@/store/config';
import { displayStatus } from '@/lib/agentStatus';
import { scheduleDeskRestart } from '@/lib/restartDesk';
import { restartSigOf, deskStaleKeys } from '@/lib/restartSig';
import { groupAgents, roleCounts, agentsInRole, type AgentGroup } from '@/lib/agentGroups';

export interface AgentStripProps {
  /** Needed to rebuild a spawn command when a restorable agent predates the
   *  persisted `command` field. Optional so the strip renders without config. */
  config?: HarnessConfig | null;
}

/** Column order for the role grid; planner/qc only appear in SDDP mode. */
const ROLE_ORDER: AgentRole[] = ['worker', 'reviewer', 'integrator', 'planner', 'qc'];

/** An open matrix cell → the flyout listing its desks. `role: null` = the Σ (all desks in the row). */
interface OpenCell { group: AgentGroup; role: AgentRole | null; rect: DOMRect; }

export function AgentStrip({ config }: AgentStripProps) {
  const agents = useStore(s => s.agents);
  const restorableAgents = useStore(s => s.restorableAgents);
  const selectedId = useStore(s => s.selectedId);
  const select = useStore(s => s.select);
  const setAddAgentOpen = useStore(s => s.setAddAgentOpen);
  const paused = useStore(s => s.paused);
  const godDesired = useStore(s => s.godDesired);
  const liveness = useStore(s => s.liveness);
  const sddpMode = useStore(s => s.sddpMode);
  const autoMode = useStore(s => s.autoMode);
  const terminalTheme = useStore(s => s.terminalTheme);
  const liveSig = restartSigOf({ sddpMode, autoMode, terminalTheme });
  const [restoring, setRestoring] = useState(false);
  const [open, setOpen] = useState<OpenCell | null>(null);

  // Close the desk flyout on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  /** Respawn every worker from the previous session with its ORIGINAL agent id,
   *  cwd, model and command — the hive workspace (memory.md, inbox, registry
   *  entry) reattaches by itself, no memory transplant needed. */
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
          id: ptyId,
          cwd: a.cwd,
          command: exe,
          args,
          cols: 100,
          rows: 30,
          isolate: !!a.worktreePath,
          hive: { id: a.id, name: a.name, cwd: a.cwd, role: a.description }
        });
        if (res.ok) {
          useStore.getState().addAgent({
            ...a, ptyId, archived: false, status: 'idle', action: 'starting up',
            carrying: undefined, currentStation: 'desk',
            // Freshly spawned under the CURRENT config — drop the old snapshot so addAgent
            // re-stamps spawnSig from the live mirror (don't carry a stale "needs restart").
            spawnSig: undefined, recentTextTs: Date.now()
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

  const groups = groupAgents(agents);
  const roleCols = ROLE_ORDER.filter((r) => sddpMode || (r !== 'planner' && r !== 'qc'));
  // grid: project label | one column per role | Σ total.
  const gridCols = `minmax(64px, max-content) repeat(${roleCols.length}, 30px) 34px`;

  const openFlyout = (group: AgentGroup, role: AgentRole | null, e: React.MouseEvent) =>
    setOpen({ group, role, rect: e.currentTarget.getBoundingClientRect() });

  /** A clickable count cell. Dim "·" when zero (not clickable). */
  const cell = (group: AgentGroup, role: AgentRole | null, count: number) => {
    if (count === 0) return <span style={{ color: 'var(--cth-ink-300)', fontSize: 11 }}>·</span>;
    const isOpen = open?.group.key === group.key && open?.role === role;
    return (
      <button
        onClick={(e) => openFlyout(group, role, e)}
        title={`${count} ${role ?? 'desk(s)'} in ${group.label} — click to list`}
        style={{
          width: '100%', height: 20, border: 'none', cursor: 'pointer',
          background: isOpen ? 'var(--cth-lemon)' : 'var(--cth-paper-100)',
          boxShadow: `inset 0 0 0 1px ${isOpen ? 'var(--cth-ink-900)' : 'var(--cth-ink-300)'}`,
          fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-900)'
        }}
      >{count}</button>
    );
  };

  const flyoutAgents = open ? (open.role ? agentsInRole(open.group.agents, open.role) : open.group.agents) : [];

  return (
    <div style={{
      display: 'flex', gap: 16, padding: '8px 16px', overflowX: 'auto', overflowY: 'hidden',
      borderTop: '2px solid var(--cth-ink-900)', background: 'var(--cth-cream-200)',
      height: 144, minHeight: 144, alignItems: 'stretch'
    }}>
      {/* Project × role count matrix — compact overview; agents revealed on click (flyout). */}
      <div style={{ overflowY: 'auto', overflowX: 'hidden', flexShrink: 0 }}>
        <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 3, alignItems: 'center' }}>
          {/* Header row: blank corner, role chips, Σ. */}
          <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-500)' }}>PROJECT</span>
          {roleCols.map((r) => (
            <span key={r} title={r} style={{
              justifySelf: 'stretch', textAlign: 'center', padding: '1px 0', height: 16,
              background: ROLE_META[r].on, boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)',
              fontFamily: 'var(--cth-font-ui)', fontSize: 10, lineHeight: '14px', color: 'var(--cth-ink-900)'
            }}>{ROLE_META[r].abbr}</span>
          ))}
          <span title="all desks" style={{ textAlign: 'center', fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-500)' }}>Σ</span>

          {/* One row per group: label, per-role counts, Σ total. */}
          {groups.map((g) => {
            const counts = roleCounts(g.agents);
            return [
              <span key={`${g.key}-label`} title={g.label} style={{
                fontFamily: 'var(--cth-font-display)', fontSize: 9, color: 'var(--cth-ink-900)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 160, paddingRight: 4
              }}>{g.label}</span>,
              ...roleCols.map((r) => (
                <span key={`${g.key}-${r}`} style={{ justifySelf: 'stretch', textAlign: 'center' }}>
                  {cell(g, r, counts[r] ?? 0)}
                </span>
              )),
              <span key={`${g.key}-sum`} style={{ justifySelf: 'stretch', textAlign: 'center' }}>
                {cell(g, null, g.agents.length)}
              </span>
            ];
          })}
        </div>
      </div>

      {/* Trailing controls — restore the previous session's team + add a new desk. */}
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
              {open.group.label} · {open.role ?? 'all'} ({flyoutAgents.length})
            </div>
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
                    <span
                      role="button" tabIndex={-1}
                      title="Settings changed since spawn — click to restart"
                      onClick={(e) => { e.stopPropagation(); scheduleDeskRestart(a.id); }}
                      style={{ fontSize: 10, color: 'var(--cth-coral)', cursor: 'pointer', flexShrink: 0 }}
                    >⟳</span>
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
