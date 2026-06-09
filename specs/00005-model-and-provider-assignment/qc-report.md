# QC Report: E005 Model and Provider Assignment

**Feature**: E005 | **Branch**: `00005-model-and-provider-assignment` | **Date**: 2026-06-08
**Verdict**: PASSED
**Required categories** (project-instructions.md): linting (PASS), performance (PASS — N/A by design)

## Category Verdicts

| Category | Verdict | Notes |
|----------|---------|-------|
| Build/Compile (typecheck node+web) | PASSED | `npm run typecheck` clean; node + web both 0 errors |
| Static Analysis / Linting (REQUIRED) | PASSED | `npm run lint` → 0 errors, 9 warnings; all 9 pre-existing/allowlisted; NO new findings in E005 files |
| Tests | PASSED | `npm run test:run` → 12 files, 79 tests passed; assignment.test.ts 25/25; no cold-start flake |
| Performance (REQUIRED) | PASSED | N/A by design — assignment = O(1) registry map lookups + UI selection; no hot path; matches plan "Performance Goals: N/A" |
| Security | PASSED (no new risk) | Reads credential PRESENCE only (E004); no new secret path; key material never crosses bridge (ADR-0007) |

## Gate Output

### Build/Compile — PASSED
`npm run typecheck` (= typecheck:node `tsc --noEmit -p tsconfig.node.json` && typecheck:web `tsc --noEmit -p tsconfig.web.json`): both completed with no diagnostics. Hard gate (PI principle V) green.

### Lint — PASSED
`npm run lint` (`eslint src`): `9 problems (0 errors, 9 warnings)`.
All 9 warnings are in pre-existing allowlisted files, none in E005-touched files:
- breaker.ts:147,207; hooks.ts:77; index.ts:656 (createWindow geometry restore — pre-existing, not the E005 spawn edit); reflect.ts:181 (no-useless-assignment)
- FileTree.tsx:29 (no-unused-vars); useHive.ts:215,269; OfficeFloor.tsx:717 (react-hooks/exhaustive-deps)
E005 files clean: assignment.ts, ProviderModelPicker.tsx, AddAgentModal.tsx, SettingsModal.tsx, CommandCenterPanel.tsx, store.ts, config.ts, preload/index.ts — 0 warnings/errors each.

### Tests — PASSED
`npm run test:run` (`vitest run`, forks): `Test Files 12 passed (12) | Tests 79 passed (79)`.
- src/shared/__tests__/assignment.test.ts — 25 tests passed (precedence, gap, stale, provenance, fleet-default round-trip)
- src/shared/__tests__/providerRegistry.test.ts — 16; main/runtime + credentials suites — 38
No "No test suite found" cold-start flake on the run.

### Performance — PASSED (N/A by design)
No benchmarkable seam introduced. Effective-model resolution is precedence checks + O(1) `lookupModel`/`lookupModelInfo`/`lookupCapabilities` registry map reads; provider derivation is one map lookup; UI is a render-time selection. No new hot path, loop, or I/O on a critical path. Consistent with plan Performance Goals: N/A.

### Security — PASSED (no new risk)
- Credential presence read-only: picker calls `cth.credentials.presence()` → `Record<string,boolean>`; raw keys never cross the bridge (preload comment + handler confirm). ADR-0007 honored.
- No new secret path: fleet default reuses `config:update` with `defaultModel` only.
- E004 `providerKeys` / `providerKeyPresence` not widened or altered.

## Data-Integrity / Security Invariants (code-verified)

| Invariant | Status | Evidence |
|-----------|--------|----------|
| Provider DERIVED from modelId, never stored | HOLDS | `deriveProviderId()` via `lookupModelInfo`; no `providerId` field on Agent/PersistedAgent or config |
| No `providerId` persisted on agent record | HOLDS | store.ts persists only `model` + `assignmentSource`; `PersistedAgent = Omit<Agent,...>`; grep `providerId` → 0 hits in store.ts |
| No `providerId` persisted in config | HOLDS | config.ts FleetDefault = `defaultModel` only; provider derived at read time (`fleetDefaultModel()`) |
| Spawn-path providerId is in-memory only | HOLDS | index.ts `agentProviderIds: Map<string,string>` for E006 seam; not written to record/config |
| GOD seam writes same shape | HOLDS | `assignAgentModel` → renderer `reassignAgentModel` (`model` + `assignmentSource='explicit'`); no separate persisted path |
| E004 providerKeys/presence not widened | HOLDS | credentials handlers/types unchanged; additive `defaultModel` only |
| Credential presence read-only (no key values to renderer) | HOLDS | `credentials.presence()` returns booleans; preload + ipcMain comments + picker confirm key material never read back |

## Requirements Traceability (Story Verifier)

**Result: PASS** — all four P1 user stories and all nine success criteria SATISFIED.

| Work item / SC | Status | Evidence / classification |
|----------------|--------|---------------------------|
| US1 — Assign per-agent at add-time | SATISFIED (4/4 scenarios) | ProviderModelPicker + AddAgentModal record `model`+`assignmentSource='explicit'`; spawn precedence + derived providerId |
| US2 — Fleet default for new agents | SATISFIED (5/5) | config `defaultModel`/`fleetDefaultModel`, preload `fleetDefault`, SettingsModal control + FR-014 scope msg, snapshot-at-creation, non-retroactive invariant |
| US3 — Change per desk + revert | SATISFIED (3/3) | CommandCenterPanel re-assign/revert/provenance + GOD seam parity |
| US4 — Capability-gap warn-at-assignment | SATISFIED (3/3) | Non-blocking gap/credential/combined/stale annotations in picker |
| SC-001 | SATISFIED | picker → `model` → `buildSpawnCommand --model` (code-inspection) |
| SC-002 | SATISFIED | `assignmentSource`+`model` in `PersistedAgent`/`cth.agents` (shape vitest-backed; restart round-trip manual per plan) |
| SC-003 | SATISFIED | inherit-default vs role-based fallback (vitest) |
| SC-004 | SATISFIED | non-retroactive: store never re-derives existing agents (vitest snapshot test) |
| SC-005 | SATISFIED | `defaultModel` persisted via `writeConfig` (vitest round-trip + manual) |
| SC-006 | SATISFIED | per-desk change+revert+provenance+persist (code-inspection + vitest provenance) |
| SC-007 | SATISFIED | gap warning names each capability, never disables; full model → none (vitest) |
| SC-008 | SATISFIED | empty-state + drawer fallback; stale flagged not remapped (vitest stale + code-inspection) |
| SC-009 | SATISFIED | GOD `agent:assign` → same `reassignAgentModel` path, same persistence (code-inspection) |

Test-evidence split: pure resolver fully vitest-backed (25/25); UI surfaces code-inspection; live picker/drawer/Settings interaction + localStorage restart round-trip (SC-002) deferred to manual/app-smoke per the plan Testing Strategy.

Documented deviation: US3 per-desk edit implemented in `CommandCenterPanel.tsx` (the real per-agent model-change surface) rather than `AddAgentModal.tsx` (creation-only) as the plan's Coverage Map named — behaviorally correct, benign.

## PI Compliance

No violations. Principles I (provider-agnostic parity), II (truthful cost — no silent remap), V (preserve core + type safety) upheld; ENFORCE_SRC_ROOT clean; secrets never to hive/transcripts/telemetry (presence-only).

## Bug Tasks Generated

None.

## Conclusion

All required categories pass. Typecheck (hard gate), lint (0 errors, no new findings), and tests (79/79) green. Performance N/A by design. Security no-new-risk. All E005 data-integrity invariants hold in code; all P1 stories + SC-001..SC-009 SATISFIED. Release-ready.
