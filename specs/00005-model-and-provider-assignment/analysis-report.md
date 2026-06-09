# Analysis Report: E005 Model and Provider Assignment

**Date**: 2026-06-08 | **Mode**: Analysis → Remediation ("apply all")
**Artifacts**: spec.md, plan.md, tasks.md, data-model.md (+ 3 checklists, all PASS)

## Verdict

No CRITICAL or HIGH findings. Spec Validator PASS (~9.3/10); Policy Auditor PASS (no principle violations). Coverage is 100% FR→task. Findings are MEDIUM coverage-hygiene (missing `[COMPLETES]` markers; two amendment-added requirements lacking explicit verification) and LOW wording/consistency.

## Findings Table

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|----|----------|----------|-------------|---------|----------------|
| A-01 | Coverage (spec) | MEDIUM | spec FR-013; Success Criteria | FR-013 (GOD programmatic assignment) has no Success Criterion — unverifiable via the SC set | Add SC-009 [US3] asserting GOD can assign provider+model via the same mechanism, persisted, same warning behavior |
| A-02 | Coverage (spec) | MEDIUM | spec FR-014; US2 scenarios | FR-014 (fleet-default scope disclosure) mandates a UI statement but no acceptance scenario/SC verifies it | Add a US2 acceptance scenario verifying the surface states its non-retroactive scope |
| A-03 | Completion point (tasks) | MEDIUM | tasks FR-004 → T005,T021,T022 | FR-004 maps to 3 tasks; last task T022 lacks `[COMPLETES FR-004]` | Add `[COMPLETES FR-004]` to T022 |
| A-04 | Completion point (tasks) | MEDIUM | tasks FR-005 → T013,T014,T015 | FR-005 maps to 3 tasks; last task T015 lacks `[COMPLETES FR-005]` | Add `[COMPLETES FR-005]` to T015 |
| A-05 | Completion point (tasks) | MEDIUM | tasks FR-009 → T003,T024,T026 | FR-009 maps to 3 tasks; last task T026 lacks `[COMPLETES FR-009]` | Add `[COMPLETES FR-009]` to T026 |
| A-06 | Consistency (tasks) | LOW | tasks T006 / T012 | Redundant `[COMPLETES FR-008]` on T006 (intended completion point is T012, the later FR-008-tagged task) | Remove `[COMPLETES FR-008]` from T006; keep on T012 |
| A-07 | Consistency (spec) | LOW | spec FR-011, Edge Case L49 (vs SC-008 "stale") | "stale/unavailable" slashed pair vs SC-008's "stale" — terminology drift | Standardize to "stale" in FR-011 + the edge case |
| A-08 | Clarity (spec) | LOW | spec SC-001 | "uses exactly that model" risks a runtime reading; execution is excluded from this epic | Reword to "is created with (bound to) exactly that model" |
| A-09 | Clarity (spec) | LOW | spec FR-002 vs FR-008 | Soft overlap on creation-time binding could yield overlapping tasks | Tighten FR-002 to selection+recording; let FR-008 own the binding/precedence |
| A-10 | Redundancy (spec) | LOW | spec Edge Case L53 vs Risk | Same E004-concurrent-edit wording appears as both edge case and risk | No action — both placements are legitimate (boundary vs likelihood/impact) |

## Quality Summaries

- **Spec Quality**: PASS, ~9.3/10. No duplicates, no `[NEEDS CLARIFICATION]`, all P1 stories have ≥1 SC. The two checklist-driven amendments (FR-014, combined uncredentialed+gapped edge case) are well-formed; gaps are verification/coverage, not contradictions. Capability flags match `src/shared/providerRuntime.ts`.
- **Compliance**: PASS. Principles I–V upheld; ENFORCE_SRC_ROOT clean; secrets read presence-only; within ADR-0008; AD-001..006 correctly reference global ADR-0001/0005/0007/0008 (no new ADR warranted). FR-014 Coverage Map row + Testing Strategy persistence-homing note introduced no violation.

## Coverage Summary

| Requirement | Has Task? | Task IDs | Notes |
|-------------|-----------|----------|-------|
| FR-001 | ✅ | T008 | |
| FR-002 | ✅ | T007, T010 | |
| FR-003 | ✅ | T020 | |
| FR-004 | ✅ | T005, T021, T022 | completion marker missing (A-03) |
| FR-005 | ✅ | T013, T014, T015 | completion marker missing (A-04) |
| FR-006 | ✅ | T017, T018 | COMPLETES on T018 |
| FR-007 | ✅ | T018, T019 | COMPLETES on T019 |
| FR-008 | ✅ | T001, T002, T012 | COMPLETES on T012 (+ redundant on T006, A-06) |
| FR-009 | ✅ | T003, T024, T026 | completion marker missing (A-05) |
| FR-010 | ✅ | T025, T026 | |
| FR-011 | ✅ | T004, T027 | COMPLETES on T027 |
| FR-012 | ✅ | T009, T011 | |
| FR-013 | ✅ | T023 | COMPLETES on T023; no SC (A-01) |
| FR-014 | ✅ | T016 | no acceptance scenario (A-02) |

Cross-phase dependency edges (`← T###:Symbol` ↔ `→ exports:`): all matched, no interface-contract mismatch. Phasing and file paths consistent with plan Project Structure. No unmapped/gold-plating tasks (T006 Foundational, T028 Gates).

## Metrics

- Total requirements: 14 FR · Total success criteria: 8 (→9 after A-01) · Total tasks: 28
- FR→task coverage: 100% (14/14)
- CRITICAL: 0 · HIGH: 0 · MEDIUM: 5 · LOW: 5

## Remediation

Applied per "apply all" — see the remediation summary returned with this run. A-10 skipped (no action required).
