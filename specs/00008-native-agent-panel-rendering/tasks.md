# Tasks: Native Agent Panel Rendering (E008)

**Input**: Design documents from `specs/00008-native-agent-panel-rendering/`
**Prerequisites**: `plan.md` (required), `spec.md` (required), `research.md`, `data-model.md`, `checklists/` (ux, performance, data-integrity). No `contracts/`.

**Tests**: Test tasks are INCLUDED — the plan's Testing Strategy explicitly requires the `foldEvents` and `nativeEventBridge` Vitest suites (unit, integration, security tiers). Pure-fold and bridge tests are written alongside their source so the fold/persist/replay invariants (FR-036/FR-039/FR-042/FR-041) are machine-verified, not deferred to QC.

**Organization**: Grouped by user story (`US#`). Cross-work-item blockers (the main→renderer event bridge, persistence, pure fold core, and the subscription hook) are lifted into Foundational because the transcript, structured tab, and input wiring ALL depend on the renderer actually receiving + folding native events (HINT-001) — none of US1/US2/US3 can be integration-tested until the bridge exists.

## Project Mode

`Brownfield`

- Extends the existing Electron/TS main + preload + React/xterm renderer. The E001 `AgentEvent` contract (`src/shared/agentEvent.ts`) and the E003 native worker/runtime (`nativeAgentWorker.ts`/`nativeRuntime.ts`) already exist and are consumed unchanged.
- Vitest (forks), `npm run typecheck` (node + web), and ESLint are already configured. NO scaffolding/bootstrap/project-init tasks.

## Epic / Capability Map

- `[US1]` → E008 MVP: synthesized terminal transcript for native desks + operator input/steer + durable re-open (CAP-015/CAP-018, ADR-0010 Option A).
- `[US2]` → Optional structured tab (turns → tool calls → token usage) for native AND Claude desks, derived from the same AgentEvent stream.
- `[US3]` → Inline capability-degradation + api-error notices surfaced in both views.

## Brownfield Notes

- **Existing flows touched**: `src/main/index.ts` (IPC registration + bridge wiring on native spawn), `src/main/runtime/nativeRuntime.ts` (forward events + send routing), `src/main/hive.ts` (per-agent JSONL path helper, reuse `appendCostLedger`/`appendLog` pattern), `src/preload/index.ts` (`window.cth` additions), `src/renderer/src/components/AgentDetailPanel.tsx`, `SidebarTabs.tsx`, `MessageQueueComposer.tsx`.
- **Compatibility / no-regression**: DO NOT TOUCH `PtyTerminalView.tsx`, `terminalPool.ts`, or the xterm/PTY path (FR-009/FR-035, Principle V). DO NOT change `AgentEvent`/`AgentUsageSample`/`ToolSpan` shapes (FR-014) — `src/shared/agentEvent.ts` is consumed, never edited. Native render path is gated on event source, not vendor.
- **Regression focus**: Claude desks must render identical authentic PTY bytes with no visual/behavioral change (SC-003); the structured tab is additive and must not alter Claude's default view.
- **Secret-free invariant (ADR-0007)**: persisted JSONL + forwarded IPC carry only `AgentEvent` payload fields — never an API key/auth header — at ANY nesting depth (FR-041).

---

## Phase 1: Foundational (Cross-Work-Item Blockers)

**HINT-001 build order: the renderer has NO native-AgentEvent subscription today. This phase MUST land the main→renderer event bridge + durable persistence FIRST (the `agent:event` IPC forward, per-agent append-only JSONL, preload `onAgentEvent`/`loadNativeEvents`, and the pure `foldEvents` core). Nothing in US1/US2/US3 can be integration-tested until the bridge exists.**

- [X] T001 [P] {FR-016,FR-038,FR-040} Add per-agent native-events JSONL path + append in `src/main/hive.ts` (mirror `appendCostLedger`) → exports: nativeEventsPath(), appendNativeEvent()
- [X] T002 {FR-016,FR-037,FR-030,FR-043} Create bridge `src/main/runtime/nativeEventBridge.ts`: append-and-commit before forward, single-writer queue → exports: createNativeEventBridge [after:T001]
- [X] T003 {FR-016,FR-042,FR-043,FR-045} Add replay to `src/main/runtime/nativeEventBridge.ts`: read once, skip corrupt lines, all 12 kinds → exports: loadNativeEvents [after:T002]
- [X] T004 {FR-016,FR-037,FR-043} Forward native runtime events to the bridge + send routing in `src/main/runtime/nativeRuntime.ts` → exports: runtimeFor().send [after:T002]
- [X] T005 {FR-016,FR-001} Wire the bridge on native spawn + register `loadNativeEvents` IPC in `src/main/index.ts` ← T004:runtimeFor().send ← T003:loadNativeEvents [after:T004]
- [X] T006 {FR-016,FR-039} Add preload `onAgentEvent` + `loadNativeEvents` to `window.cth` in `src/preload/index.ts` → exports: cth.onAgentEvent, cth.loadNativeEvents [after:T005]
- [X] T007 [P] {FR-001,FR-011,FR-044} Create PURE fold core `src/renderer/src/components/foldEvents.ts`: pair tools by `toolCallId` (orphan dropped) → exports: foldEvents, TranscriptEntry
- [X] T008 {FR-002,FR-026,FR-013,FR-032} Extend `src/renderer/src/components/foldEvents.ts`: coalesce `text-delta`; empty turn → no entry, thinking-only → collapsed ← T007:foldEvents [after:T007]
- [X] T009 {FR-012,FR-036} Add set-not-sum token projection to `src/renderer/src/components/foldEvents.ts`: REPLACES prior, clamp decreases, `usd:null`=unpriced ← T007:foldEvents [after:T007]
- [X] T010 {FR-033,FR-029} [COMPLETES FR-011] Bound end-of-stream + truncation in `src/renderer/src/components/foldEvents.ts`: flip still-`pending` + unfinished turn; 8 KB DISPLAY-ONLY [after:T008]
- [X] T011 {FR-001,FR-039,FR-042,FR-022} Create hook `src/renderer/src/hooks/useNativeAgentEvents.ts`: backfill + subscribe, fold (replay=live) → exports: useNativeAgentEvents [after:T006,T010]

### Foundational tests

- [X] T012 [P] {FR-013,FR-036,FR-044} Pure fold unit suite `src/renderer/src/components/__tests__/foldEvents.test.ts`: coalescing, pairing (+ orphan), interrupted, monotonic/`usd:null` [after:T010]
- [X] T013 {FR-039,FR-042} Add replay-determinism + degradation cases to `src/renderer/src/components/__tests__/foldEvents.test.ts`: live-fold == replay-fold; malformed = no throw [after:T012]
- [X] T014 {FR-016,FR-037,FR-039,FR-043} Bridge integration suite `src/main/__tests__/nativeEventBridge.test.ts`: event → JSONL + IPC; replay rebuilds identical views; N reopens no-mutate [after:T003]
- [X] T015 {FR-041,FR-016} [COMPLETES FR-041] Add assertion `nativeEventBridge.test.ts › "persisted JSONL and forwarded IPC are secret-free (deep)"`: recurse payloads, no secret at depth [after:T014]

---

## Phase 2: US1 - Watch a native agent work as a terminal transcript (Priority: P1) 🎯 MVP

**Goal (SC-001/002/003/008/009)**: native desks show a coherent streaming terminal-style transcript (text, tool calls/results, thinking) in the same framing as Claude; operator can submit input/steer; the run re-opens after close/restart. Claude PTY path stays untouched.

- [X] T016 [US1] {FR-001,FR-002,FR-018} Create `src/renderer/src/components/NativeTranscriptView.tsx`: incremental append + in-progress indicator → exports: NativeTranscriptView [after:T011]
- [X] T017 [US1] {FR-003,FR-004,FR-017} Render categories in `src/renderer/src/components/NativeTranscriptView.tsx`: label/glyph + container; collapsible thinking; tool pending→resolved [after:T016]
- [X] T018 [US1] {FR-010,FR-027,FR-024} Virtualize `src/renderer/src/components/NativeTranscriptView.tsx`: mount only visible + overscan (O(visible)); full run retained; stick-to-bottom [after:T016]
- [X] T019 [US1] {FR-026,FR-028} [COMPLETES FR-026] Coalesce `text-delta` to ≤1 render/frame (~16 ms) in `useNativeAgentEvents.ts` so 5–15 panels stay responsive [after:T018]
- [X] T020 [US1] {FR-001,FR-014,FR-023} [COMPLETES FR-001] Add native render path + framing in `src/renderer/src/components/AgentDetailPanel.tsx`: gate on event source; Claude PTY kept [after:T016]
- [X] T021 [US1] {FR-009,FR-035} Verify no Claude regression: `AgentDetailPanel.tsx` routes Claude to the existing `PtyTerminalView`/`terminalPool` unchanged; no PTY-path change [after:T020]
- [X] T022 [US1] {FR-015,FR-021} Add `native:send` IPC in `src/main/index.ts` → `runtimeFor(agentId).send(AgentInput)`, routing a prompt vs a steer (`control:*`) ← T004:runtimeFor().send [after:T005]
- [X] T023 [US1] {FR-015,FR-021} Add preload `nativeSend(agentId,input)` to `window.cth` in `src/preload/index.ts` bridging the `native:send` IPC with a send-ack result → exports: cth.nativeSend()
- [X] T024 [US1] {FR-015,FR-021,FR-022} [COMPLETES FR-021] Make `MessageQueueComposer.tsx` native-aware: submit + send ack; native via `cth.nativeSend` (Claude `writePty` kept) [after:T023]
- [X] T025 [US1] {FR-022} [COMPLETES FR-015] [COMPLETES FR-022] Surface not-delivered feedback in `MessageQueueComposer.tsx` when `native:send` returns `{ok:false}` — non-blocking, distinct [after:T024]
- [X] T026 [US1] {FR-016,FR-039,FR-030} [COMPLETES FR-039] [COMPLETES FR-016] Verify durable re-open via `useNativeAgentEvents` backfill: close/reopen + restart rebuilds from the persisted stream [after:T011,T014,T020]

---

## Phase 3: US2 - Inspect a run in a structured tab (Priority: P2)

**Goal (SC-004/005/020)**: an opt-in structured tab presents turns → tool calls (name, input, result, duration, status) + token usage for native AND Claude desks; toggling preserves content + scroll and reuses folded view-models without re-folding the run.

- [X] T027 [US2] {FR-005,FR-012} Create `src/renderer/src/components/StructuredRunTab.tsx`: turns → tool calls (name/input/result/duration/status) + tokens → exports: StructuredRunTab [after:T011]
- [X] T028 [US2] {FR-029} Truncate large `toolInput`/`result` past 8 KB for display in `src/renderer/src/components/StructuredRunTab.tsx`, like the transcript; full payload retained [after:T027]
- [X] T029 [US2] {FR-005,FR-006} Add the structured-tab entry to `src/renderer/src/components/SidebarTabs.tsx` (opt-in toggle alongside the default view) [after:T027]
- [X] T030 [US2] {FR-005,FR-006,FR-034} [COMPLETES FR-005] Wire structured tab into `src/renderer/src/components/AgentDetailPanel.tsx` for native + Claude; reuses folded view-models [after:T020,T029]

---

## Phase 4: US3 - See degradation and errors inline (Priority: P2)

**Goal (SC-006)**: capability-degradation + api-error events surface as distinct inline notices in BOTH the transcript and the structured tab, visually distinct from assistant content, without aborting the transcript.

- [X] T031 [US3] {FR-007,FR-008,FR-019} Render inline notices in `src/renderer/src/components/NativeTranscriptView.tsx` from `notification`/`api-error`: retryable vs terminal, no abort [after:T017]
- [X] T032 [US3] {FR-007,FR-008,FR-019} Render the same inline notices in `src/renderer/src/components/StructuredRunTab.tsx`, consistent with the transcript ← T007:foldEvents [after:T027,T031]
- [X] T033 [US3] {FR-019,FR-020} [COMPLETES FR-007] [COMPLETES FR-019] Dedup/collapse repeated notices in `foldEvents.ts`; inline (not toasts), consistent dismissibility [after:T031,T032]

---

## Phase 5: Polish & Cross-Cutting Concerns

**Final gates: `npm run typecheck` (node + web) is a HARD gate; `npm run lint` must report 0 errors; `npm run test:run` must pass (note the cold-start "No test suite found" flake — re-run once). The live-rendering app-smoke is MANUAL, not a CI gate.**

- [X] T034 [P] {FR-025} [COMPLETES FR-025] Add accessibility in `NativeTranscriptView.tsx`/`StructuredRunTab.tsx`: keyboard-focusable thinking + tab toggle; notices exposed to AT [after:T031,T030]
- [X] T035 [P] {FR-029} [COMPLETES FR-029] Verify display-only 8 KB truncation parity across both views, full payload recoverable on replay; no payload-level eviction [after:T028,T031]
- [X] T036 {FR-010,FR-027,FR-028} [COMPLETES FR-028] Perf-harden + verify virtualization: mounted DOM-node count bounded to viewport+overscan, stable across 5–15 streaming panels [after:T019,T026]
- [X] T037 {FR-009,FR-014} [COMPLETES FR-009] No-Claude-PTY-regression: `PtyTerminalView.tsx`/`terminalPool.ts`/xterm unchanged; `AgentEvent`/`AgentUsageSample`/`ToolSpan` unchanged [after:T021,T030]
- [X] T038 Run final gates: `npm run typecheck` (node + web, hard gate), `npm run lint` (0 errors), `npm run test:run` (re-run once on the cold-start no-suite flake) [after:T033,T034,T035,T036,T037]
- [X] T039 MANUAL app-smoke (not a CI gate): native streaming, virtualization, tab toggle (content/scroll kept), inline notices, operator input/steer, no Claude PTY regression [after:T038]

---

## Dependencies

Foundational (Phase 1) → US1 (Phase 2, P1 MVP) → US2 (Phase 3, P2) → US3 (Phase 4, P2) → Polish (Phase 5)

- **Phase 1 (Foundational)** has no upstream phase. Internal order: persistence path (T001) → bridge append/forward (T002) → replay (T003) → runtime forward/send (T004) → main wiring (T005) → preload (T006) → pure fold core (T007) → fold extensions (T008, T009) → bounded resolution/truncation (T010) → hook (T011); tests T012–T015 follow their subjects. The bridge MUST exist before any US can be integration-tested (HINT-001).
- **Phase 2 (US1)** depends on Foundational (T006 preload, T007/T010 fold, T011 hook, T004 runtime, T005 main wiring). The input path (T022→T023→T024→T025) depends on the runtime send seam (T004/T005). T026 verifies durable re-open from T011/T020 against T014.
- **Phase 3 (US2)** depends on the fold core (T007) and the panel host (T020); structured tab + tab wiring reuse the already-folded view-models.
- **Phase 4 (US3)** depends on the transcript (T017) and structured tab (T027) render surfaces and the fold notice mapping (T007).
- **Phase 5 (Polish)** depends on the relevant delivery tasks; T038 (final gates) depends on all preceding implementation/verification; T039 (manual smoke) runs after T038.
- Tasks marked `[P]` are parallel-safe within their phase (independent files). A task with `after:T###` or `← T###:Symbol` is never `[P]`-batched with the task it references.

## Requirement Coverage

| Req ID | Task(s) |
|--------|---------|
| FR-001 | T005, T007, T011, T016, T020 |
| FR-002 | T008, T016 |
| FR-003 | T017 |
| FR-004 | T017 |
| FR-005 | T027, T029, T030 |
| FR-006 | T029, T030 |
| FR-007 | T031, T032, T033 |
| FR-008 | T031, T032 |
| FR-009 | T021, T037 |
| FR-010 | T018, T036 |
| FR-011 | T007, T010 |
| FR-012 | T009, T027 |
| FR-013 | T008, T012 |
| FR-014 | T020, T037 (no edits to `agentEvent.ts`) |
| FR-015 | T022, T024, T025 |
| FR-016 | T001, T002, T003, T004, T005, T006, T014, T015, T026 |
| FR-017 | T017 |
| FR-018 | T016 |
| FR-019 | T031, T032, T033 |
| FR-020 | T033 |
| FR-021 | T022, T023, T024 |
| FR-022 | T011, T024, T025 |
| FR-023 | T020 |
| FR-024 | T018 |
| FR-025 | T034 |
| FR-026 | T008, T019 |
| FR-027 | T018, T036 |
| FR-028 | T019, T036 |
| FR-029 | T010, T028, T035 |
| FR-030 | T002, T026 |
| FR-031 | (accepted tradeoff — see Brownfield Notes; bounded by T018/T036 virtualization + T001/T002 append) |
| FR-032 | T008 |
| FR-033 | T010 |
| FR-034 | T030 |
| FR-035 | T021 |
| FR-036 | T009, T012 |
| FR-037 | T002, T004, T014 |
| FR-038 | T001 |
| FR-039 | T011, T013, T014, T026 |
| FR-040 | T001 |
| FR-041 | T015 |
| FR-042 | T003, T011, T013 |
| FR-043 | T002, T003, T004, T014 |
| FR-044 | T007, T012 |
| FR-045 | T003 |
