/**
 * Compatibility shim over the provider/model registry (E002).
 *
 * Pricing is no longer a hardcoded family-string table — it lives in the data-
 * driven registry (`src/shared/providerRegistry.ts`), which carries dated/tiered
 * rows for every provider and FAILS LOUD on an unknown model id instead of the
 * old `DEFAULT_PRICE = SONNET`. This module stays as a thin shim so existing
 * consumers (`transcript.ts`, `telemetry.ts`) keep importing `normalizeModel` /
 * `estimateCostUsd` unchanged. Claude cost is bit-identical to the prior table
 * because the registry's Claude rows are the same constants (SC-006).
 */
import {
  computeCost,
  lookupPrice,
  type PriceLookupOpts,
  type PriceRow,
  type TokenSplit as RegistryTokenSplit
} from '../shared/providerRegistry';

// Re-exported from the registry — the one canonical normalizer.
export { normalizeModel } from '../shared/providerRegistry';

/** USD per million tokens for one model. Kept for back-compat with `priceFor`. */
export interface ModelPrice {
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM: number;
  cacheWritePerM: number;
}

/** Token split used by the cost estimator (matches `AgentUsage` token fields). */
export interface TokenSplit {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Resolve a model id to its price row (back-compat shape). An unknown id no
 * longer defaults to Sonnet — it returns a zeroed row (the registry has already
 * warned), never another vendor's price.
 */
export function priceFor(model: string | undefined | null): ModelPrice {
  const row: PriceRow | { unknown: true } = lookupPrice(model);
  if ('unknown' in row) return { inputPerM: 0, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0 };
  return {
    inputPerM: row.inputPerM,
    outputPerM: row.outputPerM,
    cacheReadPerM: row.cacheReadPerM,
    cacheWritePerM: row.cacheWritePerM
  };
}

/**
 * Estimate USD cost for a token split. Delegates to the registry's `computeCost`,
 * which uses the same arithmetic and the same Claude price rows as before, so the
 * result is unchanged for Claude models and fail-loud (best-effort 0) for unknown.
 */
export function estimateCostUsd(model: string | undefined | null, tokens: TokenSplit): number {
  return computeCost(model, tokens).usd;
}

/**
 * Seam price resolution (E007 AD-003 / FR-006 / FR-007). The ONE place the usage
 * seam resolves token counts → USD, distinguishing the two failure modes the
 * registry's `computeCost {usd, bestEffort}` conflates:
 *
 *   - UNKNOWN MODEL id (`lookupPrice` → `{unknown:true}`): there is NO price row,
 *     so NO price is billed. Returns `usd = null` (unpriced — explicitly NOT $0)
 *     and `unknownModel = true`, so the seam writes `AgentUsageSample.usd = null`
 *     and raises the parity warning. The registry has already `console.warn`ed
 *     the unknown id (fail-loud) — never a wrong-vendor default.
 *   - KNOWN MODEL, MISSING usage FIELD: the model has a price row, so the price is
 *     never substituted. The absent field degrades to 0 for THIS computation only
 *     (registry `computeCost` already treats a nullish field as 0); `usd` is the
 *     best-effort number and `bestEffort = true`.
 *
 * The context size (the call's input/prompt length, AD-004/HINT-003) is threaded
 * into the lookup opts so the Minimax context-length tier row is selected, then
 * the WHOLE call (input+output+cache) is repriced at that selected dated row.
 *
 * USD is computed ONCE here from the registry; consumers never recompute (FR-002).
 */
export function resolvePrice(
  model: string | undefined | null,
  tokens: RegistryTokenSplit,
  opts?: PriceLookupOpts
): { usd: number | null; unknownModel: boolean; bestEffort: boolean } {
  // Distinguish unknown-model FIRST — `computeCost`'s bestEffort flag conflates
  // an unknown id with a missing field, so check the row directly (HINT-002).
  const row = lookupPrice(model, opts);
  if ('unknown' in row) {
    // Unpriced: no default/substituted price. `null`, NOT 0 (FR-006).
    return { usd: null, unknownModel: true, bestEffort: false };
  }
  // Known model: price is fixed; a missing token field degrades to 0 only (FR-007).
  const { usd, bestEffort } = computeCost(model, tokens, opts);
  return { usd, unknownModel: false, bestEffort };
}
