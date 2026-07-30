/**
 * E007 US1 — golden-vector cost (FR-012 / SC-003).
 *
 * Pure, network-free golden vectors asserting the seam's `resolvePrice` computes
 * USD = Σ(tokens × the dated registry price row) within ≤5% of a hand-computed
 * figure, for the three pricing nuances the release gate cares about:
 *   (a) DeepSeek cache read/write SPLIT (cacheRead × cacheReadPerM, cacheWrite ×
 *       cacheWritePerM — distinct rates) (FR-004).
 *   (b) Minimax whole-call context TIER — a vector BELOW and ABOVE the registry
 *       row's `contextTierThreshold`, asserting the whole call reprices at the
 *       higher dated row above the boundary (FR-004 / AD-004 / HINT-003).
 *   (c) Claude (no tier, with cache split).
 *
 * Expectations are DERIVED FROM THE REGISTRY ROWS (read via `lookupPrice`) — not
 * magic numbers — and the seam compute is asserted to equal tokens × the row
 * EXACTLY (the compute is exact against the registry; ≤5% is the bound against a
 * provider's real bill, which the exact match trivially satisfies).
 */
import { describe, it, expect } from 'vitest';
import { resolvePrice } from '../pricing';
import { TelemetryCollector, type TelemetryEvent } from '../telemetry';
import { lookupPrice, type PriceRow, type PriceLookupOpts } from '../../shared/providerRegistry';

// The seed date all non-Claude rows are effective at (registry PROVIDER_SEED_DATE);
// pin `at` so the test is stable as dated rows are added later.
const AT = '2026-06-01';

/** Read the real registry row for a model (fails the test loudly if unknown). */
function row(model: string, opts?: PriceLookupOpts): PriceRow {
  const r = lookupPrice(model, { at: AT, ...opts });
  if ('unknown' in r) throw new Error(`registry row missing for ${model} — test fixture invalid`);
  return r;
}

/** Hand-compute Σ(tokens × row) the same way the seam does (per-MILLION rates). */
function handCompute(
  r: PriceRow,
  t: { input: number; output: number; cacheRead: number; cacheWrite: number }
): number {
  return (
    (t.input / 1_000_000) * r.inputPerM +
    (t.output / 1_000_000) * r.outputPerM +
    (t.cacheRead / 1_000_000) * r.cacheReadPerM +
    (t.cacheWrite / 1_000_000) * r.cacheWritePerM
  );
}

/** The seam token mapping: accum.cacheRead → cacheReadTokens, accum.cacheCreation
 *  → cacheWriteTokens, contextSize = input (mirrors telemetry.ts aggregateLive). */
function seamUsd(
  model: string,
  t: { input: number; output: number; cacheRead: number; cacheWrite: number }
): number | null {
  return resolvePrice(
    model,
    {
      inputTokens: t.input,
      outputTokens: t.output,
      cacheReadTokens: t.cacheRead,
      cacheWriteTokens: t.cacheWrite
    },
    { at: AT, contextSize: t.input }
  ).usd;
}

function within5pct(actual: number, expected: number): void {
  // Exact-vs-registry: the compute equals tokens × the row to floating-point
  // precision, which is well inside the ≤5% bill-accuracy gate.
  expect(actual).toBeCloseTo(expected, 10);
  if (expected !== 0) {
    expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThanOrEqual(0.05);
  }
}

describe('SC-002/SC-003 — DeepSeek cache read/write SPLIT (FR-004)', () => {
  const MODEL = 'deepseek-v4-flash';
  // Asymmetric cache tokens so a mis-mapping (read↔write) changes the result.
  const tokens = { input: 1_200_000, output: 300_000, cacheRead: 800_000, cacheWrite: 50_000 };

  it('prices cacheRead at cacheReadPerM and cacheCreation at cacheWritePerM (distinct rates)', () => {
    const r = row(MODEL);
    // Guard: the registry row really has a SPLIT (read ≪ write) so the test is meaningful.
    expect(r.cacheReadPerM).not.toBe(r.cacheWritePerM);

    const expected = handCompute(r, tokens);
    const usd = seamUsd(MODEL, tokens);
    expect(usd).not.toBeNull();
    within5pct(usd as number, expected);

    // The split is load-bearing: swapping the cache tokens MUST change the USD,
    // proving cacheRead is not silently priced at the write rate (or vice versa).
    const swapped = handCompute(r, { ...tokens, cacheRead: tokens.cacheWrite, cacheWrite: tokens.cacheRead });
    expect(swapped).not.toBeCloseTo(expected, 10);
  });

  it('equals tokens × the registry row EXACTLY (exact vs the registry)', () => {
    const r = row(MODEL);
    const expected =
      (tokens.input / 1_000_000) * r.inputPerM +
      (tokens.output / 1_000_000) * r.outputPerM +
      (tokens.cacheRead / 1_000_000) * r.cacheReadPerM +
      (tokens.cacheWrite / 1_000_000) * r.cacheWritePerM;
    expect(seamUsd(MODEL, tokens)).toBe(expected);
  });
});

describe('SC-002/SC-003 — Minimax whole-call context TIER (FR-004 / AD-004)', () => {
  const MODEL = 'minimax-m3';
  // Read the long-context (tiered) row to learn the real threshold — no magic number.
  const longRow = row(MODEL, { contextSize: Number.MAX_SAFE_INTEGER });
  const threshold = longRow.contextTierThreshold;

  it('the registry exposes a context tier threshold for Minimax', () => {
    expect(threshold).toBeTypeOf('number');
    expect(threshold as number).toBeGreaterThan(0);
  });

  it('BELOW threshold uses the base-tier row for the WHOLE call', () => {
    const thr = threshold as number;
    const input = thr - 1; // just below the boundary → base tier
    const tokens = { input, output: 100_000, cacheRead: 0, cacheWrite: 0 };

    const baseRow = row(MODEL, { contextSize: input });
    expect(baseRow.contextTierThreshold).toBeUndefined(); // selected the base row

    const expected = handCompute(baseRow, tokens);
    const usd = seamUsd(MODEL, tokens);
    expect(usd).not.toBeNull();
    within5pct(usd as number, expected);
  });

  it('ABOVE threshold reprices the WHOLE call (input+output) at the higher tier row', () => {
    const thr = threshold as number;
    const input = thr + 1; // just above the boundary → long-context tier
    const tokens = { input, output: 100_000, cacheRead: 0, cacheWrite: 0 };

    const aboveRow = row(MODEL, { contextSize: input });
    // Crossing the boundary selected the tiered (higher) row.
    expect(aboveRow.contextTierThreshold).toBe(thr);
    expect(aboveRow.inputPerM).toBeGreaterThan(row(MODEL, { contextSize: 0 }).inputPerM);

    // Whole-call reprice: output is ALSO priced at the higher tier's outputPerM,
    // not the base tier — derived from the registry row, not a literal.
    const expected = handCompute(aboveRow, tokens);
    const usd = seamUsd(MODEL, tokens);
    expect(usd).not.toBeNull();
    within5pct(usd as number, expected);

    // Sanity: the same tokens priced at the base tier would be cheaper — proving
    // the WHOLE call (not just the input class) was repriced at the higher tier.
    const baseExpected = handCompute(row(MODEL, { contextSize: 0 }), tokens);
    expect(usd as number).toBeGreaterThan(baseExpected);
  });

  it('equals tokens × the selected tier row EXACTLY at the boundary crossing', () => {
    const thr = threshold as number;
    const tokens = { input: thr + 1, output: 100_000, cacheRead: 0, cacheWrite: 0 };
    const r = row(MODEL, { contextSize: tokens.input });
    const expected =
      (tokens.input / 1_000_000) * r.inputPerM +
      (tokens.output / 1_000_000) * r.outputPerM +
      (tokens.cacheRead / 1_000_000) * r.cacheReadPerM +
      (tokens.cacheWrite / 1_000_000) * r.cacheWritePerM;
    expect(seamUsd(MODEL, tokens)).toBe(expected);
  });
});

describe('SC-003 — Claude vector (cache split, no tier)', () => {
  const MODEL = 'claude-opus-4';
  const tokens = { input: 500_000, output: 200_000, cacheRead: 1_000_000, cacheWrite: 100_000 };

  it('prices input/output/cacheRead/cacheWrite at the dated Claude row within ≤5%', () => {
    const r = row(MODEL);
    const expected = handCompute(r, tokens);
    const usd = seamUsd(MODEL, tokens);
    expect(usd).not.toBeNull();
    within5pct(usd as number, expected);
  });

  it('equals tokens × the registry row EXACTLY', () => {
    const r = row(MODEL);
    const expected =
      (tokens.input / 1_000_000) * r.inputPerM +
      (tokens.output / 1_000_000) * r.outputPerM +
      (tokens.cacheRead / 1_000_000) * r.cacheReadPerM +
      (tokens.cacheWrite / 1_000_000) * r.cacheWritePerM;
    expect(seamUsd(MODEL, tokens)).toBe(expected);
  });
});

describe('FR-003 — no family/Anthropic default for a non-Claude / unknown id', () => {
  it('an unknown model id is usd = null (NOT a sibling/Anthropic price)', () => {
    const usd = seamUsd('totally-unknown-model-xyz', {
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 0,
      cacheWrite: 0
    });
    expect(usd).toBeNull();
  });
});

// ─── E007 US3 — unknown/unpriced models FAIL LOUD, not wrong (T022) ─────────────
//
// (a) An unknown model id → usd === null (NOT 0), unknownModel true, and a SINGLE
//     operator-visible parity warning on the `telemetry:event` channel, deduped,
//     carrying ONLY the model id (no secret/token/prompt). (FR-006 / SC-007)
// (b) A KNOWN model with a MISSING usage field → a REAL registry-computed usd (a
//     number, NOT null), the missing field treated as zero ONLY, the price intact
//     (bestEffort true). The missing-field path is NEVER conflated with the
//     unknown-model usd=null path. (FR-007 / SC-007)

describe('US3 (a) {FR-006} — unknown model fails loud: usd=null + ONE deduped parity warning', () => {
  const UNKNOWN = 'totally-unknown-provider-model-zzz';

  it('resolvePrice on an unknown id → usd null, unknownModel true, NOT bestEffort', () => {
    const r = resolvePrice(UNKNOWN, { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(r.usd).toBeNull();        // unpriced — explicitly NOT 0 (no free read)
    expect(r.unknownModel).toBe(true);
    expect(r.bestEffort).toBe(false); // NOT conflated with the missing-field path
  });

  it('the seam emits exactly ONE operator-visible parity warning (deduped) carrying ONLY the model id', () => {
    const events: TelemetryEvent[] = [];
    const collector = new TelemetryCollector({
      emit: (channel, payload) => {
        if (channel === 'telemetry:event') events.push(payload as TelemetryEvent);
      }
    });

    // Drive native usage on a KNOWN provider but an UNKNOWN model id (so it joins,
    // then prices to usd=null). The secret-bearing fields the warning MUST NOT echo
    // are not even part of the input — only token counts + ids reach the seam.
    const ingest = (): boolean =>
      collector.ingestNativeUsage({
        agentId: 'desk-unknown',
        sessionId: 's1',
        providerName: 'deepseek',
        requestModel: UNKNOWN,
        tokens: { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheCreation: 0 }
      });
    expect(ingest()).toBe(true); // joins + accumulates (known provider)

    // The published usage sample bills NO default price — usd is null, not 0.
    const sample = collector.getAgentUsage('desk-unknown');
    expect(sample).not.toBeNull();
    expect(sample!.usd).toBeNull();

    const warnings = events.filter((e) => e.kind === 'parity_warning');
    expect(warnings).toHaveLength(1); // surfaced once for this model
    const w = warnings[0] as { kind: 'parity_warning'; model: string; ts: number };
    expect(w.model).toBe(UNKNOWN);   // bounded to the model id ALONE

    // FR-013 — the warning payload carries ONLY {kind, model, ts}: no tokens, no
    // prompt/response content, no headers, no secret-bearing field.
    expect(Object.keys(w).sort()).toEqual(['kind', 'model', 'ts']);
    const blob = JSON.stringify(w);
    expect(blob).not.toContain('1000000');   // no token counts leaked
    expect(blob).not.toContain('deepseek');  // no provider/secret context
    expect(blob).not.toContain('session');   // no session/ids beyond the model
    expect(blob).not.toContain('desk-unknown');

    // Dedup: re-publishing the SAME unknown model does NOT spam a second warning.
    expect(ingest()).toBe(true);
    expect(events.filter((e) => e.kind === 'parity_warning')).toHaveLength(1);

    collector.stop();
  });

  it('a DIFFERENT unknown model raises its OWN single warning (dedup is per-model)', () => {
    const events: TelemetryEvent[] = [];
    const collector = new TelemetryCollector({
      emit: (channel, payload) => {
        if (channel === 'telemetry:event') events.push(payload as TelemetryEvent);
      }
    });
    const drive = (model: string, agentId: string): void => {
      collector.ingestNativeUsage({
        agentId, sessionId: 's', providerName: 'minimax', requestModel: model,
        tokens: { input: 10, output: 10, cacheRead: 0, cacheCreation: 0 }
      });
    };
    drive('unknown-model-aaa', 'desk-a');
    drive('unknown-model-bbb', 'desk-b');
    const models = events.filter((e) => e.kind === 'parity_warning').map((e) => (e as { model: string }).model);
    expect(models).toEqual(['unknown-model-aaa', 'unknown-model-bbb']);
    collector.stop();
  });
});

describe('US3 (b) {FR-007} — known model + missing usage field: zero that field, price intact', () => {
  const KNOWN = 'deepseek-v4-flash';

  it('a missing cache field → a REAL registry usd (a number, NOT null), bestEffort true', () => {
    const r = row(KNOWN);
    // cacheReadTokens / cacheWriteTokens OMITTED (provider didn't report them).
    const result = resolvePrice(
      KNOWN,
      { inputTokens: 1_000_000, outputTokens: 500_000 },
      { at: AT }
    );
    expect(result.usd).not.toBeNull();
    expect(typeof result.usd).toBe('number'); // a real price, NOT the unknown null
    expect(result.unknownModel).toBe(false);  // the price was found
    expect(result.bestEffort).toBe(true);     // a field was missing

    // The missing fields were treated as ZERO for THIS computation only — the price
    // row is intact: usd === input/output × the real registry row (cache = 0).
    const expected = (1_000_000 / 1_000_000) * r.inputPerM + (500_000 / 1_000_000) * r.outputPerM;
    expect(result.usd as number).toBe(expected);
    expect(result.usd as number).toBeGreaterThan(0); // not degraded to 0/null
  });

  it('supplying the missing field as 0 yields the IDENTICAL usd — the field, not the price, degraded', () => {
    const missing = resolvePrice(KNOWN, { inputTokens: 800_000, outputTokens: 200_000 }, { at: AT });
    const explicitZero = resolvePrice(
      KNOWN,
      { inputTokens: 800_000, outputTokens: 200_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { at: AT }
    );
    expect(missing.usd).toBe(explicitZero.usd); // zeroing the field == omitting it
    expect(explicitZero.bestEffort).toBe(false); // all fields present ⇒ exact
    expect(missing.bestEffort).toBe(true);       // a field was missing ⇒ best-effort
  });
});
