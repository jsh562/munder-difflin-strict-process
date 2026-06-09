# Tasks: Provider Credential Management

**Input**: Design documents from `specs/00004-provider-credential-management/`
**Prerequisites**: `plan.md` (required), `spec.md` (required), `contracts/credential-interface.md`

**Tests**: Vitest test tasks are included — the spec/plan Testing Strategy explicitly requires unit + non-leakage tests for the pure credential core (SC-001/002/003/004/006). The Settings-UI key entry/clear is manual (renderer), not a vitest task.

**Organization**: Technical spec — phases group by objective (`OBJ#`). The pure `credentials.ts` module + the `providerKeys` config field block all three objectives and the wiring, so they land in a Foundational phase first (HINT-001).

## Project Mode

`Brownfield`

- Extends an existing Electron 32 / TypeScript codebase. No bootstrap/scaffolding tasks — all work integrates into existing `src/main`, `src/preload`, and `src/renderer` modules and the existing vitest + eslint gates.

## Epic / Capability Map *(OPTIONAL)*

- `[OBJ1]` → E004 Objective 1 — Multi-provider credential store (set/get/clear, validation, persistence)
- `[OBJ2]` → E004 Objective 2 — Key-injection-at-spawn seam (single swap point)
- `[OBJ3]` → E004 Objective 3 — Strict non-leakage (redaction + import boundary + store location)

## Brownfield Notes *(OPTIONAL)*

- Existing flows touched: `src/main/config.ts` (HarnessConfig), `src/main/index.ts` (`config:get` IPC at ~L821), `src/main/runtime/electronWorkerTransport.ts` (utilityProcess fork, no `env` today), `src/preload/index.ts` (`getConfig`), `src/renderer/src/components/SettingsModal.tsx`.
- Compatibility/migration concerns: `providerKeys` is an OPTIONAL field — old config.json loads unchanged. The `config:get` redaction CHANGES the renderer-visible shape (`HarnessConfig` → `SafeConfig`); preload + the renderer must move in lockstep (AD-002, HINT-003).
- Out-of-scope guard: the pre-existing Slack-secret exposure on `config:get` shares the same channel — DO NOT widen it; E004 only redacts `providerKeys`.
- Regression focus: existing `config:get`/`config:update` consumers keep non-key fields; the native worker fork keeps its current `serviceName`/`execArgv` behavior (env is additive, parameterized — no provider id ⇒ no key env, HINT-005).
- `credentials.ts` MUST stay electron-free (`import type { HarnessConfig }` only) and import NO hive/telemetry/transcript module so vitest runs it in Node and the SC-004 import-boundary holds (HINT-002).

---

## Phase 1: Foundational (Cross-Work-Item Blockers)

**The `providerKeys` config field + the pure `credentials.ts` module skeleton block OBJ1, OBJ2, and OBJ3 and all downstream wiring (HINT-001). Land them first.**

- [X] T001 {TR-001,TR-005} Add optional `providerKeys?: Record<string,string>` to `HarnessConfig` in src/main/config.ts (persisted in config.json under app.getPath('userData'), beside slack* secrets, outside any repo) → exports: HarnessConfig.providerKeys
- [X] T002 {TR-006} Create electron-free pure module src/main/credentials.ts with `import type { HarnessConfig } from './config'` and NO hive/telemetry/transcript import; declare `SafeConfig = Omit<HarnessConfig,'providerKeys'> & { providerKeyPresence: Record<string,boolean> }` (AD-004, HINT-002) after:T001 ← T001:HarnessConfig.providerKeys → exports: SafeConfig
- [X] T003 Create vitest scaffold src/main/__tests__/credentials.test.ts importing src/main/credentials.ts and a fake known-provider id list (no electron) (AD-004) after:T002

---

## Phase 2: OBJ1 - Multi-provider credential store (Priority: P1) 🎯 MVP

**Set/get/clear over a passed config object, keyed by E002 provider id, with unknown-provider rejection. Pure functions on `HarnessConfig` (vitest-tested).**

- [X] T004 [OBJ1] {TR-001} Implement `setKeyInConfig(cfg,providerId,key,knownProviderIds)` (returns new config; throws when providerId ∉ knownProviderIds), `getKeyFromConfig(cfg,providerId)` (key|null), `clearKeyInConfig(cfg,providerId)` (new config sans key) in src/main/credentials.ts after:T002 → exports: setKeyInConfig(), getKeyFromConfig(), clearKeyInConfig()
- [X] T005 [OBJ1] {TR-002,TR-001} [COMPLETES TR-002] Add `keyPresence(cfg,knownProviderIds): Record<string,boolean>` (presence only, values never included) in src/main/credentials.ts after:T004 → exports: keyPresence()
- [X] T006 [P] [OBJ1] {TR-001} Vitest SC-001: set→get→clear over a config object round-trips; updated config carries `providerKeys` so it persists across a readConfig/writeConfig cycle (config-object level) in src/main/__tests__/credentials.test.ts after:T004 ← T004:setKeyInConfig,getKeyFromConfig,clearKeyInConfig
- [X] T007 [P] [OBJ1] {TR-002} Vitest SC-002: `setKeyInConfig` rejects an unknown provider id and leaves the config unchanged; `keyPresence` keyed only by known providers in src/main/__tests__/credentials.test.ts after:T005 ← T005:keyPresence

---

## Phase 3: OBJ2 - Key-injection-at-spawn seam (Priority: P1) 🎯 MVP

**The single function that returns the spawn env for a provider (key → env, no key → null). The swap point a future OS-keychain backend replaces (TR-006).**

- [X] T008 [OBJ2] {TR-003,TR-007} Implement `injectionEnvForProvider(cfg,providerId): Record<string,string>|null` returning `{ NATIVE_PROVIDER_API_KEY:<key>, NATIVE_PROVIDER_ID:<providerId> }` or null when no key (no empty/garbage env) in src/main/credentials.ts after:T004 ← T004:getKeyFromConfig → exports: injectionEnvForProvider()
- [X] T009 [P] [OBJ2] {TR-003} Vitest SC-003: `injectionEnvForProvider` returns the generic key→env map for a stored key (AD-003) in src/main/__tests__/credentials.test.ts after:T008 ← T008:injectionEnvForProvider
- [X] T010 [P] [OBJ2] {TR-007} [COMPLETES TR-007] Vitest SC-006: `injectionEnvForProvider` returns null (not an empty/garbage object, no throw) when the provider has no key in src/main/__tests__/credentials.test.ts after:T008 ← T008:injectionEnvForProvider

---

## Phase 4: OBJ3 - Strict non-leakage (Priority: P1) 🎯 MVP

**Redaction of `providerKeys` to `SafeConfig` + the value-absence test, the source-scan import-boundary test, and the store-location path assertion (SC-004/005/007).**

- [X] T011 [OBJ3] {TR-008,TR-004} Implement `redactConfig(cfg): SafeConfig` — strips `providerKeys`, adds `providerKeyPresence` (presence only); the ONLY shape sent to the renderer in src/main/credentials.ts after:T005 ← T005:keyPresence ← T002:SafeConfig → exports: redactConfig()
- [X] T012 [P] [OBJ3] {TR-004,TR-008} Vitest SC-004 (value-absence): a set key's value appears NOWHERE in `JSON.stringify(redactConfig(cfg))`; `providerKeyPresence` is true without exposing the value in src/main/__tests__/credentials.test.ts after:T011 ← T011:redactConfig
- [X] T013 [P] [OBJ3] {TR-004} [COMPLETES TR-004] Vitest SC-004 (import boundary, E001-style source scan): assert src/main/credentials.ts source imports none of `hive`/`telemetry`/`transcript` (and no electron) in src/main/__tests__/credentials.test.ts after:T002
- [X] T014 [P] [OBJ3] {TR-005} [COMPLETES TR-005] Vitest SC-005 (path assertion): assert the credential store resolves under `app.getPath('userData')/config.json` (config.ts `configPath`) — outside any registered repo in src/main/__tests__/credentials.test.ts after:T001

---

## Phase 5: Polish & Cross-Cutting Concerns

**Live electron-coupled wiring (thin): redact the `config:get` IPC, add the credentials IPC, inject env at the native spawn, move preload + the renderer to `SafeConfig`, and gate. No new pure logic here.**

- [X] T015 {TR-008} [COMPLETES TR-008] Change the `config:get` handler (~L821) to return `redactConfig(readConfig())` and type it `SafeConfig` in src/main/index.ts; do NOT widen the pre-existing Slack-secret exposure (AD-002, HINT-003) after:T011 ← T011:redactConfig
- [X] T016 {TR-001,TR-002} Add IPC handlers `credentials:set(providerId,key)` / `credentials:clear(providerId)` (validate vs `listProviders()`, apply the pure fn, `writeConfig`) and `credentials:presence()` (→ `keyPresence`) in src/main/index.ts after:T005 ← T005:setKeyInConfig,clearKeyInConfig,keyPresence ← src/shared/providerRegistry.ts:listProviders
- [X] T017 {TR-003} [COMPLETES TR-003] Thread an optional `providerId` into `makeElectronWorkerTransport` and pass `env: injectionEnvForProvider(readConfig(),providerId) ?? undefined` to `utilityProcess.fork` (additive; no providerId ⇒ no key env) in src/main/runtime/electronWorkerTransport.ts after:T008 ← T008:injectionEnvForProvider
- [X] T018 {TR-008} Change `getConfig` to return `SafeConfig` and add `credentials.set/clear/presence` bridges in src/preload/index.ts after:T015 after:T016
- [X] T019 {TR-001,TR-008} Add a minimal Settings surface (per-provider key presence from `credentials:presence`; enter sends value renderer→main via `credentials:set`; clear via `credentials:clear`; value never received main→renderer) in src/renderer/src/components/SettingsModal.tsx after:T018
- [X] T020 Run `npm run typecheck` && `npm run lint` && `npm run test:run` (vitest, forks) and fix any failures until all three are green

---

## Dependencies

Foundational (Phase 1) → OBJ1 (Phase 2) → OBJ2 (Phase 3) → OBJ3 (Phase 4) → Polish (Phase 5)

- **Phase 1 (Foundational)** has no internal cross-feature dependency beyond ordering: T001 (config field) → T002 (module skeleton + SafeConfig) → T003 (test scaffold).
- **Phase 2 (OBJ1)** depends on T002 (the module). T004 (CRUD) blocks T005 (keyPresence), T006, T007.
- **Phase 3 (OBJ2)** depends on T004 (reuses `getKeyFromConfig`). T008 blocks T009, T010.
- **Phase 4 (OBJ3)** depends on T002 (SafeConfig), T005 (keyPresence), and T001 (path). T011 blocks T012; T013 depends only on T002; T014 depends only on T001.
- **Phase 5 (Polish)** depends on the pure core being complete: T015 needs T011; T016 needs T005; T017 needs T008; T018 needs T015+T016; T019 needs T018; T020 gates everything.
- Tasks marked `[P]` run in parallel within their phase (all `[P]` tasks here are independent vitest cases in `credentials.test.ts` writing distinct test blocks, after their producing implementation task is `[X]`).
- A task with `after:T###` or `← T###:Symbol` is never `[P]`-batched with the referenced task (validated): e.g. T006/T007 are not batched with T004/T005; T009/T010 not with T008; T012 not with T011.
- The Settings-UI task (T019) is MANUAL verification (renderer); it has no vitest task. SC-007 is covered by the redaction (T011/T015) + env-only injection (T017), not a UI test.

## Coverage Notes

- **Technical Requirements**: TR-001 (T001,T004,T005,T006,T016,T019) · TR-002 (T005,T007,T016) · TR-003 (T008,T009,T017) · TR-004 (T011,T012,T013) · TR-005 (T001,T014) · TR-006 (T002,T008) · TR-007 (T008,T010) · TR-008 (T011,T012,T015,T018,T019) — every TR-001..TR-008 maps to ≥1 task.
- **Success Criteria**: SC-001 (T006, vitest) · SC-002 (T007, vitest) · SC-003 (T009, vitest) · SC-004 (T012 value-absence + T013 import-boundary, vitest) · SC-005 (T014, path assertion) · SC-006 (T010, vitest) · SC-007 (T011+T015 redaction + T017 env-only injection; Settings UI T019 manual).
- **Architecture Decisions**: AD-001 (T001 store in config.json) · AD-002 (T011,T015,T018 redact) · AD-003 (T008 generic env) · AD-004 (T002,T003 pure core) · AD-005 (T004,T007,T016 reject unknown) · AD-006 (T008,T017 env-at-fork seam).
