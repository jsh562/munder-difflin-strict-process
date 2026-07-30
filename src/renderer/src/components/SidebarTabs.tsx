import { useRef } from 'react';
import { type SidebarTab } from '@/store/store';
import { type AccentColorName } from '@/design/tokens';
import { Icon, type IconName } from './Icon';

// E008 / T029 (FR-005/FR-006) — `structured` is the OPT-IN alternate view of the SAME
// run, placed right after `terminal` (its default view). Selecting it does NOT unmount
// the default view in the host panel: `AgentDetailPanel` keeps the default view mounted
// (hidden) so toggling preserves its content + scroll position (FR-006) and reuses the
// already-folded view-models without re-folding (FR-034). The existing tabs are intact.
const TABS: { key: SidebarTab; label: string; icon: IconName }[] = [
  { key: 'terminal',   label: 'terminal',   icon: 'terminal' },
  { key: 'structured', label: 'structured', icon: 'code' },
  { key: 'files',      label: 'files',      icon: 'folder' },
  { key: 'messages',   label: 'messages',   icon: 'bell' },
  { key: 'traces',     label: 'traces',     icon: 'web' }
];

export interface SidebarTabsProps {
  current: SidebarTab;
  accent: AccentColorName;
  onChange: (tab: SidebarTab) => void;
}

/**
 * E008 / T034 (FR-025/SC-014) — the per-agent panel's view toggle, including the opt-in
 * `structured` tab (T029). It is rendered with the idiomatic ARIA tab pattern so the
 * structured-tab toggle is keyboard-focusable AND operable by assistive technology:
 *   - the container is `role="tablist"` (horizontal);
 *   - each button is `role="tab"` with `aria-selected` reflecting the active view, so
 *     a screen reader announces "selected" on the current tab;
 *   - Left/Right (and Home/End) arrow keys move focus between tabs and activate them
 *     (automatic activation, the WAI-ARIA tabs convention), while Enter/Space still
 *     activate the focused tab natively (it is a real <button>);
 *   - only the active tab is in the natural tab order (`tabIndex 0`), the rest are
 *     `-1` and reached via the arrow keys — the standard roving-tabindex pattern, so
 *     Tab lands on the tablist once rather than stepping through every tab.
 * This is additive a11y hardening: the visual/behavioral result of a click is unchanged.
 */
export function SidebarTabs({ current, accent, onChange }: SidebarTabsProps) {
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const activeIndex = Math.max(0, TABS.findIndex((t) => t.key === current));

  // Roving focus + arrow-key navigation across the tablist (WAI-ARIA tabs pattern). On
  // Left/Right/Home/End we move focus to the target tab AND select it (automatic
  // activation), wrapping at the ends. Other keys (Enter/Space) fall through to the
  // button's native activation via onClick.
  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let target = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') target = (index + 1) % TABS.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') target = (index - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') target = 0;
    else if (e.key === 'End') target = TABS.length - 1;
    if (target < 0) return;
    e.preventDefault();
    onChange(TABS[target].key);
    btnRefs.current[target]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="agent panel views"
      aria-orientation="horizontal"
      style={{
        display: 'flex',
        gap: 0,
        background: 'var(--cth-cream-200)',
        boxShadow: 'inset 0 -2px 0 var(--cth-ink-900)',
        flexShrink: 0
      }}
    >
      {TABS.map((t, index) => {
        const active = current === t.key;
        return (
          <button
            key={t.key}
            ref={(node) => { btnRefs.current[index] = node; }}
            role="tab"
            type="button"
            aria-selected={active}
            tabIndex={index === activeIndex ? 0 : -1}
            onClick={() => onChange(t.key)}
            onKeyDown={(e) => onKeyDown(e, index)}
            style={{
              flex: 1,
              height: 36,
              padding: '0 10px',
              border: 'none',
              cursor: 'pointer',
              background: active ? 'var(--cth-cream-100)' : 'transparent',
              boxShadow: active
                ? `inset 0 -3px 0 var(--cth-${accent}), inset 1px 0 0 var(--cth-ink-900), inset -1px 0 0 var(--cth-ink-900)`
                : 'inset 0 0 0 0',
              fontFamily: 'var(--cth-font-display)',
              fontSize: 10,
              lineHeight: '14px',
              color: active ? 'var(--cth-ink-900)' : 'var(--cth-ink-500)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6
            }}
          >
            <Icon name={t.icon} /> {t.label.toUpperCase()}
          </button>
        );
      })}
    </div>
  );
}
