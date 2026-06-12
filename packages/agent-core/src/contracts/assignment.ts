/**
 * Assignment resolver (E005 / ADR-0005, ADR-0008).
 *
 * The single electron-free home for model/provider assignment LOGIC: creation
 * precedence (explicit → fleet-default → role-based), provider derivation, the
 * non-blocking capability-gap warning, stale detection, and UI provenance. It is
 * a pure consumer of the E002 registry (`src/shared/providerRegistry.ts`) — no
 * `electron` import, no `src/main/*` import — so it runs in Node under vitest and
 * is shared by the renderer picker/drawer and the main spawn path (HINT-003).
 *
 * Invariants enforced here:
 *  - Provider is DERIVED, never stored as an editable second field (DR-1/AD-001).
 *  - A stored `modelId` that no longer resolves is STALE: preserve the id verbatim,
 *    flag it, never remap to another vendor (DR-5/DR-11).
 *  - The fleet-default change is non-retroactive at the data level — resolution
 *    of an explicit assignment ignores the fleet default entirely (DR-4/DR-8).
 */
import {
  lookupModel,
  lookupModelInfo,
  lookupCapabilities
} from './providerRegistry';
import type { CapabilityDescriptor } from './providerRuntime';

/** Where the effective model came from. `'role-based'` is the fallback when neither
 *  an explicit assignment nor a fleet default resolves; `'none'` means nothing was
 *  provided at all (empty registry / no role fallback). Mirrors the DR-8 precedence. */
export type AssignmentSource = 'explicit' | 'fleet-default' | 'role-based' | 'none';

/** The stored, persisted half of an assignment's source. `'role-based'` is never
 *  persisted (absence ⇒ role-based fallback, DR-8) — hence the narrower set. */
export type StoredAssignmentSource = 'explicit' | 'fleet-default';

/** Result of {@link resolveEffectiveModel}: the chosen `modelId` (or `null` when
 *  none resolved) plus the precedence tier it came from. */
export interface EffectiveModel {
  modelId: string | null;
  source: AssignmentSource;
}

/** Inputs to {@link resolveEffectiveModel}; each tier is optional and falls through
 *  to the next when absent/blank, in DR-8 order. */
export interface ResolveInput {
  /** A per-desk explicit assignment (`AgentAssignment.model`). Highest precedence. */
  explicitModelId?: string | null;
  /** The house-wide fleet default (`HarnessConfig.defaultModel`). */
  fleetDefaultModelId?: string | null;
  /** The existing role-based fallback (`modelForRole`). Lowest precedence. */
  roleBasedModelId?: string | null;
}

/** Trim and treat blank strings as absent — a `''` model id is not a selection. */
function present(modelId: string | null | undefined): string | null {
  const trimmed = (modelId ?? '').trim();
  return trimmed.length ? trimmed : null;
}

/**
 * T001 {FR-008} — resolve the effective model by DR-8 precedence:
 * explicit → fleet-default → role-based. The first tier with a present (non-blank),
 * *usable* id wins; its `source` is returned alongside so the UI/spawn path can show
 * provenance. When every tier is absent the result is `{ modelId: null, source:
 * 'none' }`.
 *
 * Staleness is handled per-tier, asymmetrically:
 *  - The EXPLICIT tier is registry-agnostic: a present explicit id wins even if it is
 *    currently stale (preserve-and-flag, DR-5) — an operator/GOD-chosen desk is never
 *    silently dropped; the caller flags staleness via {@link isAssignmentStale}.
 *  - The FLEET-DEFAULT tier is registry-aware (DR-11/T019): a present-but-unresolvable
 *    default is treated like an ABSENT default and falls THROUGH to the role-based
 *    fallback, exactly as `absence ⇒ role-based` (DR-8). The stored `defaultModel` is
 *    still preserved verbatim by the config layer and surfaced for re-selection
 *    (Settings) — it is never auto-remapped to another vendor (DR-5). This keeps a
 *    new agent created while the house default is stale on the role-based fallback,
 *    not a wrong-vendor remap (Principle II — truthful cost / parity).
 *
 * The fleet default is consulted ONLY when there is no explicit id, which is what
 * makes a fleet-default change non-retroactive at the data level for an
 * explicitly-assigned desk (DR-4).
 */
export function resolveEffectiveModel(input: ResolveInput): EffectiveModel {
  const explicit = present(input.explicitModelId);
  if (explicit) return { modelId: explicit, source: 'explicit' };

  // DR-11: a stale (present-but-unresolvable) fleet default is treated as absent.
  const fleet = present(input.fleetDefaultModelId);
  if (fleet && !isAssignmentStale(fleet)) return { modelId: fleet, source: 'fleet-default' };

  const role = present(input.roleBasedModelId);
  if (role) return { modelId: role, source: 'role-based' };

  return { modelId: null, source: 'none' };
}

/**
 * T002 {FR-008} — derive the provider id for a model from the E002 registry.
 * Provider is DERIVED, NEVER stored (DR-1/AD-001/HINT-001): two editable fields
 * would risk drift, so the model id is the single source of truth. Returns `null`
 * for an absent or unresolvable id (the caller decides whether that is "none" or
 * "stale").
 */
export function deriveProviderId(modelId: string | null | undefined): string | null {
  return lookupModelInfo(modelId)?.provider.id ?? null;
}

/** A capability the chosen model LACKS — the human-readable name of a `false` flag
 *  on its {@link CapabilityDescriptor}, used to compose the non-blocking warning. */
export type CapabilityGapItem = 'images' | 'MCP tools' | 'web search' | 'caching';

/** Maps each descriptor flag to the label surfaced in the gap warning (DR-3). */
const CAPABILITY_LABELS: ReadonlyArray<{ key: keyof CapabilityDescriptor; label: CapabilityGapItem }> = [
  { key: 'supportsImages', label: 'images' },
  { key: 'supportsMcpTools', label: 'MCP tools' },
  { key: 'supportsWebSearch', label: 'web search' },
  { key: 'supportsCaching', label: 'caching' }
];

/**
 * T003 {FR-009} — compute the capability gap for a model: the labels of every
 * descriptor flag that is `false`. Drives the warn-at-assignment, NON-BLOCKING
 * warning (DR-3/AD-003) — a fully-capable model returns `[]` (no warning). An
 * unknown/unresolvable id reads the registry's EMPTY descriptor (all flags false),
 * so it lists every capability — failing loud rather than implying support.
 */
export function computeCapabilityGap(modelId: string | null | undefined): CapabilityGapItem[] {
  const caps = lookupCapabilities(modelId);
  return CAPABILITY_LABELS.filter(({ key }) => !caps[key]).map(({ label }) => label);
}

/**
 * T004 {FR-011} — is a stored assignment STALE? True only when a `modelId` is
 * present (the desk HAS a selection) but no longer resolves in the registry
 * (`lookupModel === null`) — the model was removed/renamed after assignment. An
 * absent/blank id is NOT stale (it is the role-based fallback, never a false
 * positive). Staleness is a derived, non-destructive flag: the stored id is
 * preserved verbatim and never remapped to another vendor (DR-5/DR-11).
 */
export function isAssignmentStale(modelId: string | null | undefined): boolean {
  const id = present(modelId);
  if (!id) return false;
  return lookupModel(id) === null;
}

/** UI provenance descriptor produced by {@link assignmentProvenance}. */
export interface AssignmentProvenance {
  /** The effective precedence tier the model came from. */
  source: AssignmentSource;
  /** Short label for the UI badge ("custom" vs "fleet default" vs "role default"). */
  label: string;
  /** True when the desk carries an operator/GOD-set explicit model (vs inherited). */
  isCustom: boolean;
  /** True when the model is inherited from the fleet default. */
  isFleetDefault: boolean;
}

/** Human-readable badge text per precedence tier. */
const PROVENANCE_LABELS: Record<AssignmentSource, string> = {
  explicit: 'custom',
  'fleet-default': 'fleet default',
  'role-based': 'role default',
  none: 'unassigned'
};

/**
 * T005 {FR-004} — distinguish explicit vs fleet-default vs role-based for the UI
 * provenance badge (DR-1). Pass the resolved {@link AssignmentSource} (from
 * {@link resolveEffectiveModel}); when a record additionally carries a STORED
 * `assignmentSource` (`'explicit' | 'fleet-default'`, never `'role-based'`) that
 * persisted intent takes precedence for the label, so a desk frozen as
 * `'fleet-default'` at creation still reads "fleet default" even if resolution
 * details shift. Returns a small descriptor the UI can render directly.
 */
export function assignmentProvenance(
  resolvedSource: AssignmentSource,
  storedSource?: StoredAssignmentSource | null
): AssignmentProvenance {
  const source: AssignmentSource = storedSource ?? resolvedSource;
  return {
    source,
    label: PROVENANCE_LABELS[source],
    isCustom: source === 'explicit',
    isFleetDefault: source === 'fleet-default'
  };
}
