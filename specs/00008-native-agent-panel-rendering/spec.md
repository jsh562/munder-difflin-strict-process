---
feature_branch: "00008-native-agent-panel-rendering"
created: "2026-06-09"
input: "Per-agent panel rendering for native agents — synthesized terminal + structured tab."
spec_type: "product"
spec_maturity: "clarified"
epic_id: "E008"
epic_sources: "{PRD:CAP-015,CAP-018}{SAD:ADR-0010}"
---

# Feature Specification: Native Agent Panel Rendering

**Feature Branch**: `00008-native-agent-panel-rendering`  
**Created**: 2026-06-09  
**Status**: Draft  
**Spec Type**: product  
**Spec Maturity**: clarified  
**Epic ID**: E008  
**Epic Sources**: {PRD:CAP-015,CAP-018}{SAD:ADR-0010}  
**Product Document**: specs/prd.md

## Problem Statement *(mandatory)*

Native (DeepSeek/Minimax) desks now run full agentic loops and emit a normalized AgentEvent stream (E006/E003), but the per-agent panel only knows how to render Claude's raw PTY bytes — a native agent has no terminal byte stream, so its desk shows nothing coherent. The operator cannot watch a native agent work, inspect its tool calls, or see when a capability degraded, which breaks the floor's "every desk is a terminal" parity and leaves non-Claude desks effectively blind. Until the panel renders native activity from the event stream, native agents are unobservable and the multi-provider release cannot claim per-agent control-surface parity.

## Scope *(mandatory)*

### Included

- A synthesized terminal-style transcript in the per-agent panel for native agents, built from AgentEvents (text-delta, tool-start/end, thinking, turn boundaries), shown by default.
- Operator input from the native panel: the operator can type prompts and steer the native agent from the panel (wired to the existing input/steer seam), so a native desk is as interactive as a Claude terminal.
- An optional structured tab presenting the run as turns → tool calls (name, input, result, duration, status) → token usage, available for both native and Claude desks (built from the AgentEvent stream) without changing either desk's default view.
- Inline capability-degradation notices and api-error notices, surfaced in both views.
- Durable persistence of a native run so its transcript and structured view are re-openable after the panel is closed and reopened and after an app restart.
- Visual parity: a native desk's panel uses the same terminal-style framing as a Claude desk so the floor feels uniform.
- Preservation of the existing Claude default view: Claude desks continue to render authentic PTY bytes unchanged (the structured tab is an additive opt-in view).

### Excluded

- The AgentEvent contract and native event production (E001/E003) — consumed here, not built.
- Provider-accurate cost computation and the `AgentUsageSample`/`ToolSpan` data (E007) — the structured tab displays token-usage passthrough; it does not compute or recompute cost.
- The capability-degradation decision logic (E006 / ADR-0008) — this feature surfaces the notices it receives; it does not decide what degrades.
- Authentic ANSI/raw-byte rendering fidelity for native agents — the synthesized transcript is a rendered approximation, not raw terminal bytes (operator input/steering is supported, but the visual stays synthesized, not an interactive TUI).
- The office-floor avatar visualization and other downstream consumers — unchanged, out of scope.

### Edge Cases & Boundaries

- An interrupted or aborted stream leaves a pending tool call or unfinished turn that never completes → it must resolve to a terminal "interrupted/unresolved" state, not hang silently.
- A thinking-only turn (reasoning but no visible text) and a no-op/empty turn (no text, no tools) must render without a broken or empty entry.
- A tool call whose input or output is very large must be truncated with a clear indication, not rendered in full inline.
- A long-running run (hundreds–thousands of entries) and several concurrent native panels streaming at once must stay responsive (FR-028) — only visible entries render (virtualization) and the full run is retained (no eviction), so render cost stays bounded while memory grows with run length.
- Events may arrive interleaved or out of order (e.g., final token-usage after streamed text); rendering must not corrupt the transcript ordering.
- Switching between the transcript and the structured tab mid-run must preserve run content and the operator's scroll position.
- A provider that emits no thinking events must still render a coherent transcript (FR-013).
- Duplicate or repeated api-error / degradation notices must not flood or derail the transcript.
- A persisted native run is re-opened after an app restart — its transcript and structured view rebuild from the persisted stream; a missing or partial persisted stream renders what is available without erroring.
- The operator sends input or a steer to a native agent while it is mid-turn vs idle — the input is accepted and routed without corrupting the in-progress transcript.

## User Scenarios & Testing *(mandatory for product specs only)*

### User Story 1 - Watch a native agent work as a terminal transcript (Priority: P1)

The operator opens a DeepSeek- or Minimax-assigned desk's panel and watches a live, readable terminal-style transcript of the agent working — its streamed text, its tool calls and results, and its thinking — presented like a Claude desk so the floor stays uniform. The transcript is the default view, and the operator can also type prompts or steer the agent from the panel just as with a Claude terminal.

**Why this priority**: Core value proposition and the MVP of this epic — without it, native desks are blank and the "every desk is a terminal" parity promise fails.

**Independent Test**: Assign a desk to a native provider, run a multi-step tool-use task, open its panel, and confirm a coherent streaming transcript in which text, tool entries, and thinking are visually distinguished (FR-017).

**Acceptance Scenarios**:

1. **Given** a native desk performing a multi-step task, **When** the operator opens its panel, **Then** the default view is a synthesized terminal transcript that streams text deltas, tool-start/result entries, and thinking blocks as they arrive.
2. **Given** a streaming response, **When** text deltas arrive, **Then** they append incrementally with an in-progress indicator, without flicker or full reflow.
3. **Given** a tool invocation, **When** it starts and later ends, **Then** a pending entry resolves in place to its result, indicating success or failure and duration.
4. **Given** a Claude desk, **When** the operator views it, **Then** it still shows authentic PTY bytes with no regression.
5. **Given** a running native desk's panel, **When** the operator types a prompt or steer and submits it, **Then** the input is routed to the agent via the input/steer seam and the agent's resulting activity continues in the same transcript.

### User Story 2 - Inspect a run in a structured tab (Priority: P2)

The operator switches a desk's panel to an optional structured tab to inspect the run as turns → tool calls (name, input, result, duration, status) plus token usage, to verify or debug exactly what the agent did. The tab is available for both native and Claude desks (built from the same AgentEvent stream); each desk's default view is unchanged (synthesized transcript for native, PTY bytes for Claude).

**Why this priority**: A richer, truthful view of the SDK loop (ADR-0010) that significantly aids verification and debugging, but the MVP "watch it work" view is viable without it — ADR-0010 frames the structured tab as optional.

**Independent Test**: After a completed run on a native and a Claude desk, open the structured tab on each and confirm every turn's tool calls and the run's token usage are readable.

**Acceptance Scenarios**:

1. **Given** a completed native or Claude run, **When** the operator opens the structured tab, **Then** each turn lists its tool calls with name, input, result/output, duration, and success/failure status.
2. **Given** the structured tab, **When** the operator reviews the run, **Then** token usage is shown per turn and per run (display only, not recomputed).
3. **Given** an in-progress run, **When** the operator toggles between the default view and the structured tab, **Then** run content and scroll position are preserved and the in-progress state stays consistent.
4. **Given** a Claude desk, **When** the operator opens its structured tab and returns, **Then** the default PTY view is unchanged — the tab is additive with no PTY regression.

### User Story 3 - See degradation and errors inline (Priority: P2)

While watching a native agent, the operator sees inline notices when a capability is unsupported/degraded or an api-error occurs, stated plainly and without derailing the transcript, so they understand why behavior differs without losing the flow of work.

**Why this priority**: Important for trustworthy parity (CAP-018), but the core transcript is viable without it; notices enhance rather than block the MVP.

**Independent Test**: Drive a native agent into a degraded capability and an api-error, and confirm each surfaces as a distinct inline notice while the transcript continues.

**Acceptance Scenarios**:

1. **Given** a native agent that hits an unsupported capability, **When** the degradation notice is emitted, **Then** an inline notice appears in both the transcript and structured tab, stating what degraded, visually distinct from assistant content.
2. **Given** an api-error event, **When** it arrives, **Then** it surfaces as an inline notice (retryable vs terminal where known) and the transcript is not aborted.

## Requirements *(mandatory)*

### Functional Requirements *(product specs only)*

- **FR-001**: System MUST render a native agent's activity in the per-agent panel as a synthesized terminal-style transcript built from its AgentEvents (turn-start/end, text-delta, thinking-start/delta, tool-start, tool-end), shown by default.
- **FR-002**: System MUST append streamed text deltas to the transcript incrementally as they arrive, with an in-progress indicator before completion, and without a full re-render or layout reflow on each delta.
- **FR-003**: System MUST visually distinguish assistant text, tool calls/results, and thinking in the transcript — thinking presented as a labeled/collapsible block, not merged into the answer text.
- **FR-004**: System MUST represent a tool invocation as a pending entry on tool-start that resolves in place on tool-end, indicating success/failure and duration.
- **FR-005**: System MUST provide an optional structured tab presenting the run as turns, per-tool-call detail (name, input, result/output, duration, status), and token usage per turn and per run, available for both native and Claude desks (derived from the AgentEvent stream) without changing either desk's default view.
- **FR-006**: System MUST let the operator toggle between the transcript (default) and the structured tab without losing run content or scroll position.
- **FR-007**: System MUST surface capability-degradation notices inline in both views, visually distinct from assistant content, stating what was degraded.
- **FR-008**: System MUST surface api-error events as inline notices without aborting the transcript, distinguishing retryable from terminal where that information is available.
- **FR-009**: System MUST preserve the existing Claude PTY rendering unchanged — Claude desks continue to display authentic terminal bytes with no regression.
- **FR-010**: System MUST keep long runs and multiple concurrent native panels responsive by rendering only the visible transcript entries (virtualization), retaining the full run without eviction so no content is dropped; render cost MUST stay bounded as entry count grows.
- **FR-011**: System MUST resolve an incomplete or interrupted stream (a pending tool call or unfinished turn that never completes) to a terminal state rather than leaving it pending indefinitely. The canonical terminal-state label is **`interrupted`** (the view-model `status = interrupted`, data-model §Entity Table / §C6); "interrupted/unresolved" elsewhere in this spec refers to the same single state — there are not two competing labels.
- **FR-012**: System MUST display token usage from the cumulative token-usage events as passthrough, without recomputing cost (cost authority remains the usage seam, E007).
- **FR-013**: System MUST render empty, no-op, and thinking-only turns coherently, without a broken or empty entry.
- **FR-014**: System MUST present native panels with the same terminal-style framing as Claude panels so the office floor reads as uniform.
- **FR-015**: System MUST let the operator submit input and steer commands to a native agent from its panel, routed through the existing input/steer seam (`ProviderRuntime.send` with operator/steer input), and reflect the resulting activity in the same transcript — so a native desk is as interactive as a Claude terminal.
- **FR-016**: System MUST durably persist a native run's **AgentEvent stream** (the persisted stream is the source of truth for replay; the rendered transcript is always re-derived from it, never the persisted substrate) so the transcript and structured view are re-openable after the panel is closed and reopened and after an app restart; a missing, partial, corrupt, or truncated persisted stream MUST render what is available without erroring (graceful degradation; see FR-042 for per-mode behavior), and persisted data MUST carry no secrets (ADR-0007), including inside payload fields (FR-041). Persistence is keyed by `agentId` and segmented by `sessionId` (FR-038); "durably persist" is defined per-event append-and-commit (FR-037); replay is deterministic and idempotent (FR-039); on-disk lifecycle is append-only/retained-for-run-life (FR-040).
- **FR-017**: The "visually distinct" treatment of assistant text, tool calls/results, thinking, and notices (FR-003/FR-007) MUST be expressed through at least one concrete, observable affordance per category — a category label and/or glyph plus a consistent indent/container — so each category is identifiable on inspection rather than left to interpretation. A thinking block MUST default to collapsed (operator-expandable), with its labeled affordance present even when collapsed.
- **FR-018**: The in-progress streaming indicator (FR-002) MUST appear before the first text token of a turn (so the operator sees activity prior to any visible text) and MUST clear when that turn settles (turn-end / stop). "Without flicker or full reflow" (FR-002, SC-002) means: appending a text delta MUST NOT re-mount or re-layout already-rendered prior entries, and the visible transcript MUST NOT clear-and-redraw between deltas (observable as no whole-list flash on each delta).
- **FR-019**: A capability-degradation notice (FR-007) MUST state what degraded and SHOULD state what still works when that information is available. Notices (degradation and api-error) MUST be rendered as inline, non-modal feed entries placed at the point of occurrence; notice wording MUST be plain and specific (name the capability/error), MUST NOT be styled like assistant content, and a notice that is the last entry before the stream ends MUST render as a complete entry with no dangling/empty follow-on.
- **FR-020**: Notices MUST be persistent inline feed entries (not auto-disappearing toasts) and MAY be operator-dismissible; whichever dismissibility behavior is chosen MUST be consistent across the transcript and the structured tab for the same notice. Repeated or duplicate notices (the same degradation/api-error recurring) MUST be coalesced/collapsed — e.g., a single entry carrying a repeat count — so repeated notices do not flood or derail the transcript (Edge Cases).
- **FR-021**: The operator input/steer affordance (FR-015) MUST achieve observable parity with a Claude terminal: a submit affordance is always available on a native panel, submitted input is acknowledged (queued/sent indication) the same way as a Claude send, and the agent's resulting activity appears in the same transcript. The system MUST distinguish a plain prompt ("input") from a steer command and route each through the correct seam (`ProviderRuntime.send` operator input vs the existing `control:*` steer/halt), so each is handled and rendered unambiguously.
- **FR-022**: When operator input cannot be routed (e.g., the native worker is missing), the system MUST give distinct operator-visible feedback (a non-blocking notice indicating the input was not delivered) rather than silently appearing to send — observably different from a successful send.
- **FR-023**: Native panels MUST match Claude panels on a verifiable set of framing attributes — shared terminal container/chrome, monospace transcript typography, and the same panel/tab placement within `AgentDetailPanel` — so a native and a Claude desk read as the same surface on inspection.
- **FR-024**: During streaming the transcript MUST "stick to bottom" (auto-follow newest content) only while the operator is already at the bottom; if the operator has scrolled up, their scroll position MUST be preserved (no forced auto-scroll), consistent with virtualization (FR-010) and with toggle-preservation (FR-006).
- **FR-025**: The synthesized transcript MUST expose baseline accessibility semantics: collapsible thinking blocks and the structured-tab toggle MUST be keyboard-focusable and operable, and inline notices MUST be conveyed to assistive technology (e.g., an appropriate role/announcement) rather than as visual-only styling.
- **FR-026**: High-frequency `text-delta` updates MUST be coalesced before commit to the DOM so the transcript commits at most one render per animation frame (~60 fps / ~16 ms window) regardless of incoming delta rate; bursts of deltas within one window MUST be appended as a single update rather than one render per delta. This bounds the "batched updates" requirement (FR-002) and is the mechanism by which "without flicker or full reflow" is met.
- **FR-027**: Virtualized render cost MUST stay O(visible entries) — the count of mounted transcript DOM nodes MUST be a function of the viewport (visible entries plus a small fixed overscan buffer) and MUST NOT grow with total entry count — for runs across the operating scale of hundreds–thousands of entries (plan §Scale/Scope). "Visible" for FR-010 includes the small overscan buffer; off-screen, non-overscan entries are out of scope of "visible" and are unmounted while their underlying events remain retained (no eviction).
- **FR-028**: The system MUST stay responsive with up to the supported desk count (5–15 concurrent native panels, plan §Scale/Scope) streaming simultaneously: the aggregate main-thread work across all streaming panels MUST not block operator input or scroll, achieved because each panel renders only its visible entries (FR-027) and coalesces deltas (FR-026). Responsiveness is required for the aggregate (all panels streaming), not only a single panel.
- **FR-029**: A tool-call `toolInput` or tool-end `result`/output whose serialized size exceeds a defined display threshold (default 8 KB) MUST be truncated for display in both the transcript and the structured tab with a clear, operator-visible truncation indication (FR-017 affordance style); truncation MUST affect DISPLAY ONLY — the full payload remains in the retained event stream and in the persisted JSONL (no payload-level eviction). A single huge tool output is bounded by this display threshold independently of the entry-count scale (FR-027).
- **FR-030**: Persistence append MUST be a per-event, single-writer, append-only write in main (no per-render-frame coupling); when event arrival outpaces disk throughput, appends MUST be queued/serialized in arrival order without dropping or reordering events and without blocking AgentEvent forwarding to the renderer (the renderer MUST NOT stall on disk I/O). Replay-on-reopen of a persisted run MUST read top-to-bottom and fold once (single O(events) pass), not re-fold per entry.
- **FR-031**: Retained in-memory growth (full run, no eviction) and on-disk storage growth (every run persisted, no pruning/rotation) are an explicit, accepted requirement-level tradeoff bounded only by the operating scale (hundreds–thousands of events per run; 5–15 desks). The system MUST NOT silently fail at this scale; growth beyond it is a documented revisit trigger (Risks), not a guaranteed-supported range.
- **FR-032**: An empty, no-op, or thinking-only turn (FR-013) MUST NOT produce a degenerate transcript entry that mounts and then re-lays-out (no churning empty node): a turn with no renderable content produces no transcript entry (or a single settled placeholder), and a thinking-only turn produces exactly its collapsed thinking block — so a no-op turn carries no render cost beyond a coherent, already-settled entry. This is the render-cost statement of FR-013, not only its visual coherence.
- **FR-033**: Resolution of interrupted/unresolved entries at end-of-stream (FR-011) MUST be bounded to the still-pending entries tracked during the fold — at `stop`/abort the system flips only the entries still `pending` (by `toolCallId`) and the unfinished turn to `interrupted`; it MUST NOT re-scan the full run to find them. This keeps end-of-stream resolution O(open entries), not O(run length), for long runs.
- **FR-034**: Toggling between the transcript and the structured tab (FR-006) MUST reuse the already-folded view-models for the run and MUST NOT re-fold the full event stream or re-render the entire run on switch — toggle cost is a function of what is mounted in the newly shown view (its visible entries, FR-027), not of total run length. This is the render-cost statement of the FR-006 content/scroll-preservation guarantee.
- **FR-035**: The streaming and virtualization performance requirements (FR-026 delta coalescing, FR-027 O(visible) virtualization, FR-028 aggregate responsiveness) apply to the synthesized native transcript and the structured projection only; they imply NO change to the Claude PTY render path, which stays unchanged (FR-009/SC-003). The structured tab's fold-based projection applies to both desks; the PTY default view's rendering is out of scope for these performance requirements.
- **FR-036**: Token-usage projection MUST be cumulative "set-not-sum": each `token-usage` sample REPLACES the prior cumulative value (never added/incremented), and the displayed cumulative total MUST NEVER decrease — if a non-monotonic (decreasing) sample is received it MUST be clamped to the last-known maximum rather than regressing the total. A `usd: null` sample MUST be treated as unpriced/unknown (never read as 0, never recomputed) and is monotonicity-neutral. Per-turn token usage is the sample observed at that turn's close; per-run is the latest cumulative sample. A turn with no `token-usage` sample MUST display "no usage reported" (or carry forward the last-known cumulative for the per-run figure) rather than a fabricated 0. This is the testable form of the cumulative-monotonic passthrough constraint (FR-012, data-model §C7/§C8).
- **FR-037**: "Durably persist" (FR-016) MUST mean each `AgentEvent` is appended to the on-disk JSONL at the time the event is observed (append-on-event), with the write committed before the event is forwarded onward, so a process exit after the append leaves the event recoverable on replay — the same single-writer, immediately-durable guarantee as the existing `cost-ledger.jsonl` append path. "Durable" is satisfied by per-event append-and-commit; no end-of-run flush is required for an event already written.
- **FR-038**: The persistence unit MUST be keyed by `agentId` and segmented by `sessionId`: one append-only JSONL file per agent holds that agent's run events, and `sessionId` on each line distinguishes successive sessions/runs within that file. A new session MUST append to the same per-agent file (not start a new file), and replay MUST be able to reconstruct each session's transcript and structured view by `sessionId` segmentation. This reconciles FR-016's "per-agent" wording with the data-model `agentId`+`sessionId` join key (data-model §Entity Table): keyed by `agentId`, segmented/joined by `sessionId`.
- **FR-039**: Replay-on-reopen and replay-on-restart MUST be deterministic and idempotent: folding the persisted `AgentEvent` stream MUST reconstruct the SAME transcript entries and structured run view as the live fold produced (identical ordering, tool pairing, interrupted-state resolution, and token projection). Re-opening or restarting any number of times MUST NOT duplicate, append to, mutate, reorder, or otherwise alter the persisted log — replay is read-only over the append-only record. The persisted arrival order (by `ts`) MUST be reproduced without reordering, including the documented out-of-order case (final `token-usage` after streamed text).
- **FR-040**: The persisted run record's on-disk lifecycle MUST be append-only and retained for the lifetime of the run record (no rotation, compaction, truncation, or in-place edit), consistent with the in-memory no-eviction policy (FR-010). On-disk storage growth from retaining every run's events is the accepted requirement-level tradeoff already bounded only by the operating scale (FR-031, Risks); there is no automatic retention/pruning window within the supported scale, and growth beyond that scale is a documented revisit trigger, not a guaranteed-supported range.
- **FR-041**: The secret-free guarantee (FR-016, ADR-0007) MUST hold not only for the top-level persisted/forwarded envelope but ALSO inside every `AgentEvent` payload field — including `toolInput`, tool `result`/output, `text`, `thinking`, and notice `message` content. No API key, auth header, credential, or secret may appear anywhere in the persisted JSONL or the forwarded IPC payload, at any nesting depth; the secret-free assertion (FR-016 / plan §Testing Strategy Security tier) MUST verify payload-embedded secrets are absent, not only top-level fields.
- **FR-042**: A persisted run is "complete" when its event stream ends with a terminal `stop` event and every well-formed line parses; otherwise it is "partial". Replay MUST give each degradation mode a distinct, non-erroring outcome: (a) MISSING file → render an empty/"no persisted run" state, no error; (b) PARTIAL (no terminal `stop`) → render all parsed events and resolve still-open entries to `interrupted` via the same end-of-stream rule (FR-011/FR-033); (c) CORRUPT line (unparseable JSON) → skip that line and continue folding the remainder; (d) TRUNCATED (file ends mid-line) → skip the trailing incomplete line and render the parsed prefix. In all four modes replay MUST continue and "render what is available" rather than aborting; this is the testable form of FR-016's graceful-degradation guarantee (data-model §C5).
- **FR-043**: The main process MUST be the SOLE writer of the persisted JSONL log (single-writer invariant, data-model §C1, plan §AD-003): no renderer or worker writes the file directly, and the log is append-only and never rewritten/edited/compacted/truncated in place. Persisted-line append order MUST be preserved by arrival `ts` even when events interleave or arrive out of order (FR-039); a panel replaying (reading) a file while main is still appending MUST tolerate a concurrently-growing file — it reads the committed prefix and a trailing incomplete line is treated as TRUNCATED (FR-042d), avoiding a torn read.
- **FR-044**: Tool-call pairing MUST key strictly on `toolCallId` (never tool name or positional ordinal), so two concurrent calls of the same tool cannot be mispaired (data-model §C6). A `tool-start` with no matching `tool-end` resolves to `interrupted` at end-of-stream (FR-011/FR-033). An ORPHAN `tool-end` — a `tool-end` whose `toolCallId` has no preceding `tool-start` — MUST be handled without corrupting the transcript: it is dropped (no entry created) or rendered as a standalone settled result note, and MUST NOT create or mutate an unrelated entry. An unfinished turn (turn-start with no turn-end at end-of-stream) MUST be resolved to a terminal state in parallel to the interrupted-tool rule (FR-011/FR-033).
- **FR-045**: The persisted line schema MUST be EXACTLY the `AgentEvent` envelope (`v`, `agentId`, `sessionId`, `ts`, `kind`) plus the per-kind payload defined in data-model §AgentEvent Kinds — no persistence-only fields are added (no schema drift, FR-014; locked source of truth `src/shared/agentEvent.ts`, data-model §C3). All twelve `AgentEvent` kinds (turn-start, turn-end, thinking-start, thinking-delta, text-delta, tool-start, tool-end, token-usage, api-error, stop, needs-input, notification) MUST be handled by both the persist and the fold/replay paths — no kind is silently undefined. The persisted, secret-free fields are exactly: text, tool name/input/result, thinking, token counts, and notice messages (FR-041); nothing else is written. On replay a line whose envelope `v` differs from the current `AGENT_EVENT_VERSION` MUST be folded best-effort using the fields it carries (forward/backward-tolerant, consistent with graceful degradation FR-042) rather than rejected.

### Key Entities *(include for product or technical specs if feature involves data)*

- **AgentEvent** *(existing, consumed)*: the normalized, versioned event stream (turn-start/end, text-delta, thinking-start/delta, tool-start, tool-end, token-usage [cumulative-monotonic], api-error, stop, needs-input/notification) defined by E001 (`src/shared/agentEvent.ts`) and produced for native agents by E003; the panel renders from this stream. Not modified by this feature.
- **Transcript entry** *(new, view-model)*: a rendered transcript element (assistant text, tool call/result, thinking block, or inline notice) derived from one or more AgentEvents; the view-model is renderer-side, but the underlying AgentEvent stream it derives from is persisted (FR-016) so the transcript can be rebuilt after restart.
- **Structured run view** *(new, view-model)*: the turns → tool calls → token-usage projection of the same (now persisted) event stream backing the structured tab; available for native and Claude desks.
- **Persisted run record** *(new)*: the durably stored AgentEvent stream (and/or rendered transcript) for a desk's run that lets the panel re-open a native run's transcript and structured view after an app restart; carries only AgentEvent fields (text, tool name/input/result, thinking, token counts, notices) — never secrets (ADR-0007).
- **Capability-degradation notice** *(existing signal, consumed)*: the degradation indication originating from ADR-0008/E006 that this feature renders inline; the decision of what degrades is owned upstream.

## Assumptions & Risks *(mandatory)*

### Assumptions

- The E001 AgentEvent contract and E003 native-worker event production are available and stable; this feature consumes them and does not alter their shapes.
- The existing per-agent panel (`AgentDetailPanel`) and the xterm terminal component can host a second rendering path without restructuring the Claude PTY path.
- Capability-degradation signals (ADR-0008/E006) and cumulative token-usage events (E007) are present in the stream the panel reads.
- Operators want both a narrative (terminal) view and an inspectable (structured) view of a native run.
- A durable per-agent/per-session store is available (or can be reused) to persist a run's AgentEvent stream for re-open after restart, and the existing input/steer seam (`ProviderRuntime.send`) accepts operator turns for native agents.

### Risks

- **Two rendering paths regress the Claude terminal view** *(likelihood: medium, impact: high)*: adding a synthesized path alongside PTY could break authentic rendering — mitigate by leaving the Claude PTY path untouched and gating synthesized rendering on the event source.
- **Synthesized transcript misleads as authentic** *(likelihood: low, impact: medium)*: an approximation may be mistaken for raw bytes — mitigate with clear framing/labeling of native vs PTY views.
- **Retained full run grows memory; persistence grows storage** *(likelihood: medium, impact: medium)*: keeping the full run with no eviction (per the retention decision) means memory grows with run length, and persisting every run adds storage — mitigate render cost via virtualization (only visible entries mount) and batched updates; treat very long runs / storage growth as an accepted tradeoff to revisit if it bites. The revisit trigger is exceeding the operating scale (hundreds–thousands of events per run; 5–15 desks, plan §Scale/Scope): within that scale the tradeoff is accepted (FR-031); beyond it, retained-memory/storage bounding is reopened. Note: research §4's suggestion to "cap retained scrollback / signal truncation / release off-screen detail" was the pre-clarification input; the Clarifications (Session 2026-06-09, no-eviction; virtualize) supersede it for entry retention — virtualization (not eviction) bounds render cost, off-screen entries unmount but their events stay retained, and payload-level truncation applies to display only (FR-029), not to the retained/persisted stream.

## Implementation Signals *(mandatory)*

- `NEW-UI` — a synthesized terminal-transcript renderer plus an optional structured tab (for native and Claude desks) in the per-agent panel, with inline notice elements and an operator input/steer affordance; gated so the Claude PTY default view is unchanged.
- `NEW-ENTITY` — renderer-side view-models (transcript entry; structured run timeline) derived from the AgentEvent stream, plus a durably persisted run record (the AgentEvent stream/transcript) enabling re-open after restart; no shape change to AgentEvent/AgentUsageSample/ToolSpan, and persisted data carries no secrets (ADR-0007).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001** [US1]: An operator opening a native (DeepSeek/Minimax) desk's panel sees a coherent, streaming terminal-style transcript of the agent's text, tool calls/results, and thinking, within the same panel framing as a Claude desk.
- **SC-002** [US1]: During a multi-step task, streamed text appears incrementally (no wait-for-complete) and each tool call shows a pending→resolved progression with success/failure indicated.
- **SC-003** [US1]: Claude desks render identically to before (authentic PTY bytes) with no visual or behavioral regression.
- **SC-004** [US2]: From the structured tab, an operator can read every turn's tool calls (name, input, result, duration, status) and the run's token usage for a completed native run.
- **SC-005** [US2]: Toggling between transcript and structured tab during or after a run preserves run content and the operator's scroll position.
- **SC-006** [US3]: When a capability degrades or an api-error occurs, the operator sees a distinct inline notice describing it and the transcript continues rather than aborting.
- **SC-007** [US1]: A long native run (hundreds–thousands of entries) and several concurrent native panels stay responsive (no UI freeze) because only visible entries render, and the full run is retained with no content dropped.
- **SC-008** [US1]: From a native desk's panel, the operator can submit a prompt or steer command and see the agent act on it in the same transcript, with parity to operating a Claude terminal.
- **SC-009** [US1]: After closing and reopening a native panel — and after an app restart — the operator can re-open the run's transcript and structured view, rebuilt from the persisted stream.
- **SC-010** [US1]: An operator can identify, on inspection of a native transcript, which entries are assistant text, tool call/result, thinking, and notice via their labels/glyphs/containers; thinking blocks are collapsed by default and expandable (FR-017).
- **SC-011** [US1]: The native panel is identifiable as synthesized (not raw PTY bytes) by an operator-visible framing/label, and Claude panels remain identifiable as authentic PTY — so the two are not mistaken for one another (FR-014/FR-023, Risks).
- **SC-012** [US1]: A native panel and a Claude panel share the same framing attributes (terminal container/chrome, monospace transcript typography, panel/tab placement) such that the floor reads as uniform (FR-023).
- **SC-013** [US3]: When operator input cannot be routed (e.g., missing native worker), the operator sees distinct feedback that the input was not delivered, different from a successful send (FR-022).
- **SC-014** [US1]: Collapsible thinking blocks and the structured-tab toggle are reachable and operable by keyboard, and inline notices are exposed to assistive technology (FR-025).
- **SC-015** [US1]: During high-frequency `text-delta` streaming, the visible transcript does not clear-and-redraw between deltas (no whole-list flash) and prior entries are not re-mounted/re-laid-out; the transcript commits at most one render per animation frame, observable as a stable list that grows from the bottom (FR-026/FR-018).
- **SC-016** [US1]: For a run scaled to thousands of entries, the number of mounted transcript DOM nodes stays bounded to the viewport (visible plus overscan) and does not grow with total entry count, while scrolling to any point reveals the retained content — verifiable by inspection of the mounted node count at small vs large run sizes (FR-027/FR-010).
- **SC-017** [US1]: With the supported number of native panels (up to 5–15) streaming at once, operator input and scrolling stay responsive (no UI freeze) in the aggregate, not merely per single panel (FR-028).
- **SC-018** [US1]: A tool call whose input/output exceeds the display threshold renders truncated with a clear truncation indication in both the transcript and the structured tab, while the full payload is still present in the persisted stream and recoverable on replay (FR-029).
- **SC-019** [US1]: Re-opening a persisted run of thousands of events rebuilds the transcript and structured view from a single top-to-bottom fold pass without re-folding per entry, and the rebuilt views match the live-rendered views (FR-030/SC-009).
- **SC-020** [US2]: Toggling transcript ↔ structured tab mid-run on a run of thousands of entries shows the other view without re-folding the full stream or re-rendering the whole run — only the newly shown view's visible entries mount — and run content and scroll position are preserved (FR-034/FR-006).
- **SC-021** [US1]: An empty, no-op, or thinking-only turn renders as a single coherent settled entry (or, for a no-op turn, no entry) with no churning/empty node that re-lays-out, and a multi-step run mixing such turns stays as stable as a run without them (FR-032/FR-013).
- **SC-022** [US1]: Replaying a persisted run reconstructs a transcript and structured view byte-for-event identical to the live-rendered views (same entry ordering, tool pairing by `toolCallId`, interrupted resolution, and token projection), and re-opening/restarting any number of times neither changes the rendered result nor mutates/duplicates/reorders the persisted log — verifiable by comparing live-fold output to replay-fold output and asserting the on-disk file is unchanged after N reopens (FR-039).
- **SC-023** [US1]: Each persisted-log degradation mode produces its distinct non-erroring outcome on replay — missing → empty state, partial → parsed events with open entries marked interrupted, corrupt line → skipped, truncated tail → skipped — with replay always continuing; verifiable by feeding each malformed fixture and asserting no throw plus the expected rendered prefix (FR-042/FR-016).
- **SC-024** [US1]: The cumulative token total displayed never decreases across a run even if a smaller sample arrives (clamped to last-known maximum), a `usd: null` sample shows as unpriced (not 0), and a turn with no sample shows "no usage reported" rather than a fabricated 0 — verifiable by a fold unit test over a fabricated non-monotonic / null-usd / sample-less-turn sequence (FR-036).
- **SC-025** [US1]: A named secret-free assertion (plan §Testing Strategy Security tier) verifies neither the persisted JSONL nor the forwarded IPC payload contains any API key / auth header / credential at ANY nesting depth — including secrets embedded inside `toolInput`, tool `result`, `text`, `thinking`, or notice `message` payload fields, not only top-level fields (FR-041/FR-016/ADR-0007).

## Clarifications

### Session 2026-06-09

- Q: Is the native agent panel display-only, or can the operator type input / steer the agent from it? -> A: Fully interactive — the operator can type prompts and steer the native agent from the panel (via the existing input/steer seam), like a Claude terminal (FR-015, SC-008).
- Q: How is the optional structured tab surfaced, and does it apply to Claude desks too? -> A: Both — native and Claude desks get an opt-in structured tab built from the AgentEvent stream; each desk's default view is unchanged (FR-005, US2).
- Q: What happens to a native run's transcript when the panel is closed/reopened or the app restarts? -> A: Persist across restart — the run's stream/transcript is durably persisted and re-openable after restart (FR-016, SC-009).
- Q: What retention/eviction strategy bounds a native panel's transcript? -> A: No eviction; virtualize — retain the full run and bound render cost via virtualization, rendering only visible entries (FR-010, SC-007).

## Glossary *(include when spec introduces 2+ domain-specific terms)*

| Term | Definition |
|------|------------|
| Per-agent panel | The detail panel for a single desk/agent that shows its live activity (today the Claude xterm view; `AgentDetailPanel`). |
| Synthesized transcript | A rendered terminal-style view of a native agent's run, constructed from AgentEvents rather than raw PTY bytes; an approximation, not authentic bytes. |
| Structured tab | An optional inspector view of the same run as turns → tool calls → token usage. |
| PTY bytes | The authentic raw terminal byte stream a Claude agent emits, rendered in xterm; unchanged by this feature. |
| AgentEvent | The normalized, versioned event stream (text-delta, tool-start/end, thinking, token-usage, api-error, etc.) the panel renders from. |
| Capability-degradation notice | An inline message indicating a provider capability was unsupported/degraded at runtime (decided upstream by ADR-0008/E006). |
| Run | One agentic execution of a desk's agent, captured as its AgentEvent stream from first event to terminal `stop`; persisted per-agent and segmented by `sessionId` (FR-038). |
| Session | A `sessionId`-scoped segment of an agent's persisted log distinguishing successive runs of the same agent within the one per-agent file; the replay unit for transcript/structured reconstruction (FR-038). |
| (Event) stream | The ordered sequence of `AgentEvent`s for a run/session — the persisted JSONL is the durable form and the single source of truth for replay (FR-016). |
| Transcript | The synthesized terminal-style view-model folded from the event stream (assistant text, tool calls/results, thinking, inline notices); re-derived on every open, never the persisted substrate (FR-039). |
| Structured view | The turns → tool calls → token-usage projection of the same event stream backing the structured tab; available for native and Claude desks (FR-005). |
| Persisted run record | The append-only, secret-free JSONL log of a run's AgentEvent stream, keyed by `agentId` and segmented by `sessionId`, retained for the run's lifetime (FR-016/FR-038/FR-040). |

## Compliance Check

**Verdict**: PASS (project-instructions.md v1.0.0, Principles I–V + Governance). No CRITICAL findings.

- **I. Provider-Agnostic Parity** — PASS. Renders solely from the normalized AgentEvent stream (FR-001); native/Claude split gated on event source, not vendor; no provider-specific branching reaches downstream consumers (per ADR-0002).
- **II. Truthful Cost Governance** — PASS. Cost is not recomputed in the renderer; token usage is display passthrough and cost authority stays at the usage seam / E007 (FR-012, Excluded, SC-004).
- **III. Crash-Contained Isolation** — N/A. Renderer-only; no process/worker or shared-state changes.
- **IV. Agent Output Style** — PASS. Required sections only; concise.
- **V. Preserve Proven Core & Type Safety** — PASS. Claude PTY path preserved unchanged (FR-009, SC-003); new artifacts are renderer-side view-models only, no AgentEvent/usage shape change; observable-by-default.
- **Governance out-of-scope guard** — PASS. No cost-aware routing, failover, data-residency, OS-keychain, or fourth-provider scope introduced.
- **ADR-0010** — PASS. Implements Option A (synthesized terminal + optional structured tab; Claude keeps PTY bytes).
- **ADR-0007** — PASS. No rendering surface exposes secrets; consumes only AgentEvent fields.
- **ADR-0008** — PASS. Surfaces degradation notices; decision logic correctly Excluded as upstream-owned.
- **Clarified-scope note (2026-06-09)**: The Session 2026-06-09 additions — full interactivity (FR-015), a structured tab for both native and Claude (FR-005), durable run persistence (FR-016), and no-eviction retention (FR-010) — are additive and consistent with these principles; persistence MUST carry no secrets (ADR-0007) and the Claude PTY default view stays unchanged (Principle V). Re-confirm at the plan Instructions Check (esp. the new persistence store vs ADR-0007 secret-scrubbing and Principle V core-preservation).
