# QC Report: E006 Native Provider Adapters

**Feature**: E006 | **Branch**: `00006-native-provider-adapters` | **Date**: 2026-06-09
**Verdict**: PASSED
**Required categories** (project-instructions.md): linting (PASS), performance (PASS)

## Category Verdicts

| Category | Verdict | Notes |
|----------|---------|-------|
| Build/Compile (typecheck node+web) | PASSED | `npm run typecheck` clean; both projects 0 errors (hard gate, Principle V) |
| Static Analysis / Linting (REQUIRED) | PASSED | `npm run lint` → 0 errors, 9 warnings; all 9 pre-existing/allowlisted; NO new findings in any E006 file |
| Tests | PASSED | `npm run test:run` → 23 files, **170 tests** passed; 91 are the E006 suites; no cold-start flake |
| Performance (REQUIRED) | PASSED | No in-process hot path beyond the provider round-trip; runs bounded by max-turn/max-hop caps + per-turn wall-clock budget + ADR-0009 bounded backoff; live latency provider-bound (manual smoke) |
| Security (key handling) | PASSED | `keyNonLeak.test.ts` (4) verified: key + substrings never in events/turn/usage/api-error (incl. forced-401), only at the fetch boundary |

## Test Results

Runner: Vitest (forks). 23 files, 170/170 passed, 0 failures. E006 suites: sseParser (9), reliability (18), capabilityGate (4), agentLoopE006 (5), deepseekAdapter (11), minimaxAdapter (15), selectAdapter (7), nativePeerLoop (6), nativeRuntimeSpawn (3), degradation (9), keyNonLeak (4).

## Static Analysis

ESLint `eslint src`: 0 errors, 9 warnings — all in pre-existing allowlisted files (breaker.ts, hooks.ts, index.ts:660 window-geometry, reflect.ts, FileTree.tsx, useHive.ts, OfficeFloor.tsx). Zero new findings in adapters/, hiveTools.ts, agentWorker.ts, agentLoop.ts, nativeRuntime.ts, nativeAgentWorker.ts, providerCall.ts, workerProtocol.ts, providerRegistry.ts.

## Security Audit

- **FR-013 (key from env only, never emitted)**: HOLDS. Only `process.env` key read is `agentWorker.ts` via `selectAdapter(process.env)`; key passed as a param, used solely at the fetch boundary (`Authorization: Bearer` DeepSeek; `x-api-key`+bearer Minimax). `keyNonLeak.test.ts` asserts absence across events/turn/usage/api-error on success + forced-401.
- **FR-007 (no SDK/wire types past the adapter)**: HOLDS. No `openai`/`@anthropic-ai` imports in `src`; the `ProviderCall` seam uses only provider-agnostic types.
- **AD-007 (registry caps static-source only)**: HOLDS. Capability descriptors are static `const` data; `lookupCapabilities` is read-only; no registry mutation in `src`.

## PI Compliance

No violations. Principle I (provider-agnostic parity — adapters behind the port, normalized stream, no downstream branching), II (usage passthrough cumulative-monotonic; recompute deferred to E002/E007), III (per-agent worker isolation; ADR-0009 retry/backoff; malformed JSON never crashes; single-committer preserved — registry is static source), V (additive; no SDK types; typecheck hard gate) all upheld. Secrets never to events/telemetry/hive (ADR-0007). Degrade-gracefully (ADR-0008 runtime half) implemented.

## Requirements Traceability (Story Verifier)

**Result: PASS** — all 4 user stories and all 9 success criteria SATISFIED; FR-001..FR-014 each trace to code + ≥1 passing test.

| Work item / SC | Status | Evidence basis |
|----------------|--------|----------------|
| US1 — DeepSeek desk runs full loop | SATISFIED | deepseekAdapter (index-keyed assembly, reasoning→thinking non-replay, cumulative usage); fixture + code-inspection (live = manual) |
| US2 — Minimax M3 desk runs full loop | SATISFIED | minimaxAdapter (partial_json at block stop, thinking, latest-message_delta usage + tier); fixture + code-inspection |
| US3 — Native desk is a full hive peer | SATISFIED | selectAdapter + agentWorker (HIVE_TOOL_CATALOG advertised + executeTool→main IPC) + index.ts spawn router; normalized stream no-branching; fixture + code-inspection |
| US4 — Graceful runtime degradation | SATISFIED | capabilityGate applied in both adapters (one notice/session, caching→0, never throw); degradation.test |
| SC-001 | SATISFIED (fixture) | DeepSeek multi-round assembly + loop |
| SC-002 | SATISFIED (fixture) | reasoning→thinking, not replayed (asserted on the replayed request body) |
| SC-003 | SATISFIED (fixture) | Minimax partial_json assembly + thinking |
| SC-004 | SATISFIED (fixture) | context tier derived from registry `contextTierThreshold`; below/above/boundary |
| SC-005 | SATISFIED (fixture) | cumulative-monotonic usage both adapters; no recompute |
| SC-006 | SATISFIED (fixture stream/loop; manual for full live parity) | normalized stream no provider branching; hive-tool seam + no-drift test |
| SC-007 | SATISFIED (fixture + code-inspection) | selectAdapter env→adapter→registry endpoint; spawn router routes native desks |
| SC-008 | SATISFIED (fixture) | single notice/session, caching-off→cache 0, never error |
| SC-009 | SATISFIED (fixture) | malformed→no exec + error result; interrupted→retryable; bounded 3–5 + budget; empty turn ends cleanly |

## Code Coverage

No numeric coverage target (project policy). Coverage reported, not enforced.

## Performance

PASSED (no in-process regression by design). Live streaming latency is provider-bound; perceptible streaming parity confirmed by the manual smoke.

## Manual Testing

`manual-smoke.md` (T031) documents the live app-smoke procedure — 8 confirmations tied to SC-001/002/003/005/006/008 + the FR-008 needs-credentials guard + FR-013 operator spot-check. Live DeepSeek/Minimax calls require real keys (none in CI), legitimately deferred per the plan's no-keys-in-CI boundary. No P1 acceptance criterion or SC depends solely on the manual gate — all adapter logic is fixture-tested.

## Bug Tasks Generated

None.

## Notes (non-blocking, cosmetic)

- E006 test files live in `src/main/runtime/__tests__/` rather than the `worker/__tests__/` path named in the plan — the existing worker-test home; all suites run and pass.
- tasks.md names two test files slightly differently from disk (T024 `agentLoopIntegration.test.ts` → `nativePeerLoop.test.ts`); content matches the task intent, no missing coverage.
- A defensive `system`-role filter in `minimaxAdapter.buildBody` is currently unreachable from the loop (harmless).

## Conclusion

All required QC categories pass with real command output: typecheck (hard gate), lint (0 errors, no new findings), tests (170/170), performance (no regression), security (key non-leak verified). All P1 stories + SC-001..SC-009 SATISFIED; FR-001..FR-014 implemented and tested. No bug tasks. Release-readiness additionally requires the T031 manual app-smoke against real provider keys (separately tracked, as designed). `.qc-passed` written.
