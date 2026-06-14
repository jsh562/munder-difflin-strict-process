import { useState } from 'react';
import { AgentCard } from './AgentCard';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { ROLE_META } from './AgentRoleControl';
import { useStore, type Agent, type AgentRole } from '@/store/store';
import { buildSpawnCommand, type HarnessConfig } from '@/store/config';
import { displayStatus } from '@/lib/agentStatus';
import { scheduleDeskRestart } from '@/lib/restartDesk';
import { restartSigOf, deskStaleKeys, RESTART_SIG_LABELS } from '@/lib/restartSig';
import { groupAgents, roleCounts } from '@/lib/agentGroups';

export interface AgentStripProps {
  /** Needed to rebuild a spawn command when a restorable agent predates the
   *  persisted `command` field. Optional so the strip renders without config. */
  config?: HarnessConfig | null;
}

/** Stable order for the per-role count chips in a cluster header. */
const ROLE_ORDER: AgentRole[] = ['worker', 'reviewer', 'integrator', 'planner', 'qc'];
const LS_COLLAPSED = 'cth.collapsedAgentGroups';

function loadCollapsed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(LS_COLLAPSED);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch { return new Set(); }
}

export function AgentStrip({ config }: AgentStripProps) {
  const agents = useStore(s => s.agents);
  const restorableAgents = useStore(s => s.restorableAgents);
  const selectedId = useStore(s => s.selectedId);
  const select = useStore(s => s.select);
  const setAddAgentOpen = useStore(s => s.setAddAgentOpen);
  const paused = useStore(s => s.paused);
  const godDesired = useStore(s => s.godDesired);
  const liveness = useStore(s => s.liveness);
  // Live restart-required settings ([[restartSig]]) — a desk whose spawn snapshot differs is
  // running with outdated settings and gets a ⟳ "restart to apply" marker on its card.
  const liveSig = restartSigOf({
    sddpMode: useStore(s => s.sddpMode),
    autoMode: useStore(s => s.autoMode),
    terminalTheme: useStore(s => s.terminalTheme)
  });
  const [restoring, setRestoring] = useState(false);
  // Per-project collapse state (persisted) — the "without crowding" lever: fold projects you're
  // not watching down to a one-line header + counts.
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const toggleCollapsed = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      try { window.localStorage.setItem(LS_COLLAPSED, JSON.stringify([...next])); } catch { /* noop */ }
      return next;
    });
  };

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
          // Re-request isolation if the agent ran in its own worktree before —
          // the old worktree was torn down on exit, so a fresh one is created.
          isolate: !!a.worktreePath,
          hive: { id: a.id, name: a.name, cwd: a.cwd, role: a.description }
        });
        if (res.ok) {
          useStore.getState().addAgent({
            ...a,
            ptyId,
            archived: false,
            status: 'idle',
            action: 'starting up',
            carrying: undefined,
            currentStation: 'desk',
            // Freshly spawned under the CURRENT config — drop the old snapshot so addAgent
            // re-stamps spawnSig from the live mirror (don't carry a stale "needs restart").
            spawnSig: undefined,
            recentTextTs: Date.now()
          });
        } else {
          // Leave it restorable so the user can retry; don't block the rest.
          console.error('[restore] spawn failed for', a.id, res.error);
        }
      }
    } finally {
      // addAgent auto-selects each spawn; put the user back where they were.
      const sel = useStore.getState();
      if (prevSel && sel.agents.some((x) => x.id === prevSel)) sel.select(prevSel);
      setRestoring(false);
    }
  };

  const renderCard = (a: Agent) => {
    const staleKeys = a.isAssistant ? [] : deskStaleKeys(a.spawnSig, liveSig);
    return (
      <AgentCard
        key={a.id}
        name={a.name}
        character={a.character}
        accent={a.accent}
        status={displayStatus(a, !!paused[a.id], godDesired)}
        project={a.project}
        action={a.action}
        progress={a.progress}
        contextTokens={a.contextTokens}
        contextLimit={a.contextLimit}
        selected={a.id === selectedId}
        isGod={a.isGod}
        isAssistant={a.isAssistant}
        needsRestart={staleKeys.length > 0}
        needsRestartReason={staleKeys.length > 0
          ? `Changed since this desk spawned: ${staleKeys.map((k) => RESTART_SIG_LABELS[k]).join(', ')} — click to restart and apply`
          : undefined}
        onRestart={() => scheduleDeskRestart(a.id)}
        warm={a.id in liveness ? liveness[a.id] : undefined}
        onClick={() => select(a.id)}
      />
    );
  };

  const groups = groupAgents(agents);

  return (
    <div style={{
      display: 'flex',
      gap: 14,
      padding: '8px 16px',
      overflowX: 'auto',
      overflowY: 'hidden',
      borderTop: '2px solid var(--cth-ink-900)',
      background: 'var(--cth-cream-200)',
      height: 144,
      minHeight: 144,
      alignItems: 'stretch'
    }}>
      {groups.map((g) => {
        const isCollapsed = collapsed.has(g.key);
        const counts = roleCounts(g.agents);
        return (
          <div key={g.key} style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
            {/* Cluster header: project name + per-role count chips + collapse toggle. The counts
                are the at-a-glance "how many agents per role per project". */}
            <button
              onClick={() => toggleCollapsed(g.key)}
              title={isCollapsed ? 'Expand — show desks' : 'Collapse — hide desks'}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '2px 6px',
                background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left',
                boxShadow: 'inset 0 -1px 0 var(--cth-ink-300)'
              }}
            >
              <span style={{ fontSize: 9, color: 'var(--cth-ink-500)', flexShrink: 0, width: 8 }}>{isCollapsed ? '▸' : '▾'}</span>
              <span style={{
                fontFamily: 'var(--cth-font-display)', fontSize: 9, color: 'var(--cth-ink-900)',
                whiteSpace: 'nowrap', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis'
              }}>{g.label}</span>
              <span style={{ fontSize: 10, color: 'var(--cth-ink-500)' }}>({g.agents.length})</span>
              {/* Per-role count chips (only roles actually held; adapts to standard vs SDDP). */}
              <span style={{ display: 'inline-flex', gap: 3, alignItems: 'center' }}>
                {ROLE_ORDER.filter((r) => (counts[r] ?? 0) > 0).map((r) => (
                  <span
                    key={r}
                    title={`${counts[r]} ${r}`}
                    style={{
                      display: 'inline-flex', alignItems: 'center', padding: '0 4px', height: 14,
                      background: ROLE_META[r].on, boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)',
                      fontFamily: 'var(--cth-font-ui)', fontSize: 10, lineHeight: '14px', color: 'var(--cth-ink-900)'
                    }}
                  >{ROLE_META[r].abbr}{counts[r]}</span>
                ))}
              </span>
            </button>

            {/* Desks for this cluster (hidden when collapsed). */}
            {!isCollapsed && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                {g.agents.map(renderCard)}
              </div>
            )}
          </div>
        );
      })}

      {/* Trailing controls — restore the previous session's team + add a new desk. */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', alignSelf: 'center', flexShrink: 0 }}>
        {restorableAgents.length > 0 && (
          <span
            title={`Respawn from last session: ${restorableAgents.map((a: Agent) => a.name).join(', ')} — same ids, memory and inboxes reattach automatically`}
          >
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
    </div>
  );
}
