/** E005 — assignment resolver: creation precedence (explicit→fleet-default→
 *  role-based), provider derivation, capability-gap, stale detection, provenance,
 *  and the non-retroactive snapshot shape. Electron-free; runs in Node (HINT-003),
 *  mirroring src/shared/__tests__/providerRegistry.test.ts. Model ids are real
 *  registry ids (claude-opus-4-8 → Anthropic/all-caps, deepseek-v4-flash →
 *  DeepSeek/caching-only, minimax-m3 → MiniMax/no-caps). */
import { describe, it, expect } from 'vitest';
import {
  resolveEffectiveModel,
  deriveProviderId,
  computeCapabilityGap,
  isAssignmentStale,
  assignmentProvenance
} from '../assignment';

describe('T001 {FR-008} — resolveEffectiveModel precedence (DR-8)', () => {
  it('explicit wins over fleet-default and role-based', () => {
    const r = resolveEffectiveModel({
      explicitModelId: 'claude-opus-4-8',
      fleetDefaultModelId: 'deepseek-v4-flash',
      roleBasedModelId: 'minimax-m3'
    });
    expect(r).toEqual({ modelId: 'claude-opus-4-8', source: 'explicit' });
  });

  it('fleet-default wins over role-based when no explicit', () => {
    const r = resolveEffectiveModel({
      fleetDefaultModelId: 'deepseek-v4-flash',
      roleBasedModelId: 'minimax-m3'
    });
    expect(r).toEqual({ modelId: 'deepseek-v4-flash', source: 'fleet-default' });
  });

  it('falls through to role-based when only it is present', () => {
    const r = resolveEffectiveModel({ roleBasedModelId: 'minimax-m3' });
    expect(r).toEqual({ modelId: 'minimax-m3', source: 'role-based' });
  });

  it('returns none when every tier is absent', () => {
    expect(resolveEffectiveModel({})).toEqual({ modelId: null, source: 'none' });
  });

  it('treats blank/whitespace ids as absent (no false selection)', () => {
    const r = resolveEffectiveModel({
      explicitModelId: '   ',
      fleetDefaultModelId: '',
      roleBasedModelId: 'minimax-m3'
    });
    expect(r).toEqual({ modelId: 'minimax-m3', source: 'role-based' });
  });
});

describe('T002 {FR-008} — deriveProviderId (DERIVED, never stored; DR-1)', () => {
  it('resolves a real model to its provider id', () => {
    expect(deriveProviderId('claude-opus-4-8')).toBe('anthropic');
    expect(deriveProviderId('deepseek-v4-flash')).toBe('deepseek');
    expect(deriveProviderId('minimax-m3')).toBe('minimax');
  });

  it('returns null for an unknown/unresolvable id', () => {
    expect(deriveProviderId('gpt-4o-unknown')).toBeNull();
  });

  it('returns null for an absent id', () => {
    expect(deriveProviderId(undefined)).toBeNull();
    expect(deriveProviderId('')).toBeNull();
  });
});

describe('T003 {FR-009} — computeCapabilityGap names false flags (DR-3)', () => {
  it('a fully-capable model returns an empty gap', () => {
    expect(computeCapabilityGap('claude-opus-4-8')).toEqual([]);
  });

  it('lists exactly the false flags for a partially-capable model', () => {
    // DeepSeek V4 Flash: caching only — images / MCP / web search are false.
    expect(computeCapabilityGap('deepseek-v4-flash')).toEqual(['images', 'MCP tools', 'web search']);
  });

  it('lists every capability for a no-capability model', () => {
    expect(computeCapabilityGap('minimax-m3')).toEqual(['images', 'MCP tools', 'web search', 'caching']);
  });

  it('an unknown id reads the empty descriptor and lists all (fail loud)', () => {
    expect(computeCapabilityGap('totally-unknown')).toEqual(['images', 'MCP tools', 'web search', 'caching']);
  });
});

describe('T004 {FR-011} — isAssignmentStale (preserve+flag, never remap; DR-5/DR-11)', () => {
  it('a present-but-unresolvable model id is stale', () => {
    expect(isAssignmentStale('removed-model-xyz')).toBe(true);
  });

  it('a real registry model is not stale', () => {
    expect(isAssignmentStale('claude-opus-4-8')).toBe(false);
    expect(isAssignmentStale('deepseek-v4-flash')).toBe(false);
  });

  it('an absent/blank id is never stale (no false positive)', () => {
    expect(isAssignmentStale(undefined)).toBe(false);
    expect(isAssignmentStale(null)).toBe(false);
    expect(isAssignmentStale('')).toBe(false);
    expect(isAssignmentStale('   ')).toBe(false);
  });
});

describe('T005 {FR-004} — assignmentProvenance distinguishes explicit vs fleet-default (DR-1)', () => {
  it('marks an explicit assignment as custom', () => {
    const p = assignmentProvenance('explicit');
    expect(p.source).toBe('explicit');
    expect(p.isCustom).toBe(true);
    expect(p.isFleetDefault).toBe(false);
    expect(p.label).toBe('custom');
  });

  it('marks a fleet-default assignment distinctly', () => {
    const p = assignmentProvenance('fleet-default');
    expect(p.source).toBe('fleet-default');
    expect(p.isCustom).toBe(false);
    expect(p.isFleetDefault).toBe(true);
    expect(p.label).toBe('fleet default');
  });

  it('role-based and none get their own labels', () => {
    expect(assignmentProvenance('role-based').label).toBe('role default');
    expect(assignmentProvenance('none').label).toBe('unassigned');
  });

  it('a stored source overrides the resolved source for the badge', () => {
    // Desk frozen as fleet-default at creation still reads "fleet default".
    const p = assignmentProvenance('role-based', 'fleet-default');
    expect(p.source).toBe('fleet-default');
    expect(p.isFleetDefault).toBe(true);
    expect(p.label).toBe('fleet default');
  });
});

describe('FR-006 — non-retroactive snapshot shape (DR-4)', () => {
  it('an explicit assignment is unaffected by a different fleet default', () => {
    // Desk was assigned claude-opus-4-8 explicitly; the house default later moved
    // to deepseek-v4-flash. Resolution still returns the explicit model — the
    // fleet default is never consulted, so the snapshot is non-retroactive.
    const r = resolveEffectiveModel({
      explicitModelId: 'claude-opus-4-8',
      fleetDefaultModelId: 'deepseek-v4-flash'
    });
    expect(r).toEqual({ modelId: 'claude-opus-4-8', source: 'explicit' });
    expect(deriveProviderId(r.modelId)).toBe('anthropic');
  });
});

describe('T019 {FR-007} — fleet-default round-trip (DR-8/DR-11)', () => {
  it('(a) a fleet-default modelId drives resolution when there is no explicit assignment', () => {
    // Round-trip: a default of deepseek-v4-flash, set in config, resolves onto a new
    // agent that made no explicit pick — source = 'fleet-default', provider derived.
    const r = resolveEffectiveModel({
      fleetDefaultModelId: 'deepseek-v4-flash',
      roleBasedModelId: 'claude-sonnet-4-6'
    });
    expect(r).toEqual({ modelId: 'deepseek-v4-flash', source: 'fleet-default' });
    expect(deriveProviderId(r.modelId)).toBe('deepseek');
  });

  it('(b) a STALE fleet-default (unknown to the registry) falls through to the role-based fallback', () => {
    // DR-11: a present-but-unresolvable default is treated like an ABSENT default —
    // the new agent gets the role-based fallback, NOT a remapped vendor.
    const r = resolveEffectiveModel({
      fleetDefaultModelId: 'retired-house-default-v0',
      roleBasedModelId: 'claude-sonnet-4-6'
    });
    expect(r).toEqual({ modelId: 'claude-sonnet-4-6', source: 'role-based' });
    // The stale default is itself flagged for re-selection by the Settings surface.
    expect(isAssignmentStale('retired-house-default-v0')).toBe(true);
  });

  it('a stale fleet default with no role fallback resolves to none (never remapped)', () => {
    const r = resolveEffectiveModel({ fleetDefaultModelId: 'retired-house-default-v0' });
    expect(r).toEqual({ modelId: null, source: 'none' });
  });

  it('an explicit pick still wins over a (valid) fleet default — DR-11 only affects the default tier', () => {
    const r = resolveEffectiveModel({
      explicitModelId: 'minimax-m3',
      fleetDefaultModelId: 'deepseek-v4-flash'
    });
    expect(r).toEqual({ modelId: 'minimax-m3', source: 'explicit' });
  });

  it('a STALE explicit assignment is preserved (DR-5), not dropped like a stale default', () => {
    // Asymmetry guard: the explicit tier is registry-agnostic (preserve+flag), so a
    // stale explicit id still wins even though a stale *default* would fall through.
    const r = resolveEffectiveModel({
      explicitModelId: 'removed-explicit-xyz',
      fleetDefaultModelId: 'deepseek-v4-flash',
      roleBasedModelId: 'claude-sonnet-4-6'
    });
    expect(r).toEqual({ modelId: 'removed-explicit-xyz', source: 'explicit' });
    expect(isAssignmentStale('removed-explicit-xyz')).toBe(true);
  });
});
