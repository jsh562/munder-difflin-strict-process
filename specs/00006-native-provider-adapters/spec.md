---
feature_branch: "00006-native-provider-adapters"
created: "2026-06-08"
input: "Two native provider adapters (DeepSeek, Minimax M3) running full agentic loops behind the port with graceful degradation."
spec_type: "product"
spec_maturity: "draft"
epic_id: "E006"
epic_sources: "{PRD:CAP-013,CAP-015}{SAD:ADR-0001}"
---

# Feature Specification: Native Provider Adapters

**Feature Branch**: `00006-native-provider-adapters`  
**Created**: 2026-06-08  
**Status**: Draft  
**Spec Type**: product  
**Spec Maturity**: draft  
**Epic ID**: E006  
**Epic Sources**: {PRD:CAP-013,CAP-015}{SAD:ADR-0001}  
**Product Document**: specs/prd.md

## Problem Statement *(mandatory)*

Everything for native multi-provider agents is now in place except the part that actually talks to the providers: the runtime port (E001), the model/capability registry (E002), the isolated native worker (E003), credential injection (E004), and per-desk assignment (E005) all exist, but the worker still runs a stub — no agent can actually run on DeepSeek or Minimax M3. An operator can assign a desk to DeepSeek today and nothing happens. This feature builds the two adapters that run real agentic tool-use loops on those providers behind the existing port, so an assigned desk becomes a full, working peer on the office floor. Without it, the entire multi-provider investment is inert and the headline "run on DeepSeek / Minimax M3" capability does not exist.

## Scope *(mandatory)*

### Included

- A DeepSeek adapter running a full agentic tool-use loop over the provider's OpenAI-compatible API: streamed tool-call assembly, reasoning-content handling, multi-round tool use, and cumulative usage.
- A Minimax M3 adapter running a full agentic tool-use loop over the provider's Anthropic-compatible API: text/thinking/tool_use content blocks, partial-JSON tool-input assembly, and context-length-tier usage.
- Both adapters running inside the existing native worker (E003) behind the ProviderRuntime port / `ProviderCall` seam, selected from the injected provider id (E004) for a desk assigned to that provider (E005).
- Wiring the assignment→spawn→adapter-selection path so assigning a desk to a native provider actually launches it on that provider with its assigned model.
- Both adapters emitting the normalized AgentEvent stream so a native-provider desk participates in the hive (memory, mailbox, autonomy/drain, avatars, telemetry, breaker) as a full peer, indistinguishable downstream from a Claude desk.
- Normalizing the three known provider divergences inside the adapter: streamed tool-call assembly, reasoning/thinking handling, and cumulative-vs-delta usage accounting.
- Runtime graceful degradation: unsupported capabilities (images, MCP tools, web search, caching) no-op with a clear notice instead of erroring (the runtime half of ADR-0008).
- Loop robustness: malformed/partial tool-call JSON handling, bounded max-turn/max-hop caps, and retry-with-bounded-jittered-backoff for transient provider errors only.

### Excluded

- The Claude adapter — it already exists (E001 wraps the PTY+hooks path); E006 delivers only the two native (non-Claude) adapters.
- True-cost recompute and the price table — the adapter passes provider-reported usage through; recompute from token counts × price rows is owned by E002/E007.
- Budget and circuit-breaker logic — E006 emits the usage/error events the breaker consumes; the breaker's parity behavior is a separate epic (CAP-017).
- Live model/provider switch parity (preserving a running desk's state when its provider changes) — CAP-019, a separate epic.
- Defining or seeding the provider/model registry rows — E002 already seeded DeepSeek and Minimax rows; E006 reads them and corrects a capability flag only if it misrepresents real provider support.
- New agent tools — adapters drive the existing tool-execution seam; no new tools are introduced.
- Image-input UI and MCP server management — out of scope; their absence on a provider is handled by graceful degradation, not new UI.

### Edge Cases & Boundaries

- A streamed tool call never completes (stream interrupted mid-tool-call): the incomplete call is discarded (never executed) and surfaced as a retryable error; the agent does not crash. An interruption mid-thinking/text block (no tool involved) is likewise non-fatal — because no tool is ever executed from an incomplete block, whatever streamed is surfaced and the interruption is handled as the same retryable error, not a crash.
- The model returns malformed/partial tool-call arguments: the agent surfaces an error tool result so the model can self-correct, rather than erroring the desk.
- The model returns an empty or refused turn (no tool call and no content): the turn ends cleanly without looping or erroring, rather than re-requesting until a bound is hit.
- A transient provider error (429 / 5xx / timeout) occurs: it is retried with bounded jittered backoff; a non-retryable error (400/401/403, context overflow) is not retried and ends the turn cleanly.
- The agent loops without converging: the existing max-turn / max-hop caps — together with the per-turn wall-clock budget (ADR-0009 / plan Error Handling) — stop it with a clear terminal reason (e.g. `stop reason:"max-turns"`), distinct from a non-retryable-error end-of-turn.
- A task needs a capability the assigned provider lacks: one clear notice is emitted and the agent continues (no error, no silent drop, no repeated notice).
- The assigned provider has no stored API key at launch: the desk does not start a broken loop — it surfaces a clear "needs credentials" state rather than erroring obscurely.
- Usage fields arrive in different shapes (cumulative vs single-final): the normalized counter is monotonic and never decreases or double-counts.
- Reasoning/thinking content is never replayed back into the provider request as prior context where the provider forbids it.

## User Scenarios & Testing *(mandatory for product specs only)*

### User Story 1 - Run a desk on DeepSeek (Priority: P1)

An operator assigns a desk to a DeepSeek model and gives it a task that needs tools. The desk runs a full agentic loop on DeepSeek — thinking, calling tools, reading results, and continuing until it produces a final answer — appearing and behaving on the floor like any other agent.

**Why this priority**: One of the two headline deliverables of the epic (CAP-015) — without a working DeepSeek loop the provider cannot be used at all; it is the core value the whole multi-provider stack was built for.

**Independent Test**: Assign a desk to DeepSeek, give it a multi-step tool-use task, and confirm it completes the task end-to-end with tool calls correctly assembled from the streamed response and reasoning shown as thinking.

**Acceptance Scenarios**:

1. **Given** a desk assigned to a DeepSeek model with a stored key, **When** it is given a task requiring a tool, **Then** it streams a response, assembles the tool call(s) from the indexed deltas, executes the tool, reads the result, and continues the loop to a final answer.
2. **Given** a DeepSeek turn that emits reasoning content, **When** the turn is processed, **Then** the reasoning appears as thinking (separate from the final answer) and is not replayed into the next provider request.
3. **Given** a DeepSeek turn that requests multiple tool calls, **When** the turn completes, **Then** each call is assembled by its index and all are executed before the loop continues.

### User Story 2 - Run a desk on Minimax M3 (Priority: P1)

An operator assigns a desk to Minimax M3 and gives it a task that needs tools. The desk runs a full agentic loop on Minimax — surfacing thinking blocks, calling tools, and continuing — as a full peer on the floor.

**Why this priority**: The second headline deliverable (CAP-015); Minimax M3 support is an explicit release goal and exercises the Anthropic-compatible path that the DeepSeek path does not.

**Independent Test**: Assign a desk to Minimax M3, give it a multi-step tool-use task, and confirm it completes end-to-end with tool input assembled from partial JSON, thinking blocks surfaced, and usage accounted (including the context-length tier).

**Acceptance Scenarios**:

1. **Given** a desk assigned to Minimax M3 with a stored key, **When** it is given a task requiring a tool, **Then** it streams content blocks, assembles each `tool_use` input from its partial-JSON fragments at block completion, executes the tool, and continues until a no-tool stop.
2. **Given** a Minimax turn with thinking content, **When** the turn is processed, **Then** the thinking is surfaced as thinking (distinct from text) on the desk.
3. **Given** a Minimax request whose prompt crosses the context-length pricing-tier threshold, **When** usage is reported, **Then** the usage reflects the correct tier.

### User Story 3 - A native-provider desk is a full hive peer (Priority: P1)

A desk running on DeepSeek or Minimax behaves identically to a Claude desk everywhere downstream: it has a live avatar, per-agent telemetry, memory and a mailbox, and obeys autonomy/drain and the circuit breaker. No part of the floor needs to know which provider backs it.

**Why this priority**: Provider-agnostic parity is the core promise of the product (Principle I, ADR-0001); a native desk that runs but doesn't participate as a peer fails the release's reason for existing.

**Independent Test**: Run a DeepSeek desk and a Minimax desk alongside a Claude desk; confirm avatars, telemetry, memory, mailbox, autonomy/drain, and breaker all behave the same for all three, with no provider-specific branching in downstream consumers.

**Acceptance Scenarios**:

1. **Given** a desk assigned to a native provider, **When** the operator assigns it (E005) and it has a key, **Then** it launches on that provider (native worker + the correct adapter selected from the injected provider id, using the assigned model).
2. **Given** a running native-provider desk, **When** it works, **Then** it emits the normalized AgentEvent stream (turn/thinking/text/tool/usage/stop) and its avatar, telemetry, memory, mailbox, and autonomy behave exactly as a Claude desk's do.
3. **Given** a running native-provider desk, **When** its usage accrues, **Then** the per-agent token/cost telemetry and the breaker act on a cumulative-monotonic usage signal, with no provider-specific consumer code.

### User Story 4 - Unsupported capabilities degrade gracefully at runtime (Priority: P2)

When a native-provider desk encounters work that needs a capability its provider lacks (image input, MCP tools, web search, or prompt caching), the unsupported path no-ops with a single clear notice and the agent keeps running, instead of erroring out.

**Why this priority**: The runtime half of ADR-0008 / CAP-018 (P2) — it keeps "degrade gracefully, never silently break" honest while a desk runs; the core loops (US1–US3) work without it for capable tasks, so it enhances rather than blocks the MVP.

**Independent Test**: Give a native-provider desk that lacks a capability a task that would invoke it, and confirm a single clear notice is surfaced and the agent continues to a result rather than erroring.

**Acceptance Scenarios**:

1. **Given** a desk on a provider that does not support a capability, **When** work would invoke that capability, **Then** the adapter skips the unsupported path, surfaces one clear notice, and the agent continues.
2. **Given** the same capability gap, **When** the desk does more work in the same session, **Then** the notice is not repeated for that capability on every turn.
3. **Given** a desk on a provider that lacks prompt caching, **When** it runs, **Then** cache controls are omitted and cache usage fields report zero (not an error).

## Requirements *(mandatory)*

### Functional Requirements *(product specs only)*

- **FR-001**: System MUST provide a DeepSeek adapter that runs a full agentic tool-use loop over the provider's OpenAI-compatible API behind the existing ProviderRuntime port / `ProviderCall` seam, inside the native worker.
- **FR-002**: The DeepSeek adapter MUST assemble streamed `tool_calls` by their index into complete calls, parse tool arguments only once a call is complete, and support multiple tool calls and repeated tool rounds within a task.
- **FR-003**: The DeepSeek adapter MUST route reasoning content to thinking and message content to text, and MUST NOT replay reasoning content back into a subsequent provider request.
- **FR-004**: System MUST provide a Minimax M3 adapter that runs a full agentic tool-use loop over the provider's Anthropic-compatible API behind the same port/seam, inside the native worker.
- **FR-005**: The Minimax adapter MUST assemble each `tool_use` input from its partial-JSON fragments at block completion, surface thinking blocks as thinking, and treat a tool-use stop as a signal to continue the loop.
- **FR-006**: Both adapters MUST normalize provider-reported usage into a cumulative-monotonic usage signal (never decreasing or double-counting), and the Minimax adapter MUST reflect the correct context-length pricing tier (the tier rule is Minimax-only because DeepSeek's E002 registry price rows are flat, with no context-length tier); raw provider `usd` is passed through (recompute is out of scope).
- **FR-007**: Both adapters MUST emit the normalized AgentEvent stream (turn, thinking, text, tool start/end, usage, stop, error, notification) at the current event-contract version, and MUST NOT leak provider SDK/wire types past the adapter boundary.
- **FR-008**: System MUST launch a desk assigned (E005) to a native provider on that provider — spawning the native worker (E003) and selecting the correct adapter from the injected provider id (E004), using the desk's assigned model — i.e., the assignment→spawn→adapter-selection path MUST be wired end-to-end.
- **FR-009**: A native-provider desk MUST participate in the hive as a full peer — memory, mailbox, autonomy/drain, avatars, telemetry, and the circuit breaker behaving identically to a Claude desk, with no provider-specific code in downstream consumers.
- **FR-010**: At runtime, an unsupported capability (images, MCP tools, web search, caching — per the E002 registry capability descriptor) MUST no-op with a single clear notice rather than erroring, enforced inside the adapter; the notice MUST NOT repeat for the same capability every turn within a session. The notice payload MUST be bounded to the capability name and the model id and MUST NOT echo the request content that triggered it (e.g. dropped image bytes, raw tool inputs, or any other sensitive request payload).
- **FR-011**: The agent MUST NOT execute a tool from incomplete or malformed tool-call arguments; on a parse failure or a stream interrupted mid-tool-call, the system MUST surface a clear error — an `api-error` carrying a machine-readable reason, plus an error tool result enabling self-correction — rather than crashing the desk.
- **FR-012**: Transient provider errors — the retryable allowlist defined in ADR-0009 / plan Error Handling (429, 500, 502, 503, 504, 529, plus connection/read timeouts and network failures with no HTTP status) — MUST be retried with bounded, jittered backoff and classified retryable-vs-terminal so only retryable errors are retried; non-retryable errors (400/401/403, context overflow) MUST end the turn cleanly, and runaway loops MUST be bounded by the existing max-turn/max-hop caps and the per-turn wall-clock budget (ADR-0009). The classification is exhaustive: every error a turn encounters is exactly one of retryable or terminal, with no value in both classes. An empty or refused turn (no tool call and no content) ends the turn cleanly — it is neither retried, nor treated as a runaway loop, nor surfaced as an error.
- **FR-013**: Adapters MUST read the provider API key only from the injected environment (E004 seam) and MUST NEVER write or emit it to any sink — AgentEvents, telemetry, transcripts, the hive, logs, or api-error/diagnostic messages — on either the success path or any error/diagnostic path. This is an absolute prohibition: no redaction- or truncation-based exception is permitted, so partial-key exposure (any substring of the key or the Authorization header value) is equally disallowed. Auth headers carrying the key are constructed only at the HTTP/fetch boundary and are never retained in any normalized turn, event, or usage payload.
- **FR-014**: Each adapter's capability gating MUST read the E002 registry capability descriptor for the assigned model; if a seeded capability flag misrepresents the provider's real support — established from the provider's published documentation and confirmed by manual smoke (real provider behavior cannot be exercised in CI) — it MUST be corrected so degradation gates correctly.

### Key Entities *(include for product or technical specs if feature involves data)*

- **Native provider adapter** *(produced by this epic)*: the DeepSeek adapter and the Minimax M3 adapter — each translates a provider's streamed API into the normalized turn/usage/event contract and runs the agentic loop; the unit of per-provider isolation behind the port.
- **ProviderRuntime port** *(referenced, E001/ADR-0001)*: the start/stop/kill/send/getUsage/subscribe/capabilities boundary the adapters run behind; downstream consumers depend on it, not on any provider.
- **AgentEvent (normalized stream)** *(referenced, E001)*: the versioned event vocabulary (turn, thinking, text, tool, cumulative usage, stop, error, notification) every adapter emits and avatars/telemetry/breaker consume.
- **ProviderModelRegistry** *(referenced, E002)*: the source of truth for each model's endpoint, price rows, and capability descriptor that the adapters read for model facts and degradation gating.

## Assumptions & Risks *(mandatory)*

### Assumptions

- The E001 port + AgentEvent contract, E002 registry rows (DeepSeek `deepseek-v4-flash`/`deepseek-v4-pro`, Minimax `minimax-m3`), E003 native worker + `ProviderCall` seam, E004 credential-env injection (`NATIVE_PROVIDER_API_KEY` / `NATIVE_PROVIDER_ID`), and E005 per-desk assignment are present and stable.
- DeepSeek exposes an OpenAI-compatible Chat Completions API and Minimax M3 an Anthropic-compatible Messages API (per the epic and the seeded registry endpoints); the seeded model ids and endpoints are correct.
- The agent loop's existing max-turn/max-hop caps and the `api-error` retryable flag are reused for robustness rather than reinvented.
- The `ProviderCall` seam may be extended additively (e.g., to carry streaming thinking/text deltas) without breaking the stub or Claude paths.
- Provider-reported usage is trusted as a passthrough; recompute against the price table is E002/E007.
- The provider API key is held at rest in the E004 plaintext harness config (ADR-0007); OS-keychain (`safeStorage`) hardening is an explicitly accepted, bounded MVP residual risk owned upstream by E004/ADR-0007, not a gap this epic closes. E006 only consumes the injected key and is bound by FR-013 (env-only, never emitted); it introduces no new at-rest secret store.

### Risks

- **Provider API divergence / drift** *(likelihood: medium, impact: high)*: undocumented differences in streamed tool-call shape, reasoning/thinking format, or cumulative-vs-delta usage cause incorrect assembly; mitigated by normalizing in-adapter, parse-on-complete-only, and monotonic usage handling.
- **No live API keys in CI** *(likelihood: high, impact: medium)*: real provider endpoints cannot be hit in automated tests; mitigated by unit tests over recorded/mocked provider streams for assembly, usage, and degradation, with live behavior confirmed by manual smoke.
- **Non-streaming seam limits avatar parity** *(likelihood: medium, impact: medium)*: the current `ProviderCall` returns an aggregate turn, so per-token thinking/text avatar animation may require an additive streaming extension to the seam; mitigated by scoping the extension additively and falling back to per-turn events if not extended.

## Implementation Signals *(mandatory)*

- `EXTERNAL-SERVICE` — the adapters call the DeepSeek (OpenAI-compatible) and Minimax M3 (Anthropic-compatible) HTTP APIs; network, auth, streaming, and error handling against two external providers.
- `NEW-WORKER` — the native worker (E003) runs real adapters for non-Claude desks, replacing the stub `ProviderCall`; adapter selection happens at the worker from the injected provider id.
- `BREAKING-CHANGE` — the `ProviderCall` seam may be extended (additively) to carry streaming thinking/text/tool deltas and richer stop/usage; the AgentEvent contract is consumed additively, no downstream consumer change.
- `NEW-CONFIG` — none expected beyond existing config; flagged only if an adapter needs a per-provider tuning knob (e.g., retry budget) — default to existing config.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001** [US1]: A desk assigned to DeepSeek completes a multi-step tool-use task end-to-end (assistant → tool call → tool result → continue → final answer) with tool calls correctly assembled from the streamed deltas.
- **SC-002** [US1]: DeepSeek reasoning content is shown as thinking, separate from the final answer, and is not replayed into a subsequent provider request.
- **SC-003** [US2]: A desk assigned to Minimax M3 completes a multi-step tool-use task end-to-end with each tool input assembled from partial JSON and thinking blocks surfaced.
- **SC-004** [US2]: Minimax usage is accounted with the correct context-length pricing tier applied past the threshold, where the threshold is the tier boundary defined by the model's E002 registry price rows (the adapter reports the prompt-size input that selects the tier; it does not recompute price). A fixture can therefore derive the boundary from the registry row and place a prompt just below and just above it to assert the correct tier.
- **SC-005** [US1,US2]: Both adapters' usage signal is cumulative-monotonic across a turn/round — it never decreases or double-counts — and feeds the existing telemetry without the adapter recomputing cost.
- **SC-006** [US3]: A native-provider desk runs with a live avatar, per-agent telemetry, memory, and mailbox, and obeys autonomy/drain and the breaker — behaviorally indistinguishable from a Claude desk, with no provider-specific downstream code.
- **SC-007** [US3]: Assigning a desk to DeepSeek or Minimax (E005) actually launches it on that provider — the native worker spawns with the correct adapter selected from the injected provider id and the assigned model.
- **SC-008** [US4]: A task requiring an unsupported capability produces a single clear notice — not repeated for that capability across turns within the session — and the agent continues to a result, rather than erroring or silently dropping the work; for a provider lacking prompt caching, cache controls are omitted and cache usage fields report zero rather than erroring.
- **SC-009** [US1,US2]: Malformed/partial tool-call JSON or a transient provider error does not crash the desk — no tool is executed from incomplete arguments, transient errors recover within bounded retries (3–5 attempts, ADR-0009) without tripping the breaker, and runaway loops stop at the max-turn/max-hop cap or the per-turn wall-clock budget with a clear terminal reason; an empty or refused turn ends cleanly rather than looping or erroring.

## Glossary *(include when spec introduces 2+ domain-specific terms)*

| Term | Definition |
|------|------------|
| Adapter | A per-provider module that translates a provider's streamed API into the normalized turn/event/usage contract and runs the agentic loop behind the port. |
| Agentic (tool-use) loop | The cycle: model produces text/thinking and tool calls → tools execute → results feed back → repeat until the model stops requesting tools. |
| Streamed tool-call assembly | Reconstructing a complete tool call from fragments that arrive across streamed chunks (OpenAI index-keyed deltas; Anthropic per-block partial JSON). |
| Reasoning / thinking | Provider-emitted intermediate reasoning, surfaced as "thinking" distinct from the final answer (DeepSeek `reasoning_content`; Minimax thinking blocks). |
| Cumulative-monotonic usage | A token/cost counter that only ever grows within an agent's life, normalized from cumulative or delta provider reports. |
| Graceful degradation | No-op-with-notice handling of a capability the provider lacks — skip the path, surface one notice, keep running. |
| Full peer | A native-provider desk that behaves identically to a Claude desk across memory, mailbox, autonomy, avatars, telemetry, and the breaker. |
| ProviderCall seam | The internal function contract a worker calls each turn; the exact plug-in point each native adapter implements. |
| Session | One native-provider desk run from spawn to stop/respawn. It is the de-duplication scope for the per-capability degradation notice (FR-010): one notice per unsupported capability per session (i.e., per desk lifetime), not per turn. |

## Compliance Check

Audited against project-instructions.md v1.0.0 (Principles I–V + Governance), AGENTS.md, .github/sddp-config.md, and ADRs 0001/0003/0005/0007/0008/0009 on 2026-06-08.

**Status: PASS** — no violations.

- Principle I (Provider-Agnostic Parity): PASS — FR-001/004/007/009, US3, SC-006; ADR-0001.
- Principle II (Truthful Cost Governance): PASS — FR-006, SC-005; recompute deferred to E002/E007; ADR-0005.
- Principle III (Crash-Contained Isolation & Resilience): PASS — FR-011/012, SC-009; ADR-0003, ADR-0009.
- Principle IV (Agent Output Style): N/A — governs agent runtime output, not spec/artifact content.
- Principle V (Preserve Core & Type Safety): PASS — additive scope; no SDK types past adapter (FR-007).
- Degrade-gracefully: PASS — FR-010, US4, SC-008; runtime half of ADR-0008.
- Secrets (ADR-0007): PASS — FR-013, env-only key, never emitted.
- Governance out-of-scope guard: PASS — failover/auto-routing/CAP-019/CAP-017 correctly excluded.

Non-blocking note for Plan: confirm the FR-014 registry capability-flag correction routes through the single-committer main process (Principle III), not a worker write.
