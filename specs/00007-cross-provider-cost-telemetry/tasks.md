# Tasks: Cross-Provider Cost Telemetry

**Feature**: E007 | **Branch**: `00007-cross-provider-cost-telemetry` | **Spec**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

## Project Mode

**Brownfield** — extends the existing Electron/TS harness. No scaffolding/bootstrap tasks. Work integrates into the live usage seam (`src/main/telemetry.ts`), the E002 registry consumers (`src/main/pricing.ts` / `src/shared/providerRegistry.ts`), the native worker usage forward (`src/main/runtime/`), and adds co-located vitest suites under `src/main/__tests__/`. `AgentUsageSample`/`ToolSpan` field shapes stay locked except the one approved `usd → number | null` widening (FR-014).

## Brownfield Notes

- **Central seam change** (Foundational): USD source at the collector publish moves from summing `claude_code.cost.usage` to `Σ(tokens × registry row)` (AD-001/FR-005). `cost.usage` is retained as a diagnostic cross-check only — both US1 (provider-accurate cost) and US2 (native parity) build on this seam.
- **One approved shape change**: `AgentUsageSample.usd` widens to `number | null` (`null` = unpriced/unknown-model, FR-006/FR-014); all consumers (ledger, breaker, renderer, waterfall) must exclude `null` from billed totals (never treat as 0).
- **Critical invariants baked into tasks**: compute USD ONCE at the publish, never sum `cost.usage` into it (HINT-001); unknown-model → parity warning + `usd=null` (NOT 0), missing FIELD → zero that field only (HINT-002); select Minimax tier from input/prompt context length, then reprice the WHOLE call (HINT-003); single-writer cumulative-monotonic accumulation, clamp on decreasing arrival (HINT-004); least-attribute, no secret in any channel (HINT-005).
- **Test env**: Vitest forks, electron-light — `telemetry.ts` ingest is callable with fabricated OTLP bodies; `computeCost` is pure. Cold-start "No test suite found" flake: re-run `npm run test:run` once.
- **Out of band**: Live ≤5% reconciliation vs a real provider bill is MANUAL (no CI keys) — see T026, not a vitest task.

## Phase 1: Foundational (Cross-Work-Item Blockers)

These are the cross-story seam/registry/shape changes both US1 and US2 build on. Complete before any delivery phase.

- [ ] T001 {FR-005,FR-014} Widen `AgentUsageSample.usd` to `number | null` in src/main/telemetry.ts (re-export in usage.ts); no other shape change; `null` = unpriced → exports: AgentUsageSample.usd
- [ ] T002 {FR-006,FR-007} Add a price-resolution helper in src/main/pricing.ts splitting unknown-model (UnknownPrice -> warn, usd=null) from a missing usage FIELD (zero it) → exports: resolvePrice()
- [ ] T003 {FR-004} Thread request context-size opts (input/prompt context length) into the pricing path in src/main/pricing.ts to select the Minimax tier after:T002 → exports: PriceLookupOpts
- [ ] T004 {FR-001,FR-002,FR-005} Replace the cost source at the collector publish in telemetry.ts: USD = sum(tokens x row) ONCE via the resolver, not `cost.usage` after:T003 → exports: publishUsage()
- [ ] T005 {FR-002,FR-014} Audit consumers (ledger/breaker/renderer/waterfall) so USD is read as-is and a `null` `usd` is excluded from billed totals - src/main/usage.ts + call sites after:T001

## Phase 2: User Story 1 — Provider-accurate cost for every desk (Priority: P1) 🎯 MVP

**Goal**: Every desk (Claude, DeepSeek, Minimax) reports USD = its tokens × the registry price (cache split / context tier applied), computed once at the seam, never from a self-reported figure. **Independent test**: run a DeepSeek and a Minimax desk; each desk's USD equals tokens × registry (split/tier applied) within ≤5%, and no self-reported cost is used. **Covers**: SC-001, SC-002, SC-003.

- [ ] T006 [US1] {FR-004} Apply the DeepSeek cache read/write split at the seam in src/main/telemetry.ts: cache-read and cache-write tokens priced at their distinct dated-row rates after:T004
- [ ] T007 [US1] {FR-004} [COMPLETES FR-004] Apply the Minimax whole-call context tier in telemetry.ts: select tier from input/prompt context length, then reprice the call at that row after:T006
- [ ] T008 [US1] {FR-003} Ensure no family-string/Anthropic default for a non-Claude model: every model priced only from its per-provider/per-model dated row in src/main/pricing.ts after:T004
- [ ] T009 [P] [US1] {FR-012} Golden-vector cost vitest in costVectors.test.ts: tokens x dated rows give USD within 5% (DeepSeek cache split, Minimax tier below + above threshold, Claude) after:T007

## Phase 3: User Story 2 — Native desks reach telemetry parity (Priority: P1) 🎯 MVP

**Goal**: A DeepSeek/Minimax desk produces the same `AgentUsageSample` (token + registry cost) and `ToolSpan` waterfall as a Claude desk, via the collector's `gen_ai.*` normalization branch, with no downstream consumer change. **Independent test**: run a native desk beside a Claude desk; the native desk produces equivalent `AgentUsageSample` + `ToolSpan` consumed unchanged by ledger/breaker/waterfall. **Covers**: SC-004, SC-005, SC-006.

- [ ] T010 [US2] {FR-009} Pin `OTEL_SEMCONV_STABILITY_OPT_IN` (electron.vite.config.ts or main env) and record the pinned version at the collector in src/main/telemetry.ts → exports: PINNED_SEMCONV
- [ ] T011 [US2] {FR-008} Wire the native worker usage forward into the collector `gen_ai.*` branch (single-writer, main) in src/main/runtime/nativeAgentWorker.ts after:T004 → exports: forwardUsage
- [ ] T012 [US2] {FR-008} Add the `gen_ai.*` ingest/normalization branch in telemetry.ts for the closed span set (invoke_agent/chat/execute_tool) + token.usage histogram after:T011 → exports: ingest
- [ ] T013 [US2] {FR-015} Enforce mandatory join-attributes (gen_ai branch): `agent.id` (join key), `provider.name`, `request.model`, tool-name; `response.model` optional; missing = drop after:T012
- [ ] T014 [US2] {FR-016} Map a native `execute_tool` span to `ToolSpan`: tool=tool-name, duration=end-start, success=false on ERROR, error=`error.type` else empty, decision=attr/default after:T012
- [ ] T015 [US2] {FR-010} Reconcile claude_code.* delta + gen_ai.* per-call into ONE single-writer cumulative-monotonic sample: idempotent joins, never double-count, clamp on decrease after:T012
- [ ] T016 [US2] {FR-009} Distinguish two ignore paths in the gen_ai branch: malformed metric (invalid OTLP) vs semconv drift (off-version, well-formed); both drop on distinct reasons after:T013
- [ ] T017 [US2] {FR-011} Verify a native desk reaches telemetry parity: the normalized `AgentUsageSample` + `ToolSpan` consumed unchanged by all consumers (no provider code) after:T015
- [ ] T018 [US2] {FR-010} [COMPLETES FR-010] Normalization vitest in telemetryNormalize.test.ts: claude_code.* + gen_ai.* bodies give ONE cumulative-monotonic sample (no double-count) after:T015
- [ ] T019 [P] [US2] {FR-016} [COMPLETES FR-016] `execute_tool`-to-`ToolSpan` mapping vitest in telemetryNormalize.test.ts: all fields mapped; failed tool=success false+error after:T014

## Phase 4: User Story 3 — Unknown or unpriced models fail loud, not wrong (Priority: P1) 🎯 MVP

**Goal**: An unknown/unpriced model id surfaces a clear operator-visible parity warning and bills no default price (`usd=null`, not 0); a missing usage field on a known model degrades that field to zero only, never the price. **Independent test**: point a desk at an unknown model id → parity warning + no default price; then a known model with one missing usage field → that field zero, price intact. **Covers**: SC-007.

- [ ] T020 [US3] {FR-006} Surface the operator-visible telemetry-parity warning at the seam on an unknown model id; `usd=null`, no default price; warning bounded to the model id alone after:T002
- [ ] T021 [US3] {FR-007} Best-effort degradation in src/main/pricing.ts: a missing usage FIELD on a known model is zero for that computation only; the price is never substituted after:T002
- [ ] T022 [P] [US3] {FR-006,FR-007} [COMPLETES FR-006] [COMPLETES FR-007] Fail-loud vitest in costVectors.test.ts: unknown model gives warning + usd=null (NOT 0); missing field gives zero after:T020

## Phase 5: Polish & Cross-Cutting Concerns

Security hardening (least-attribute / secret non-leak) spanning all stories, plus final gates and the manual out-of-band reconciliation note.

- [ ] T023 {FR-013} Enforce least-attribute emission in telemetry.ts: fail-closed attribute allowlist; content-capture off; no secret/payload in any span/metric/attr or diagnostic/drop after:T016 after:T020
- [ ] T024 {FR-013} Secret-non-leak vitest in telemetryNormalize.test.ts: an injected secret is absent from every span/metric/attr AND from diagnostic/warning/degradation/drop paths after:T023
- [ ] T025 Run the final gates: `npm run typecheck` (node + web, hard gate) + `npm run lint` (0 errors) + `npm run test:run` (vitest forks; on cold-start flake, re-run once) after:T024
- [ ] T026 Record the MANUAL out-of-band 5% reconciliation (computed registry cost vs a real provider bill, no CI keys) in the feature notes / PR description; mark it manual, not a CI gate (FR-012)

## Dependencies

- **Foundational (Phase 1)** has no upstream phase. Order within phase: T001 → T002 → T003 → T004; T005 depends on T001 (consumer null-handling).
- **US1 (Phase 2)** depends on Foundational (seam compute at T004, resolver T002, tier opts T003). T006 → T007 (tier after split at the same seam); T008 after T004; T009 (test) after T007.
- **US2 (Phase 3)** depends on Foundational (T004 publish seam). T010 (semconv pin) blocks T012; T011 (usage forward) → T012 (gen_ai branch) → {T013 join-attrs, T014 ToolSpan map, T015 reconcile}; T016 after T013; T017 after T015+T014; tests T018 after T015, T019 after T014.
- **US3 (Phase 4)** depends on Foundational (resolver T002). T020 (unknown warning) and T021 (missing-field) after T002; T022 (test) after both.
- **Polish (Phase 5)** depends on all stories: T023 after T016+T020 (covers every emission/diagnostic/drop path); T024 after T023; T025 (gates) after T024; T026 manual note (no code dependency).
- **Parallel-safe `[P]`**: T009, T019, T022 are test files independent of each other's source within their `after:` constraints; they are not in the same `[P]` batch as the tasks they depend on.

## Requirement Coverage

| Requirement | Task(s) |
|-------------|---------|
| FR-001 | T004, T009 |
| FR-002 | T004, T005 |
| FR-003 | T008 |
| FR-004 | T003, T006, T007 |
| FR-005 | T004 |
| FR-006 | T002, T020, T022 |
| FR-007 | T002, T021, T022 |
| FR-008 | T011, T012 |
| FR-009 | T010, T016 |
| FR-010 | T015, T018 |
| FR-011 | T017 |
| FR-012 | T009, T026 |
| FR-013 | T023, T024 |
| FR-014 | T001, T005 |
| FR-015 | T013 |
| FR-016 | T014, T019 |

| Success Criterion | Task(s) |
|-------------------|---------|
| SC-001 [US1] | T004, T009 |
| SC-002 [US1] | T006, T007, T009 |
| SC-003 [US1,US2] | T009, T026 |
| SC-004 [US2] | T017, T019 |
| SC-005 [US2] | T012, T018 |
| SC-006 [US2] | T015, T018 |
| SC-007 [US3] | T020, T021, T022 |
| SC-008 [US1,US2] | T024 |
