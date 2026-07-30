import { useState } from 'react';
import { useStore, type Agent } from '@/store/store';
import { restartDesk } from '@/lib/restartDesk';

/**
 * Show + change a desk's working directory (cwd). A cwd is set at spawn, so changing it
 * RESPAWNS the desk into the new folder (via the shared `restartDesk`, which works for
 * native + Claude). Persists the renderer record (setAgentCwd) to match the registry the
 * respawn rewrites. Shared by the Command Center roster + a desk's own panel.
 *
 * Selection is STEERED to the registered project repos (the primary choice) with a custom
 * folder as an escape hatch — mirroring the Add-Agent dialog so a desk stays on a known
 * project rather than an ad-hoc path. The registered list is fetched lazily when the menu
 * opens (the store doesn't mirror it).
 */
function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function AgentWorkspaceControl({ agent }: { agent: Agent }) {
  const setAgentCwd = useStore((s) => s.setAgentCwd);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [repos, setRepos] = useState<string[]>([]);

  const openMenu = async () => {
    if (!open) {
      try { setRepos((await window.cth.getConfig()).registeredRepos ?? []); } catch { setRepos([]); }
    }
    setOpen((o) => !o);
  };

  const moveTo = async (cwd: string) => {
    setOpen(false);
    setBusy(true);
    try {
      const res = await restartDesk(agent, { cwd });
      if (res.ok) setAgentCwd(agent.id, cwd);
    } finally {
      setBusy(false);
    }
  };

  const pickCustom = async () => {
    const picked = await window.cth.chooseFolder();
    if (!picked.ok) return; // cancelled
    await moveTo(picked.path);
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, position: 'relative' }}>
      <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-500)', flexShrink: 0 }}>WORKSPACE</span>
      <span style={{
        flex: 1, minWidth: 0, fontFamily: 'var(--cth-font-mono, monospace)', fontSize: 11,
        color: 'var(--cth-ink-500)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
      }} title={agent.cwd}>{agent.cwd}</span>
      <button
        onClick={() => void openMenu()}
        disabled={busy}
        title="Change this desk's working directory (restarts it in the new folder)"
        style={{
          flexShrink: 0, padding: '2px 8px 1px', border: 'none', cursor: busy ? 'default' : 'pointer',
          background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
          fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-900)', opacity: busy ? 0.6 : 1
        }}
      >{busy ? 'restarting…' : 'change…'}</button>

      {open && (
        <>
          {/* click-away */}
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
          <div style={{
            position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 41,
            minWidth: 200, maxWidth: 320, maxHeight: 260, overflowY: 'auto',
            background: 'var(--cth-paper-100)', boxShadow: '0 0 0 1px var(--cth-ink-900), 2px 2px 0 var(--cth-ink-900)'
          }}>
            <div style={{ padding: '4px 8px', fontSize: 10, color: 'var(--cth-ink-500)', fontFamily: 'var(--cth-font-display)' }}>PROJECT REPOS</div>
            {repos.length === 0 && (
              <div style={{ padding: '4px 8px', fontSize: 12, color: 'var(--cth-ink-500)' }}>none — register one in Settings</div>
            )}
            {repos.map((r) => (
              <button
                key={r}
                onClick={() => void moveTo(r)}
                title={r}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', border: 'none', cursor: 'pointer',
                  padding: '4px 8px', background: agent.cwd === r ? 'var(--cth-sky-light)' : 'transparent',
                  fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)'
                }}
              >{basename(r)}</button>
            ))}
            <button
              onClick={() => void pickCustom()}
              style={{
                display: 'block', width: '100%', textAlign: 'left', border: 'none', cursor: 'pointer',
                padding: '4px 8px', background: 'transparent', borderTop: '1px solid var(--cth-cream-300)',
                fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-700)'
              }}
            >custom folder…</button>
          </div>
        </>
      )}
    </div>
  );
}
