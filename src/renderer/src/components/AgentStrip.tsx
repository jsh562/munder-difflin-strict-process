import { useState } from 'react';
import { AgentCard } from './AgentCard';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { useStore, type Agent } from '@/store/store';
import { buildSpawnCommand, type HarnessConfig } from '@/store/config';
import { displayStatus } from '@/lib/agentStatus';
import { scheduleDeskRestart } from '@/lib/restartDesk';
import { restartSigOf, deskStaleKeys, RESTART_SIG_LABELS } from '@/lib/restartSig';

export interface AgentStripProps {
  /** Needed to rebuild a spawn command when a restorable agent predates the
   *  persisted `command` field. Optional so the strip renders without config. */
  config?: HarnessConfig | null;
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

  return (
    <div style={{
      display: 'flex',
      gap: 12,
      padding: '12px 16px',
      overflowX: 'auto',
      overflowY: 'hidden',
      borderTop: '2px solid var(--cth-ink-900)',
      background: 'var(--cth-cream-200)',
      height: 124,
      minHeight: 124,
      alignItems: 'center'
    }}>
      {[...agents.filter(a => a.isGod), ...agents.filter(a => !a.isGod)].map(a => {
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
      })}
      {restorableAgents.length > 0 && (
        <span
          style={{ alignSelf: 'center', flexShrink: 0 }}
          title={`Respawn from last session: ${restorableAgents.map((a: Agent) => a.name).join(', ')} — same ids, memory and inboxes reattach automatically`}
        >
          <PixelButton
            variant="primary"
            size="lg"
            onClick={restoreTeam}
            disabled={restoring}
          >
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <Icon name="play" /> {restoring ? 'restoring…' : `restore team (${restorableAgents.length})`}
            </span>
          </PixelButton>
        </span>
      )}
      <PixelButton
        variant="secondary"
        size="lg"
        style={{ alignSelf: 'center' }}
        onClick={() => setAddAgentOpen(true)}
      >
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <Icon name="plus" /> add agent
        </span>
      </PixelButton>
    </div>
  );
}
