/**
 * Provider & model registry (E002 / ADR-0005, ADR-0008).
 *
 * The canonical, data-driven catalog of providers and models — metadata, dated +
 * tiered price rows, and capability descriptors — that every provider-aware epic
 * reads. It supersedes the family-string table in `src/main/pricing.ts` (which
 * defaulted any unknown id to Sonnet): an unknown model id now FAILS LOUD (warns)
 * and is never priced as another vendor. Lives in `src/shared` so the main process
 * (pricing/cost) and the renderer (model metadata/capabilities, E005) share one
 * definition. Pure data + functions — no node/electron deps.
 *
 * Claude price rows are kept identical to the prior `pricing.ts` constants so cost
 * is bit-identical for Claude models (SC-006).
 */
import { EMPTY_CAPABILITY_DESCRIPTOR, type CapabilityDescriptor } from './providerRuntime';

/** A dated (and optionally context-tiered) price row, USD per MILLION tokens —
 *  same unit as the prior `ModelPrice` so Claude cost is unchanged. */
export interface PriceRow {
  /** ISO date (YYYY-MM-DD); the row applies from this date onward. */
  effectiveDate: string;
  inputPerM: number;
  outputPerM: number;
  /** Cache-hit (read) price. */
  cacheReadPerM: number;
  /** Cache-write / miss price. */
  cacheWritePerM: number;
  /** When set, this row applies only when the request context size exceeds the
   *  threshold (e.g. Minimax M3 long-context tier > ~512K tokens). */
  contextTierThreshold?: number;
}

export interface Model {
  /** Canonical (normalized) model id. */
  id: string;
  providerId: string;
  displayName: string;
  /** Max context window, tokens. */
  contextWindow: number;
  capabilities: CapabilityDescriptor;
  /** Dated/tiered price rows (newest-applicable selected at lookup). */
  priceRows: PriceRow[];
  /** Optional substrings that also resolve to this model — used for vendor
   *  families whose exact ids vary (e.g. any `claude-opus-*` → the Opus row),
   *  preserving the prior family-string behavior for Claude. */
  matchSubstrings?: string[];
}

export interface Provider {
  id: string;
  displayName: string;
  /** Region/jurisdiction. Data-only — NOT enforced or surfaced (PRD: risk-only). */
  originLabel: string;
  defaultEndpoint: string;
  models: Model[];
}

export interface ProviderModelRegistry {
  providers: Provider[];
}

/** Token split for cost; fields optional so a missing one degrades best-effort. */
export interface TokenSplit {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface PriceLookupOpts {
  /** Request context size (tokens) — selects a context-length tier. */
  contextSize?: number;
  /** ISO date the price is effective at (default: today). */
  at?: string;
}

/** Fail-loud sentinel returned for an unknown/unseeded model id. */
export interface UnknownPrice {
  unknown: true;
}

// ── Seed data ───────────────────────────────────────────────────────────────
// Claude rows MUST match the prior pricing.ts constants (SC-006). DeepSeek and
// Minimax figures + the Minimax tier are research seeds — CONFIRM AT BUILD TIME
// (ADR-0005 spike) before treating them as authoritative.

const ALL_CAPS: CapabilityDescriptor = {
  supportsImages: true,
  supportsMcpTools: true,
  supportsWebSearch: true,
  supportsCaching: true
};
const NO_CAPS: CapabilityDescriptor = { ...EMPTY_CAPABILITY_DESCRIPTOR };
// DeepSeek has context caching (hit/miss pricing) but no image/MCP/web-search.
const DEEPSEEK_CAPS: CapabilityDescriptor = { ...EMPTY_CAPABILITY_DESCRIPTOR, supportsCaching: true };

const CLAUDE_EFFECTIVE = '2025-01-01';
const PROVIDER_SEED_DATE = '2026-06-01';

export const PROVIDER_REGISTRY: ProviderModelRegistry = {
  providers: [
    {
      id: 'anthropic',
      displayName: 'Anthropic (Claude)',
      originLabel: 'US',
      defaultEndpoint: 'https://api.anthropic.com',
      models: [
        {
          id: 'claude-opus-4',
          providerId: 'anthropic',
          displayName: 'Claude Opus 4.x',
          contextWindow: 200_000,
          capabilities: ALL_CAPS,
          matchSubstrings: ['opus'],
          // Identical to prior pricing.ts OPUS — do not change (SC-006).
          priceRows: [{ effectiveDate: CLAUDE_EFFECTIVE, inputPerM: 15, outputPerM: 75, cacheReadPerM: 1.5, cacheWritePerM: 18.75 }]
        },
        {
          id: 'claude-sonnet-4',
          providerId: 'anthropic',
          displayName: 'Claude Sonnet 4.x',
          contextWindow: 200_000,
          capabilities: ALL_CAPS,
          matchSubstrings: ['sonnet'],
          priceRows: [{ effectiveDate: CLAUDE_EFFECTIVE, inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75 }]
        },
        {
          id: 'claude-haiku-4',
          providerId: 'anthropic',
          displayName: 'Claude Haiku 4.x',
          contextWindow: 200_000,
          capabilities: ALL_CAPS,
          matchSubstrings: ['haiku'],
          priceRows: [{ effectiveDate: CLAUDE_EFFECTIVE, inputPerM: 0.8, outputPerM: 4, cacheReadPerM: 0.08, cacheWritePerM: 1.0 }]
        }
      ]
    },
    {
      id: 'deepseek',
      displayName: 'DeepSeek',
      originLabel: 'CN',
      defaultEndpoint: 'https://api.deepseek.com',
      models: [
        {
          id: 'deepseek-v4-flash',
          providerId: 'deepseek',
          displayName: 'DeepSeek V4 Flash',
          contextWindow: 1_000_000,
          capabilities: DEEPSEEK_CAPS,
          // CONFIRM AT BUILD TIME — cache-read = hit, cache-write = miss (≈ input).
          priceRows: [{ effectiveDate: PROVIDER_SEED_DATE, inputPerM: 0.14, outputPerM: 0.28, cacheReadPerM: 0.0028, cacheWritePerM: 0.14 }]
        },
        {
          id: 'deepseek-v4-pro',
          providerId: 'deepseek',
          displayName: 'DeepSeek V4 Pro',
          contextWindow: 1_000_000,
          capabilities: DEEPSEEK_CAPS,
          // CONFIRM AT BUILD TIME — promo figures; standard list ~1.74/3.48.
          priceRows: [{ effectiveDate: PROVIDER_SEED_DATE, inputPerM: 0.435, outputPerM: 0.87, cacheReadPerM: 0.003625, cacheWritePerM: 0.435 }]
        }
      ]
    },
    {
      id: 'minimax',
      displayName: 'MiniMax',
      originLabel: 'CN',
      defaultEndpoint: 'https://api.minimax.io',
      models: [
        {
          id: 'minimax-m3',
          providerId: 'minimax',
          displayName: 'MiniMax M3',
          contextWindow: 1_000_000,
          capabilities: NO_CAPS,
          matchSubstrings: ['minimax-m3', 'minimax_m3'],
          // CONFIRM AT BUILD TIME — base tier + long-context tier (> ~512K tokens).
          priceRows: [
            { effectiveDate: PROVIDER_SEED_DATE, inputPerM: 0.6, outputPerM: 2.4, cacheReadPerM: 0.6, cacheWritePerM: 0.6 },
            { effectiveDate: PROVIDER_SEED_DATE, inputPerM: 1.2, outputPerM: 4.8, cacheReadPerM: 1.2, cacheWritePerM: 1.2, contextTierThreshold: 512_000 }
          ]
        }
      ]
    }
  ]
};

// ── Lookup ──────────────────────────────────────────────────────────────────

/** Strip a variant suffix (e.g. `claude-opus-4-8[1m]` → `claude-opus-4-8`). */
export function normalizeModel(model: string | null | undefined): string {
  return (model ?? '').trim().replace(/\[[^\]]*\]\s*$/, '');
}

export function listProviders(): Provider[] {
  return PROVIDER_REGISTRY.providers;
}

function allModels(): Model[] {
  return PROVIDER_REGISTRY.providers.flatMap((p) => p.models);
}

/** Resolve a (possibly vendor-family) model id to its registry model, or null. */
export function lookupModel(modelId: string | null | undefined): Model | null {
  const norm = normalizeModel(modelId).toLowerCase();
  if (!norm) return null;
  const models = allModels();
  const exact = models.find((m) => m.id.toLowerCase() === norm);
  if (exact) return exact;
  for (const m of models) {
    if (m.matchSubstrings?.some((s) => norm.includes(s.toLowerCase()))) return m;
  }
  return null;
}

/** Model plus its owning provider (endpoint/origin), or null. */
export function lookupModelInfo(modelId: string | null | undefined): { model: Model; provider: Provider } | null {
  const model = lookupModel(modelId);
  if (!model) return null;
  const provider = PROVIDER_REGISTRY.providers.find((p) => p.id === model.providerId)!;
  return { model, provider };
}

export function lookupCapabilities(modelId: string | null | undefined): CapabilityDescriptor {
  return lookupModel(modelId)?.capabilities ?? EMPTY_CAPABILITY_DESCRIPTOR;
}

const warnedUnknown = new Set<string>();
function warnUnknownModel(id: string): void {
  const key = normalizeModel(id) || '(empty)';
  if (warnedUnknown.has(key)) return;
  warnedUnknown.add(key);
  // Fail loud — surface the gap; never silently price as another vendor.
  console.warn(`[providerRegistry] unknown model id "${key}" — not priced (no wrong-vendor default; cost best-effort 0).`);
}

function selectRow(rows: PriceRow[], opts?: PriceLookupOpts): PriceRow {
  const at = opts?.at ?? new Date().toISOString().slice(0, 10);
  const effective = rows
    .filter((r) => r.effectiveDate <= at)
    .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate));
  const pool = effective.length ? effective : rows; // fallback: no row effective yet
  const ctx = opts?.contextSize ?? 0;
  const tiered = pool.find((r) => r.contextTierThreshold != null && ctx > r.contextTierThreshold);
  if (tiered) return tiered;
  return pool.find((r) => r.contextTierThreshold == null) ?? pool[0];
}

/** Dated/tiered price row for a model, or a fail-loud sentinel on an unknown id. */
export function lookupPrice(modelId: string | null | undefined, opts?: PriceLookupOpts): PriceRow | UnknownPrice {
  const model = lookupModel(modelId);
  if (!model) {
    warnUnknownModel(modelId ?? '');
    return { unknown: true };
  }
  return selectRow(model.priceRows, opts);
}

/**
 * Compute USD from a token split × the selected price row. Returns `bestEffort`
 * true when the model is unknown (cost 0, already warned — never a wrong default)
 * or a required token field is missing. The arithmetic mirrors the prior
 * `estimateCostUsd` exactly so Claude cost is bit-identical (SC-006).
 */
export function computeCost(
  modelId: string | null | undefined,
  tokens: TokenSplit,
  opts?: PriceLookupOpts
): { usd: number; bestEffort: boolean } {
  const row = lookupPrice(modelId, opts);
  if ('unknown' in row) return { usd: 0, bestEffort: true };
  const missing =
    tokens.inputTokens == null ||
    tokens.outputTokens == null ||
    tokens.cacheReadTokens == null ||
    tokens.cacheWriteTokens == null;
  const usd =
    ((tokens.inputTokens ?? 0) / 1_000_000) * row.inputPerM +
    ((tokens.outputTokens ?? 0) / 1_000_000) * row.outputPerM +
    ((tokens.cacheReadTokens ?? 0) / 1_000_000) * row.cacheReadPerM +
    ((tokens.cacheWriteTokens ?? 0) / 1_000_000) * row.cacheWritePerM;
  return { usd, bestEffort: missing };
}
