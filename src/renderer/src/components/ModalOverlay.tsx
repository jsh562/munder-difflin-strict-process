import { useEffect, type ReactNode } from 'react';
import { PixelPanel } from './PixelPanel';

export interface ModalOverlayProps {
  /** Dialog title rendered in the pinned header chrome. */
  title: string;
  /** Fired by a backdrop click AND the Escape key (both gated on `closeOnBackdrop`). */
  onClose: () => void;
  /** The scrollable body content (each caller supplies its own padded/gapped column). */
  children: ReactNode;
  /** Pinned action-button row at the bottom; stays visible while the body scrolls. */
  footer?: ReactNode;
  /** Panel width in px (capped to 92vw). Default 600. */
  width?: number;
  /** Stacking order. Default 200; pass the caller's existing value to avoid regressions. */
  zIndex?: number;
  /** When false, backdrop-click and Escape do NOT close (e.g. while a save is in flight). */
  closeOnBackdrop?: boolean;
}

/**
 * Shared centered modal: a dimmed full-screen backdrop with a viewport margin, a
 * height-capped panel, and a fixed header → scrolling body → pinned footer layout.
 * On any screen height the dialog fits, the body scrolls (chunky scrollbar from
 * global.css), and the action buttons stay visible. Reuses `PixelPanel` chrome.
 */
export function ModalOverlay({
  title,
  onClose,
  children,
  footer,
  width = 600,
  zIndex = 200,
  closeOnBackdrop = true
}: ModalOverlayProps) {
  useEffect(() => {
    if (!closeOnBackdrop) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeOnBackdrop, onClose]);

  return (
    <div
      onClick={closeOnBackdrop ? onClose : undefined}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(26, 19, 32, 0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        // Guarantees a margin so a tall panel never touches the screen edges.
        padding: 24,
        zIndex
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width,
          maxWidth: '92vw',
          // Cap to the backdrop's content box (viewport minus the 24px padding).
          maxHeight: '100%',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0
        }}
      >
        <PixelPanel
          variant="dialog"
          title={title}
          noPadding
          style={{
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            maxHeight: '100%',
            overflow: 'hidden'
          }}
        >
          {/* The only scroll region — the header (PixelPanel title) and footer stay pinned. */}
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>{children}</div>
          {footer && (
            <div
              style={{
                flexShrink: 0,
                padding: '12px 16px',
                display: 'flex',
                justifyContent: 'flex-end',
                gap: 8,
                boxShadow: 'inset 0 1px 0 var(--cth-ink-700)'
              }}
            >
              {footer}
            </div>
          )}
        </PixelPanel>
      </div>
    </div>
  );
}
