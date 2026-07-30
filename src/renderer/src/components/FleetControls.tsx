import { useState } from 'react';
import { useStore } from '@/store/store';
import { Icon } from './Icon';
import { ModalOverlay } from './ModalOverlay';
import { PixelButton } from './PixelButton';
import { pauseAllAgents, resumeAllAgents, stopAllAgents } from '@/lib/fleetControl';

/**
 * Title-bar fleet controls: one Pause/Resume-ALL toggle + a Stop-ALL button (confirmed),
 * acting on every active desk at once (per-agent pause/stop is still available on each desk).
 * Pause is reversible (denies tools, keeps each desk's process + context); Stop kills every
 * desk's process (they become restorable; the floor stays down). Mirrors the gear button styling.
 */
export function FleetControls() {
  const agents = useStore((s) => s.agents);
  const paused = useStore((s) => s.paused);
  const [confirmStop, setConfirmStop] = useState(false);
  const [busy, setBusy] = useState(false);

  if (agents.length === 0) return null;

  const pausedCount = agents.filter((a) => paused[a.id]).length;
  const anyPaused = pausedCount > 0;

  const btn: React.CSSProperties = {
    position: 'relative',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
    height: 28, padding: '0 8px',
    background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1.5px var(--cth-ink-900)',
    border: 'none', borderRadius: 2, cursor: 'pointer', color: 'var(--cth-ink-900)',
    fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px'
  };

  const togglePause = async () => {
    setBusy(true);
    try { await (anyPaused ? resumeAllAgents() : pauseAllAgents()); } finally { setBusy(false); }
  };
  const doStopAll = async () => {
    setBusy(true);
    try { await stopAllAgents(); } finally { setBusy(false); setConfirmStop(false); }
  };

  return (
    <>
      <button
        className="cth-titlebar-nodrag"
        onClick={togglePause}
        disabled={busy}
        title={anyPaused ? `Resume all desks (${pausedCount} paused)` : 'Pause all desks (deny tools, keep context)'}
        style={btn}
      >
        <Icon name={anyPaused ? 'play' : 'pause'} size={1} style={{ width: 12, height: 12 }} />
        {anyPaused ? 'RESUME ALL' : 'PAUSE ALL'}
        {anyPaused && (
          <span style={{
            position: 'absolute', top: -5, right: -5, minWidth: 14, height: 14, padding: '0 3px',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            background: 'var(--cth-lemon)', color: 'var(--cth-ink-900)',
            boxShadow: '0 0 0 1.5px var(--cth-ink-900)', borderRadius: 7, fontSize: 8, lineHeight: '14px'
          }}>{pausedCount}</span>
        )}
      </button>
      <button
        className="cth-titlebar-nodrag"
        onClick={() => setConfirmStop(true)}
        disabled={busy}
        title="Stop all desks (kill every process — they become restorable)"
        style={{ ...btn, boxShadow: 'inset 0 0 0 1.5px var(--cth-coral)', color: 'var(--cth-coral)' }}
      >
        <Icon name="x" size={1} style={{ width: 12, height: 12 }} /> STOP ALL
      </button>

      {confirmStop && (
        <ModalOverlay title="STOP ALL DESKS?" width={420} zIndex={320} onClose={() => setConfirmStop(false)}
          footer={
            <>
              <PixelButton variant="secondary" size="md" onClick={() => setConfirmStop(false)} disabled={busy}>cancel</PixelButton>
              <PixelButton variant="destructive" size="md" onClick={doStopAll} disabled={busy}>
                {busy ? 'stopping…' : `stop ${agents.length} desk${agents.length === 1 ? '' : 's'}`}
              </PixelButton>
            </>
          }
        >
          <div style={{ padding: 20, fontSize: 14, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
            This kills every desk's process ({agents.length} active). They become <b>restorable</b> (one-click respawn
            from the strip), and the floor stays down across reloads. To pause reversibly instead — keeping each desk's
            process and context — use <b>Pause all</b>.
          </div>
        </ModalOverlay>
      )}
    </>
  );
}
