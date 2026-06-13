import { useState } from 'react';
import { useStore, type Agent } from '@/store/store';
import { restartDesk } from '@/lib/restartDesk';

/**
 * Show + change a desk's working directory (cwd). A cwd is set at spawn, so changing it
 * RESPAWNS the desk into the new folder (via the shared `restartDesk`, which works for
 * native + Claude). Persists the renderer record (setAgentCwd) to match the registry the
 * respawn rewrites. Shared by the Command Center roster + a desk's own panel.
 */
export function AgentWorkspaceControl({ agent }: { agent: Agent }) {
  const setAgentCwd = useStore((s) => s.setAgentCwd);
  const [busy, setBusy] = useState(false);

  const change = async () => {
    const picked = await window.cth.chooseFolder();
    if (!picked.ok) return; // cancelled
    setBusy(true);
    try {
      const res = await restartDesk(agent, { cwd: picked.path });
      if (res.ok) setAgentCwd(agent.id, picked.path);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-500)', flexShrink: 0 }}>WORKSPACE</span>
      <span style={{
        flex: 1, minWidth: 0, fontFamily: 'var(--cth-font-mono, monospace)', fontSize: 11,
        color: 'var(--cth-ink-500)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
      }} title={agent.cwd}>{agent.cwd}</span>
      <button
        onClick={() => void change()}
        disabled={busy}
        title="Change this desk's working directory (restarts it in the new folder)"
        style={{
          flexShrink: 0, padding: '2px 8px 1px', border: 'none', cursor: busy ? 'default' : 'pointer',
          background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
          fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-900)', opacity: busy ? 0.6 : 1
        }}
      >{busy ? 'restarting…' : 'change…'}</button>
    </div>
  );
}
