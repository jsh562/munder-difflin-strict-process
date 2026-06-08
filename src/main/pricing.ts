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
import { computeCost, lookupPrice, type PriceRow } from '../shared/providerRegistry';

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
