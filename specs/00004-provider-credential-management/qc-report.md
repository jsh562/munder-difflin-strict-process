# QC Report: E004 — Provider Credential Management

**Date:** 2026-06-09
**Verdict:** ✅ PASS
**Tasks:** T001–T020 all complete (`tasks.md` all `[X]`)

## Gates (run for real)

| Gate | Command | Result |
|------|---------|--------|
| Typecheck (node + web) | `npm run typecheck` | ✅ PASS — `tsc --noEmit` both projects, exit 0 |
| Lint (required) | `npm run lint` | ✅ PASS — **0 errors**, 9 warnings (all pre-existing, none in E004 files) |
| Tests | `npm run test:run` | ✅ PASS — 11 files, **54 tests**; `credentials.test.ts` **8/8** |
| Performance (required) | static review | ✅ N/A by design — injection is a single map lookup at spawn; no hot path |
| Coverage | — | Not enforced (no project coverage target) |

Lint warnings are confined to pre-approved files (`breaker.ts`, `hooks.ts`, `index.ts:603` window-geometry restore, `reflect.ts`, `FileTree.tsx`, `useHive.ts`, `OfficeFloor.tsx`). None originate in any E004 file.

## Success Criteria (Story Verifier)

| SC | Verdict | Evidence |
|----|---------|----------|
| SC-001 store CRUD persists | SATISFIED | `setKeyInConfig`/`getKeyFromConfig`/`clearKeyInConfig` over `HarnessConfig.providerKeys`; persisted via `readConfig`/`writeConfig`; test SC-001 |
| SC-002 only known providers | SATISFIED | `setKeyInConfig` throws on unknown id; IPC validates vs `listProviders()`; `keyPresence` keyed by known providers; test SC-002 |
| SC-003 injection seam → spawn env | SATISFIED | `injectionEnvForProvider` → `{ NATIVE_PROVIDER_API_KEY, NATIVE_PROVIDER_ID }` → `NativeRuntime.spawn(agentId, providerId?)` → `makeElectronWorkerTransport({ env })` → `utilityProcess.fork`; test SC-003 |
| SC-004 non-leakage | SATISFIED | `redactConfig` strips `providerKeys`, adds `providerKeyPresence`; `config:get` returns `SafeConfig`; value-absence + import-boundary tests |
| SC-005 store outside any repo | SATISFIED | `join(app.getPath('userData'), 'config.json')`; path-assertion test |
| SC-006 missing key → clean null | SATISFIED | `injectionEnvForProvider` returns `null` (no throw, no empty/garbage env); spawn maps `null → undefined`; test SC-006 |
| SC-007 renderer never receives key values | SATISFIED (manual UI) | Only renderer channels are redacted `config:get`, boolean `credentials:presence`, and write-only `credentials:set/clear`; preload type omits `providerKeys`; Settings UI presence-only + write-only. No main→renderer key-value path exists. |

## Security properties (CRITICAL — ADR-0007)

1. **Key values never reach the renderer** — `redactConfig` + `SafeConfig` type-level guarantee; value-absence test green. ✅
2. **`credentials.ts` imports no hive/telemetry/transcript/electron module** — `import type` only; source-scan test green. ✅
3. **Keys stored only in `config.json` (userData, outside any repo) and injected only into worker spawn env** — confirmed `hive.ts`/`telemetry.ts` reference zero credential symbols; no git/telemetry leak path. ✅

## Implementation note (seam location)

T017's intent (env injected at the `utilityProcess.fork`, additive, no providerId ⇒ no key env) is honored, but the `readConfig()`/`injectionEnvForProvider` call lives in the **main process** (`index.ts` `credentialEnvFor` seam → `NativeRuntime.spawn(agentId, providerId?)` → transport `env`) rather than inside `electronWorkerTransport.ts`. This keeps `electronWorkerTransport.ts` from importing `config`/`readConfig` and preserves it as the single electron-only file. TR-003 (env-at-fork, parameterized, no-providerId ⇒ no-key) is fully satisfied; `spawn` is the single swap point a future OS-keychain backend replaces.

## Conclusion

All required QC categories pass with real command output; all seven success criteria satisfied; all CRITICAL security properties verified. Feature is release-ready. `.qc-passed` written.
