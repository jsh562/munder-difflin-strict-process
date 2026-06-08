# Analysis Report — E001 Provider Runtime and Event Bus

> Feature: `specs/00001-provider-runtime-and-event-bus/` | Date: 2026-06-07 | Artifacts: spec.md, plan.md, tasks.md (+ contracts/, research.md)

## Findings Table

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|----|----------|----------|-------------|---------|----------------|
| A1 | Duplication | MEDIUM | TR-002, TR-003, Technical Constraints | Cumulative/monotonic token-usage property stated in 3+ places | TR-003 is normative; TR-002 references it |
| A2 | Duplication | MEDIUM | TR-002, TR-006 | "versioned" duplicated across both | TR-006 owns versioning; drop "versioned" from TR-002 lead |
| A3 | Duplication | MEDIUM | TR-005, TR-008 | Behavior-preservation overlaps; TR-008 is a subset | Note TR-008 as the hive-autonomy specialization of TR-005 |
| A4 | Duplication | LOW | Technical Constraints (4 bullets) | Restates TR-003/005/006/007 verbatim | Convert to references; keep only the unique /src+typecheck constraint |
| A5 | Underspecification | MEDIUM | TR-001, Scope, SC-001 | capability-descriptor accessor carries no verifiable behavior in E001 (data is E002) | Specify accessor returns empty/placeholder descriptor; SC-001 asserts the agreed empty shape |
| A6 | Ambiguity | LOW | TR-005, SC-003 | "pre-refactor baseline" not pinned to an artifact | Define baseline as recorded golden fixtures |
| A7 | Underspecification | LOW | TR-002 | needs-input/notification lacks required fields | Specify `message` field |
| A8 | Underspecification | LOW | SC-006 | "100% of end-of-turn cases observed" denominator unbounded | Tie to the OBJ3 validation scenario |
| A9 | Forward-compat | LOW | TR-002 (api-error) | `retryable` carried but unacted in E001 | Note E001 emits only; acting is E009 |
| A10 | Consistency | LOW | plan.md Instructions Check (Principle II) | Plan labels "PASS" while spec labels "PASS (scoped)" | Align plan label to "PASS (scoped)" |

No CRITICAL or HIGH findings.

## Quality Summaries

- **Spec Quality** (Spec Validator): PASS — score ~84/100. Marker-free, structurally complete, every requirement has validation/SC coverage. Dominant weakness: duplication between the Technical Constraints block and TR-002/003/005/006. No HIGH/CRITICAL.
- **Compliance** (Policy Auditor): PASS — no MUST/SHOULD violations on plan.md. Every deferral (worker isolation→E003, retry→E009, cost recompute→E005) is backed by spec Excluded scope + an accepted ADR. One cosmetic label inconsistency (A10).

## Coverage Summary

| Requirement | Has Task? | Task IDs | Notes |
|-------------|-----------|----------|-------|
| TR-001 | Yes | T005, T006, T008 | port definition + conformance |
| TR-002 | Yes | T004, T009, T011 | contract + event kinds |
| TR-003 | Yes | T010, T016 | cumulative-monotonic usage |
| TR-004 | Yes | T013–T019, T021 | Claude adapter wrap |
| TR-005 | Yes | T020, T023, T024 | parity translator + parity test |
| TR-006 | Yes | T012 | additive-version test |
| TR-007 | Yes | T007 | boundary guard test |
| TR-008 | Yes | T017, T019, T022 | stop→drain autonomy |

Success Criteria: SC-001→T008, SC-002→T011(+T016), SC-003→T023, SC-004→T012, SC-005→T007, SC-006→T022 — all covered.

## Instructions Alignment Issues

None (Policy Auditor PASS). A10 is a cosmetic label inconsistency, not a compliance gap.

## Unmapped Tasks

T024 (typecheck+test green gate) and T025 (doc comments) — Polish phase, intentionally unmapped (repo-level gate / documentation), not gold-plating. T004/T005 Foundational (no requirement tag expected).

## Metrics

- Total Requirements: 8 TR + 6 SC = 14
- Total Tasks: 25
- Requirement→Task Coverage: 100% (8/8 TR; 6/6 SC)
- Critical Issues: 0 · High: 0 · Medium: 4 · Low: 6
