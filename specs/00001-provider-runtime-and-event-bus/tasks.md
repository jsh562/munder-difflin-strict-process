# Tasks: Provider Runtime and Event Bus

**Input**: Design documents from `specs/00001-provider-runtime-and-event-bus/`
**Prerequisites**: `plan.md` (required), `spec.md` (required), `research.md`, `contracts/provider-runtime-contract.md`

**Tests**: Test tasks are INCLUDED — the spec/plan explicitly require Vitest critical-path conformance, contract, parity, and additive-extension tests (SC-001..SC-006; Testing Strategy). They are written to assert the deliverable behavior and gate the success criteria.

**Organization**: Grouped by technical objective (`OBJ#`) per the Requirement Coverage Map. Shared `src/shared` types and repo-root test tooling are lifted to Setup/Foundational because every objective depends on them (HINT-001, AD-001).

## Project Mode

`Brownfield`

- Extends an existing Electron 32 / TypeScript codebase under `/src`. No generic bootstrap; work is integration, compatibility, and zero-behavior-change parity over the existing Claude PTY+hooks runtime.

## Epic / Capability Map *(OPTIONAL)*

- `[OBJ1]` → ProviderRuntime port — provider-agnostic boundary (TR-001, TR-007; SC-001, SC-005)
- `[OBJ2]` → Normalized, versioned AgentEvent contract (TR-002, TR-003, TR-006; SC-002, SC-004)
- `[OBJ3]` → Claude adapter with zero behavior change (TR-004, TR-005, TR-008; SC-003, SC-006)

## Brownfield Notes *(OPTIONAL)*

- Existing flows touched: `src/main/hooks.ts` (PreToolUse/PostToolUse/Stop/Notification/Status → adapter/bus), `src/main/pty.ts` (text-delta), `src/main/index.ts` (wiring), `src/main/usage.ts` (locked cost seam, read-only), `src/main/hive.ts` (`drainForStop`, read-only).
- Compatibility/migration concerns: IPC translator must re-emit the EXACT existing `hive:*` messages so the renderer/avatars need no change (HINT-003, AD-002); `token-usage` mirrors `AgentUsageSample` and never recomputes `usd` (HINT-002, HINT-004, AD-004); preserve `stop_hook_active` guard on the Stop path (HINT-005).
- Regression focus: avatar station transitions, per-agent token/cost telemetry, budget/breaker velocity (diffs consecutive cumulative samples), per-agent terminal stream, and hive inbox-drain autonomy.

---

## Phase 1: Setup (Repository / Workspace Delta)

- [X] T001 Add Vitest dev dependency via `npm i -D vitest` and add `test` / `test:run` scripts in package.json
- [X] T002 Create Vitest config in vitest.config.ts (node environment, include `src/main/runtime/__tests__/**`, alias `src/shared`) after:T001 → exports: default vitest config
- [X] T003 [P] Create test directory scaffold and shared fixture placeholder in src/main/runtime/__tests__/fixtures/.gitkeep

---

## Phase 2: Foundational (Cross-Work-Item Blockers)

**Land the `src/shared` types FIRST — every adapter, bus, translator, and test depends on them (HINT-001, AD-001).**

- [X] T004 {TR-002} Define versioned `AgentEvent` discriminated union and `AGENT_EVENT_VERSION` const in src/shared/agentEvent.ts → exports: AgentEvent(union), AGENT_EVENT_VERSION, AgentEventKind
- [X] T005 {TR-001} Define `ProviderRuntime` port + `AgentInput` + `CapabilityDescriptor` in src/shared/providerRuntime.ts after:T004 ← T004:AgentEvent → exports: ProviderRuntime, AgentInput

---

## Phase 3: ProviderRuntime port (Priority: P1) 🎯 MVP

**OBJ1 — provider-agnostic boundary. Satisfies TR-001, TR-007; validates SC-001, SC-005.**

- [X] T006 [OBJ1] {TR-001} Specify port methods (start/stop/kill/send/getUsage/subscribe/capabilities) with `AgentUsageSample`-compatible `getUsage` in src/shared/providerRuntime.ts ← T005:ProviderRuntime
- [X] T007 [OBJ1] {TR-007} Add boundary guard test: no provider-specific (Claude/PTY/hook) type in port/event/consumer exports, in src/main/runtime/__tests__/boundary.test.ts after:T006 ← T005:ProviderRuntime
- [X] T008 [OBJ1] {TR-001} [COMPLETES TR-001] Add conformance test: drive adapter through all port methods, 100% coverage (SC-001), in src/main/runtime/__tests__/conformance.test.ts after:T021 ← T005:ProviderRuntime

---

## Phase 4: Normalized AgentEvent contract (Priority: P1) 🎯 MVP

**OBJ2 — versioned event vocabulary. Satisfies TR-002, TR-003, TR-006; validates SC-002, SC-004.**

- [X] T009 [P] [OBJ2] {TR-002} Define all event kinds + required fields (turns, thinking, text-delta, tool-start/end, token-usage, api-error, stop, needs-input) in src/shared/agentEvent.ts ← T004:AgentEvent
- [X] T010 [OBJ2] {TR-003} Add `token-usage` fields mirroring `AgentUsageSample` (input/output/cacheRead/cacheCreation/model/usd), cumulative+monotonic, `usd` passthrough, in src/shared/agentEvent.ts after:T009
- [X] T011 [OBJ2] {TR-002} [COMPLETES TR-002] Add contract test: every event kind + required field emittable/typed across a session (SC-002) in src/main/runtime/__tests__/contract.test.ts after:T009 ← T004:AgentEvent
- [X] T012 [OBJ2] {TR-006} [COMPLETES TR-006] Add additive-extension test: new kind + field, assert version rule + existing consumers still compile (SC-004) in src/main/runtime/__tests__/versioning.test.ts after:T010 ← T004:AGENT_EVENT_VERSION

---

## Phase 5: Claude adapter with zero behavior change (Priority: P1) 🎯 MVP

**OBJ3 — wrap existing PTY+hooks behind the port. Satisfies TR-003, TR-004, TR-005, TR-008; validates SC-002, SC-003, SC-006.**

- [X] T013 [OBJ3] {TR-004} Create typed in-main event bus (emit/subscribe over `AgentEvent`) in src/main/runtime/eventBus.ts after:T005 ← T004:AgentEvent → exports: EventBus.emit, EventBus.subscribe
- [X] T014 [OBJ3] {TR-004} Scaffold Claude adapter implementing `ProviderRuntime` over the bus in src/main/runtime/claudeAdapter.ts after:T013 ← T005:ProviderRuntime → exports: ClaudeAdapter
- [X] T015 [OBJ3] {TR-004} Map HookServer payloads to events (PreToolUse→tool-start, PostToolUse→tool-end, Notification→needs-input) in src/main/runtime/claudeAdapter.ts after:T014 ← T013:EventBus
- [X] T016 [OBJ3] {TR-003} [COMPLETES TR-003] Emit `token-usage` from cumulative `UsageProvider` totals (never deltas); `getUsage` delegates to `UsageProvider` in src/main/runtime/claudeAdapter.ts after:T010,T015
- [X] T017 [OBJ3] {TR-008} Map Stop hook → normalized `stop` event carrying `stopActive` (`stop_hook_active`-equivalent) in src/main/runtime/claudeAdapter.ts after:T015 ← T004:AgentEvent
- [X] T018 [OBJ3] {TR-004} Surface PTY byte stream as `text-delta` events to the adapter in src/main/pty.ts after:T014 ← T013:EventBus
- [X] T019 [OBJ3] {TR-004,TR-008} Route hook payloads through adapter/bus, preserving existing IPC and the `drainForStop` Stop path with `stop_hook_active` guard, in src/main/hooks.ts after:T017 ← T014:ClaudeAdapter
- [X] T020 [OBJ3] {TR-005} Create IPC translator that re-emits the EXACT existing `hive:*` messages (parity, no rewrite) in src/main/runtime/ipcTranslator.ts after:T016 ← T013:EventBus → exports: IpcTranslator
- [X] T021 [OBJ3] {TR-004} [COMPLETES TR-004] Instantiate runtime/bus/Claude adapter and wire hooks/pty/usage/breaker/translator in src/main/index.ts after:T020 ← T014:ClaudeAdapter, T020:IpcTranslator
- [X] T022 [OBJ3] {TR-008} [COMPLETES TR-008] Add stop→drain test: `stop` with `stopActive` guard triggers `drainForStop` in 100% of end-of-turn cases (SC-006) in src/main/runtime/__tests__/stopDrain.test.ts after:T021 ← T004:AgentEvent
- [X] T023 [OBJ3] {TR-005} [COMPLETES TR-005] Add parity test over recorded fixtures: zero regression in avatars, telemetry, breaker, terminal, <250ms reaction (SC-003) in src/main/runtime/__tests__/parity.test.ts after:T021 ← T020:IpcTranslator

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T024 Run `npm run typecheck` (node + web) and `npm run test:run`; confirm both green as the hard release gate (TR-005 constraint) after:T023
- [X] T025 [P] Document the `AGENT_EVENT_VERSION` additive-only evolution rule and port/contract usage as header comments in src/shared/agentEvent.ts and src/shared/providerRuntime.ts after:T012

---

## Dependencies

Setup (Phase 1) → Foundational (Phase 2) → OBJ1/OBJ2/OBJ3 delivery (Phases 3–5, all P1) → Polish (Phase 6)

- **Setup → Foundational**: T004/T005 require the Vitest config (T002) only for their tests; the type definitions themselves depend on nothing but may be authored in parallel with T001–T003.
- **Foundational blocks all objectives**: T004 (`AgentEvent`) precedes T005 (`ProviderRuntime` references it) — HINT-001 ordering. Every Phase 3–5 task imports from these two files.
- **OBJ3 internal order**: bus (T013) → adapter scaffold (T014) → signal mappings (T015–T018) → integration wiring (T019, T021) → translator (T020) → validation (T022, T023). The conformance test T008 (OBJ1) depends on a runnable adapter, so it carries `after:T021`.
- **Parallel safety**: the only `[P]` tasks are T003 (fixture scaffold), T009 (event-kind definitions, depends only on prior-phase T004), and T025 (docs, `after:T012`). Each touches an isolated file with no unmet in-batch dependency; no `[P]` task shares a batch with a task it lists in `after:`/`←`.
- **Cross-phase edges**: `agentEvent.ts` is authored incrementally across T004 → T009 → T010 (`token-usage` field set must exist before T016 emits it, hence T016 `after:T010,T015`). Conformance/parity/stop-drain tests (T008, T022, T023) all carry `after:T021` because they need the fully wired adapter.

## Requirement Coverage

| Req | Tasks | Success Criterion | Validation Task |
|-----|-------|-------------------|-----------------|
| TR-001 | T005, T006, T008 | SC-001 | T008 |
| TR-002 | T004, T009, T011 | SC-002 | T011 |
| TR-003 | T010, T016 | SC-002 | T011, T016 |
| TR-004 | T013–T019, T021 | SC-001 | T008 |
| TR-005 | T020, T023, T024 | SC-003 | T023 |
| TR-006 | T012 | SC-004 | T012 |
| TR-007 | T007 | SC-005 | T007 |
| TR-008 | T017, T019, T022 | SC-006 | T022 |

---

## Phase: Bug Fixes

- [ ] T026 [BUG:WARNING] [pi-violation] Adopt and run a linter (ESLint or Biome) for the required 'linting' QC category — repo-wide (project-instructions.md Testing & Quality Policy; TODO(LINTER))
  > Error: QC required category 'linting' SKIPPED — no linter configured (no eslint/biome config or dependency). Required by .github/sddp-config.md Derived QC Policy (linting, performance).
  > Fix hint: `npm i -D eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin` + flat `eslint.config.js`, or `npm i -D @biomejs/biome` + `npx biome init`; wire into CI. NOTE: package installs currently roll back in this sandbox (TLS-proxy blocks binary downloads + Windows file locks) — resolvable only in a normal environment.
