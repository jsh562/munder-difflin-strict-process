# UX: Native Agent Panel Rendering
**Created**: 2026-06-09 | **Feature**: [spec.md](../spec.md)

## Transcript Clarity & Visual Distinction

- [X] CHK001 Are requirements defined for how assistant text, tool calls/results, and thinking are each visually distinguished from one another in the transcript? [Completeness, Spec §FR-003] <!-- Evaluator: Covered by spec.md §FR-003 (distinct text/tool/thinking) -->
- [X] CHK002 Is the term "visually distinct" given concrete, observable criteria (e.g., label, glyph, indent, color) anywhere in the spec, or is it left to interpretation? [Ambiguity, Spec §FR-003/FR-007] <!-- Evaluator: Resolved — added FR-017 (label/glyph/indent per category) to spec.md -->
- [X] CHK003 Are requirements defined for how thinking is presented as a "labeled/collapsible block" — including its default collapsed/expanded state? [Completeness, Spec §FR-003] <!-- Evaluator: Resolved — FR-017 sets thinking default collapsed/expandable; SC-010 -->
- [X] CHK004 Is the requirement that thinking is "not merged into the answer text" stated consistently between FR-003, US1, and research §1? [Consistency, Spec §FR-003, US1] <!-- Evaluator: Covered by FR-003 + US1 AS1 (thinking blocks distinct) + research §1 -->
- [X] CHK005 Are requirements defined for rendering a provider that emits no thinking events, so the transcript stays coherent without a thinking affordance? [Coverage, Spec §Edge Cases, FR-013] <!-- Evaluator: Covered by spec.md §Edge Cases (no-thinking provider) + FR-013 -->
- [X] CHK006 Are requirements defined for how a tool call with very large input or output is truncated, including how truncation is indicated to the operator? [Completeness, Spec §Edge Cases] <!-- Evaluator: Covered by spec.md §Edge Cases (truncate with clear indication) + data-model truncated-for-display -->
- [X] CHK007 Is "synthesized" framing required to be operator-visible so the approximation is not mistaken for authentic PTY bytes, and is that labeling requirement testable? [Coverage, Spec §Risks, FR-014] <!-- Evaluator: Resolved — added SC-011 (operator-visible synthesized vs PTY framing, testable) to spec.md -->


## Streaming Feedback & In-Progress / Pending States

- [X] CHK008 Are requirements defined for an in-progress indicator on streamed text, including when it appears (before first token) and when it clears? [Completeness, Spec §FR-002, US1 AS2] <!-- Evaluator: Resolved — added FR-018 (indicator before first token, clears on turn settle) to spec.md -->
- [X] CHK009 Is the meaning of "without flicker or full reflow" expressed in observable/measurable terms rather than as a subjective quality? [Measurability, Spec §FR-002, SC-002] <!-- Evaluator: Resolved — FR-018 defines no re-mount/re-layout of prior entries, no whole-list flash per delta -->
- [X] CHK010 Are requirements defined for the pending→resolved transition of a tool entry, including that it resolves "in place" and signals success/failure and duration? [Completeness, Spec §FR-004, US1 AS3] <!-- Evaluator: Covered by spec.md §FR-004 + US1 AS3 -->
- [X] CHK011 Are the distinct tool-call states (pending, resolved-success, resolved-failure, interrupted) enumerated consistently across FR-004, FR-011, and the data-model status field? [Consistency, Spec §FR-004/FR-011] <!-- Evaluator: Covered by FR-004/FR-011 + data-model status enum (pending|resolved|interrupted) + state machine -->
- [X] CHK012 Are requirements defined for resolving a pending tool call or unfinished turn that never completes to a terminal "interrupted/unresolved" state, and is that state visually defined? [Completeness, Spec §FR-011, Edge Cases] <!-- Evaluator: Covered by FR-011 + Edge Cases + data-model C6/state machine -->
- [X] CHK013 Is it specified how out-of-order or interleaved events (e.g., final token-usage after streamed text) must render without corrupting transcript ordering, from an operator-visible standpoint? [Coverage, Spec §Edge Cases] <!-- Evaluator: Covered by spec.md §Edge Cases + data-model C4 (ts-ordered, no corruption) -->
- [X] CHK014 Are requirements defined for rendering empty, no-op, and thinking-only turns without a broken or empty entry, with observable acceptance criteria? [Completeness, Spec §FR-013, Edge Cases] <!-- Evaluator: Covered by FR-013 + Edge Cases + testing strategy (empty/thinking-only fold) -->


## Notices, Degradation & Errors

- [X] CHK015 Are requirements defined for what information a capability-degradation notice must convey (what degraded, and optionally what still works)? [Completeness, Spec §FR-007] <!-- Evaluator: Resolved — FR-019 adds "what degraded" (MUST) + "what still works" (SHOULD when available) -->
- [X] CHK016 Are requirements defined for distinguishing retryable from terminal api-errors, including behavior when that information is unavailable? [Clarity, Spec §FR-008] <!-- Evaluator: Covered by FR-008 ("where that information is available") + data-model api-error payload -->
- [X] CHK017 Is there a requirement that the transcript continues rather than aborts on an api-error or degradation, and is "continues" stated unambiguously? [Clarity, Spec §FR-008, SC-006] <!-- Evaluator: Covered by FR-008 ("without aborting") + SC-006 ("continues rather than aborting") -->
- [X] CHK018 Are requirements defined for de-duplicating or collapsing repeated/duplicate api-error and degradation notices so they do not flood the transcript? [Completeness, Spec §Edge Cases, Plan Error Handling] <!-- Evaluator: Covered by spec.md §Edge Cases (must not flood/derail) + plan.md Error Handling (inline-notice dedup, collapse repeats) -->
- [X] CHK019 Is notice verbosity/wording guidance (plain, specific, non-modal) captured as a requirement rather than only as research guidance? [Coverage, Spec §US3, Research §5] <!-- Evaluator: Resolved — FR-019 makes plain/specific/non-modal/not-styled-as-assistant a requirement -->
- [X] CHK020 Are requirements defined for whether notices are dismissible or persistent, and is that consistent between transcript and structured tab? [Completeness, Spec §FR-007/FR-008] <!-- Evaluator: Resolved — FR-020 (persistent inline, MAY dismiss, consistent across both views) -->
- [X] CHK021 Is it specified how a notice with no following content (degradation/error then stream ends) renders without a broken or dangling entry? [Coverage, Spec §Edge Cases, Research §5] <!-- Evaluator: Resolved — FR-019 requires a complete entry with no dangling follow-on when a notice is the last entry -->
- [X] CHK022 Are requirements defined for surfacing the same notice inline in BOTH the transcript and the structured tab consistently? [Consistency, Spec §FR-007, US3 AS1] <!-- Evaluator: Covered by FR-007 (both views) + US3 AS1 -->


## Operator Input / Steer Affordance Parity

- [X] CHK023 Are requirements defined for the operator input/steer affordance on a native panel achieving parity with the Claude terminal, and is "parity" defined observably? [Clarity, Spec §FR-015, SC-008] <!-- Evaluator: Resolved — FR-021 defines observable parity (always-available submit, send acknowledgement, same transcript) -->
- [X] CHK024 Is it specified how operator input behaves when sent mid-turn vs idle, such that the in-progress transcript is not corrupted? [Coverage, Spec §Edge Cases, FR-015] <!-- Evaluator: Covered by spec.md §Edge Cases (mid-turn vs idle accepted/routed without corrupting in-progress transcript) -->
- [X] CHK025 Are requirements defined for how the agent's resulting activity from operator input is reflected back in the same transcript? [Completeness, Spec §FR-015, US1 AS5] <!-- Evaluator: Covered by FR-015 + US1 AS5 (resulting activity continues in same transcript) -->
- [X] CHK026 Are requirements defined for operator-visible feedback when input cannot be routed (e.g., missing native worker), distinct from a normal send? [Coverage, Spec §Plan Error Handling, FR-015] <!-- Evaluator: Resolved — FR-022 + SC-013 (distinct not-delivered feedback) -->
- [X] CHK027 Is the distinction between "input" (prompt) and "steer" command stated clearly enough to render/route each unambiguously? [Ambiguity, Spec §FR-015] <!-- Evaluator: Resolved — FR-021 routes prompt via ProviderRuntime.send vs steer via control:* unambiguously -->


## Structured Tab Toggle, Visibility & Parity

- [X] CHK028 Are requirements defined for how the structured tab is surfaced/toggled and that each desk's default view stays unchanged? [Completeness, Spec §FR-005/FR-006, US2] <!-- Evaluator: Covered by FR-005/FR-006 + US2 (opt-in tab, default view unchanged) -->
- [X] CHK029 Is it required that toggling between transcript and structured tab preserves run content AND scroll position, with that behavior specified for both in-progress and completed runs? [Completeness, Spec §FR-006, SC-005, US2 AS3] <!-- Evaluator: Covered by FR-006 + SC-005 + US2 AS3 (in-progress) + US2 AS4 (completed) -->
- [X] CHK030 Are requirements defined for the structured tab's per-turn and per-run token-usage display as passthrough (not recomputed), and is "display only" stated unambiguously? [Clarity, Spec §FR-005/FR-012, US2 AS2] <!-- Evaluator: Covered by FR-005/FR-012 + US2 AS2 ("display only, not recomputed") + data-model C8 -->
- [X] CHK031 Is the structured tab's availability for BOTH native and Claude desks stated consistently across FR-005, US2, and the Clarifications? [Consistency, Spec §FR-005, Clarifications] <!-- Evaluator: Covered by FR-005 + US2 + Clarifications (both native and Claude) -->
- [X] CHK032 Are requirements defined for what the structured tab shows for an in-progress run whose final token counts lag the streamed content? [Coverage, Spec §Edge Cases, Research §3] <!-- Evaluator: Covered by US2 AS3 (in-progress state stays consistent) + Edge Cases (final token-usage after text) + data-model latest-cumulative-sample -->
- [X] CHK033 Are requirements defined for truncating very large tool input/output within the structured tab (vs forcing megabyte payloads inline)? [Coverage, Spec §Edge Cases, Research §3] <!-- Evaluator: Covered by spec.md §Edge Cases (truncate large in/out) + data-model (truncated for display) -->


## Visual Parity, Framing & Claude Preservation

- [X] CHK034 Are requirements defined for native panels using the "same terminal-style framing" as Claude panels, with framing criteria specific enough to verify uniformity? [Measurability, Spec §FR-014, SC-001] <!-- Evaluator: Resolved — FR-023 + SC-012 enumerate verifiable framing attributes (container/chrome, monospace typography, panel/tab placement) -->
- [X] CHK035 Is the requirement that the Claude PTY default view is unchanged (no visual/behavioral regression) stated consistently across FR-009, SC-003, and the Risks section? [Consistency, Spec §FR-009, SC-003] <!-- Evaluator: Covered consistently by FR-009 + SC-003 + Risks (Two rendering paths regress Claude) -->
- [X] CHK036 Is the boundary between "synthesized approximation" and "authentic PTY bytes" defined clearly enough that operators are not misled about which they are viewing? [Ambiguity, Spec §Excluded, Risks] <!-- Evaluator: Covered by Excluded + Risks + Glossary (synthesized vs PTY), reinforced by new SC-011 operator-visible framing -->


## Persistence, Re-open & Cross-cutting UX Gaps

- [X] CHK037 Are requirements defined for the operator-facing behavior of re-opening a native run's transcript and structured view after close/reopen and after app restart? [Completeness, Spec §FR-016, SC-009] <!-- Evaluator: Covered by FR-016 + SC-009 (re-openable after close/reopen and app restart) -->
- [X] CHK038 Is it specified how a missing or partial persisted stream renders (what is available, without erroring) from an operator-visible standpoint? [Coverage, Spec §FR-016, Edge Cases] <!-- Evaluator: Covered by FR-016 + Edge Cases + data-model C5 (render what parsed, no error) -->
- [X] CHK039 Is scroll behavior — including "stick to bottom" during streaming/virtualization vs preserving operator scroll position — defined as a requirement, or is the spec silent on this interaction? [Completeness, Spec §FR-006/FR-010, Research §4] <!-- Evaluator: Resolved — added FR-024 (stick-to-bottom only when at bottom; preserve scroll otherwise) -->
- [X] CHK040 Are accessibility requirements for the synthesized transcript (e.g., screen-reader semantics, keyboard focus on collapsible thinking and tabs) defined, or is the spec silent on transcript accessibility? [Coverage, Spec §US1/FR-003] <!-- Evaluator: Resolved — added FR-025 + SC-014 (keyboard-focusable thinking/tabs; notices exposed to AT) -->

