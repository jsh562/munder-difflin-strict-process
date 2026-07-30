---
adr_id: ADR-0006
status: accepted
date: 2026-06-07
tags: [multi-provider, observability, opentelemetry, cost]
supersedes: []
superseded_by: ""
related_artifacts: [specs/prd.md, specs/sad.md]
---

# ADR-0006: Cross-provider observability via OTel GenAI conventions at the loopback collector

## Status

Accepted.

## Context

`telemetry.ts` runs a loopback OTLP collector that today consumes Claude Code's `claude_code.token.usage` / `claude_code.cost.usage` metrics (delta-summed) and joins them to agents via a locked `UsageProvider`/`AgentUsageSample` contract that also feeds the cost ledger, budgets, breaker, and the per-agent `ToolSpan` waterfall. Native SDK adapters must produce equivalent telemetry so non-Claude agents reach telemetry parity without changing those downstream consumers.

## Decision Drivers

- Telemetry parity for non-Claude agents.
- Reuse the locked `UsageProvider`/`AgentUsageSample` + `ToolSpan` seam unchanged.
- Use standard conventions over a bespoke shape.
- Keep secrets out of telemetry.

## Considered Options

### Option A: Native workers emit OpenTelemetry GenAI semantic-convention spans/metrics to the same loopback collector

Native workers emit OpenTelemetry GenAI semantic-convention spans/metrics (`invoke_agent` / `chat` / `execute_tool` spans; `gen_ai.client.token.usage` histogram; `gen_ai.provider.name` / `request.model` / `response.model` / `agent.id` / `tool.name` attributes) to the SAME loopback collector, which normalizes both `claude_code.*` and `gen_ai.*` into one `AgentUsageSample` + `ToolSpan`.

- **Pros**: uniform observability + ToolWaterfall for native agents; standard conventions; downstream untouched.
- **Cons**: GenAI semconv is experimental (must pin a version); a normalization layer to maintain.

### Option B: Native agents bypass OTel and push onto an internal bus only

- **Pros**: simpler.
- **Cons**: diverges from the established collector; loses span/waterfall uniformity.

### Option C: A separate per-provider telemetry path

- **Pros**: provider-tuned.
- **Cons**: drift; duplicate consumers.

## Decision Outcome

Chosen option: **Option A: Native workers emit OpenTelemetry GenAI semantic-convention spans/metrics to the same loopback collector** — pin a GenAI semconv version (`OTEL_SEMCONV_STABILITY_OPT_IN`); the collector maps both Claude's delta metrics and the native GenAI metrics into the existing cumulative `AgentUsageSample` and the `ToolSpan` ring; API keys are scrubbed and never emitted.

## Consequences

### Positive

- Native agents get the same cost, budget, breaker, and tool-span treatment as Claude agents.

### Negative

- OTel GenAI conventions are still experimental, so a version must be pinned and tracked; the normalization layer must reconcile delta-vs-cumulative usage.

### Neutral

- Cost USD is still derived from the registry (ADR-0005), not from any provider's self-reported value.

## Links

- PRD CAP-016.
- PRD CAP-018.
- Related ADR-0002 (event bus).
- Related ADR-0005 (pricing).
