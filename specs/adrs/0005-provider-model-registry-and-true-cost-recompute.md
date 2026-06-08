---
adr_id: ADR-0005
status: accepted
date: 2026-06-07
tags: [multi-provider, cost, pricing, registry]
supersedes: []
superseded_by: ""
related_artifacts: [specs/prd.md, specs/sad.md]
---

# ADR-0005: Extensible provider/model registry with dated price rows and single-seam true-cost recompute

## Status

Accepted.

## Context

The existing `pricing.ts` matches model FAMILY strings (opus/sonnet/haiku) and silently defaults unknown ids to Sonnet. For DeepSeek/Minimax this default is a correctness bug. A coding-agent CLI's self-reported USD is an Anthropic-priced approximation and is wrong for non-Anthropic models. Budgets and the circuit breaker depend on accurate cost (the PRD sets a ≤5% cost-attribution-accuracy release gate). Providers add complications: DeepSeek reports a cache-hit/miss split; Minimax M3 prices by context-length tier (≤512K vs >512K); both run rotating promos and dated model deprecations.

## Decision Drivers

- Cost-attribution accuracy across providers.
- Safety (never mis-bill via a wrong default).
- Maintainability under volatile, dated pricing.
- Extensibility to new providers/models.
- Preserve the existing invariant that USD is computed once at the UsageProvider seam and never recomputed downstream.

## Considered Options

### Option A: Dated, versioned per-provider registry with single-seam true-cost recompute

A dated, versioned per-provider registry keyed by provider+modelId+effectiveDate, with rows supporting cache-split and context-length tiers; cost computed once at the usage seam as Σ(tokens_k × price_k); fail loud on unknown model id. The same registry also holds context windows, endpoints, and an origin label; three providers validated, registry open for more.

- **Pros**: Accurate, safe, extensible, maintainable.
- **Cons**: Dated-row maintenance burden; needs a build-time spike to confirm provider usage fields.

### Option B: Keep family-string pricing

Retain the current family-string matching with a default fallback.

- **Pros**: No change.
- **Cons**: Wrong for non-Anthropic; unsafe default.

### Option C: Trust each provider's self-reported USD

Consume each provider's self-reported USD figure directly without a pricing table.

- **Pros**: No table.
- **Cons**: Approximations; cross-provider wrong; breaks budgets/breaker.

## Decision Outcome

Chosen option: **Option A** — replace family matching with the registry; compute USD once at the usage seam from cumulative-monotonic token samples; an unknown model id raises a loud telemetry-parity warning rather than defaulting to a price; best-effort degradation applies only when a usage FIELD is missing, never the price.

## Consequences

### Positive

- Provider-accurate cost feeds budgets/breaker/ledger.
- Extensible and safe.

### Negative

- The price table must be kept dated and current.
- A build-time spike is required to confirm DeepSeek/Minimax usage fields (cache split).

### Neutral

- The registry becomes the canonical config artifact for providers and models.

## Links

- PRD CAP-012, CAP-016, CAP-017.
- Related ADR-0002 (token-usage event).
- Related ADR-0006 (OTel/collector normalization).
