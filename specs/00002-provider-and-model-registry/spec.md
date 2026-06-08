---
feature_branch: "00002-provider-and-model-registry"
created: "2026-06-08"
input: "E002 Provider and model registry"
spec_type: "technical"
spec_maturity: "draft"
epic_id: "E002"
epic_sources: "{SAD:ADR-0005,ADR-0008}{PRD:CAP-012}"
---

# Feature Specification: Provider and Model Registry

**Feature Branch**: `00002-provider-and-model-registry`  
**Created**: 2026-06-08  
**Status**: Draft  
**Spec Type**: technical  
**Spec Maturity**: draft  
**Epic ID**: E002  
**Epic Sources**: {SAD:ADR-0005,ADR-0008}{PRD:CAP-012}  
**Product Document**: specs/prd.md

## Problem Statement *(mandatory)*

The harness has no single description of which providers and models exist, what they cost, or what they can do. Pricing today is a hardcoded family-string table (`src/main/pricing.ts`) that knows only Claude's opus/sonnet/haiku and **defaults every unknown model id to Sonnet** — which silently mis-prices DeepSeek and Minimax. Without a maintainable, dated, fail-loud registry, the multi-provider release cannot bill accurately, cannot tell which capabilities a provider lacks, and every later epic would re-derive provider facts ad hoc. This registry is the canonical configuration artifact those epics read.

## Scope *(mandatory)*

### Included

- An extensible registry describing each supported provider and model: provider id, model id, display name, context-window size, API endpoint/base URL, and an origin label (region/jurisdiction).
- Dated price rows per model — input, output, and cache-split prices — with effective dates, and optional context-length-tier thresholds.
- A price-lookup keyed by provider + model (and context size / date) that returns the correct row and **fails loud** on an unknown model id.
- Per-provider/model capability descriptors (image, MCP tools, web search, prompt caching) populating the `CapabilityDescriptor` shape defined in E001, queryable by consumers.
- Seed data for the three validated providers (Claude/Anthropic, DeepSeek, Minimax M3) with accurate context windows, endpoints, capabilities, and dated price rows.
- A cost computation from token counts × the selected price row that replaces the family-string fallback, preserving existing Claude cost behavior.

### Excluded

- Wiring provider-accurate cost into the live telemetry/budgets/breaker — that integration is E007/E009; E002 provides the lookup, not the live recompute path.
- Data-residency surfacing or allow/deny enforcement — deferred (PRD records PRC-hosting as a risk only); the origin label is captured as data, not enforced or surfaced in UI.
- Provider credential/API-key storage — E004.
- Per-agent / fleet-default model assignment and selection UI — E005.
- A pricing/admin GUI — the registry is a maintainable data/config artifact edited as data.
- Providers or models beyond the three validated.

### Edge Cases & Boundaries

- Unknown / unseeded model id → loud failure, never a silent wrong-vendor price.
- A request whose context size crosses a tiered-pricing threshold → the correct tier row is selected.
- A usage field needed for pricing (e.g. cache-token split) is absent → best-effort estimate with the gap surfaced, never a wrong default.
- A model id carrying a variant suffix (e.g. `[1m]`) → normalized to its base id before lookup.
- Multiple dated price rows for one model → the row effective at the relevant date is chosen.
- A provider/model added to the registry data → consumers see it with no code change.

## Technical Objectives *(mandatory for technical specs only)*

### Objective 1 - Provider/model registry & data model (Priority: P1)

Define the extensible registry describing providers and models (context windows, endpoints, origin label) as the canonical configuration artifact every later epic reads.

**Why this priority**: Foundation — E004, E005, E006, E007, and E009 all read provider/model facts from here; without it they would each re-derive them.

**Rationale**: A single data-driven registry keeps provider knowledge in one maintainable place and makes "add a provider" a data change, not a code change.

**Deliverables**:
- A `ProviderModelRegistry` data model + module under `/src` (providers, models, context windows, endpoints, origin labels).
- Seed entries for Claude/Anthropic, DeepSeek, and Minimax M3 with their relevant models.
- A query API to look up provider/model metadata.

**Validation Criteria**:
1. **Given** the seeded registry, **When** a consumer queries a model, **Then** it returns context window, endpoint, and origin for that model.
2. **Given** a new provider/model added as data, **When** consumers query it, **Then** it resolves with no consumer-code change.

### Objective 2 - Dated/tiered pricing with fail-loud lookup (Priority: P1)

Provide dated, cache-split, context-length-tiered price rows and a lookup that returns provider-accurate prices and fails loud on unknown model ids — replacing the family-string table that defaults to Sonnet.

**Why this priority**: Trustworthy budgets and cost depend on accurate per-provider pricing and on never silently mis-pricing an unknown model.

**Rationale**: Vendors run rotating promos and dated deprecations; pricing must be dated and maintainable, and a wrong default is worse than a loud failure.

**Deliverables**:
- Dated `PriceRow` entries per model (input, output, cache-read, cache-write/miss), with optional context-length-tier thresholds.
- A price-lookup keyed by provider + model (+ context size / date) with fail-loud behavior on unknown ids.
- A cost computation from a token split × the selected row (replacing `priceFor`/`estimateCostUsd`'s Sonnet default).

**Validation Criteria**:
1. **Given** a known model and a token split, **When** cost is computed, **Then** it uses the correct dated/tiered row (DeepSeek cache hit/miss; Minimax context tier).
2. **Given** an unknown model id, **When** a price is requested, **Then** the lookup fails loud (surfaces a warning/error) and does not return a wrong-vendor price.

### Objective 3 - Per-provider capability descriptors (Priority: P1)

Declare and expose per-provider/model capability descriptors (image, MCP tools, web search, prompt caching), populating the `CapabilityDescriptor` shape defined in E001.

**Why this priority**: Downstream graceful-degradation and warn-at-assignment (E005/E008) depend on knowing what each provider can and cannot do.

**Rationale**: DeepSeek and Minimax lack several features the Claude plane assumes; declaring them in one place lets consumers degrade gracefully instead of breaking.

**Deliverables**:
- Capability descriptors per seeded provider/model declaring image / MCP / web-search / caching support.
- A query API returning the descriptor for a given provider/model.

**Validation Criteria**:
1. **Given** the seeded registry, **When** a consumer queries a provider's capabilities, **Then** it returns an accurate `CapabilityDescriptor`.
2. **Given** a provider that lacks a capability, **When** queried, **Then** the descriptor reports it unsupported.

### Technical Constraints

- Prices MUST be dated and maintainable; price rows MUST support DeepSeek cache hit/miss split and Minimax context-length tiers.
- An unknown model id MUST fail loud — never default to another model's price (removes the Sonnet default).
- Existing Claude cost behavior MUST NOT regress when the registry supersedes the family-string table.
- The origin label is captured as a data field only; no residency surfacing or enforcement (deferred per PRD).
- All source resides under `/src`; `npm run typecheck` stays green and `npm run lint` stays clean.

## Integration Points *(mandatory for technical and operational specs)*

- **IP-001**: Replaces/extends `src/main/pricing.ts` (`priceFor` / `estimateCostUsd`, currently family-string + Sonnet default) with registry-backed dated/tiered, fail-loud lookup; `normalizeModel` (variant-suffix stripping) is reused.
- **IP-002**: Populates the `CapabilityDescriptor` shape from `src/shared/providerRuntime.ts` (E001); the `ProviderRuntime.capabilities()` accessor and consumers (E005 assignment, E008/E009) query the registry.
- **IP-003**: Cost computation consumes registry price rows; the `token-usage` / `AgentUsageSample` cache-split fields (cacheRead / cacheCreation) from E001 / `src/main/usage.ts` map to the registry's cache pricing.
- **IP-004**: Depended on by E004 (provider list + endpoints), E005 (capabilities + model selection), E006 (model/price/capability rows), E007 (true-cost recompute at the usage seam), E009 (budgets/breaker on true cost).

## Requirements *(mandatory)*

### Technical Requirements *(technical specs only)*

- **TR-001**: System MUST provide an extensible registry describing each supported provider and model with at least provider id, model id, display name, context-window size, API endpoint/base URL, and an origin label; new providers/models are addable as data without consumer-code changes.
- **TR-002**: The registry MUST carry dated price rows per model — input, output, cache-read, and cache-write/miss prices — each with an effective date.
- **TR-003**: Price rows MUST support context-length-tiered pricing (a threshold above which a different rate applies), selected by request context size.
- **TR-004**: System MUST provide a price-lookup keyed by provider + model id (and context size / effective date) that returns the correct row and MUST fail loud (surface a clear warning/error) on an unknown model id, never returning a wrong-vendor default.
- **TR-005**: System MUST provide per-provider/model capability descriptors declaring image-input, MCP-tool, web-search, and prompt-caching support, queryable by consumers and conforming to the E001 `CapabilityDescriptor` shape.
- **TR-006**: The registry MUST seed Claude/Anthropic, DeepSeek, and Minimax M3 with their relevant models, accurate context windows, endpoints, capability descriptors, and dated price rows.
- **TR-007**: Cost MUST be computed from a token split × the selected price row (mirroring the `estimateCostUsd` contract), replacing the family-string fallback and preserving existing Claude cost values.
- **TR-008**: When a usage field required for pricing (e.g. cache-token split) is unavailable, cost MUST degrade to a documented best-effort estimate and surface the gap — never a wrong-vendor default.

### Key Entities *(include for product or technical specs if feature involves data)*

- **ProviderModelRegistry**: The extensible catalog of providers and their models; the canonical config artifact every later epic reads.
- **Provider**: A model vendor — id, display name, origin label (region/jurisdiction), default endpoint/base URL.
- **Model**: A model offered by a provider — id, display name, context-window size, capability descriptor, and price rows.
- **PriceRow**: Dated per-model pricing — effective date, input/output/cache-read/cache-write prices, optional context-length-tier threshold.
- **CapabilityDescriptor** *(from E001)*: Declares supportsImages / supportsMcpTools / supportsWebSearch / supportsCaching per provider/model.

## Assumptions & Risks *(mandatory)*

### Assumptions

- DeepSeek and Minimax usage responses provide the token fields (including the cache split where applicable) the pricing needs; where absent, cost is best-effort.
- Provider list prices are obtainable and seeded with effective dates; they change over time (promos, deprecations).
- The validated models are Claude (opus/sonnet/haiku 4.x), DeepSeek (current V4-class), and Minimax M3.
- The E001 `CapabilityDescriptor` shape is the contract capability data conforms to.

### Risks

- **Pricing drift / dated-row maintenance** *(likelihood: high, impact: medium)*: Providers run promos and dated deprecations; stale rows mis-bill. Mitigation: dated rows + an easy-to-update data artifact; unknown ids fail loud.
- **Provider usage-field gaps** *(likelihood: medium, impact: medium)*: Missing cache-split fields force best-effort cost for some providers. Mitigation: documented best-effort degradation that surfaces the gap (TR-008).
- **Unconfirmed seed prices/tiers** *(likelihood: medium, impact: medium)*: Exact GA prices/tiers (esp. Minimax M3) may be promotional/third-party at author time. Mitigation: flag seed values for a build-time confirmation spike.

## Implementation Signals *(mandatory)*

- `NEW-ENTITY` — `ProviderModelRegistry` / `Provider` / `Model` / `PriceRow` data model.
- `NEW-CONFIG` — the registry as a maintainable, dated config/data artifact (price rows, capabilities, endpoints, origin labels).
- `BREAKING-CHANGE` — replaces `pricing.ts`'s `priceFor` / `estimateCostUsd` family-string + Sonnet-default behavior; the transcript reconciler and telemetry fallback move to registry lookup. Must preserve existing Claude cost values (no regression).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001** [OBJ1]: The registry returns provider+model metadata (context window, endpoint, origin) for 100% of seeded models, and a new provider/model added as data resolves with no consumer-code change (verified by a test).
- **SC-002** [OBJ2]: A price lookup for a known model returns the correct dated/tiered row, exercising DeepSeek cache hit/miss and Minimax context-tier selection (verified by tests).
- **SC-003** [OBJ2]: An unknown model id produces a loud failure and zero silent wrong-price defaults (verified by a test).
- **SC-004** [OBJ3]: Capability descriptors for 100% of seeded providers are queryable and correctly declare image / MCP / web-search / caching support (verified by a test).
- **SC-005** [OBJ2]: Cost computed from a token split × the selected row matches expected provider-accurate values within a defined tolerance for the seeded providers (verified by tests).
- **SC-006** [OBJ1]: Claude cost values are unchanged versus the prior `pricing.ts` family-string table for the seeded Claude models (no regression, verified by a comparison test).
- **SC-007** [OBJ2]: When a required usage field (e.g. cache-token split) is unavailable, cost degrades to a documented best-effort estimate and the gap is surfaced — never a wrong-vendor default (verified by a test).

## Glossary *(include when spec introduces 2+ domain-specific terms)*

| Term | Definition |
|------|------------|
| Provider/model registry | The extensible, data-driven catalog of providers and models (metadata, prices, capabilities) every later epic reads. |
| Price row | A dated per-model pricing entry (input/output/cache prices, optional context-tier threshold). |
| Cache-split pricing | Separate prices for cache-read (hit) vs cache-write/miss tokens (e.g. DeepSeek). |
| Context-length tier | A context-size threshold above which a model bills at a different rate (e.g. Minimax M3 > ~512K). |
| Origin label | A registry data field naming a provider's region/jurisdiction; captured only, not surfaced or enforced in MVP. |
| Fail-loud lookup | A price lookup that surfaces a warning/error on an unknown model id rather than defaulting to a wrong price. |
| Capability descriptor | The E001 shape declaring image / MCP / web-search / caching support per provider/model. |

## Compliance Check

**Result**: PASS — `project-instructions.md` v1.0.0 · **Audited**: 2026-06-08

| Principle | Verdict |
|-----------|---------|
| I. Provider-Agnostic Parity | PASS |
| II. Truthful Cost Governance | PASS |
| III. Crash-Contained Isolation | N/A (out of E002 scope) |
| IV. Agent Output Style | PASS |
| V. Preserve Proven Core & Type Safety | PASS |
| Source Layout (ENFORCE_SRC_ROOT) | PASS |
| Out-of-Scope Guard | PASS |

- Registry is the provider-agnostic canonical config; capability descriptor conforms to the E001 shape (TR-001, TR-005).
- Dated/tiered rows + fail-loud-on-unknown-id + cost = tokens × selected row (TR-002/003/004/007); implements accepted ADR-0005 & ADR-0008.
- No regression to existing Claude cost behavior (TR-007, SC-006); all source under `/src`; typecheck/lint gated.
- Residency captured as a data-only origin label; enforcement/surfacing correctly deferred. No out-of-scope item (auto-routing/failover/keychain/extra-providers) introduced.
- Scoped deferrals (E007 recompute wiring, E005 assignment UI, E004 credentials) are bounded, not violations.

**Remediations**: None blocking. Confirm unconfirmed Minimax M3 seed prices/tiers via the build-time spike (Risk; per ADR-0005) before GA seed data is authoritative.
