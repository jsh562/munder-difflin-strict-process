---
feature_branch: "00007-cross-provider-cost-telemetry"
created: "2026-06-09"
input: "Provider-accurate true-cost recompute + OTel GenAI telemetry normalization for native agents."
spec_type: "product"
spec_maturity: "draft"
epic_id: "E007"
epic_sources: "{PRD:CAP-016}{SAD:ADR-0005,ADR-0006}"
---

# Feature Specification: Cross-Provider Cost Telemetry

**Feature Branch**: `00007-cross-provider-cost-telemetry`  
**Created**: 2026-06-09  
**Status**: Draft  
**Spec Type**: product  
**Spec Maturity**: draft  
**Epic ID**: E007  
**Epic Sources**: {PRD:CAP-016}{SAD:ADR-0005,ADR-0006}  
**Product Document**: specs/prd.md

## Problem Statement *(mandatory)*

Native desks now run on DeepSeek and Minimax (E006), but their cost is not trustworthy: the telemetry seam still derives per-agent USD from Claude Code's self-reported `cost.usage` metric, which is an Anthropic-priced figure that is simply wrong for a non-Anthropic model, and native agents emit no telemetry into that seam at all — so a DeepSeek or Minimax desk shows no cost and no tool-span waterfall. Budgets and the circuit breaker act on this cost, and the release is gated on ≤5% cost-attribution accuracy across all three providers. Until cost is computed provider-accurately, once, from the price registry — and native agents reach the same telemetry seam as Claude — the operator cannot trust any cost number, budgets misfire on non-Claude desks, and the headline accuracy gate cannot be met.

## Scope *(mandatory)*

### Included

- Computing per-agent and fleet cost (USD) once at the single usage seam from token counts × the E002 dated price registry, for every provider (Claude, DeepSeek, Minimax) — replacing reliance on any provider's self-reported cost.
- Honoring the registry's pricing nuances: DeepSeek cache read/write split and Minimax context-length tier (whole-call repricing past the threshold), via dated price rows.
- Replacing the family-string pricing default so a non-Claude model is never priced with a wrong (Anthropic) default.
- Failing loud on an unknown/unpriced model id with a clear telemetry-parity warning, instead of billing a default price.
- Native agent workers emitting OpenTelemetry GenAI semantic-convention spans/metrics to the existing loopback collector, with the semconv version pinned.
- The loopback collector normalizing both Claude `claude_code.*` (delta) and native `gen_ai.*` usage into the same existing cumulative `AgentUsageSample` and `ToolSpan` shapes — reconciling delta-vs-cumulative without double-counting — so no downstream consumer changes.
- A native-provider desk reaching telemetry parity: the same per-agent token/cost telemetry and tool-span waterfall as a Claude desk.
- Meeting the ≤5% cost-attribution accuracy gate for non-Claude providers.
- Scrubbing API keys/secrets so they never appear in any emitted telemetry.

### Excluded

- The price registry data and lookup/compute functions themselves — owned by E002 (the dated rows, `lookupPrice`/`computeCost`); E007 consumes them and wires them into the live seam.
- The native adapters' in-process `token-usage` event emission — delivered by E006; E007 adds the telemetry-seam (OTel/collector) path that produces `AgentUsageSample`.
- Budget and circuit-breaker logic — E007 feeds them accurate cost; their thresholds and steer→constrain→stop behavior (CAP-017) are a separate epic.
- The shape of `AgentUsageSample` / `ToolSpan` — kept stable (the contract E009/E010 consume); E007 makes the values provider-accurate without changing the field shapes.
- Live model/provider switch parity (CAP-019) and the renderer cost/telemetry UI surfaces — consumers of this seam, not part of it.
- Reconciliation against a real provider bill in CI — live keys/bills are not in CI; accuracy is validated by reproducible golden vectors plus out-of-band manual reconciliation.

### Edge Cases & Boundaries

- An unknown/unpriced model id reaches the seam: a clear telemetry-parity warning is surfaced and NO default price is billed (the cost is flagged, not silently substituted).
- A usage field is missing on a known model (e.g., the provider omitted a cache count): that field degrades to zero for the computation only — the price is never degraded or substituted.
- A Minimax request crosses the context-length tier threshold: the whole call is priced at the higher tier per the registry row, not class-by-class at mixed tiers.
- Claude's self-reported `cost.usage` disagrees with the registry recompute: the registry value is authoritative unconditionally — any disagreement, of any magnitude, resolves to the registry value (no threshold gates the billed USD; self-reported cost is never the source of truth). The retained `cost.usage` is a diagnostic cross-check only and never affects the billed USD.
- Delta (Claude) and per-call (native) usage interleave: the per-agent counter stays cumulative-monotonic — it never decreases or double-counts across the two sources. If a sample would lower the counter, the counter holds at its prior cumulative max (the decrease is not applied), so the never-decreases invariant is preserved.
- A long-idle desk resumes: its cumulative counter is not falsely reset by idle-eviction.
- The pinned GenAI semconv version drifts (upstream changes shape): emission stays on the pinned version; an unrecognized incoming shape is ignored rather than mis-normalized. The two ignore-paths are distinguished by a measurable criterion at ingest: an "unrecognized shape" is a metric/span whose instrument or attribute schema does NOT match the pinned semconv (e.g. an unknown metric name, or a known name carrying the wrong/renamed attributes) — it is well-formed OTLP but off-version; a "malformed metric" is structurally invalid OTLP (e.g. a missing/non-numeric data point, an unparseable body). Both are dropped (accumulate nothing), but they are counted on distinct internal reasons (drift vs malformed) so the two cases are not conflated and drift is attributable to semconv change rather than corruption.
- A secret would otherwise appear in a span attribute or metric: it is scrubbed; telemetry carries only token counts and the required ids.

## User Scenarios & Testing *(mandatory for product specs only)*

### User Story 1 - Provider-accurate cost for every desk (Priority: P1)

The operator looks at any desk — Claude, DeepSeek, or Minimax — and sees a USD cost computed from that model's real token counts × the price registry, including cache splits and context tiers, never an Anthropic-priced approximation. The same number drives the cost ledger, budgets, and the breaker.

**Why this priority**: The core value and the release gate (CAP-016, ≤5% accuracy) — without provider-accurate cost the operator cannot trust any number and budgets/breaker misfire on non-Claude desks.

**Independent Test**: Run a DeepSeek desk and a Minimax desk; confirm each desk's reported USD equals its tokens × the registry price (cache split / context tier applied) within ≤5%, and that no provider's self-reported cost is used.

**Acceptance Scenarios**:

1. **Given** a desk on any provider with known token counts, **When** its usage reaches the seam, **Then** the USD is computed once as Σ(tokens × registry price) and is not recomputed by any downstream consumer.
2. **Given** a DeepSeek desk with cache hits, **When** its cost is computed, **Then** cache read and cache write tokens are priced at their distinct registry rates.
3. **Given** a Minimax desk whose request crosses the context-length tier threshold, **When** its cost is computed, **Then** the whole call is priced at the higher tier per the registry row.
4. **Given** Claude's self-reported `cost.usage` differs from the registry recompute, **When** the seam computes cost, **Then** the registry value is used, not the self-reported one.

### User Story 2 - Native desks reach telemetry parity (Priority: P1)

A desk running on DeepSeek or Minimax shows the same per-agent telemetry as a Claude desk — live token/cost and the tool-span waterfall — because the native worker emits OpenTelemetry GenAI telemetry that the loopback collector normalizes into the same `AgentUsageSample` and `ToolSpan` shapes, with no change to any downstream consumer.

**Why this priority**: Telemetry parity (CAP-016 / ADR-0006) is how accurate cost actually reaches the operator, the ledger, and the breaker for native agents; without it a native desk is a blank in the cost/telemetry surfaces.

**Independent Test**: Run a native desk alongside a Claude desk; confirm the native desk produces an `AgentUsageSample` (token + registry-computed cost) and `ToolSpan` entries equivalent to the Claude desk, via the collector, with the cost ledger / breaker / waterfall consuming them unchanged.

**Acceptance Scenarios**:

1. **Given** a native-provider desk doing work, **When** it runs, **Then** its worker emits OTel GenAI spans/metrics (a pinned semconv version) to the loopback collector.
2. **Given** both Claude `claude_code.*` (delta) and native `gen_ai.*` usage arriving, **When** the collector normalizes them, **Then** both produce a cumulative-monotonic `AgentUsageSample` (no double-count, no decrease) and `ToolSpan` entries in the existing shapes.
3. **Given** a native desk's normalized usage, **When** the cost ledger, budgets, breaker, and the per-agent waterfall read it, **Then** they consume it unchanged (no provider-specific consumer code).

### User Story 3 - Unknown or unpriced models fail loud, not wrong (Priority: P1)

When a model id is not in the price registry, the operator gets a clear parity warning rather than a silently wrong cost — the desk is never billed a default (e.g., Anthropic) price for an unpriced model.

**Why this priority**: Safety and trust (Principle II: an unknown id MUST fail loud, never default to another vendor's price) — a wrong default silently corrupts budgets, the breaker, and the ledger.

**Independent Test**: Point a desk at an unknown/unpriced model id; confirm a clear telemetry-parity warning is surfaced and no default price is billed; then confirm a known model with one missing usage field degrades that field to zero (not the price).

**Acceptance Scenarios**:

1. **Given** a model id absent from the registry, **When** its usage reaches the seam, **Then** a clear telemetry-parity warning is surfaced and no default/substituted price is applied.
2. **Given** a known model with a missing usage field, **When** cost is computed, **Then** the absent field is treated as zero for that computation only and the price is never substituted or degraded.

## Requirements *(mandatory)*

### Functional Requirements *(product specs only)*

- **FR-001**: System MUST compute per-agent and fleet cost (USD) once at the single usage seam from token counts × the E002 price registry, for every provider (Claude, DeepSeek, Minimax).
- **FR-002**: System MUST NOT recompute USD anywhere downstream of the usage seam — the seam is the single source of cost truth.
- **FR-003**: System MUST price every model from the registry's per-provider/per-model dated price rows and MUST NOT apply a family-string or Anthropic default to a non-Claude model.
- **FR-004**: Cost computation MUST honor the registry's pricing nuances — DeepSeek cache read/write split and Minimax context-length tier (whole-call repricing past the threshold) — selecting the price row by effective date.
- **FR-005**: System MUST NOT use any provider's self-reported USD (including Claude Code's `cost.usage`) as the cost source; USD is always derived from the registry.
- **FR-006**: An unknown/unpriced model id MUST surface a clear telemetry-parity warning and MUST NOT be billed a default or substituted price. The sample's `usd` MUST be `null` (unpriced — explicitly NOT 0, so a consumer never reads it as free); the operator-visible parity warning is the flag, and consumers exclude a `null` `usd` from billed totals. The parity-warning payload MUST be bounded to the unknown model id alone — it MUST NOT include the failing request's prompt/response content, request tokens, headers, or any other secret-bearing field (FR-013) — so the `usd = null` sample adds no extra attribute beyond the least-attribute set (AD-005) and the warning is non-leaking and reviewable.
- **FR-007**: Best-effort degradation MUST apply only to a missing usage FIELD (treated as zero for that computation), never to the price; a missing price is never silently substituted.
- **FR-008**: Native agent workers MUST emit OpenTelemetry GenAI semantic-convention spans/metrics to the existing loopback collector. The set is closed (not "e.g."): the worker MUST emit an `invoke_agent` span per agent invocation, a `chat` span per inference call, and an `execute_tool` span per tool call (span `gen_ai.operation.name` carries the operation so the collector routes unambiguously: `invoke_agent` → agent invocation, `chat` → inference, `execute_tool` → tool call); and the `gen_ai.client.token.usage` histogram (unit `{token}`, split by the `gen_ai.token.type` attribute = `input` / `output`) for token usage. See FR-015 for the mandatory-vs-recommended attribute boundary the collector relies on.
- **FR-009**: The GenAI semantic-convention version MUST be pinned and recorded, since the conventions are experimental; emission stays on the pinned version.
- **FR-010**: The loopback collector MUST normalize both Claude `claude_code.*` (delta) and native `gen_ai.*` usage into the SAME existing cumulative `AgentUsageSample` and `ToolSpan` shapes, reconciling delta-vs-cumulative so the per-agent counter is cumulative-monotonic (never decreasing, never double-counting).
- **FR-011**: A native-provider desk MUST reach telemetry parity — equivalent per-agent token/cost telemetry and tool-span waterfall as a Claude desk — through the normalized `AgentUsageSample` + `ToolSpan`, with no provider-specific code in any downstream consumer.
- **FR-012**: Non-Claude per-agent and fleet cost MUST be provider-accurate within the ≤5% cost-attribution accuracy gate (computed tokens × registry vs the provider's real pricing), validated by reproducible golden vectors.
- **FR-013**: API keys and other secrets MUST be scrubbed and MUST NEVER appear in emitted telemetry — spans, metrics, attributes, or collector output (least-attribute emission; provider content-capture stays off). For this requirement a "secret" is any provider credential — an API key, an authorization/`Authorization`-style header value, or any other auth token/credential injected to the worker at spawn (ADR-0007). The NEVER guarantee is absolute and covers EVERY emission path, including the diagnostic and degradation channels: the retained `claude_code.cost.usage` diagnostic cross-check (FR-005), the unknown-model parity warning (FR-006), the missing-field best-effort degradation (FR-007), the clamp-monotonic reconciliation (FR-010), and the malformed-metric / semconv-drift drop paths (FR-009 edge case) MUST NOT echo any secret or request payload (prompt/response content, headers, request tokens) into a span, metric, attribute, log, warning, or diagnostic — they carry only token counts and the required join/cost ids. No error, warning, or diagnostic emitted by the seam is an exempt channel.
- **FR-014**: The `AgentUsageSample` and `ToolSpan` shapes MUST remain stable (the contract E009/E010 and the existing consumers depend on); E007 changes the cost source and adds native ingestion without changing the sample/span field names or structure, with ONE deliberate, approved widening: `AgentUsageSample.usd` becomes `number | null` so an unpriced (unknown-model) sample carries `null` (FR-006). Every consumer (ledger, breaker, renderer, waterfall) MUST handle a `null` `usd` by excluding it from billed totals (never treating it as 0).
- **FR-015**: The collector's usage→agent join depends on a MANDATORY attribute set that MUST be present on every emission requiring attribution: `gen_ai.agent.id` (the join key associating any span/metric to an agent — equivalently `agent.id`; present on every attributable emission), `gen_ai.provider.name`, `gen_ai.request.model`, and (on an `execute_tool` span) the tool name. `gen_ai.response.model` is RECOMMENDED (used in preference to `gen_ai.request.model` when present, but its absence is NOT a defect); other GenAI attributes are recommended. A missing RECOMMENDED attribute MUST NOT be treated as a defect. An emission missing a MANDATORY attribute (e.g. no `gen_ai.agent.id`) MUST NOT be attributed to an arbitrary agent or to "unknown" and silently accumulated — it is dropped (accumulate nothing) consistent with the malformed/unrecognized-metric ignore path, since it cannot be joined.
- **FR-016**: The collector MUST map a native `execute_tool` span to a `ToolSpan` by a fixed rule (no new or renamed field, FR-014): `tool` ← the tool-name attribute (`gen_ai.tool.name`); `duration` ← the span's elapsed time (end − start); `success` ← `true` when the span ends with status OK / unset and `false` when the span ends with status ERROR (or carries `error.type`); `error` ← the span's `error.type` / status-description when present, else empty; `decision` ← the tool-decision attribute when the span carries one, else the ToolSpan default (no decision recorded). A failed native tool invocation (status ERROR / `error.type` set) MUST populate `success = false` and the `error` field so the waterfall reflects failures, not only successes.

### Key Entities *(include for product or technical specs if feature involves data)*

- **AgentUsageSample** *(existing, made provider-accurate)*: the per-agent cumulative usage snapshot (agent, session, timestamp, input/output/cache token counts, model, USD) that the cost ledger, budgets, breaker, and renderer consume. E007 makes its USD registry-computed for every provider and feeds it from native agents too; field names/structure are unchanged except the one approved widening of `usd` to `number | null` (`null` = unpriced/unknown-model, FR-006/FR-014).
- **ToolSpan** *(existing, referenced)*: the per-agent tool-invocation record (agent, session, timestamp, tool, success, duration, decision, error) driving the waterfall; native agents now produce equivalent spans via the collector. The mapping from a native `execute_tool` span to these fields is fixed by FR-016 so the collector produces an equivalent record without renaming or adding any field (shape locked, FR-014).
- **PriceRow** *(E002, referenced)*: the dated per-provider/per-model price row (effective date, input/output/cache-read/cache-write per-million rates, optional context-tier threshold) that the cost is computed from.

## Assumptions & Risks *(mandatory)*

### Assumptions

- E002 provides the dated price registry plus `lookupPrice`/`computeCost` (Σ tokens × price, cache split, dated-row + context-tier selection, unknown → flagged); E007 wires these into the live seam and makes the unknown case a loud parity warning.
- The locked `UsageProvider`/`AgentUsageSample` + `ToolSpan` seam (`usage.ts`/`telemetry.ts`) is the single cost seam; the loopback OTLP collector already normalizes Claude `claude_code.*` metrics; USD is set once per sample today and is never recomputed downstream.
- E006 native adapters/worker emit cumulative-monotonic token usage; E007 routes that to the telemetry seam via OTel GenAI rather than the in-process event alone.
- OTel GenAI semconv is experimental, so a pinned version (`OTEL_SEMCONV_STABILITY_OPT_IN`) is acceptable and tracked.
- The provider's real bill (for ≤5% validation) is reconciled out-of-band; CI validates the computation against golden vectors of known token counts × dated rows.

### Risks

- **≤5% accuracy hard to validate without live bills / cache-field ambiguity** *(likelihood: medium, impact: high)*: cache-split semantics, tier boundaries, rounding, and promo dates cause drift; mitigated by golden-vector reconciliation against the dated rows + a build-time spike confirming each provider's usage fields, with out-of-band manual bill reconciliation.
- **Delta-vs-cumulative reconciliation double-counts or drops** *(likelihood: medium, impact: high)*: mixing Claude deltas with native per-call usage could break monotonicity; mitigated by single-writer cumulative accumulation, idempotent joins, and idle-eviction tuned above the longest idle gap.
- **Experimental GenAI semconv drift** *(likelihood: medium, impact: medium)*: upstream shape changes could break normalization; mitigated by pinning the version, recording it, and ignoring unrecognized incoming shapes rather than mis-mapping.

## Implementation Signals *(mandatory)*

- `NEW-CONFIG` — the pinned GenAI semconv version (`OTEL_SEMCONV_STABILITY_OPT_IN`) and the loopback collector's secret-scrubbing allowlist.
- `NEW-WORKER` — the native worker gains OTel GenAI emission to the loopback collector (extends the E006 worker); the collector gains a `gen_ai.*` normalization path.
- `BREAKING-CHANGE` — the cost SOURCE at the seam changes from provider self-reported (`claude_code.cost.usage`) to registry recompute; additive at the `AgentUsageSample` shape (FR-014), so downstream consumers are unchanged.
- `EXTERNAL-SERVICE` — none new; the collector is loopback and the providers were integrated in E006. (Listed for completeness; no new external dependency.)

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001** [US1]: Per-agent and fleet USD is computed once at the usage seam as Σ(tokens × registry price) for every provider, and no downstream consumer recomputes it.
- **SC-002** [US1]: A DeepSeek desk's cost reflects the cache read/write split and a Minimax desk's cost reflects the correct context-length tier (whole-call), per the registry rows — not a flat or Anthropic default.
- **SC-003** [US1,US2]: A non-Claude desk's computed cost matches its tokens × registry price within ≤5% (the release accuracy gate), verified by reproducible golden vectors.
- **SC-004** [US2]: A native-provider desk shows the same per-agent token/cost telemetry and tool-span waterfall as a Claude desk, via the normalized `AgentUsageSample` + `ToolSpan`, with the ledger/budgets/breaker/waterfall consuming it unchanged. "Same" is pinned to the field sets: the `AgentUsageSample` fields (agent, session, ts, input/output/cache token counts, model, usd) are populated equivalently (per Key Entities), and `ToolSpan` entries follow the FR-016 mapping — including a FAILED native tool call surfaced as `success = false` with a populated `error`, so the waterfall reflects failures, not only successes.
- **SC-005** [US2]: Native workers emit OTel GenAI spans/metrics on a pinned semconv version that the loopback collector normalizes into the existing cumulative shapes, with no downstream consumer change.
- **SC-006** [US2]: Claude delta usage and native per-call usage both normalize to a cumulative-monotonic `AgentUsageSample` — it never decreases or double-counts across the two sources.
- **SC-007** [US3]: An unknown/unpriced model id surfaces a clear telemetry-parity warning and bills no default price (the sample's `usd` is `null`, not 0); a missing usage field degrades that field to zero only, never substituting a price.
- **SC-008** [US1,US2]: No API key or secret appears anywhere in emitted telemetry (spans, metrics, attributes, or collector output) on ANY path — including the diagnostic (`cost.usage` cross-check), parity-warning, best-effort degradation, clamp-monotonic, and malformed/drift drop channels — verified by asserting the secret is absent from every emitted span/metric/attribute and from any warning/diagnostic/log the seam produces, including on the unknown-model and dropped-input paths.

## Glossary *(include when spec introduces 2+ domain-specific terms)*

| Term | Definition |
|------|------------|
| Usage seam | The single locked `UsageProvider`/`AgentUsageSample` point where per-agent usage + USD is produced; the one place cost is computed. |
| True-cost recompute | Computing USD from token counts × the price registry (not a provider's self-reported figure). |
| Compute-once | USD is computed at the seam — once per published cumulative sample — and is never recomputed by any downstream consumer of that sample. "Once" pins the place and writer (the seam), not a single lifetime computation: each cumulative `AgentUsageSample` carries a freshly seam-computed USD, but no downstream consumer re-derives it. |
| Dated price row | A registry price row keyed by effective date (and optional context-tier threshold) with per-class per-million rates. |
| Cache split | Distinct pricing for cache-read vs cache-write tokens (e.g. DeepSeek). |
| Context-length tier | A whole-call price tier selected by request size (e.g. Minimax ≤512K vs >512K). |
| OTel GenAI semconv | OpenTelemetry GenAI semantic conventions (spans + the token-usage histogram + attributes); experimental, version-pinned. |
| Loopback collector | The local `127.0.0.1` OTLP collector that normalizes provider telemetry into `AgentUsageSample` + `ToolSpan`. |
| Delta-vs-cumulative | Reconciling Claude's delta metrics and native per-call usage into one cumulative-monotonic counter. |
| Telemetry parity | A native desk producing the same `AgentUsageSample`/`ToolSpan`/waterfall as a Claude desk. |
| Parity warning | The loud signal raised when a model id is unknown/unpriced, instead of billing a default. |

## Compliance Check

Audited against project-instructions.md v1.0.0 (Principles I–V + Governance), AGENTS.md, .github/sddp-config.md, and ADR-0005/ADR-0006/ADR-0007 on 2026-06-09.

**Status: PASS** — no violations.

- Principle II (Truthful Cost Governance) — the central principle: PASS. Cost computed ONCE at the single seam (FR-001/002, SC-001) from token counts × dated registry rows (FR-003/004); self-reported USD incl. `claude_code.cost.usage` explicitly rejected (FR-005, US1 scenario 4); unknown id fails loud with a parity warning and bills no default (FR-006, SC-007); only a missing usage field degrades, never the price (FR-007); ≤5% gate via golden vectors (FR-012, SC-003). Realizes ADR-0005.
- Principle I (Provider-Agnostic Parity): PASS — native `gen_ai.*` + Claude `claude_code.*` normalize into the SAME `AgentUsageSample`/`ToolSpan`; no provider-specific downstream code (FR-010/011, SC-004/005). Realizes ADR-0006.
- Principle III (Crash-Contained Isolation): N/A — breaker/retry out of scope; single-writer cumulative accumulation consistent with single-committer.
- Principle IV (Agent Output Style): PASS — required sections only, terse.
- Principle V (Preserve Core & Type Safety): PASS — `AgentUsageSample`/`ToolSpan` shapes locked (FR-014); the `BREAKING-CHANGE` is the cost SOURCE only, additive at the sample shape; lands at the existing `/src` seam.
- Secrets never to telemetry (ADR-0007): PASS — keys scrubbed from spans/metrics/attributes/collector output (FR-013, SC-008).
- Governance out-of-scope guard: PASS — registry data (E002), native token-usage emission (E006), budget/breaker logic (CAP-017), switch parity + UI (CAP-019/E010) correctly excluded.

Carry to Plan: surface the `npm run typecheck` (node+web) hard gate in plan.md Instructions Check.
