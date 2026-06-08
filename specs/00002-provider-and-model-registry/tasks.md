# Tasks: Provider and Model Registry

**Input**: Design documents from `specs/00002-provider-and-model-registry/`
**Prerequisites**: `plan.md` (required), `spec.md` (required), `data-model.md`, `contracts/registry-interface.md`

**Tests**: Included — the spec mandates test-verified Success Criteria (SC-001..SC-007, each "verified by a test"); the Testing Strategy in `plan.md` configures Vitest for the registry suite.

**Organization**: Grouped by Technical Objective (`OBJ#`). All three objectives are P1 and write into the single shared module `src/shared/providerRegistry.ts`, so the shared types/scaffold are lifted to Foundational and the per-objective tasks are sequenced (not `[P]`) where they edit that one file.

## Project Mode

`Brownfield`

- Extends an existing Electron 32 / TypeScript codebase; no project bootstrap.
- vitest + eslint are already installed and gating — no Setup install step.
- The one repo-config delta is `tsconfig.web.json` (test exclude, HINT-005).

## Epic / Capability Map

- `[OBJ1]` → E002 OBJ1: Provider/model registry & data model (canonical config — TR-001, TR-006/seed metadata).
- `[OBJ2]` → E002 OBJ2: Dated/tiered pricing + fail-loud lookup + cost (TR-002, TR-003, TR-004, TR-007, TR-008).
- `[OBJ3]` → E002 OBJ3: Per-provider/model capability descriptors (TR-005).

## Brownfield Notes

- Existing flows touched: `src/main/pricing.ts` (becomes a thin shim, AD-002); consumed by `src/main/transcript.ts` (`estimateCostUsd`, `normalizeModel`) and `src/main/telemetry.ts` (`normalizeModel`) — imports MUST keep working (HINT-004).
- Compatibility/migration concerns: replace the family-string + Sonnet-default table (`priceFor`/`estimateCostUsd`) with registry-backed lookup; preserve Claude per-M values exactly (OPUS 15/75/1.5/18.75; SONNET 3/15/0.3/3.75; HAIKU 0.8/4/0.08/1.0) so cost is bit-identical (SC-006, HINT-002, VR-8); keep `normalizeModel` re-exported.
- Regression focus: offline transcript reconciler must keep running — fail-loud is a loud warning + best-effort sentinel, never a throw that crashes it and never a wrong-vendor default (AD-003, HINT-003).
- Ordering: land registry types + seed + lookup in `src/shared/providerRegistry.ts` FIRST; the pricing.ts shim and tests depend on it (HINT-001).
- `CapabilityDescriptor` MUST conform exactly to the E001 shape in `src/shared/providerRuntime.ts` (4 boolean fields, no add/rename) — reuse it, plus `EMPTY_CAPABILITY_DESCRIPTOR` (VR-9, AD-005).

---

## Phase 1: Setup (Repository / Workspace Delta)

**The single repo-config change: keep the new registry test out of the web typecheck (HINT-005, AD-002). Land it early so subsequent test work doesn't break `npm run typecheck`.**

- [ ] T001 Add `"exclude": ["src/**/__tests__/**", "src/**/*.test.ts"]` to tsconfig.web.json so the `src/shared` registry test is not pulled into the web typecheck (node tsconfig already excludes it)

---

## Phase 2: Foundational (Cross-Work-Item Blockers)

**The registry module is one shared file consumed by all three objectives; create its types + empty module skeleton first so OBJ1/OBJ2/OBJ3 tasks have a stable surface to extend (HINT-001). Blocks every delivery phase.**

- [ ] T002 {TR-001} Create registry type definitions (Provider, Model, PriceRow, ProviderModelRegistry, PriceLookupKey) in src/shared/providerRegistry.ts, re-using the E001 CapabilityDescriptor + pricing.ts TokenSplit shapes after:T001 → see data-model.md
- [ ] T003 {TR-001,TR-004} Add `normalizeModel` (reuse the variant-suffix regex) and lookup scaffolding (`listProviders`, `lookupModel` returning null on miss) in src/shared/providerRegistry.ts ← T002:Provider,Model → exports: listProviders(), lookupModel(providerId,modelId), normalizeModel(model)

---

## Phase 3: OBJ1 - Provider/model registry & data model (Priority: P1) 🎯 MVP

**Canonical, extensible provider/model catalog with metadata lookup (context window, endpoint, origin). Satisfies TR-001 and the metadata half of seed TR-006; validated by SC-001.**

- [ ] T004 [OBJ1] {TR-006} Seed Provider+Model metadata for anthropic/Claude (opus/sonnet/haiku 4.x), deepseek (V4-class), minimax (M3) — id, displayName, contextWindow, defaultEndpoint, originLabel — in src/shared/providerRegistry.ts after:T003 ← T002:Provider,Model → exports: PROVIDER_REGISTRY
- [ ] T005 [OBJ1] {TR-001} Implement metadata query so `lookupModel(providerId, modelId)` returns context window / endpoint / origin and unseeded ids resolve only as data edits (no consumer-code change) in src/shared/providerRegistry.ts after:T004 ← T004:PROVIDER_REGISTRY → exports: lookupModel
- [ ] T006 [P] [OBJ1] {TR-001} Test: SC-001 — seeded models return metadata (context window/endpoint/origin) and a registry-data-added model resolves with no consumer-code change, in src/shared/__tests__/providerRegistry.test.ts after:T005 ← T005:lookupModel

---

## Phase 4: OBJ2 - Dated/tiered pricing with fail-loud lookup (Priority: P1) 🎯 MVP

**Dated, cache-split, context-tiered price rows; a fail-loud price lookup; cost = token split × selected row, replacing the Sonnet default while preserving Claude values. Satisfies TR-002/003/004/007/008; validated by SC-002/003/005/006/007.**

- [ ] T007 [OBJ2] {TR-002} Seed dated PriceRow arrays per model (input/output/cacheRead/cacheWrite perM + effectiveDate); Claude rows EXACTLY match pricing.ts OPUS/SONNET/HAIKU values; DeepSeek cache hit/miss split; flag confirm-at-build-time figures — in src/shared/providerRegistry.ts after:T004 ← T002:PriceRow,Model
- [ ] T008 [OBJ2] {TR-003} Seed Minimax M3 two-tier rows (base + long-context `contextTierThreshold ≈ 512_000`, higher rate) in src/shared/providerRegistry.ts after:T007 ← T002:PriceRow
- [ ] T009 [OBJ2] {TR-002,TR-003} Implement `lookupPrice(modelId, opts?)` row selection — normalize id, date filter (latest effectiveDate ≤ `at`, VR-3), deterministic tier match (VR-4) — in src/shared/providerRegistry.ts after:T008 ← T002:PriceRow → exports: lookupPrice(modelId,opts)
- [ ] T010 [OBJ2] {TR-004} Add fail-loud branch to lookupPrice: unknown/unseeded id emits a loud warning + returns the `{ unknown: true }` sentinel (never another model's row, never a throw that crashes the reconciler), removing DEFAULT_PRICE=SONNET — in src/shared/providerRegistry.ts after:T009 ← T009:lookupPrice → exports: lookupPrice
- [ ] T011 [OBJ2] {TR-007,TR-008} Implement `computeCost(modelId, tokens, opts?)` = Σ tokens_k × price_k / 1e6 from the selected row (VR-6); return `{ usd, bestEffort }` with bestEffort+surfaced gap on a missing required field, never a wrong default (VR-7) — in src/shared/providerRegistry.ts after:T010 → exports: computeCost(modelId,tokens,opts)
- [ ] T012 [P] [OBJ2] {TR-002,TR-003} Test: SC-002 — known-model lookup returns the correct dated/tiered row, exercising DeepSeek cache hit/miss and Minimax context-tier selection, in src/shared/__tests__/providerRegistry.test.ts after:T011 ← T009:lookupPrice
- [ ] T013 [P] [OBJ2] {TR-004} Test: SC-003 — unknown model id produces a loud failure (warning + sentinel) and zero silent wrong-price defaults, in src/shared/__tests__/providerRegistry.test.ts after:T011 ← T010:lookupPrice
- [ ] T014 [P] [OBJ2] {TR-007} Test: SC-005 — cost from token split × selected row matches expected provider-accurate values within tolerance for seeded providers, in src/shared/__tests__/providerRegistry.test.ts after:T011 ← T011:computeCost
- [ ] T015 [P] [OBJ2] {TR-008} [COMPLETES TR-008] Test: SC-007 — missing required usage field degrades to documented best-effort (bestEffort flag + surfaced gap), never a wrong-vendor default, in src/shared/__tests__/providerRegistry.test.ts after:T011 ← T011:computeCost

---

## Phase 5: OBJ3 - Per-provider/model capability descriptors (Priority: P1) 🎯 MVP

**Per-model CapabilityDescriptor (image / MCP / web-search / caching) conforming to the E001 shape, queryable by consumers. Satisfies TR-005; validated by SC-004.**

- [ ] T016 [OBJ3] {TR-006} Seed CapabilityDescriptor per seeded model — Claude all `true`; DeepSeek and Minimax all `false` (VR-9) — attached to each Model in src/shared/providerRegistry.ts after:T004 ← T002:CapabilityDescriptor
- [ ] T017 [OBJ3] {TR-005} Implement `lookupCapabilities(modelId)` returning the model's E001 CapabilityDescriptor, or `EMPTY_CAPABILITY_DESCRIPTOR` for an unknown id, in src/shared/providerRegistry.ts after:T016 ← src/shared/providerRuntime.ts:EMPTY_CAPABILITY_DESCRIPTOR → exports: lookupCapabilities(modelId)
- [ ] T018 [P] [OBJ3] {TR-005} Test: SC-004 — capabilities for 100% of seeded providers are queryable and correctly declare image/MCP/web-search/caching, including an unsupported-feature case returning `false`, in src/shared/__tests__/providerRegistry.test.ts after:T017 ← T017:lookupCapabilities

---

## Phase 6: Polish & Cross-Cutting Concerns

**Wire pricing.ts to the registry (compat shim, AD-002), prove no Claude regression, and run the repo gates. Cross-cuts OBJ1/OBJ2/OBJ3 because the shim depends on the full lookup/cost surface.**

- [ ] T019 {TR-007} Convert src/main/pricing.ts to a thin shim: `estimateCostUsd`/`priceFor` delegate to registry computeCost/lookupPrice; re-export `normalizeModel`; keep `ModelPrice`/`TokenSplit` so transcript.ts/telemetry.ts imports are unchanged (HINT-004) after:T011 → exports: estimateCostUsd, normalizeModel, priceFor
- [ ] T020 {TR-007} [COMPLETES TR-007] Test: SC-006 — `estimateCostUsd` is bit-identical to the prior family-string table for seeded Claude models (OPUS/SONNET/HAIKU regression comparison), in src/shared/__tests__/providerRegistry.test.ts after:T019 ← T019:estimateCostUsd
- [ ] T021 [P] {TR-001,TR-006} [COMPLETES TR-006] Test: registry shim contract — transcript.ts/telemetry.ts still resolve `normalizeModel`/`estimateCostUsd`; assert seed structural invariants (provider/model/priceRow non-empty, contextWindow>0, all perM≥0, valid ISO effectiveDate — VR-10) in src/shared/__tests__/providerRegistry.test.ts after:T019 ← T019:normalizeModel
- [ ] T022 Run repo gates — `npm run typecheck`, `npm run lint`, `npm run test:run` — and resolve any failures so the registry + shim land green (constraint: all three stay green) after:T020 after:T021

---

## Dependencies

Setup → Foundational → OBJ1 → OBJ2 → OBJ3 → Polish

- **T001** (Setup) has no dependencies; land first so the new test file doesn't break the web typecheck.
- **T002–T003** (Foundational) depend on T001 and define the shared types + lookup scaffold every objective extends (HINT-001).
- **OBJ1 (T004–T006)**: T004 seeds provider/model metadata (after:T003); T005 metadata query (after:T004); T006 SC-001 test (after:T005).
- **OBJ2 (T007–T015)**: T007 price seed (after:T004, shares the seed structure); T008 Minimax tiers (after:T007); T009 row selection (after:T008); T010 fail-loud (after:T009); T011 computeCost (after:T010); T012–T015 are SC-002/003/005/007 tests (after:T011), parallel to each other (all append to the one test file but carry no inter-test dependency).
- **OBJ3 (T016–T018)**: T016 capability seed (after:T004); T017 query (after:T016); T018 SC-004 test (after:T017).
- **Polish (T019–T022)**: T019 shim depends on the full pricing surface (after:T011); T020 SC-006 regression and T021 shim-contract/invariants tests depend on T019; T022 runs the gates after T020 and T021.
- Tasks marked `[P]` are test additions with no dependency on each other and are never `[P]`-batched with a task they reference via `after:`/`←`. (They share one test file; run sequentially if the editor serializes file writes — `[P]` denotes logical independence, not concurrent file writes.)
- Cross-phase edges are explicit via `after:T###`; OBJ2 and OBJ3 both branch from the T004 seed but write disjoint fields (priceRows vs capabilities), so they may proceed independently after T004 while sharing the file.

## Requirement & Success-Criterion Coverage

| Req / SC | Task(s) |
|----------|---------|
| TR-001 | T002, T003, T005, T021 |
| TR-002 | T007, T009, T012 |
| TR-003 | T008, T009, T012 |
| TR-004 | T003, T010, T013 |
| TR-005 | T017, T018 |
| TR-006 | T004, T007, T016, T021 |
| TR-007 | T011, T019, T020 |
| TR-008 | T011, T015 |
| SC-001 | T006 |
| SC-002 | T012 |
| SC-003 | T013 |
| SC-004 | T018 |
| SC-005 | T014 |
| SC-006 | T020 |
| SC-007 | T015 |
