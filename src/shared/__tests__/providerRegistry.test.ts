/** E002 — provider/model registry: metadata, dated/tiered fail-loud pricing,
 *  capabilities, and the pricing.ts shim contract (SC-001..SC-007). */
import { describe, it, expect, vi } from 'vitest';
import {
  PROVIDER_REGISTRY,
  listProviders,
  lookupModel,
  lookupModelInfo,
  lookupCapabilities,
  lookupPrice,
  computeCost,
  normalizeModel
} from '../providerRegistry';
import { estimateCostUsd, normalizeModel as shimNormalizeModel } from '../../main/pricing';

describe('SC-001 — provider/model metadata', () => {
  it('returns context window, endpoint, and origin for seeded models', () => {
    const info = lookupModelInfo('claude-opus-4-8');
    expect(info).not.toBeNull();
    expect(info!.model.contextWindow).toBeGreaterThan(0);
    expect(info!.provider.defaultEndpoint).toMatch(/^https:\/\//);
    expect(info!.provider.originLabel.length).toBeGreaterThan(0);
  });

  it('resolves every seeded model purely from data (3 providers)', () => {
    expect(listProviders().map((p) => p.id).sort()).toEqual(['anthropic', 'deepseek', 'minimax']);
    for (const p of listProviders()) {
      for (const m of p.models) {
        expect(lookupModel(m.id)?.id, m.id).toBe(m.id);
      }
    }
  });
});

describe('SC-002 — dated/tiered price selection', () => {
  it('DeepSeek returns a cache-split row', () => {
    const row = lookupPrice('deepseek-v4-flash');
    expect('unknown' in row).toBe(false);
    if (!('unknown' in row)) {
      expect(row.cacheReadPerM).toBeLessThan(row.inputPerM); // cache hit cheaper than input
    }
  });

  it('Minimax M3 selects the long-context tier above the threshold', () => {
    const base = lookupPrice('minimax-m3', { contextSize: 100_000 });
    const long = lookupPrice('minimax-m3', { contextSize: 600_000 });
    expect('unknown' in base).toBe(false);
    expect('unknown' in long).toBe(false);
    if (!('unknown' in base) && !('unknown' in long)) {
      expect(long.inputPerM).toBeGreaterThan(base.inputPerM);
      expect(base.contextTierThreshold).toBeUndefined();
      expect(long.contextTierThreshold).toBe(512_000);
    }
  });
});

describe('SC-003 — fail-loud on unknown id', () => {
  it('warns and returns a sentinel, never a wrong-vendor price', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const row = lookupPrice('gpt-4o-unknown');
    expect(row).toEqual({ unknown: true });
    expect(warn).toHaveBeenCalled();
    const cost = computeCost('some-other-unknown-model', { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(cost.usd).toBe(0); // not a Sonnet-priced (=18) value
    expect(cost.bestEffort).toBe(true);
    warn.mockRestore();
  });
});

describe('SC-005 — cost from token split x selected row', () => {
  it('computes provider-accurate cost', () => {
    // DeepSeek V4 Flash: input 0.14/M, output 0.28/M.
    const cost = computeCost('deepseek-v4-flash', { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(cost.bestEffort).toBe(false);
    expect(cost.usd).toBeCloseTo(0.14 + 0.28, 9);
  });
});

describe('SC-007 — missing usage field degrades best-effort', () => {
  it('flags bestEffort and still prices the available fields, never a wrong default', () => {
    const cost = computeCost('claude-opus-4-8', { inputTokens: 1_000_000 }); // other fields omitted
    expect(cost.bestEffort).toBe(true);
    expect(cost.usd).toBeCloseTo(15, 9); // input only, Opus 15/M — not zero, not wrong
  });
});

describe('SC-004 — capability descriptors', () => {
  it('declares accurate capabilities per provider, EMPTY for unknown', () => {
    expect(lookupCapabilities('claude-sonnet-4-6')).toEqual({ supportsImages: true, supportsMcpTools: true, supportsWebSearch: true, supportsCaching: true });
    expect(lookupCapabilities('deepseek-v4-flash')).toMatchObject({ supportsImages: false, supportsMcpTools: false, supportsWebSearch: false });
    expect(lookupCapabilities('minimax-m3')).toEqual({ supportsImages: false, supportsMcpTools: false, supportsWebSearch: false, supportsCaching: false });
    expect(lookupCapabilities('totally-unknown')).toEqual({ supportsImages: false, supportsMcpTools: false, supportsWebSearch: false, supportsCaching: false });
  });
});

describe('SC-006 — Claude cost is bit-identical to the prior pricing.ts table', () => {
  // The exact prior family-string behavior.
  const OLD: Record<string, { i: number; o: number; cr: number; cw: number }> = {
    opus: { i: 15, o: 75, cr: 1.5, cw: 18.75 },
    sonnet: { i: 3, o: 15, cr: 0.3, cw: 3.75 },
    haiku: { i: 0.8, o: 4, cr: 0.08, cw: 1.0 }
  };
  function oldEstimate(model: string, t: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): number {
    const x = model.toLowerCase();
    const p = x.includes('opus') ? OLD.opus : x.includes('haiku') ? OLD.haiku : OLD.sonnet;
    return (t.inputTokens / 1e6) * p.i + (t.outputTokens / 1e6) * p.o + (t.cacheReadTokens / 1e6) * p.cr + (t.cacheWriteTokens / 1e6) * p.cw;
  }
  const splits = [
    { inputTokens: 123_456, outputTokens: 65_432, cacheReadTokens: 10_000, cacheWriteTokens: 2_500 },
    { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  ];
  for (const model of ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001']) {
    for (const s of splits) {
      it(`${model} unchanged`, () => {
        expect(estimateCostUsd(model, s)).toBe(oldEstimate(model, s));
      });
    }
  }
});

describe('T021 — shim contract + seed invariants', () => {
  it('pricing.ts re-exports a working normalizeModel', () => {
    expect(typeof estimateCostUsd).toBe('function');
    expect(shimNormalizeModel('claude-opus-4-8[1m]')).toBe('claude-opus-4-8');
    expect(normalizeModel('claude-opus-4-8[1m]')).toBe('claude-opus-4-8');
  });

  it('every seeded model has price rows, capabilities, and a provider with endpoint+origin', () => {
    for (const p of PROVIDER_REGISTRY.providers) {
      expect(p.defaultEndpoint).toMatch(/^https:\/\//);
      expect(p.originLabel.length).toBeGreaterThan(0);
      for (const m of p.models) {
        expect(m.priceRows.length).toBeGreaterThan(0);
        expect(m.capabilities).toBeDefined();
        expect(m.contextWindow).toBeGreaterThan(0);
      }
    }
  });
});
