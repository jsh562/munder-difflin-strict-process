# QC Report — E001 Provider Runtime and Event Bus

> Date: 2026-06-08 | Feature: `specs/00001-provider-runtime-and-event-bus/` | Run: full

## Overall Verdict: **FAIL**

QC fails on one **required** category: **linting is SKIPPED** (no linter configured). Per the user's decision (AUTOPILOT off), the SKIPPED PI-mandated category is treated as a QC failure and a bug task (T026) was generated. All other gates are green.

## Test Results

- **Runner**: `npm run test:run` → esbuild bundle + Node `node:test` (`tools/run-runtime-tests.mjs`); zero-install because `vitest` cannot be installed in this sandbox.
- **Result**: 21 passed / 0 failed / 0 skipped, 8 suites. Deterministic across serial re-runs.
- Suites: boundary, conformance, contract, versioning, monotonic, stopDrain, parity (+ shared harness).

## Static Analysis (Linting) — **FAIL (required, SKIPPED)**

- No linter configured (no `.eslintrc*` / `eslint.config.*` / `biome.json`; no `eslint`/`@biomejs/biome` dependency).
- `linting` is a Required Category (`.github/sddp-config.md` → Derived QC Policy). User chose **Fail QC + bug task** over accept-as-warning. → bug task T026.
- Root cause is environmental, not code: the repo has a standing `TODO(LINTER)` (project-instructions.md), and package installs roll back in this sandbox (TLS-proxy blocks binary downloads + Windows file locks).

## Security Audit — WARNING (not required)

- No scanner present; not a Required Category. No new external dependency or secret introduced by E001 (credentials are E004). SKIPPED → WARNING; no install attempted.

## PI Compliance — No violations

- Principles I/II/III/V satisfied by the implementation (provider-agnostic port + normalized contract; `token-usage` mirrors the locked `AgentUsageSample`, `usd` passthrough; lifecycle stop/kill + api-error modeled; parity translator keeps existing `hive:*` IPC; all source under `/src`; typecheck green). IV (output style) n/a to code.
- The linting gap is a Testing & Quality Policy/tooling gap (tracked as T026), not a core-principle violation.

## Requirements Traceability

| Work Item | Status | Evidence |
|-----------|--------|----------|
| OBJ1 — ProviderRuntime port | PASSED | `src/shared/providerRuntime.ts`; conformance.test.ts (SC-001), boundary.test.ts (SC-005) |
| OBJ2 — AgentEvent contract | PASSED | `src/shared/agentEvent.ts`; contract.test.ts (SC-002), versioning.test.ts (SC-004) |
| OBJ3 — Claude adapter, zero behavior change | PASSED | `claudeAdapter.ts` + `ipcTranslator.ts` + additive wiring; parity.test.ts (SC-003), stopDrain.test.ts (SC-006) |

| SC | Status | Validating test |
|----|--------|-----------------|
| SC-001 | PASSED | conformance.test.ts (100% port methods + empty descriptor) |
| SC-002 | PASSED | contract.test.ts (all kinds + monotonic usage) |
| SC-003 | PASSED | parity.test.ts (exact `hive:hookEvent` payload + <250 ms) |
| SC-004 | PASSED | versioning.test.ts (additive extension, consumers unchanged) |
| SC-005 | PASSED | boundary.test.ts (no provider-specific import/export in shared) |
| SC-006 | PASSED | stopDrain.test.ts (stopActive guard, 25-run scenario) |

All TR-001..TR-008 have implementing code + a validating test (per Story Verifier).

## Traceability Gaps

None. Non-blocking observation: `api-error`/`turn-end`/`thinking-*` are defined in the contract (TR-002) and type-validated, but not emitted by the Claude adapter (Claude hooks expose no equivalent signal) — consistent with the spec (E001 defines the vocabulary; the adapter maps the signals it receives).

## Code Coverage

n/a — no numeric coverage target (Coverage Target = none). Not collected.

## Checklist Fulfillment

WARNING (process): feature checklists `CHL001 Testing`, `CHL002 Observability`, `CHL003 Performance` are unchecked. Non-blocking; the Testing/Performance intents are satisfied by the suite (conformance/contract/parity + the <250 ms assertion).

## Performance — PASSED (required)

- `parity.test.ts` asserts the <250 ms avatar-reaction budget over a 4000-event stream; passes within the green suite.

## Accessibility — SKIPPED

- No accessibility NFRs in this feature (internal architecture seam, no UI surface introduced).

## Browser Runtime Validation — SKIPPED — not required

- No browser/UI behavior in this epic. The Electron app is not launchable in this sandbox (binary download blocked by the TLS proxy); E001 is validated by typecheck + the logic test suite, which is what its requirements target.

## Manual Testing — none

## Tool Recommendations

- **Linting** (required, FAIL): adopt ESLint (`npm i -D eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin` + flat `eslint.config.js`) or Biome (`npm i -D @biomejs/biome` + `npx biome init`); wire into CI. Blocked in this sandbox — run in a normal environment.
- **Security** (optional): add `npm audit` to CI.

## Bug Tasks Generated

- **T026** `[BUG:WARNING] [pi-violation]` Adopt and run a linter for the required 'linting' QC category — repo-wide.

## Bug Context

- **T026** — QC required category `linting` SKIPPED; no linter configured (no eslint/biome config or dependency). Required by `.github/sddp-config.md` Derived QC Policy. Fix: install + configure ESLint or Biome and wire into CI. Environmental blocker: package installs roll back in this sandbox (TLS-proxy + Windows file locks); resolvable in a normal environment.
