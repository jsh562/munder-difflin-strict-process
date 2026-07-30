import { useState } from 'react';
import { ModalOverlay } from './ModalOverlay';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';

export interface QuitWarningModalProps {
  ptyCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}

export function QuitWarningModal({ ptyCount, onCancel, onConfirm }: QuitWarningModalProps) {
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    setBusy(true);
    await onConfirm();
    // No need to clear busy — the app is quitting.
  };

  return (
    <ModalOverlay
      title="QUITTING NOW?"
      width={480}
      zIndex={300}
      onClose={onCancel}
      footer={
        <>
          <PixelButton variant="secondary" size="md" onClick={onCancel} disabled={busy}>
            keep them running
          </PixelButton>
          <PixelButton variant="destructive" size="md" onClick={confirm} disabled={busy}>
            {busy ? 'killing...' : `kill ${ptyCount === 1 ? 'it' : 'all'} & quit`}
          </PixelButton>
        </>
      }
    >
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <div style={{
            width: 32, height: 32,
            background: 'var(--cth-coral-light)',
            boxShadow: 'inset 0 0 0 2px var(--cth-ink-900)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0
          }}>
            <Icon name="bell" />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{
              fontFamily: 'var(--cth-font-display)',
              fontSize: 12, lineHeight: '20px',
              color: 'var(--cth-ink-900)',
              marginBottom: 4
            }}>
              {ptyCount} {ptyCount === 1 ? 'AGENT' : 'AGENTS'} STILL RUNNING
            </div>
            <div style={{ fontSize: 15, lineHeight: '22px', color: 'var(--cth-ink-700)' }}>
              Closing the harness will terminate{' '}
              {ptyCount === 1 ? 'the running claude session' : `all ${ptyCount} running claude sessions`}{' '}
              and discard any unsaved progress they were holding in memory. The conversation
              history inside each session is lost when the PTY exits.
            </div>
          </div>
        </div>

        <div style={{
          padding: 8,
          background: 'var(--cth-cream-200)',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
          fontSize: 13, lineHeight: '18px',
          color: 'var(--cth-ink-700)'
        }}>
          Tip: leave the harness open in the background if you want sessions to keep
          working. You can detach individual agents by clicking <Icon name="x" /> on
          their detail panel.
        </div>
      </div>
    </ModalOverlay>
  );
}
