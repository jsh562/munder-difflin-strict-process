# Analysis Report: E008 Native Agent Panel Rendering

**Date**: 2026-06-10 | **Feature**: `00008-native-agent-panel-rendering`
**Artifacts**: spec.md (FR-001..FR-045, SC-001..SC-025), plan.md, tasks.md (T001..T039, all `[ ]`)
**Verdict**: Implementation-ready. 0 CRITICAL, 0 HIGH. Findings are coverage-marker accuracy + spec consolidation cleanups.

## Findings Table

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|----|----------|----------|-------------|---------|----------------|
| F1 | Coverage / Completion point | MEDIUM | tasks.md FR-019 (T031,T032,T033) | FR-019 maps to 3+ tasks but no task carries `[COMPLETES FR-019]` | Add `[COMPLETES FR-019]` to T033 (last FR-019 task) |
| F2 | Coverage / Completion point | MEDIUM | tasks.md FR-021 (T022,T023,T024) | FR-021 maps to 3 tasks, no `[COMPLETES FR-021]` | Add `[COMPLETES FR-021]` to T024 |
| F3 | Coverage / Completion point | MEDIUM | tasks.md FR-022 (T011,T024,T025) | FR-022 maps to 3 tasks, no `[COMPLETES FR-022]` | Add `[COMPLETES FR-022]` to T025 |
| F4 | Coverage / Completion ordering | MEDIUM | tasks.md T015, T026 | `[COMPLETES FR-016]` is on T015, but T026 (higher ID) re-tags FR-016; FR-016's true end-to-end completion is the re-open verification (T026); FR-041's sole task (T015) carries no completion marker | Move `[COMPLETES FR-016]` → T026; mark T015 `[COMPLETES FR-041]` |
| F5 | Consistency / Coverage table | MEDIUM | tasks.md §Requirement Coverage, FR-016 row | Table omits T004 and T006, which both carry `{FR-016}` inline | Add T004, T006 to the FR-016 row |
| F6 | Consistency / Coverage table | MEDIUM | tasks.md §Requirement Coverage, FR-030 row | Table lists T014 for FR-030, but T014's tags are `{FR-016,FR-037,FR-039,FR-043}` (no FR-030) | Correct FR-030 row to T002, T026 |
| F7 | Ambiguity | MEDIUM | spec.md Edge Cases (responsive, coherent), US1 Independent Test (visually distinguished) | Narrative adjectives are quantified downstream but lack inline FR pointers, so a reader of just those lines sees untestable adjectives | Add parenthetical FR pointers (FR-028 / FR-013 / FR-017) at the narrative occurrences |
| F8 | Underspecification | LOW | spec.md Edge Cases ("Duplicate or repeated … notices must not flood") | The repeated-notice flood edge case has no governing FR (FR-019/FR-020 cover wording/persistence, not dedup); T033 already implements dedup | Extend FR-020 with a coalesce/collapse-repeats clause so the edge case has a governing requirement |
| F9 | Duplication | MEDIUM | spec.md FR-018/027/028/032/033/034 | Refinement-FR inflation — several FRs are self-described "render-cost statement / testable form of" a parent FR | NOT remediated — folding requires removing FR IDs (artifact-conventions preservation rule); layering is acceptable and each child adds a measurable threshold. Skipped by design. |
| F10 | Underspecification | LOW | spec.md FR-031 | "MUST NOT silently fail at scale" has no verification path | Optional: restate as accepted-tradeoff/assumption or add an at-scale SC. Skipped (requires user judgment on weakening a MUST). |
| F11 | Underspecification | LOW | spec.md FR-045 / `needs-input` | `needs-input` operator-response UX unspecified beyond "render as notice" | Optional: extend FR-021. Skipped (scope judgment). |
| F12 | Consistency | LOW | spec.md FR-029 "8 KB" | Hard-coded display threshold in a product spec | No action — plan.md FR-029 row uses the same 8 KB; sources consistent. |

## Quality Summaries

- **Spec Quality** (Spec Validator): **PASS-WITH-ISSUES, 86/100**. Mandatory sections complete; requirements overwhelmingly testable; SC↔FR↔US traceability fully closed (all 25 SCs map to ≥1 FR; all 3 stories covered); no `[NEEDS CLARIFICATION]`; no HIGH findings. Suspected conflicts (no-eviction vs bounded; research §4 "cap scrollback"; read-only remnants) **adjudicated as non-conflicts** — deliberately reconciled in-text (render-cost bounding via virtualization ≠ entry retention; research §4 superseded in §Risks). Dominant issue: refinement-FR duplication (F9).
- **Compliance** (Policy Auditor): **PASS** — no violations, no CRITICAL findings. Principles I–V + Governance + ADR-0001/0002/0007/0010 all satisfied (renderer folds the normalized stream; cost passthrough only; Claude PTY untouched; locked shapes; secret-free persistence verified against source — credentials ride spawn `env`, not the event bus; single-writer JSONL in main). Coverage Map traces all FR-001..FR-045. No standalone ADR warranted.

## Coverage Summary

- **Requirements**: 45 FR (FR-001..FR-045). 44 have ≥1 task. **FR-031** has zero tasks — intentional accepted memory/storage tradeoff (bounded by T018/T036 virtualization + T001/T002 append), documented in tasks.md §Requirement Coverage. Not a gap.
- **Tasks**: 39 (T001..T039), all `[ ]` pending; no `[BUG]`/`[DEFERRED]` tags. No gold-plating (every US-phase task carries an FR; T038/T039 are Polish gates).
- **Cross-task interfaces**: all 6 `← T###:Symbol` imports resolve to a matching `→ exports:`. 0 mismatches.
- **Completion points** (FRs with 3+ tasks): FR-001 ✓, FR-005 ✓, FR-007 ✓, FR-015 ✓, FR-039 ✓ already marked; **FR-019, FR-021, FR-022 missing** (F1–F3); **FR-016 mis-ordered** (F4).

## Metrics

- Total Requirements: 45 FR + 25 SC | Total Tasks: 39
- Requirement→Task coverage: 44/45 with tasks (FR-031 intentional tradeoff) = effectively 100%
- CRITICAL: 0 | HIGH: 0 | MEDIUM: 8 (6 remediated, 2 skipped-by-rule/judgment) | LOW: 4 (1 remediated, 3 skipped/no-action)
- Spec Quality: 86/100 (PASS-WITH-ISSUES) | Compliance: PASS

## Remediation (applied — "apply all")

Applied: F1, F2, F3, F4, F5, F6, F7, F8 (additive markers / table corrections / clarifying pointers / one FR clause). See remediation summary in the run output.
Skipped: F9 (would remove FR IDs — preservation rule), F10/F11 (require user judgment), F12 (already consistent).
