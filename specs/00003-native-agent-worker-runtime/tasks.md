---
description: "Task list for E003 Native Agent Worker Runtime"
---

# Tasks: Native Agent Worker Runtime

**Input**: Design documents from `specs/00003-native-agent-worker-runtime/`
**Prerequisites**: `plan.md` (required), `spec.md` (required), `contracts/native-worker-interface.md`

**Tests**: Vitest test tasks are included per the plan Testing Strategy (SC-002/003/004/005/007 are unit/contract-tested; SC-001/006 are app-smoke). Tests for a behavior precede or accompany the implementation they validate.

**Organization**: Grouped by Technical Objective (`OBJ#`). Shared seams (the pure loop, the IPC protocol, the provider-call seam) are lifted to Foundational because every objective depends on them (HINT-001).

## Project Mode

`Brownfield`

- Extends the existing Electron 32 / TypeScript desktop app. No bootstrap tasks.
- Consumes already-shipped E001 (`src/shared/providerRuntime.ts`, `src/shared/agentEvent.ts`); mirrors the `src/main/pty.ts` lifecycle; reuses `teardownPty` and `hive.drainForStop`.

## Epic / Capability Map

- `[OBJ1]` → Isolated `utilityProcess` worker runtime & lifecycle (`NativeAgentWorker`, `NativeRuntime`, transport, resource caps).
- `[OBJ2]` → Provider-agnostic agent-loop scaffold + pluggable `ProviderCall` seam + stub provider.
- `[OBJ3]` → Native autonomy continuation (drain route + `stopActive` guard + hop/turn caps).

## Brownfield Notes

- Existing flows touched: `src/main/index.ts` (instantiate `NativeRuntime`; wire `drainForStop`, shared `teardownPty`, usage provider); `electron.vite.config.ts` (add the `agentWorker` build input, AD-001).
- Compatibility/migration concerns: worker exit MUST reuse the existing `teardownPty` archive + `breaker.forget` path rather than forking the lifecycle (AD-004, HINT-005). The worker is a SEPARATE process and MUST NOT touch the hive git — it drains via IPC `drainRequest` → main `drainForStop` → `drainResult` (AD-005, HINT-003).
- Regression focus: existing Claude PTY runtime stays unchanged; `npm run typecheck`, `npm run lint`, `npm run test:run` (vitest, forks pool) must stay green.

---

## Phase 1: Foundational (Cross-Work-Item Blockers)

**The shared cross-process seam + protocol + the pure (electron-free) loop scaffold block every objective. Land these first (HINT-001). `agentLoop.ts` and `stubProvider.ts` MUST stay free of any electron/node-pty import so vitest runs them in Node (HINT-002).**

- [ ] T001 [P] {TR-005} Create the ProviderCall seam in src/shared/providerCall.ts (AD-003) → exports: ProviderCall, ProviderTurn(toolUses,usage,endOfTurn), UsageDelta
- [ ] T002 {TR-003} Create the typed worker IPC protocol (WorkerCommand / WorkerMessage unions per contract) in src/shared/workerProtocol.ts ← T001:UsageDelta → exports: WorkerCommand, WorkerMessage
- [ ] T003 {TR-004} Create PURE agent-loop (no electron) in src/main/runtime/worker/agentLoop.ts: runAgentLoop drives request→tool_use→execute→tool_result ← T001:ProviderCall → exports: runAgentLoop(deps), AgentLoopDeps
- [ ] T004 {TR-005} Create the deterministic stub ProviderCall (electron-free) in src/main/runtime/worker/stubProvider.ts: a tool call then end-of-turn ← T001:ProviderCall → exports: createStubProvider()

---

## Phase 2: Objective 2 - Provider-agnostic agent-loop scaffold (Priority: P1) 🎯 MVP

**The tool-use cycle + pluggable seam are the engine. Validated end-to-end in Node with the stub provider (SC-003 ordered events, SC-007 cumulative-monotonic usage + contract fields). HINT-002.**

- [ ] T005 [OBJ2] {TR-004} In src/main/runtime/worker/agentLoop.ts, emit ordered AgentEvents (turn-start→tool-start→tool-end→token-usage→stop) + cumulative-monotonic token-usage from UsageDelta after:T003
- [ ] T006 [OBJ2] {TR-005} [COMPLETES TR-005] In src/main/runtime/worker/agentLoop.ts, wire the seam (deps.providerCall + deps.executeTool) so a stub or E006 adapter drives the loop ← T001:ProviderCall after:T005
- [ ] T007 [P] [OBJ2] {TR-004} [COMPLETES TR-004] Add vitest src/main/runtime/__tests__/agentLoop.test.ts: stub loop emits ordered AgentEvents (SC-003), monotonic usage & tool/stop fields (SC-007) after:T004,T005 ← T003:runAgentLoop

---

## Phase 3: Objective 3 - Native autonomy continuation (Priority: P1) 🎯 MVP

**Reproduce the Stop-hook autonomy without Claude Code: end-of-turn drains the inbox over IPC and continues, guarded against infinite loops. SC-004 continue/idle, SC-005 always-terminates. HINT-003/HINT-004. The drain ROUTE (worker→main→hive→worker) is finished in OBJ1 with the transport.**

- [ ] T008 [OBJ3] {TR-006} In src/main/runtime/worker/agentLoop.ts, on endOfTurn call deps.requestDrain(): on `{block:true}` inject `reason` as the next user turn; on `{block:false}` go idle after:T006 → exports: AgentLoopDeps.requestDrain()
- [ ] T009 [OBJ3] {TR-007} In src/main/runtime/worker/agentLoop.ts, add the stopActive-equivalent guard (a drain-created turn does NOT re-drain) + deps.caps maxTurns/maxHops bounding the loop after:T008
- [ ] T010 [P] [OBJ3] {TR-006,TR-007} [COMPLETES TR-007] Add vitest src/main/runtime/__tests__/agentLoop.test.ts: continue/idle on drain (SC-004); loop-forever case halts via guard+caps (SC-005) after:T008,T009

---

## Phase 4: Objective 1 - Isolated worker runtime & lifecycle (Priority: P1) 🎯 MVP

**Host the pure loop in a real Electron utilityProcess fronted by the E001 ProviderRuntime port, with PTY-equivalent teardown, the drain route, and bounded resources. SC-002 is unit-tested over a FAKED transport (no electron); SC-001/SC-006 require the running app (app-smoke). HINT-005.**

- [ ] T011 [OBJ1] {TR-003,TR-008} Add utilityProcess entry src/main/runtime/worker/agentWorker.ts: parentPort IPC ↔ runAgentLoop + bounded queue after:T004 ← T002:WorkerCommand ← T003:runAgentLoop
- [ ] T012 [OBJ1] {TR-002,TR-003} [COMPLETES TR-003] Implement the E001 ProviderRuntime over a utilityProcess in src/main/runtime/nativeAgentWorker.ts after:T002,T011 → exports: NativeAgentWorker
- [ ] T013 [OBJ1] {TR-008} In src/main/runtime/nativeAgentWorker.ts, fork the built agentWorker with execArgv `--max-old-space-size` (per-worker memory cap, AD-006) after:T011,T012
- [ ] T014 [OBJ1] {TR-001} Add registry src/main/runtime/nativeRuntime.ts: spawn/track a worker per agentId; on exit run shared teardown like teardownPty (AD-004) ← T012:NativeAgentWorker → exports: NativeRuntime
- [ ] T015 [OBJ1] {TR-006} In src/main/runtime/nativeRuntime.ts, route drainRequest → hive.drainForStop → drainResult over IPC (worker never touches hive git; AD-005) ← hive.ts:drainForStop after:T002,T014
- [ ] T016 [OBJ1] {TR-008} In src/main/runtime/nativeRuntime.ts, enforce a floor-wide concurrency cap (~5–15 workers) on spawn (AD-006) after:T014
- [ ] T017 [P] [OBJ1] {TR-002} [COMPLETES TR-002] Add vitest src/main/runtime/__tests__/nativeAgentWorker.test.ts: drive every ProviderRuntime method over a FAKED transport (SC-002) after:T012

---

## Phase 5: Polish & Cross-Cutting Concerns

**Build-entry registration, main-process wiring, and the green-gates + app-smoke that prove SC-001/SC-006 on the real Electron utilityProcess (cannot run in vitest).**

- [ ] T018 {TR-001} Add the `agentWorker` entry to the main build in electron.vite.config.ts rollupOptions.input so it builds to out/main/agentWorker.js (AD-001) after:T011
- [ ] T019 {TR-001,TR-006} [COMPLETES TR-006] Wire src/main/index.ts: instantiate NativeRuntime, pass the drainForStop route + shared teardownPty + usage provider (AD-004) ← T014:NativeRuntime after:T015,T018
- [ ] T020 Run gates green: `npm run typecheck`, `npm run lint`, `npm run test:run` (vitest forks pool) all pass after:T019
- [ ] T021 {TR-001,TR-008} [COMPLETES TR-001] [COMPLETES TR-008] App-smoke via `npm run dev`: kill/crash a worker → teardown, main alive (SC-001); 5 workers, one crash isolated (SC-006) after:T020

---

## Dependencies

Foundational → OBJ2 → OBJ3 → OBJ1 → Polish.

- **Phase 1 (Foundational, T001–T004)** has no internal blockers except that T003 (loop) needs T001 (seam) and T002 (protocol) needs T001 (UsageDelta). T001, T002, T004 are file-independent of one another where marked `[P]`; T003 depends on T001 and emits the AgentEvents the rest of the loop work extends.
- **Phase 2 (OBJ2, T005–T007)** depends on T003 (the loop scaffold) and T004 (stub). T007 (vitest) depends on T005 and T004.
- **Phase 3 (OBJ3, T008–T010)** depends on T006 (seam wired) and extends `agentLoop.ts`. T010 (vitest) depends on T008 and T009.
- **Phase 4 (OBJ1, T011–T017)** depends on the finished loop + protocol: T011 (entry) needs T002/T003/T004; T012 (port) needs T002 + E001 `ProviderRuntime`; T013–T016 chain off T012/T014; T015 also needs the OBJ3 drain contract; T017 (vitest) depends on T012.
- **Phase 5 (Polish, T018–T021)** depends on the worker entry + runtime: T018 needs T011; T019 needs T014/T015 and T018; T020 needs all implementation merged; T021 (app-smoke) needs T020.
- Tasks marked `[P]` are file-independent within their phase and carry no `after:`/`←` edge to another `[P]` task in the same batch.
- A task with `after:T###` or `← T###:Symbol` is never `[P]`-batched with its referenced task.

### Coverage notes

- **Requirements**: TR-001 (T014,T018,T019,T021), TR-002 (T012,T017), TR-003 (T002,T011,T012), TR-004 (T003,T005,T007), TR-005 (T001,T004,T006), TR-006 (T008,T010,T015,T019), TR-007 (T009,T010), TR-008 (T011,T013,T016,T021). All TR-001..TR-008 are covered.
- **Success Criteria**: SC-002 (T017 vitest, faked transport), SC-003 (T007 vitest), SC-004 (T010 vitest), SC-005 (T010 vitest), SC-007 (T007 vitest), SC-001 (T021 app-smoke), SC-006 (T021 app-smoke).
- **Architecture Decisions reflected**: AD-001 (T018), AD-002 (Phase 1/2 pure loop vs transport split), AD-003 (T001 seam in src/shared), AD-004 (T014,T019 reuse teardownPty), AD-005 (T015 drain over IPC), AD-006 (T013,T016 execArgv + concurrency cap + T011 bounded queue).
- **Hints reflected**: HINT-001 (Foundational first), HINT-002 (T003/T004 electron-free; tests in Node), HINT-003 (T015 drain over IPC, no hive git in worker), HINT-004 (T009/T010 guard + caps + loop-forever test), HINT-005 (T014/T019 reuse teardownPty; SC-001/006 via app-smoke T021).
