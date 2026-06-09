import { useEffect, useMemo, useState } from 'react';
import { listProviders } from '@shared/providerRegistry';
import { computeCapabilityGap, deriveProviderId, isAssignmentStale } from '@shared/assignment';
import type { CapabilityDescriptor } from '@shared/providerRuntime';
import type { AccentColorName } from '@/design/tokens';

/**
 * ProviderModelPicker (E005 / FR-001, FR-009, FR-010, FR-011, FR-012).
 *
 * A reusable, provider-grouped model picker built read-only from the E002 registry
 * (`listProviders()`): every model is listed under its owning provider, each option
 * shows the provider name and per-model capability tags (the four flags from the
 * registry's `CapabilityDescriptor`). Selecting a model surfaces a NON-BLOCKING
 * capability-gap warning naming each capability the chosen model lacks (DR-3) — it
 * never disables the picker or the surrounding Save action.
 *
 * Three non-blocking annotations layer on top, every one of which keeps selection
 * enabled (the core US4 invariant — AD-003/DR-3/DR-6):
 *  - T024 {FR-009}: the capability-gap warning naming each missing capability for the
 *    selected model; a fully-capable model shows nothing (SC-007).
 *  - T025 {FR-010}: a per-model "needs credentials — add in Settings" affordance when
 *    the model's (derived) provider has no stored key, read from E004 credential
 *    PRESENCE (`window.cth.credentials.presence()`) on mount (DR-6). Presence is a
 *    read-only annotation — key material is never read here.
 *  - T026 {FR-009,FR-010}: when the selected model is BOTH uncredentialed AND gapped,
 *    both annotations surface together; neither blocks the assignment.
 *  - T027 {FR-011}: when the currently-assigned model id no longer resolves in the
 *    registry (`isAssignmentStale`), a "stale — model unavailable, re-select" notice
 *    prompts a re-pick while the stored id is PRESERVED verbatim (never remapped —
 *    DR-5/DR-11).
 *
 * Controlled component: the parent owns `selectedModelId`; the picker calls
 * `onChange(modelId)` on every selection. When the registry yields no models it
 * renders an empty-state pointing to setup and disables selection (DR-7/FR-012);
 * the parent's create flow still succeeds by falling through to its existing
 * role-based default (handled in the drawer, T011).
 *
 * Provider is DERIVED from the model id, never stored — this picker only ever emits
 * a `modelId` (DR-1/HINT-001).
 */

export interface ProviderModelPickerProps {
  /** The currently-selected model id, or `undefined` when nothing is chosen yet. */
  selectedModelId?: string;
  /** Called with the chosen model id whenever the operator picks a model. */
  onChange: (modelId: string) => void;
  /** Accent used to highlight the active option — matches the host drawer's color. */
  accent?: AccentColorName;
}

/** Human-readable labels for each capability flag, in the same order the gap
 *  warning lists them (mirrors `assignment.ts` CAPABILITY_LABELS). */
const CAPABILITY_TAGS: ReadonlyArray<{ key: keyof CapabilityDescriptor; label: string }> = [
  { key: 'supportsImages', label: 'images' },
  { key: 'supportsMcpTools', label: 'MCP tools' },
  { key: 'supportsWebSearch', label: 'web search' },
  { key: 'supportsCaching', label: 'caching' }
];

export function ProviderModelPicker({ selectedModelId, onChange, accent = 'sky' }: ProviderModelPickerProps) {
  // Read the registry once per render; it is frozen data (E002), so memoizing on
  // nothing is safe and keeps the grouped list stable across re-renders.
  const providers = useMemo(() => listProviders(), []);
  const hasModels = providers.some((p) => p.models.length > 0);

  // T025 {FR-010} — credential PRESENCE per provider (provider id → has-key), loaded
  // once on mount from E004. The renderer only ever learns presence (a boolean) — raw
  // key material never crosses the bridge (ADR-0007). The async result is best-effort:
  // until it arrives (and on any error / empty result) every provider reads as
  // "no presence known", which simply shows the non-blocking "needs credentials"
  // affordance — it never blocks selection (DR-6). `cth` may be absent in non-Electron
  // test/preview contexts, hence the optional-chained guard.
  const [presence, setPresence] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let alive = true;
    window.cth?.credentials
      ?.presence()
      .then((p) => {
        if (alive) setPresence(p ?? {});
      })
      .catch(() => {
        /* no presence known ⇒ treat every provider as uncredentialed (annotate, never block) */
      });
    return () => {
      alive = false;
    };
  }, []);

  /** A model needs credentials when its DERIVED provider (DR-1) has no stored key.
   *  Unknown/unresolvable provider ⇒ treat as missing (annotate, never block). */
  const needsCredentials = (modelId: string): boolean => {
    const providerId = deriveProviderId(modelId);
    return providerId ? presence[providerId] !== true : true;
  };

  // T009 {FR-012} — empty-registry branch: no pickable models ⇒ point to setup and
  // disable selection. The host drawer still creates the agent via its role-based
  // fallback (DR-7).
  if (!hasModels) {
    return (
      <div
        role="note"
        style={{
          padding: '8px 10px 6px',
          background: 'var(--cth-cream-100)',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
          fontFamily: 'var(--cth-font-ui)',
          fontSize: 13,
          color: 'var(--cth-ink-700)'
        }}
      >
        No providers configured — add credentials in Settings.
      </div>
    );
  }

  // Annotations below are for the active selection only and are ALL non-blocking.
  const selected = (selectedModelId ?? '').trim();
  // T027 {FR-011} — the currently-assigned id no longer resolves in the registry:
  // surface a stale notice + prompt re-selection. The stored id is preserved (the
  // parent never remaps it — DR-5/DR-11). When stale, the gap/credential annotations
  // are moot (the model is gone), so only the stale notice is shown.
  const stale = isAssignmentStale(selected);
  // T024 {FR-009} — capability gap for the active (resolvable) selection (DR-3).
  const gap = selected && !stale ? computeCapabilityGap(selected) : [];
  // T026 {FR-009,FR-010} — does the active (resolvable) selection also lack credentials?
  const selectedUncredentialed = selected.length > 0 && !stale && needsCredentials(selected);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {providers
        .filter((p) => p.models.length > 0)
        .map((provider) => (
          <div key={provider.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span
              style={{
                fontFamily: 'var(--cth-font-display)',
                fontSize: 8,
                lineHeight: '12px',
                color: 'var(--cth-ink-700)',
                textTransform: 'uppercase'
              }}
            >
              {provider.displayName}
            </span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {provider.models.map((model) => {
                const active = (selectedModelId ?? '') === model.id;
                // T025 {FR-010} — non-blocking per-model credential annotation. Selecting
                // an uncredentialed model is allowed; this only flags it (DR-6).
                const uncredentialed = needsCredentials(model.id);
                return (
                  <button
                    key={model.id}
                    type="button"
                    onClick={() => onChange(model.id)}
                    title={model.id}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      gap: 4,
                      padding: '5px 8px 4px',
                      textAlign: 'left',
                      background: active ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                      boxShadow: active
                        ? 'inset 0 0 0 2px var(--cth-ink-900)'
                        : 'inset 0 0 0 1px var(--cth-ink-700)',
                      cursor: 'pointer',
                      border: 'none',
                      width: '100%'
                    }}
                  >
                    <span
                      style={{
                        fontFamily: 'var(--cth-font-ui)',
                        fontSize: 14,
                        color: 'var(--cth-ink-900)'
                      }}
                    >
                      {model.displayName}
                      <span style={{ color: 'var(--cth-ink-700)', fontSize: 12 }}>
                        {' · '}{provider.displayName}
                      </span>
                    </span>
                    <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                      {CAPABILITY_TAGS.map(({ key, label }) => {
                        const supported = model.capabilities[key];
                        return (
                          <span
                            key={key}
                            style={{
                              padding: '1px 6px 0',
                              fontFamily: 'var(--cth-font-ui)',
                              fontSize: 11,
                              lineHeight: '16px',
                              color: supported ? 'var(--cth-ink-900)' : 'var(--cth-ink-300)',
                              background: 'var(--cth-paper-100)',
                              boxShadow: supported
                                ? 'inset 0 0 0 1px var(--cth-ink-700)'
                                : 'inset 0 0 0 1px var(--cth-ink-300)',
                              textDecoration: supported ? 'none' : 'line-through'
                            }}
                          >
                            {label}
                          </span>
                        );
                      })}
                      {/* T025 {FR-010} — "needs credentials" affordance per uncredentialed
                          provider; the model stays selectable (NOT blocked — DR-6). */}
                      {uncredentialed && (
                        <span
                          title={`${provider.displayName} has no stored API key — add one in Settings. You can still select this model.`}
                          style={{
                            padding: '1px 6px 0',
                            fontFamily: 'var(--cth-font-ui)',
                            fontSize: 11,
                            lineHeight: '16px',
                            color: 'var(--cth-ink-900)',
                            background: 'var(--cth-coral-light)',
                            boxShadow: 'inset 0 0 0 1px var(--cth-coral)'
                          }}
                        >
                          needs credentials
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}

      {/* T027 {FR-011} — stale: the assigned model id is no longer in the registry.
          Prompt re-selection; the stored id is preserved by the parent (never
          remapped — DR-5/DR-11). Non-blocking: the picker above stays usable. */}
      {stale && (
        <div
          role="alert"
          style={{
            padding: '6px 10px 4px',
            background: 'var(--cth-coral-light)',
            boxShadow: 'inset 0 0 0 1px var(--cth-coral)',
            fontFamily: 'var(--cth-font-ui)',
            fontSize: 13,
            color: 'var(--cth-ink-900)'
          }}
        >
          stale — model "{selected}" is no longer available. Re-select a model above.
        </div>
      )}

      {/* T026 {FR-010} — credential annotation for the active selection, surfaced
          ALONGSIDE the gap warning when the model is both uncredentialed and gapped.
          Non-blocking (DR-6). */}
      {selectedUncredentialed && (
        <div
          role="alert"
          style={{
            padding: '6px 10px 4px',
            background: 'var(--cth-coral-light)',
            boxShadow: 'inset 0 0 0 1px var(--cth-coral)',
            fontFamily: 'var(--cth-font-ui)',
            fontSize: 13,
            color: 'var(--cth-ink-900)'
          }}
        >
          needs credentials — add a key for this provider in Settings. You can still use it.
        </div>
      )}

      {/* T024 {FR-009} — non-blocking capability-gap warning naming EACH missing
          capability for the selected model (DR-3); fully-capable ⇒ nothing (SC-007). */}
      {gap.length > 0 && (
        <div
          role="alert"
          style={{
            padding: '6px 10px 4px',
            background: 'var(--cth-lemon-light)',
            boxShadow: 'inset 0 0 0 1px var(--cth-lemon)',
            fontFamily: 'var(--cth-font-ui)',
            fontSize: 13,
            color: 'var(--cth-ink-900)'
          }}
        >
          This model lacks: {gap.join(', ')}. You can still use it.
        </div>
      )}
    </div>
  );
}
