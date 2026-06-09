# Tasks: Model and Provider Assignment

**Feature**: E005 Model and Provider Assignment | **Branch**: `00005-model-and-provider-assignment` | **Spec type**: product
**Inputs**: spec.md, plan.md, data-model.md (checklists data-integrity / ux / testing all PASS)

## Project Mode

**Brownfield** — extends the existing Electron 32 / TypeScript 5.6 / React 18 + zustand app. No scaffolding or bootstrap tasks. All work integrates into existing `src/shared`, `src/main`, `src/preload`, `src/renderer` surfaces, additively coexisting with E002 (registry) and E004 (credentials/config).

## Epic / Capability Map

| User Story | Priority | Phase | Requirements |
|------------|----------|-------|--------------|
| US1 — Assign provider+model to a new agent | P1 | 4 (MVP) | FR-001, FR-002, FR-008, FR-012 |
| US2 — Set a fleet-default provider+model | P1 | 5 | FR-005, FR-006, FR-007, FR-014 |
| US3 — Change an existing agent's assignment per desk | P1 | 6 | FR-003, FR-004, FR-013 |
| US4 — Capability-aware warning at assignment | P1 | 7 | FR-009, FR-010, FR-011 |

Foundational (Phase 3): the electron-free resolver `src/shared/assignment.ts` blocks every story (precedence, gap, stale, provenance). Phases 1–2 (Setup) omitted — no repo-root tooling/config change.

## Brownfield Notes

- **HINT-001 / AD-001 / DR-1**: store `modelId` only; derive `providerId` via `lookupModelInfo` at read time. NEVER persist provider as an editable field.
- **HINT-002 / AD-005 / DR-4**: fleet-default inheritance is snapshot-at-creation; "revert to default" re-inherits; changing the default MUST NOT mutate existing agents.
- **HINT-004 / DR-9**: assignment fields are additive + independently-keyed. Do NOT widen/alter E004 `providerKeys`/presence.
- **HINT-005 / AD-006 / DR-5 / DR-11**: registry is a soft dependency — unresolved `modelId` ⇒ stale (preserve+flag+prompt, never remap); empty registry ⇒ empty-state + role-based fallback.
- Warn-at-assignment (FR-009 / AD-003 / DR-3) is NON-BLOCKING — Save/confirm stays enabled.
- GOD uses the SAME mechanism (FR-013 / DR-10) — no separate path.
- UI behaviors (picker render, drawer flow, Settings control, localStorage restart round-trip) are app-smoke / **manual** per the plan Testing Strategy — recorded as manual verification, NOT vitest tasks.

---

## Phase 3: Foundational (Cross-Story Blockers)

Pure, electron-free resolver module + its vitest suite. Blocks US1–US4. Mirrors the E001–E004 pure-module + vitest convention (HINT-003).

- [X] T001 {FR-008} Create electron-free resolver src/shared/assignment.ts: precedence explicit→FleetDefault→role-based (DR-8) ← providerRegistry.ts:lookupModel → exports: resolveEffectiveModel()
- [X] T002 {FR-008} Add deriveProviderId to src/shared/assignment.ts (providerId via lookupModelInfo; never stored, DR-1) ← providerRegistry.ts:lookupModelInfo → exports: deriveProviderId(modelId)
- [X] T003 {FR-009} Add computeCapabilityGap to src/shared/assignment.ts naming each false capability flag (images, MCP, web search, caching; DR-3) → exports: computeCapabilityGap(modelId)
- [X] T004 {FR-011} Add isAssignmentStale to src/shared/assignment.ts (model present but lookupModel===null ⇒ stale; preserve id, never remap; DR-5/DR-11) → exports: isAssignmentStale(modelId)
- [X] T005 {FR-004} Add assignmentProvenance to src/shared/assignment.ts distinguishing explicit vs fleet-default vs role-based (DR-1) → exports: assignmentProvenance()
- [X] T006 Create vitest src/shared/__tests__/assignment.test.ts (mirror providerRegistry.test.ts): precedence, gap, stale, provenance, non-retroactive snapshot shape after:T005

---

## Phase 4: US1 — Assign provider+model to a new agent (Priority: P1) 🎯 MVP

**Goal**: Operator picks a provider+model in the Add-Agent drawer; the new agent is created bound to that model with `assignmentSource='explicit'`; empty registry falls back to role-based default. **Independent test**: add an agent, choose a specific provider+model, confirm it is created with that model and still shown after restart.

- [X] T007 [US1] {FR-002} Add additive `assignmentSource?: 'explicit'|'fleet-default'` to Agent + PersistedAgent in src/renderer/src/store/store.ts (cth.agents persisted) → exports: assignmentSource
- [X] T008 [P] [US1] {FR-001} Create provider-grouped picker src/renderer/src/components/ProviderModelPicker.tsx via listProviders, with per-model capability tags → exports: ProviderModelPicker
- [X] T009 [US1] {FR-012} Add empty-state branch to src/renderer/src/components/ProviderModelPicker.tsx (no models ⇒ setup-pointer, selection disabled; DR-7) after:T008 ← T008:ProviderModelPicker
- [X] T010 [US1] {FR-002} Integrate the picker into src/renderer/src/components/AddAgentModal.tsx; on create record `model` + `assignmentSource='explicit'` after:T007 ← T008:ProviderModelPicker
- [X] T011 [US1] {FR-012} Wire empty-registry fallback in src/renderer/src/components/AddAgentModal.tsx — creation falls through to role-based default when no model pickable after:T010
- [X] T012 [US1] {FR-008} [COMPLETES FR-008] In spawn path src/main/index.ts honor assignment `--model` precedence + record providerId for the E006 nativeRuntime.spawn seam after:T010

---

## Phase 5: US2 — Set a fleet-default provider+model (Priority: P1) 🎯 MVP

**Goal**: Operator sets a house default (`HarnessConfig.defaultModel`); newly created agents with no pick inherit it as a snapshot; changing it is non-retroactive. **Independent test**: set a default, add an agent without picking, confirm it inherits; change the default, confirm existing agents keep their model while a new agent uses the new default.

- [X] T013 [P] [US2] {FR-005} Clarify FleetDefault on `HarnessConfig.defaultModel` + add optional accessor in src/main/config.ts (provider derived, not stored; DR-1) → exports: fleetDefaultModel()
- [X] T014 [US2] {FR-005} Add fleet-default get/set passthrough in src/preload/index.ts via existing `config:update` IPC (set/read `defaultModel`; no secret path) after:T013 ← T013:fleetDefaultModel
- [X] T015 [US2] {FR-005} [COMPLETES FR-005] Fleet-default control in src/renderer/src/components/SettingsModal.tsx reusing the picker, persisted via config after:T014 ← T008:ProviderModelPicker
- [X] T016 [US2] {FR-014} Add non-retroactive scope message to the fleet-default surface in src/renderer/src/components/SettingsModal.tsx — change applies to new agents only (FR-006) after:T015
- [X] T017 [US2] {FR-006} Snapshot resolved fleet default onto the new agent in src/renderer/src/components/AddAgentModal.tsx (`assignmentSource='fleet-default'`) after:T010
- [X] T018 [US2] {FR-006,FR-007} [COMPLETES FR-006] Verify non-retroactivity in src/renderer/src/store/store.ts: changing `defaultModel` MUST NOT mutate existing agents (DR-4, DR-9, SC-004) after:T017
- [X] T019 [US2] {FR-007} [COMPLETES FR-007] Add fleet-default config round-trip vitest in src/shared/__tests__/assignment.test.ts: `defaultModel` survives reload; stale falls through after:T013

---

## Phase 6: US3 — Change an existing agent's assignment per desk (Priority: P1) 🎯 MVP

**Goal**: Operator re-assigns an existing desk's model (`source='explicit'`) or reverts it to the fleet default (`source='fleet-default'`, re-inherits current default); UI shows default-vs-custom provenance; GOD uses the same mechanism. **Independent test**: open an agent, change its model to another provider's, confirm recorded + persists; "revert to fleet default" re-inherits.

- [X] T020 [US3] {FR-003} Extend updateAgent in src/renderer/src/store/store.ts to re-assign per desk (overwrite `model`, set `assignmentSource='explicit'`, persist) after:T007 ← T007:assignmentSource
- [X] T021 [US3] {FR-004} Add "revert to fleet default" re-resolving the default (`assignmentSource='fleet-default'`) via updateAgent in src/renderer/src/store/store.ts after:T020
- [X] T022 [US3] {FR-004} [COMPLETES FR-004] Surface default-vs-custom provenance on the per-desk UI in src/renderer/src/components/AddAgentModal.tsx after:T021 ← T005:assignmentProvenance
- [X] T023 [US3] {FR-013} [COMPLETES FR-013] Expose GOD assignment seam in src/main/index.ts writing the SAME `model` + `assignmentSource` (DR-10) after:T020 ← T007:assignmentSource

---

## Phase 7: US4 — Capability-aware warning at assignment (Priority: P1) 🎯 MVP

**Goal**: Selecting a model with a capability gap shows a non-blocking warning naming each missing capability; uncredentialed providers are annotated (not blocked); a model removed from the registry is flagged stale and prompts re-selection. Save/confirm stays enabled throughout. **Independent test**: assign a gapped model, confirm a naming warning while Save stays enabled; assign a full-capability model, confirm no warning.

- [X] T024 [US4] {FR-009} Render non-blocking gap warning in src/renderer/src/components/ProviderModelPicker.tsx naming each missing capability after:T008 ← T003:computeCapabilityGap
- [X] T025 [US4] {FR-010} Annotate "needs credentials" in src/renderer/src/components/ProviderModelPicker.tsx via cth.credentials.presence() per provider, not blocking selection (DR-6) after:T008
- [X] T026 [US4] {FR-009,FR-010} [COMPLETES FR-009] Surface combined annotation when a model is BOTH uncredentialed AND gapped in src/renderer/src/components/ProviderModelPicker.tsx after:T024
- [X] T027 [US4] {FR-011} [COMPLETES FR-011] Surface stale state in src/renderer/src/components/ProviderModelPicker.tsx (unresolvable ⇒ stale badge + re-select) after:T024 ← T004:isAssignmentStale

---

## Phase 8: Polish & Gates

- [X] T028 Run gates: `npm run typecheck` (node+web, hard gate), `npm run lint` (0 errors), `npm run test:run` (forks); a cold-start "No test suite found" flake can appear once — re-run after:T027

---

## Dependencies

**Phase order**: Phase 3 (Foundational) → Phase 4 (US1) → Phase 5 (US2) → Phase 6 (US3) → Phase 7 (US4) → Phase 8 (Gates). All four P1 stories are independently testable; US2/US3/US4 build on the US1 picker and store shape via explicit `after:` edges.

**Foundational (Phase 3)** blocks all delivery phases:
- T001 (resolver/precedence) → T002, T004, T005, and consumed by T011, T012, T017, T019, T021.
- T003 (gap) → consumed by T024, T026.
- T004 (stale) → consumed by T027.
- T005 (provenance) → consumed by T022.
- T006 closes the foundational vitest chain (depends on T001–T005).

**Cross-phase edges**:
- T007 (store shape) precedes T010, T017, T020.
- T008 (picker) precedes T009, T010, T015, T022, T024, T025.
- T010 (drawer integration) precedes T011, T012, T017.
- T013 (config accessor) precedes T014, T019; T014 precedes T015; T015 precedes T016.
- T017 (snapshot) precedes T018.
- T020 (updateAgent re-assign) precedes T021, T023; T021 precedes T022; T024 precedes T026, T027.
- T028 (gates) runs last (after T027), after every implementation task.

**Parallel-safe `[P]`**: T008 (new picker file, no in-phase predecessor), T013 (config accessor, independent of US1 store work). No `[P]` task shares a batch with its `after:`/`←` dependency.

**Requirement completion points** (`[COMPLETES]`): FR-004 → T022; FR-005 → T015; FR-006 → T018; FR-007 → T019; FR-008 → T012; FR-009 → T026; FR-011 → T027; FR-013 → T023.

## Requirement Coverage

| Req | Tasks | Story |
|-----|-------|-------|
| FR-001 | T008 | US1 |
| FR-002 | T007, T010 | US1 |
| FR-003 | T020 | US3 |
| FR-004 | T005, T021, T022 | US3 |
| FR-005 | T013, T014, T015 | US2 |
| FR-006 | T017, T018 | US2 |
| FR-007 | T018, T019 | US2 |
| FR-008 | T001, T002, T012 | US1 |
| FR-009 | T003, T024, T026 | US4 |
| FR-010 | T025, T026 | US4 |
| FR-011 | T004, T027 | US4 |
| FR-012 | T009, T011 | US1 |
| FR-013 | T023 | US3 |
| FR-014 | T016 | US2 |

All FR-001..FR-014 covered. Success criteria: SC-001/SC-002 (US1: T010/T012, restart manual), SC-003 (T011/T017), SC-004 (T018), SC-005 (T019), SC-006 (T020/T021/T022), SC-007 (T024), SC-008 (T009/T011/T027), SC-009 (GOD assignment: T023).

## Testing Notes (per plan Testing Strategy)

- **Vitest (Node, electron-free)**: T006 (resolver: precedence, gap, stale, provenance, snapshot shape) and T019 (fleet-default config round-trip + stale fall-through). No numeric coverage target.
- **Manual / app-smoke** (NOT vitest tasks): picker render, Add-Agent drawer flow, Settings fleet-default control, and the per-agent `cth.agents` localStorage restart round-trip (SC-002). Verified on real restart per the E001–E004 convention.
- **Gate flake note**: first `npm run test:run` after adding `assignment.test.ts` may emit a cold-start "No test suite found" — re-run once (see T028).
