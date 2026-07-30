# Research: Cross-Provider Cost Telemetry

Product-spec research for provider-accurate true-cost recompute + OTel GenAI telemetry normalization for native (DeepSeek/Minimax) agents in a local Electron harness. A loopback OTLP collector (`telemetry.ts`) today sums Claude's `claude_code.token.usage` (deltas) and `claude_code.cost.usage` (self-reported USD, delta-summed) into the locked `AgentUsageSample` + `ToolSpan` seam that feeds the cost ledger, budgets, breaker, and tool-span waterfall. E002 already provides the dated price registry + `lookupPrice`/`computeCost`; E007 wires registry recompute into the live seam (replacing reliance on self-reported cost) and adds native OTel emission/normalization. USD is computed ONCE at the seam; unknown id fails loud; ≤5% accuracy gate.

## 1. OTel GenAI semantic conventions (spans + metrics)

GenAI span operations: `invoke_agent`/`create_agent` (INTERNAL for local), `execute_tool`, `chat`/inference. Token usage is the `gen_ai.client.token.usage` histogram (unit `{token}`), split by `gen_ai.token.type` = input/output. Standard attributes: `gen_ai.provider.name`, `gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.agent.id`, plus tool ids. All are EXPERIMENTAL ("Development" status, no stable timeline).

- **Recommended**: pin a version via `OTEL_SEMCONV_STABILITY_OPT_IN`; emit native workers through the same attribute set Claude uses so the seam ingests them identically; record the pinned version as a parity invariant.
- **Avoid**: treating attribute names/shapes as stable; mixing legacy and experimental emissions in one stream.
- **Sources**: opentelemetry.io GenAI metrics + agent-spans semconv.

## 2. Normalizing delta-vs-cumulative usage

Claude `claude_code.*` arrives as deltas (sum them); native GenAI token usage is per-call. Reconcile both into ONE cumulative-monotonic counter per agent, keyed by `gen_ai.agent.id`/`agent.id`. Single-writer accumulation (the harness main process) avoids multi-instance double-count; idempotent span→agent joins (dedupe by span id) survive retries/replays; a cumulative counter must never decrease.

- **Recommended**: single-writer per-agent cumulative accumulation; idempotent joins; tune any idle-eviction (`max_stale`) above the longest agent-idle gap so a long-quiet desk's counter doesn't falsely reset.
- **Avoid**: multi-collector/load-balanced accumulation (non-monotonic downstream); summing native per-call usage as if it were a delta stream.
- **Sources**: OTel collector deltatocumulative processor.

## 3. True-cost from token counts × dated price rows

Compute USD = Σ(tokens_k × price_k) once at the seam. DeepSeek splits cache-hit vs cache-miss input pricing; Minimax bills a context-length tier — crossing ~512K reprices the WHOLE call (input+output+cache) at the long-context rate (~2×), so evaluate the tier from the call's total tokens BEFORE pricing any class. Select the price row by effective date (promo/launch discounts are time-bounded → dated rows mandatory).

- **Recommended**: distinguish failure modes — unknown model id → fail loud (parity warning), never default a price; a missing usage FIELD on a known model → best-effort (treat absent class as 0, flag), never a substituted price. Use actual token counts from response metadata.
- **Avoid**: trusting a provider's self-reported USD; pricing each class independent of the Minimax tier; defaulting an unknown model to a sibling price.
- **Sources**: DeepSeek pricing docs; Minimax PAYGO pricing.

## 4. Cost-attribution accuracy (≤5% gate)

Teams reconcile computed cost against the provider's usage/billing dashboard for the same period. Drift sources: cache-class accounting differences, day-boundary bucketing, SDK rounding, tier-boundary misclassification, promo/discount expiry. Industry rule-of-thumb: <~10% delta is boundary/rounding noise; the ≤5% gate here is stricter, so cache-column alignment is the highest-leverage check.

- **Recommended**: CI-reproducible golden vectors (known token-class counts → expected USD per dated row) runnable WITHOUT live keys/bills; plus an out-of-band manual reconcile against the real dashboard to validate the registry rows.
- **Avoid**: validating only against live bills (not CI-reproducible); comparing mismatched cache columns across the two sides; ignoring discount expiry.
- **Sources**: LiteLLM cost-discrepancy guide; Traceloop bill-reconciliation.

## 5. Keeping secrets out of telemetry

GenAI semconv treats prompt/response content as Opt-In, so secret-bearing content stays off by default. Emit only token counts + the required ids the cost ledger needs — never API keys/auth headers.

- **Recommended**: least-attribute emission; keep content-capture OFF; enforce a fail-closed allowlist on the loopback collector as defense-in-depth (aligns with ADR-0007: no keys in hive/transcripts/telemetry).
- **Avoid**: capturing prompt/response content for secret-bearing agents; denylist-only scrubbing (misses unknown key shapes); relying on hashing for sensitive ids.
- **Sources**: OTel handling-sensitive-data; collector redaction processor.

## Summary

Pin an experimental GenAI semconv version and emit native workers through the same attribute/histogram contract Claude uses. Accumulate to one single-writer cumulative-monotonic counter per agent (idempotent joins, idle-eviction tuned), and compute USD once at the seam from the E002 dated price rows — DeepSeek cache split, Minimax whole-call tier repricing — failing loud on an unknown model while degrading gracefully only on a missing usage field. Replace reliance on Claude's self-reported `cost.usage` with registry recompute so the cost source is uniform. Validate the ≤5% gate with CI golden vectors plus out-of-band dashboard reconciliation, and keep secrets out via least-attribute emission with content-capture off and a fail-closed collector allowlist.
