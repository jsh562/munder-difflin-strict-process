# Tasks: Native Provider Adapters

**Feature**: E006 — Native Provider Adapters
**Branch**: `00006-native-provider-adapters`
**Spec**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Research**: [research.md](research.md)
**Spec Type**: product

## Project Mode

**Brownfield** — extends the existing Electron/TS multi-provider runtime (E001–E005). No scaffolding/bootstrap tasks: the port (`providerRuntime.ts`), AgentEvent contract, `ProviderCall` seam, native worker, credential env (E004), per-desk assignment (E005), and registry (E002) all exist. Work is integration, additive-seam extension, two new adapters, and degradation/reliability helpers behind the port. Vitest (forks) + `npm run typecheck` (node+web) + ESLint are already configured.

## Epic / Capability Map

| Work Item | Priority | Capability | Phase |
|-----------|----------|------------|-------|
| US1 — Run a desk on DeepSeek | P1 | CAP-015 (DeepSeek loop) | Phase 3 (MVP) |
| US2 — Run a desk on Minimax M3 | P1 | CAP-015 (Minimax loop) | Phase 4 (MVP) |
| US3 — Native-provider desk is a full hive peer | P1 | CAP-013 (parity wiring) | Phase 5 (MVP) |
| US4 — Unsupported capabilities degrade gracefully | P2 | CAP-018 (ADR-0008 runtime half) | Phase 6 |

## Brownfield Notes

- **Path aliases** (used in task lines to stay under the line cap; resolve to exact repo paths): `worker/` = `src/main/runtime/worker/`, `adapters/` = `src/main/runtime/worker/adapters/`, `tests/` = `src/main/runtime/worker/__tests__/`, `shared/` = `src/shared/`, `main/` = `src/main/`.
- **Annotation sources**: Requirement Coverage Map + Project Structure in `plan.md` name files and symbols; `→ exports:` / `← T###:` annotations are emitted (`HAS_ANNOTATION_SOURCES = true`).
- **Additive seam only** (AD-001 / HINT-005): the `ProviderCall` extension is optional (`emit?`); `stubProvider.ts` and the Claude path MUST keep compiling and behaving unchanged. No provider SDK/wire type may cross the adapter boundary (FR-007).
- **Electron-free cores** (HINT-001 / AD-003): adapter stream→turn/event cores take an injected `fetch`; only the worker entry (`agentWorker.ts` / `selectAdapter.ts`) reads `process.env`. This is what lets vitest run them in Node over recorded SSE fixtures.
- **Existing worker test home**: `src/main/runtime/__tests__/` already holds `agentLoop.test.ts` / `nativeAgentWorker.test.ts`; new adapter fixture suites land in `src/main/runtime/worker/__tests__/` per plan Project Structure.
- **No live keys in CI**: live DeepSeek/Minimax calls are MANUAL app-smoke (plan Testing Strategy) — captured as the manual gate task, NOT vitest tasks.
- **`npm run test:run` cold-start flake**: the forks pool can report "No test suite found" on a cold first run — re-run once before treating it as a failure.

---

## Phase 1: Foundational (Cross-Work-Item Blockers)

Both adapters and the loop depend on these. No story label. Complete before Phase 3.

- [X] T001 [P] Add shared electron-free, `fetch`-injected SSE line/event parser in adapters/sseParser.ts {HINT-001,AD-003} → exports: parseSseStream(body,onEvent)
- [X] T002 [P] {FR-012} Add ADR-0009 reliability wrapper (retryable allowlist + full-jitter backoff + per-turn budget) in adapters/reliability.ts {AD-006} → exports: withReliability()
- [X] T003 [P] {FR-010} Add capability gate on `lookupCapabilities`, no-op + one notice/capability/session, never throw, in adapters/capabilityGate.ts {AD-005,HINT-004} → exports: makeCapabilityGate()
- [X] T004 {FR-007} Extend `ProviderCall` ADDITIVELY to `(req, emit?)` + richer turn (`stopReason`/`thinking`) in shared/providerCall.ts; stub/Claude unchanged {AD-001,HINT-005}
- [X] T005 {FR-007,FR-011,FR-012} Wire `emit` + streamed deltas + `withReliability` + capability notices + caps/budget into worker/agentLoop.ts after:T002 after:T003 after:T004

---

## Phase 2: User Story 1 — Run a desk on DeepSeek (P1) 🎯 MVP

**Goal** (SC-001, SC-002, SC-005): a DeepSeek-assigned desk completes a multi-step tool-use task end-to-end with index-keyed tool assembly, reasoning→thinking (not replayed), and cumulative-monotonic usage.
**Independent test**: drive `runAgentLoop` with the DeepSeek adapter over a recorded multi-round SSE fixture; assert assembled tool calls, thinking routing, and monotonic usage.

- [X] T006 [US1] {FR-001} Create DeepSeek adapter factory (OpenAI-compat, electron-free, `fetch`-injected) in adapters/deepseekAdapter.ts after:T005 → exports: makeDeepseekAdapter(deps)
- [X] T007 [US1] {FR-002,FR-011} Index-keyed `tool_calls` accumulation in adapters/deepseekAdapter.ts — parse args ONLY at `finish_reason:'tool_calls'`; multi-call/round; no partial exec {HINT-002}
- [X] T008 [US1] {FR-003} Route `reasoning_content`→thinking, `content`→text in adapters/deepseekAdapter.ts; never replay reasoning into a later request {SC-002}
- [X] T009 [US1] {FR-006} Normalize DeepSeek usage cumulative-monotonic in adapters/deepseekAdapter.ts — emit at final `include_usage` chunk, absent cache = 0, `usd` passthrough {AD-004,HINT-003}
- [X] T010 [P] [US1] {FR-001,FR-002,FR-003} Test: DeepSeek index-keyed multi-call/multi-round assembly + reasoning→thinking (not replayed), in tests/deepseekAdapter.test.ts after:T009
- [X] T011 [P] [US1] {FR-006} Test: DeepSeek cumulative-monotonic usage across rounds (no decrease/double-count; absent cache = 0) in tests/deepseekAdapter.test.ts after:T009
- [X] T012 [P] [US1] {FR-011} Test: DeepSeek malformed/partial JSON (no exec, error tool result) + stream-interrupt mid-call (discard, retryable) in tests/deepseekAdapter.test.ts after:T009

---

## Phase 3: User Story 2 — Run a desk on Minimax M3 (P1) 🎯 MVP

**Goal** (SC-003, SC-004, SC-005): a Minimax-assigned desk completes a multi-step tool-use task end-to-end with partial-JSON tool-input assembly, thinking blocks surfaced, and correct context-length pricing tier.
**Independent test**: drive `runAgentLoop` with the Minimax adapter over a recorded content-block SSE fixture; assert block assembly, thinking, tool_use continuation, and tier-correct usage.

- [X] T013 [US2] {FR-004} Create Minimax M3 adapter factory (Anthropic-compat, electron-free, `fetch`-injected) in adapters/minimaxAdapter.ts after:T005 → exports: makeMinimaxAdapter(deps)
- [X] T014 [US2] {FR-005,FR-011} [COMPLETES FR-011] Content-block assembly in adapters/minimaxAdapter.ts — parse `partial_json` ONLY at `content_block_stop`; `stop_reason:'tool_use'` continues
- [X] T015 [US2] {FR-006} Normalize Minimax usage cumulative-monotonic + context tier in adapters/minimaxAdapter.ts — latest `message_delta.usage` (no decrease; absent cache 0); report tier {HINT-003}
- [X] T016 [P] [US2] {FR-004,FR-005} Test: Minimax `partial_json` assembly at block stop + thinking distinct from text + `stop_reason:'tool_use'` continues, in tests/minimaxAdapter.test.ts after:T015
- [X] T017 [P] [US2] {FR-006} [COMPLETES FR-006] Test: Minimax usage + context-tier pair (prompt below/above registry boundary asserts tier) in tests/minimaxAdapter.test.ts after:T015 {SC-004,SC-005}

---

## Phase 4: User Story 3 — Native-provider desk is a full hive peer (P1) 🎯 MVP

**Goal** (SC-006, SC-007): assigning a desk to DeepSeek/Minimax actually launches it on that provider via the native worker with the correct adapter, and it participates in memory/mailbox/autonomy/avatars/telemetry/breaker identically to a Claude desk.
**Independent test**: select an adapter from `NATIVE_PROVIDER_ID`, run `runAgentLoop` with a mock adapter through a multi-round tool loop, and confirm the normalized stream feeds downstream consumers with no provider branching.

- [X] T018 [US3] {FR-008} Add dispatch on `NATIVE_PROVIDER_ID`→deepseek/minimax factory (handle unknown id) in adapters/selectAdapter.ts {AD-002} after:T006 after:T013 → exports: selectAdapter(env)
- [X] T019 [US3] {FR-008} Inject `selectAdapter(process.env)` in place of `makeStubProvider()` in worker/agentWorker.ts (only place reading `process.env`) after:T018 {HINT-001}
- [X] T020 [US3] {FR-008} Wire spawn router in main/index.ts — native-assigned desk (via `providerIdForAgent`) routes to `nativeRuntime.spawn(agentId,providerId)` not the PTY path after:T019 {SC-007}
- [X] T021 [US3] {FR-008} Missing-key-at-launch guard in main/index.ts / main/runtime/nativeRuntime.ts — no-key provider surfaces "needs credentials", not a broken loop after:T020 {Edge Cases}
- [X] T022 [US3] {FR-009} Verify/wire hive-peer participation in worker/agentWorker.ts (+ agentLoop deps) — `executeTool` exposes hive tools + autonomy/drain; stream feeds avatars/telemetry after:T020
- [X] T023 [P] [US3] {FR-008} [COMPLETES FR-008] Test: `selectAdapter` maps `NATIVE_PROVIDER_ID`→correct adapter + handles unknown id, in tests/selectAdapter.test.ts after:T018 {SC-007}
- [X] T024 [P] [US3] {FR-007,FR-009} [COMPLETES FR-007] Integration test: `runAgentLoop` + mock adapter, multi-round loop emits the normalized stream, in tests/agentLoopIntegration.test.ts after:T005

---

## Phase 5: User Story 4 — Unsupported capabilities degrade gracefully (P2)

**Goal** (SC-008): each adapter gates images/MCP/web-search/caching on the registry descriptor, no-ops the unsupported path with exactly one notice per capability per session, and continues — caching-off omits cache controls and reports cache fields as 0.
**Independent test**: give each adapter a task that would invoke an unsupported capability; assert a single notice and a completed result with no error.

- [X] T025 [US4] {FR-010} Apply `makeCapabilityGate` in adapters/deepseekAdapter.ts — gate images/MCP/web-search/caching before each optional path; caching-off→cache 0 after:T009 after:T003 {HINT-004}
- [X] T026 [US4] {FR-010} Apply `makeCapabilityGate` in adapters/minimaxAdapter.ts — gate images/MCP/web-search/caching before each optional path; caching-off→cache 0 after:T015 after:T003 {HINT-004}
- [X] T027 [US4] {FR-014} Verify seeded DeepSeek/Minimax capability flags vs real support in shared/providerRegistry.ts; correct any wrong flag as a STATIC source edit only (no runtime write) {AD-007}
- [X] T028 [P] [US4] {FR-010,FR-014} [COMPLETES FR-010] Test: gate no-op + single-notice/session (not repeated) + never-throw, caching-off→cache 0, in tests/degradation.test.ts after:T026 {SC-008}

---

## Phase 6: Polish & Cross-Cutting Concerns

Cross-cutting reliability/security tests and the final gate. No story label.

- [X] T029 [P] {FR-012} [COMPLETES FR-012] Test: reliability — retryable/terminal classes (no overlap), bounded jittered backoff, exhausted/budget→stop, in tests/reliability.test.ts after:T002
- [X] T030 [P] {FR-013} [COMPLETES FR-013] Test: key+substring never leaks — `NATIVE_PROVIDER_API_KEY` absent from events/usage/telemetry/transcripts/hive/logs, in tests/keyNonLeak.test.ts after:T005
- [X] T031 MANUAL app-smoke (no CI keys): real DeepSeek + Minimax desks finish a tool-use task; reasoning not replayed; telemetry monotonic; key never visible {SC-001,SC-003,SC-007,FR-013}
- [X] T032 Final gates: `npm run typecheck` (node+web hard gate, 0 errors), `npm run lint` (0 errors), `npm run test:run` (vitest forks; re-run once on cold "No test suite found" flake) after:T030

---

## Dependencies

```text
Phase 1 (Foundational)
  T001 [P] ─┐
  T002 [P] ─┤
  T003 [P] ─┼─► T004 ─► T005  (T005 also ← T002, T003)
            │
Phase 2 (US1)  needs T001,T004,T005
  T006 ◄ T001,T004 ─► T007 ─► T008 ─► T009 ─► {T010,T011,T012}[P]
Phase 3 (US2)  needs T001,T004,T005
  T013 ◄ T001,T004 ─► T014 ─► T015 ─► {T016,T017}[P]
Phase 4 (US3)  needs T006,T013,T005
  T018 ◄ T006,T013 ─► T019 ─► T020 ─► T021
                              T020 ─► T022
  T023[P] ◄ T018 ;  T024[P] ◄ T005
Phase 5 (US4)  needs T003,T009,T015,T027
  T025 ◄ T009,T003 ;  T026 ◄ T015,T003 ;  T027 (independent source edit)
  T028[P] ◄ T026,T003
Phase 6 (Polish)  needs prior phases
  T029[P] ◄ T002 ;  T030[P] ◄ T005 (exercises both adapters T006/T013) ;  T031 (manual) ;  T032 ◄ T030
```

**Edges**:
- Phase 1 is the cross-story blocker. `T001`/`T002`/`T003` are independent (`[P]`); `T004` (seam) then `T005` (loop) gate every adapter and the integration test.
- US1 (Phase 2) and US2 (Phase 3) are parallel once Phase 1 lands — the two adapters are independent files. Within each, the adapter core precedes its assembly/usage tasks, which precede that adapter's tests.
- US3 (Phase 4) depends on both adapter factories (`T006`, `T013`) for selection and on `T005`/`runAgentLoop` for the integration test.
- US4 (Phase 5) applies the foundational `capabilityGate` (`T003`) inside each adapter; `T027` is an independent static registry edit.
- Polish (Phase 6) reliability/key-leak tests depend on their targets; the final gate runs last.

## Coverage Summary

| Requirement | Tasks |
|-------------|-------|
| FR-001 | T006, T010 |
| FR-002 | T007, T010 |
| FR-003 | T008, T010 |
| FR-004 | T013, T016 |
| FR-005 | T014, T016 |
| FR-006 | T009, T011, T015, T017 |
| FR-007 | T004, T005, T024 |
| FR-008 | T018, T019, T020, T021, T022, T023 |
| FR-009 | T022, T024 |
| FR-010 | T003, T025, T026, T028 |
| FR-011 | T007, T012, T014 |
| FR-012 | T002, T005, T029 |
| FR-013 | T030, T031 |
| FR-014 | T027, T028 |

| Success Criterion | Covered by |
|-------------------|-----------|
| SC-001 [US1] | T006–T010, T031 |
| SC-002 [US1] | T008, T010, T031 |
| SC-003 [US2] | T013–T016, T031 |
| SC-004 [US2] | T015, T017 |
| SC-005 [US1,US2] | T011, T017, T024 |
| SC-006 [US3] | T022, T024, T031 |
| SC-007 [US3] | T020, T023, T031 |
| SC-008 [US4] | T028 |
| SC-009 [US1,US2] | T012, T029 |

All FR-001..FR-014 map to ≥1 task. Each P1 story (US1/US2/US3) covers its success criteria; US4 (P2) covers SC-008.
