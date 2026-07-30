# Internal Interface Contract — Provider & Model Registry (E002)

Internal TypeScript module interface (no network API). Lives in `src/shared/providerRegistry.ts` so both the main process (pricing/cost) and the renderer (E005 model metadata/capabilities) consume one definition. References: ADR-0005, ADR-0008, `src/main/pricing.ts` (superseded), `src/shared/providerRuntime.ts` (`CapabilityDescriptor`).

## Query API (`src/shared/providerRegistry.ts`)

- `listProviders(): Provider[]` — all seeded providers.
- `lookupModel(providerId, modelId): Model | null` — model metadata (context window, endpoint, origin) by id; `null` when unseeded.
- `lookupCapabilities(modelId): CapabilityDescriptor` — the E001 descriptor for a model (or `EMPTY_CAPABILITY_DESCRIPTOR` when unknown).
- `lookupPrice(modelId, opts?: { contextSize?: number; at?: string }): PriceRow | { unknown: true }` — selects the dated row effective `at` (default now), then the tier matching `contextSize`. Returns a fail-loud sentinel (`{ unknown: true }`) + emits a loud warning for an unknown/unseeded model id — never another model's row.
- `computeCost(modelId, tokens: TokenSplit, opts?): { usd: number; bestEffort: boolean }` — `Σ tokens_k × price_k` from the selected row; `bestEffort: true` (with a surfaced note) when a required field (e.g. cache split) is missing; never a wrong-vendor default. Mirrors the existing `estimateCostUsd(model, tokens)` contract.

`TokenSplit` is reused from `pricing.ts` (`{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }`), mapped from `AgentUsageSample`. Model id is normalized (variant suffix `[1m]` stripped via `normalizeModel`) before lookup.

## Compatibility shim (`src/main/pricing.ts`)

`pricing.ts` is kept as a thin shim re-exporting registry-backed functions so existing consumers don't change imports:
- `normalizeModel(model)` — re-exported (used by `transcript.ts`, `telemetry.ts`).
- `estimateCostUsd(model, tokens)` — delegates to `computeCost`; returns the `usd` number. Claude models resolve to the same values as today (SC-006); unknown ids fail loud (warn + best-effort) instead of defaulting to Sonnet.
- `priceFor(model)` — delegates to `lookupPrice` (kept for back-compat where referenced).

## Seed data outline

- **Anthropic/Claude**: opus/sonnet/haiku 4.x; capabilities all `true`; price rows **identical** to the current `pricing.ts` values (OPUS 15/75/1.5/18.75; SONNET 3/15/0.3/3.75; HAIKU 0.8/4/0.08/1.0 per M) → no regression.
- **DeepSeek**: V4-class; capabilities all `false`; cache hit/miss split rows. *(confirm prices at build time)*
- **Minimax M3**: capabilities all `false`; two tiered rows (`contextTierThreshold ≈ 512K`). *(confirm price + tier at build time)*
