# QC Report: E007 Cross-Provider Cost Telemetry

**Feature**: E007 | **Branch**: `00007-cross-provider-cost-telemetry` | **Date**: 2026-06-09
**Verdict**: PASSED
**Required categories** (.github/sddp-config.md): linting (PASS), performance (PASS)

## Category Verdicts

| Category | Verdict | Notes |
|----------|---------|-------|
| Build/Compile (typecheck node+web) | PASSED | `npm run typecheck` → both projects 0 errors (hard gate, Principle V) |
| Static Analysis / Linting (REQUIRED) | PASSED | `npm run lint` → 0 errors, 9 warnings; all 9 pre-existing/allowlisted; ZERO findings in any E007 file |
| Tests | PASSED | `npm run test:run` → 25 files, **203 tests** passed; E007 suites costVectors (14) + telemetryNormalize (19) green; no cold-start flake |
| Security (FR-013 / SC-008 secret non-leak) | PASSED | T024 block asserts an injected sentinel is absent from every sample/span/event/snapshot/drop tally/diagnostic across 5 input paths; runtime scrub confirmed (`deepseek-(redacted)`) |
| Performance (REQUIRED) | PASSED | Cost compute O(1) per publish (a few multiplies); no NFR benchmark defined; no introduced hot path |

## Test Results

Runner: Vitest 1.6.1 (forks). 25 files, **203/203 passed**, 0 failures. E007 suites: `costVectors.test.ts` (14 — golden-vector cost within ≤5%: DeepSeek cache split, Minimax tier below/above threshold, Claude; unknown→usd=null+warning; missing field→0), `telemetryNormalize.test.ts` (19 — claude_code.* delta + gen_ai.* normalize to one cumulative-monotonic AgentUsageSample + ToolSpan; semconv pin; drift vs malformed drop; T024 secret non-leak). stderr `[providerRegistry] unknown model id …` lines are asserted FR-006 parity-warning output, not failures.

## Static Analysis

ESLint `eslint src`: 0 errors, 9 warnings — all in pre-existing allowlisted files (breaker.ts ×2, hooks.ts, index.ts:667, reflect.ts, FileTree.tsx, useHive.ts ×2, OfficeFloor.tsx). Zero new findings in any E007-touched file: telemetry.ts, pricing.ts, usage.ts, runtime/nativeAgentWorker.ts, __tests__/costVectors.test.ts, __tests__/telemetryNormalize.test.ts.

## Security Audit

- **FR-013 / SC-008 (secrets never in telemetry, every channel)**: HOLDS. Fail-closed `ATTR_ALLOWLIST` in `flattenAttrs` drops every non-allowlisted OTLP attribute key before its value is read; `scrubSecret` redacts `sk-`/`pk-`/`api_`/`Bearer …` tokens from the few free-form strings (model id at both ingest seams, parity-warning model id, native `ToolSpan.error`); `claude_code.cost.usage` diagnostic and the drift/malformed drop paths are numeric-only; `api_error` emits a fixed label, never upstream free-text. T024 vitest injects a sentinel across metric-attr / log free-text / native-model-id / tool-error / malformed+drift drop paths and asserts absence from every emission; the unknown-model parity-warning payload is bounded to `{kind, model, ts}` with the model id redacted.
- **FR-006 (fail-loud, no wrong-vendor default)**: HOLDS. Unknown id → `usd=null` (explicitly not 0) + deduped parity warning; no family-string/Anthropic substitution.
- **FR-014 (shape stability)**: HOLDS. Only the approved `AgentUsageSample.usd → number | null` widening; all consumers (breaker, hive/ledger, renderer, waterfall) exclude `null` from billed totals.

## PI Compliance

No violations. Principle I (provider-agnostic parity — native gen_ai.* + Claude claude_code.* normalize into the SAME AgentUsageSample/ToolSpan; no provider-specific downstream code), II (truthful cost governance — USD computed once at the seam from real tokens × dated registry rows; self-reported `cost.usage` rejected as a source, retained diagnostic-only; unknown id fails loud, never defaults to another vendor's price; ≤5% gate via golden vectors), III (single-writer cumulative-monotonic accumulation in main, consistent with single-committer), V (AgentUsageSample/ToolSpan shapes locked except the approved widening; typecheck hard gate green; all source under /src) upheld. Secrets never to telemetry (ADR-0007) verified (FR-013).

## Requirements Traceability (Story Verifier)

**Result: PASS** — all 3 P1 user stories and all 8 success criteria SATISFIED; FR-001..FR-016 each trace to code + a passing test (live ≤5% bill reconciliation is the out-of-band manual half of FR-012, golden-vector covered in CI).

| Work item / SC | Status | Evidence basis |
|----------------|--------|----------------|
| US1 — Provider-accurate cost for every desk | SATISFIED | `aggregateLiveWithFlag` computes USD once via `resolvePrice`/`computeCost`; DeepSeek cache split + Minimax whole-call tier (`selectRow`); `cost.usage` diagnostic-only; costVectors |
| US2 — Native desks reach telemetry parity | SATISFIED | `nativeAgentWorker.forwardTelemetry` → `ingestNativeUsage`/`ingestNativeToolSpan`; gen_ai.* branch normalizes into existing shapes; delta/cumulative reconciliation clamp; telemetryNormalize |
| US3 — Unknown/unpriced models fail loud | SATISFIED | `resolvePrice` usd=null + `warnUnpricedModel` (deduped, model-id-only); missing field→0 not price; costVectors US3 |
| SC-001 | SATISFIED | Compute-once at the seam; no downstream recompute |
| SC-002 | SATISFIED | DeepSeek split + Minimax context tier per registry rows |
| SC-003 | SATISFIED (CI half) | Golden vectors == tokens×row within ≤5%; live-bill half manual (T026) |
| SC-004 | SATISFIED | AgentUsageSample field-equivalence + FR-016 ToolSpan mapping (failed tool → success=false + error) |
| SC-005 | SATISFIED | Pinned `PINNED_SEMCONV`; normalize into existing shapes; no consumer change |
| SC-006 | SATISFIED | Cumulative-monotonic across both sources; clamp on decrease; no double-count |
| SC-007 | SATISFIED | Unknown → usd=null + warning (not 0); missing field → zero only |
| SC-008 | SATISFIED | Secret absent from every span/metric/attr/event/diagnostic/drop path (T024) |

## Traceability Gaps

None. Every FR-001..FR-016 traces to code and a passing test; every SC-001..SC-008 traces to code + a passing test; every P1 scenario maps to implementation + a covering test.

## Code Coverage

No numeric coverage target (project policy). Coverage reported, not enforced.

## Checklist Fulfillment

Spot-checked `[Security]` and `[Testing]` categories against `checklists/` (data-integrity.md, observability.md, security.md — all items complete). PASSED, no gaps: secret non-leak (FR-013) implemented + tested; golden-vector, normalization, drop-path, and secret tests present; data-integrity (cumulative-monotonic, no double-count) covered.

## Performance

PASSED (no in-process regression by design). Cost compute is O(1) per publish; no NFR latency/throughput benchmark defined for this feature; no new hot path beyond the existing per-batch collector ingest.

## Accessibility

SKIPPED — no accessibility NFRs in spec (main-process telemetry seam; renderer surfaces are unchanged consumers).

## Browser Runtime Validation

SKIPPED — not required. Feature is a main-process cost/telemetry seam; spec scopes renderer cost/telemetry UI as unchanged consumers (out of scope). All acceptance is fixture/golden-vector tested.

## Manual Testing

`manual-reconciliation.md` (T026) records the out-of-band live ≤5% cost-attribution reconciliation (computed registry cost vs a real provider bill). Explicitly MANUAL, NOT a CI gate (plan AD-006 / FR-012) — live keys/bills are not in CI; the reproducible half is the costVectors golden vectors. No P1 acceptance criterion or SC depends solely on this manual gate. Does not block QC PASS (mirrors the E006 manual app-smoke precedent).

## Tool Recommendations

None. TODO(LINTER) in project-instructions is already satisfied for this feature — ESLint is configured and run as the linting gate.

## Bug Tasks Generated

None.

## Conclusion

All required QC categories pass with real command output: typecheck (hard gate) 0/0, lint 0 errors with no E007 findings, tests 203/203 (incl. costVectors 14 + telemetryNormalize 19), performance no-regression, security FR-013 secret-non-leak verified. All 3 P1 stories + SC-001..SC-008 SATISFIED; FR-001..FR-016 implemented and tested. No bug tasks. The live ≤5% bill reconciliation (FR-012) is separately tracked as an out-of-band manual gate, as designed. `.qc-passed` written.
