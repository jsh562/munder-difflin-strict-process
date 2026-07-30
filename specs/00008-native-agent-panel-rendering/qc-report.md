# QC Report: E008 Native Agent Panel Rendering

**Feature**: E008 | **Branch**: `00008-native-agent-panel-rendering` | **Date**: 2026-06-12
**Verdict**: PASSED
**Required categories** (.github/sddp-config.md): linting (PASS), performance (PASS)

## Category Verdicts

| Category | Verdict | Notes |
|----------|---------|-------|
| Build/Compile (typecheck node+web) | PASSED | `npm run typecheck` → both projects 0 errors (hard gate, Principle V) |
| Static Analysis / Linting (REQUIRED) | PASSED | `npm run lint` → 0 errors, 9 warnings; all 9 pre-existing/allowlisted; **0 introduced by any E008 file** (the one E008-touched file with a warning, index.ts:686, is pre-existing code outside E008's diff) |
| Tests | PASSED | `npm run test:run` → 29 files, **271 tests** passed; E008 suites: foldEvents (37), nativeEventBridge (14, incl. durable re-open + deep secret-free), transcriptWindow (11), truncationParity (6); no cold-start flake |
| Security (FR-041 / ADR-0007 secret-free) | PASSED | Named deep assertion `nativeEventBridge.test.ts › "persisted JSONL and forwarded IPC are secret-free (deep)"` passes: recurses payloads at any depth; no key/header injected; clean-stream "never invents a secret" case. Credentials ride spawn env, not the AgentEvent bus |
| Performance (REQUIRED) | PASSED | Virtualization mounts only viewport+overscan (O(visible)) — `transcriptWindow.test.ts` asserts a bounded mounted-node count across 100→1k→10k→50k entries; rAF coalescing ≤1 render/frame; no NFR latency tool required |

## Test Results

Runner: Vitest 1.6.1 (forks). 29 files, **271/271 passed**, 0 failures. E008-owned suites (70 tests): `foldEvents.test.ts` (37 — coalescing, strict toolCallId pairing + orphan drop, interrupted resolution, cumulative-monotonic SET-not-SUM with usd:null preserved, empty/no-op/thinking-only turns, truncation, notice dedup, replay determinism), `nativeEventBridge.test.ts` (14 — persist-before-forward ordering, replay==live, N-reopen idempotent no-mutate, graceful missing/corrupt/truncated, durable re-open T026, deep secret-free T015), `transcriptWindow.test.ts` (11 — O(visible) windowing math), `truncationParity.test.ts` (6 — 8KB display-only truncation parity, full payload recoverable on replay).

## Static Analysis

ESLint `eslint src`: 0 errors, 9 warnings — all in pre-existing allowlisted files (breaker.ts, hooks.ts, index.ts:686, reflect.ts, FileTree.tsx, useHive.ts ×2, OfficeFloor.tsx). Zero new findings in any E008 file (NativeTranscriptView.tsx, StructuredRunTab.tsx, foldEvents.ts, transcriptWindow.ts, useNativeAgentEvents.ts, nativeEventBridge.ts, and the modified hive.ts/nativeRuntime.ts/index.ts/preload/index.ts/AgentDetailPanel.tsx/SidebarTabs.tsx/MessageQueueComposer.tsx/store.ts).

## Security Audit

- **FR-041 / SC-025 (secret-free persistence + IPC, deep)**: HOLDS. The bridge persists/forwards each AgentEvent verbatim — it injects no key/header at any nesting depth; the named deep-scan test verifies absence across nested toolInput/text/thinking/notice-message fields in both the JSONL and the forwarded payload, plus a clean-stream case. Credentials ride spawn `env` (nativeRuntime), never the AgentEvent bus.
- **ADR-0007**: HOLDS. No rendering/persistence surface exposes secrets.
- **FR-014 (shape stability)**: HOLDS. `src/shared/agentEvent.ts` and `src/main/usage.ts` (AgentUsageSample/ToolSpan) byte-unchanged; view-models derive, never write back.

## PI Compliance

No violations. Principle I (provider-agnostic parity — renderer folds the normalized AgentEvent stream; native/Claude split gated on event source via `deriveProviderId`, not vendor strings; no provider-specific downstream branching), II (truthful cost — token usage display passthrough, never recomputed in the renderer; usd:null shown unpriced, never $0), III (crash-contained/single-committer — the per-agent JSONL log is single-writer in main, append-and-commit; renderer/worker never write it), V (preserve core & type safety — Claude PTY/xterm path byte-for-byte unchanged; locked AgentEvent/AgentUsageSample/ToolSpan shapes; typecheck node+web hard gate; all source under /src; observable-by-default) all upheld. Secrets never to persistence/telemetry (ADR-0007) verified.

## Requirements Traceability (Story Verifier)

**Result: PASS** — all 3 user stories and all 25 success criteria SATISFIED; FR-001..FR-045 each trace to code + a test (FR-031 is an intentional accepted memory/storage tradeoff, no task).

| Work item / SC | Status | Evidence basis |
|----------------|--------|----------------|
| US1 — synthesized transcript + operator input + durable re-open | SATISFIED | NativeTranscriptView + foldEvents + useNativeAgentEvents; AgentDetailPanel native path; native:send→runtime.send; nativeEventBridge replay |
| US2 — structured tab (native + Claude) | SATISFIED (note) | StructuredRunTab reuses the panel's single fold (native); Claude via Option B (existing telemetry ToolSpan/usage) to keep PTY path untouched |
| US3 — inline degradation/api-error notices | SATISFIED | Fold notice entries + dedup; NoticeRow in both views; retryable vs terminal; no abort |
| SC-001..SC-025 | ALL PASSED | Per Story Verifier: each maps to code + a passing test (transcript/stream/tool/thinking/notices/virtualization/truncation/input/durable-re-open/monotonic/secret-free/a11y) |

## Traceability Gaps

None. Every FR-001..FR-045 traces to code; FR-031 documented as an accepted tradeoff. FR-005 Claude structured tab is SATISFIED-with-note: sourced from existing telemetry (Option B / AD-005) — coarser turns + no tool-input for Claude (telemetry structurally lacks them), a deliberate choice to keep the Claude PTY path untouched (FR-009, the higher-priority invariant). Native tab is full-fidelity from the fold.

## Code Coverage

No numeric coverage target (project policy). Coverage reported, not enforced.

## Checklist Fulfillment

`checklists/` (UX, Performance, Data Integrity) — all three complete (.checklists all `[X]`; 120 items satisfied during the checklist phase). Their intents are implemented + tested: transcript clarity/streaming/notices (UX), virtualization/coalescing/no-eviction (Performance), persistence/replay-fidelity/monotonic/secret-free (Data Integrity). No gaps.

## Performance

PASSED. Virtualization mounts O(visible) entries (bounded mounted-node count verified across 100→50k via `transcriptWindow.test.ts`); rAF coalescing keeps updates ≤1/frame; full run retained with no eviction (memory growth is the deliberate, documented tradeoff). No in-process hot path beyond the per-frame fold.

## Accessibility

PASSED (code-level). FR-025/SC-014: collapsible thinking is a real focusable `<button aria-expanded>`; the structured-tab toggle is a roving-tabindex WAI-ARIA tablist (arrow/Home/End + Enter/Space); notices carry `role="alert"` (terminal api-error) / `role="status"` (degradation/retryable/needs-input) so assistive tech announces them. Live screen-reader confirmation is part of the manual smoke.

## Browser Runtime Validation

SKIPPED — no Electron-GUI browser tool available in this environment. All rendering/fold/persistence logic is unit-tested (271 tests, incl. the pure windowing math and replay determinism). The live visual behavior is the documented MANUAL gate.

## Manual Testing

`manual-smoke.md` (T039) records the live app-smoke procedure — 10 confirmations tied to SC-001/002/003/004/005/006/007/008/009/014 + the FR-022 not-delivered guard and FR-009 no-regression. Explicitly MANUAL, NOT a CI gate (requires a running Electron app with real native keys). No P1 acceptance criterion or SC depends solely on this manual gate — all rendering logic is unit-tested. Does not block QC PASS (mirrors the E006/E007 manual-gate precedent).

## Tool Recommendations

None. ESLint + Vitest + typecheck configured and run as the gates.

## Bug Tasks Generated

None.

## Conclusion

All required QC categories pass with real command output: typecheck (hard gate) 0/0, lint 0 errors with no E008 findings, tests 271/271 (incl. 70 E008-owned), performance bounded-mounting verified, security FR-041 deep secret-free verified. All 3 user stories + SC-001..SC-025 SATISFIED; FR-001..FR-045 implemented and tested; Claude PTY path + locked shapes byte-for-byte unchanged. No bug tasks. The live app-smoke (T039) is separately tracked as an out-of-band manual gate, as designed. `.qc-passed` written.
