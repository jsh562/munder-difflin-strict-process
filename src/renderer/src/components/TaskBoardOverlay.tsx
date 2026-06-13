import { useEffect } from 'react';
import { useStore } from '@/store/store';
import { TasksKanban } from './TasksKanban';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';

/**
 * The big task board, opened by clicking the kanban board in the conference room. Renders
 * INSIDE the main center area (absolute inset:0 over the office scene) — NOT a full-window
 * overlay — so the sidebar/roster stays visible. Esc or the exit button closes it. Reuses
 * the self-contained `TasksKanban`; "assign" routes the card to Michael's queue.
 */
export function TaskBoardOverlay() {
  const setTasksBoardOpen = useStore((s) => s.setTasksBoardOpen);
  const enqueueMessage = useStore((s) => s.enqueueMessage);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setTasksBoardOpen(false); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setTasksBoardOpen]);

  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 200,
      background: 'var(--cth-cream-100)',
      display: 'flex', flexDirection: 'column',
      boxShadow: 'inset 0 0 0 2px var(--cth-ink-900)'
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', flexShrink: 0,
        background: 'var(--cth-cream-200)', borderBottom: '2px solid var(--cth-ink-900)'
      }}>
        <Icon name="check" />
        <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 11, color: 'var(--cth-ink-900)' }}>TASK BOARD</span>
        <PixelButton variant="secondary" size="sm" onClick={() => setTasksBoardOpen(false)} style={{ marginLeft: 'auto' }}>
          <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}><Icon name="x" /> close (esc)</span>
        </PixelButton>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <TasksKanban onAssign={(prefill) => enqueueMessage('god', prefill)} />
      </div>
    </div>
  );
}
