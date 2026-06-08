---
adr_id: ADR-0009
status: accepted
date: 2026-06-07
tags: [multi-provider, reliability, circuit-breaker]
supersedes: []
superseded_by: ""
related_artifacts: [specs/prd.md, specs/sad.md]
---

# ADR-0009: Provider-call reliability policy (retry/backoff and breaker separation)

## Status

Accepted.

## Context

Native agents make direct provider API calls subject to rate limits (429), transient 5xx, overload (529), and timeouts. Cross-provider failover is OUT of scope for the MVP, but resilience is in scope. The existing circuit breaker has an error-storm trip (`recordError`) and separate cost/velocity trips; a transient rate-limit blip must not false-trip the error-storm ladder, and the breaker must keep distinguishing provider errors from cost overruns.

## Decision Drivers

- Resilience to transient provider errors without false breaker trips.
- Avoid thundering-herd retries across 5–15 concurrent agents.
- Bound long autonomous runs.
- Keep cost-overrun and error-storm trips distinct.

## Considered Options

### Option A: Retryable-status allowlist with jittered backoff and breaker separation

A retryable-status allowlist (429, 500, 502, 503, 504, 529 + connection/read timeouts; never 400/401) with Retry-After honored when present, else exponential backoff with full jitter (3–5 attempts, cap ~30–60s); only EXHAUSTED retries / non-retryable errors feed `breaker.recordError`; cost overruns remain a separate cost/velocity trip; a per-turn wall-clock budget bounds long runs.

- **Pros**: Resilient; no false error-storm trips; no herd; bounded.
- **Cons**: Per-adapter retry/backoff + error-classification logic.

### Option B: Retry everything

- **Pros**: Trivial.
- **Cons**: Retries non-retryable errors; wastes spend; masks real failures.

### Option C: No retry; let the breaker absorb all errors

- **Pros**: Simplest.
- **Cons**: Transient blips false-trip steer→constrain→stop.

## Decision Outcome

Chosen option: **Option A** — Adapters retry transient retryable errors silently with Retry-After + full-jitter backoff; exhausted/non-retryable errors surface as api-error events that feed the breaker error-storm trip; cost overruns stay a separate trip; a per-turn wall-clock budget caps long runs.

## Consequences

### Positive

- Resilient under rate limits/overload.
- No false breaker trips from transient blips.
- Spend protected by the separate cost trip.

### Negative

- Each adapter must classify errors and implement bounded jittered backoff.

### Neutral

- Failover across providers remains explicitly out of scope (roadmap).

## Links

- PRD CAP-017.
- Related ADR-0002 (api-error event).
- Related ADR-0003 (worker).
- Related ADR-0008 (capabilities).
