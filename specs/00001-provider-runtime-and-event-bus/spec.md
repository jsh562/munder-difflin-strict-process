---
feature_branch: "00001-provider-runtime-and-event-bus"
created: "2026-06-07"
input: "E001 Provider runtime and event bus"
spec_type: "technical"
spec_maturity: "draft"
epic_id: "E001"
epic_sources: "{SAD:ADR-0001,ADR-0002}{PRD:CAP-015}"
---

# Feature Specification: Provider Runtime and Event Bus

**Feature Branch**: `00001-provider-runtime-and-event-bus`  
**Created**: 2026-06-07  
**Status**: Draft  
**Spec Type**: technical  
**Spec Maturity**: draft  
**Epic ID**: E001  
**Epic Sources**: {SAD:ADR-0001,ADR-0002}{PRD:CAP-015}  
**Product Document**: specs/prd.md

## Problem Statement *(mandatory)*

Every agent capability in the harness — avatars, telemetry, budgets, and the circuit breaker — is wired directly to a single vendor's runtime: a `claude` process in a PTY plus Claude Code hook payloads. Adding any other model vendor would mean re-implementing that whole plane per vendor. Without a provider-agnostic boundary and a single normalized event contract, the multi-provider release cannot deliver parity, and downstream features would fork per provider and drift. This epic establishes the foundation every later native-provider epic depends on.

## Scope *(mandatory)*

### Included

- A provider-agnostic `ProviderRuntime` port that represents one running agent and exposes lifecycle, input, usage, a capability-descriptor accessor, and an event subscription.
- A single normalized, versioned `AgentEvent` contract that all runtime adapters emit and all downstream consumers read.
- A Claude adapter that wraps the existing node-pty + Claude Code hook runtime behind the port, with no change to observable behavior.
- Routing existing consumers (avatars, telemetry/cost, budgets, breaker, per-agent terminal) to read the normalized event stream via the Claude adapter.

### Excluded

- Native DeepSeek/Minimax adapters and the SDK agent loop — delivered in later epics (E006); this epic only proves the port with the existing Claude runtime.
- The per-agent worker/process isolation runtime — delivered in E003.
- Provider/model registry, pricing, and capability-descriptor data — owned by E002; this epic defines only the descriptor accessor shape on the port.
- The native autonomy continuation mechanism — owned by E003 (ADR-0004); this epic preserves the existing Claude Stop-hook trigger only.
- Any user-facing feature or UI change — this is an internal architecture boundary.

### Edge Cases & Boundaries

- A consumer relies on a Claude-specific signal not represented in the normalized contract → the contract must carry an equivalent, or the gap is surfaced, never silently dropped.
- A provider reports token usage as per-request totals rather than deltas → adapters must convert to cumulative-monotonic before emitting (Claude's existing delta metrics included).
- An agent terminates mid-turn or its runtime dies → lifecycle (stop/exit) must still emit a normalized terminal event so consumers settle correctly.
- Out-of-order or duplicate underlying signals → the normalized stream must remain consistent for consumers (idempotent where the current system is idempotent).
- A future event type/field is added → existing consumers must continue to function unchanged.

## Technical Objectives *(mandatory for technical specs only)*

### Objective 1 - ProviderRuntime port (Priority: P1)

Define a provider-agnostic port that represents a single running agent regardless of which vendor powers it, exposing lifecycle control, operator/continuation input, a cumulative usage snapshot, an event subscription, and a capability-descriptor accessor — with no provider-specific types leaking to consumers.

**Why this priority**: Core abstraction — every native-provider epic and every downstream consumer depends on this boundary existing; it blocks everything else.

**Rationale**: A stable port is the mechanism that keeps avatars, telemetry, budgets, and the breaker provider-agnostic and makes adding a provider an additive change rather than a fork.

**Deliverables**:
- A `ProviderRuntime` port/interface (TypeScript) under `/src` with: start, stop (graceful), kill, send, getUsage (cumulative snapshot), event subscription, capability-descriptor accessor.
- A conformance contract the Claude adapter (and future adapters) is verified against.

**Validation Criteria**:
1. **Given** the port definition, **When** the Claude adapter is driven through it (start → send → stop), **Then** the agent runs and terminates without any consumer referencing a provider-specific type.
2. **Given** a running agent via the port, **When** `getUsage` is called, **Then** it returns a cumulative usage snapshot compatible with the existing telemetry seam.

### Objective 2 - Normalized AgentEvent contract (Priority: P1)

Define one versioned, normalized event vocabulary that every adapter emits and every consumer reads, carrying enough to drive avatar station mapping, token/cost telemetry, the autonomy loop, and the transcript view.

**Why this priority**: The contract is the single interface all downstream features consume; without it consumers stay coupled to Claude-specific payloads and cannot serve other providers.

**Rationale**: A normalized stream decouples consumers from provider internals and is the only way parity holds across Claude, DeepSeek, and Minimax M3.

**Deliverables**:
- A versioned `AgentEvent` type set under `/src` covering: turn-start, turn-end, thinking-start, thinking-delta, text-delta, tool-start, tool-end, token-usage, api-error, stop, needs-input/notification.
- A documented versioning/extension rule allowing additive event types and fields.

**Validation Criteria**:
1. **Given** the contract, **When** a session runs end to end, **Then** every specified event type is emitted with its required fields and token-usage samples are cumulative and monotonic.
2. **Given** the contract, **When** a new event type or field is added, **Then** existing consumers compile and behave unchanged.

### Objective 3 - Claude adapter with zero behavior change (Priority: P1)

Wrap the existing node-pty + Claude Code hook runtime behind the port as the Claude adapter, emitting the normalized event stream, so that all current consumers behave identically to the pre-refactor baseline.

**Why this priority**: Proves the boundary against the real runtime and protects the shipped product — without it the existing plane regresses.

**Rationale**: Re-routing the proven Claude runtime through the port is the parity test for the whole abstraction and the guarantee that the multi-provider work does not destabilize what already ships.

**Deliverables**:
- A Claude adapter implementing the `ProviderRuntime` port over the existing PTY + hook signals.
- Consumer wiring so avatars, telemetry/cost, budgets, breaker, and the per-agent terminal read the normalized stream.
- A parity check comparing pre/post behavior across those consumers.

**Validation Criteria**:
1. **Given** the Claude adapter active, **When** an agent reads/edits a file and runs a command, **Then** avatar station transitions, telemetry/cost, budget/breaker behavior, and terminal output match the pre-refactor baseline.
2. **Given** an agent finishes a turn, **When** its end-of-turn fires, **Then** the normalized `stop` event still triggers the existing hive inbox-drain autonomy.

### Technical Constraints

- Behavior-preservation is normative in TR-005 (and its hive-autonomy specialization TR-008); the provider-agnostic boundary in TR-007; `token-usage` cumulative/monotonic in TR-003; contract versioning/extensibility in TR-006 — not re-asserted here.
- All source resides under `/src`; `npm run typecheck` (node + web) MUST stay green.

## Integration Points *(mandatory for technical and operational specs)*

- **IP-001**: The native agent worker runtime (E003) depends on the `ProviderRuntime` port and the `AgentEvent` contract from this epic via the internal module interface.
- **IP-002**: The native provider adapters (E006) depend on the `ProviderRuntime` port — each adapter implements it.
- **IP-003**: Avatars/office-floor renderer, the telemetry/usage seam (`UsageProvider`/`AgentUsageSample`), and the circuit breaker depend on the normalized `AgentEvent` stream produced here (today they consume Claude hook payloads and PTY bytes directly).
- **IP-004**: The hive autonomy drain (`drainForStop`) depends on the normalized `stop` event being emitted at end-of-turn; the Claude adapter must preserve the current Stop-hook trigger.

## Requirements *(mandatory)*

### Technical Requirements *(technical specs only)*

- **TR-001**: System MUST define a `ProviderRuntime` port exposing start, stop (graceful), kill, send (operator input / steer injection / drain continuation), getUsage (cumulative snapshot), an event subscription, and a capability-descriptor accessor (returns an empty/placeholder `CapabilityDescriptor` in E001; descriptor data is owned by E002).
- **TR-002**: System MUST define a normalized `AgentEvent` contract (versioning/extensibility rules in TR-006) including at least: turn-start, turn-end, thinking-start, thinking-delta, text-delta, tool-start (toolName, toolInput, toolCallId), tool-end (toolCallId, success, durationMs, error?), token-usage (input, output, cacheRead, cacheCreation, model, usd; cumulative/monotonic per TR-003), api-error (retryable — E001 emits the field only; acting on it is E009), stop (reason, stop-active-equivalent flag), and needs-input/notification (message).
- **TR-003**: `token-usage` `AgentEvent`s MUST be cumulative and monotonic for each agent session.
- **TR-004**: System MUST implement a Claude adapter that wraps the existing node-pty + Claude Code hook runtime behind the `ProviderRuntime` port and emits the normalized `AgentEvent` stream.
- **TR-005**: With the Claude adapter active, avatars, per-agent token/cost telemetry, budgets, the circuit breaker, and the per-agent terminal MUST behave identically to the pre-refactor baseline (captured as recorded golden fixtures); the hive-autonomy specialization of this requirement is TR-008.
- **TR-006**: The `AgentEvent` contract MUST be versioned and additively extensible — new event types or fields MUST NOT break existing consumers.
- **TR-007**: The `ProviderRuntime` port MUST NOT expose provider-specific types to downstream consumers (avatars, telemetry, breaker, hive).
- **TR-008**: The Claude adapter MUST emit the normalized `stop` event at end-of-turn so the existing hive inbox-drain autonomy continues to fire.

### Key Entities *(include for product or technical specs if feature involves data)*

- **ProviderRuntime**: The provider-agnostic port representing one running agent. Exposes lifecycle (start/stop/kill), input (send), cumulative usage (getUsage), an event subscription, and a capability-descriptor accessor. Holds no vendor-specific surface.
- **AgentEvent**: A normalized, versioned event describing agent activity — turns, thinking, text output, tool calls, token usage, API errors, stop, and input needs. The single contract all downstream consumers read.
- **Claude adapter**: An implementation of `ProviderRuntime` that wraps the existing PTY + Claude Code hook signals and maps them onto the normalized event stream.
- **AgentUsageSample** *(existing, boundary)*: The telemetry/cost sample the `token-usage` event normalizes into; not introduced here, but the boundary must remain compatible.

## Assumptions & Risks *(mandatory)*

### Assumptions

- The current Claude PTY+hooks runtime's observable behavior is the parity baseline to preserve.
- Existing hook payloads (PreToolUse/PostToolUse/Stop) plus the PTY byte stream carry enough signal to map onto the normalized `AgentEvent` contract for Claude.
- The existing `UsageProvider`/`AgentUsageSample` seam remains the cost/telemetry contract that `token-usage` events normalize into.
- Downstream consumers can be migrated to read the normalized stream without changing their observable outputs.
- This epic introduces no new external service (Claude only; native providers arrive later).

### Risks

- **Signal loss during normalization** *(likelihood: medium, impact: high)*: Mapping Claude hook/PTY signals onto the contract could drop or reshape information a consumer relies on. Mitigation: a parity test comparing pre/post behavior across all consumers (TR-005).
- **Under-specified contract forces later breaking changes** *(likelihood: medium, impact: medium)*: DeepSeek/Minimax semantics may not fit the initial vocabulary. Mitigation: design for additive versioning now (TR-006).
- **Refactor regression in avatars/telemetry/breaker** *(likelihood: medium, impact: high)*: Re-routing the Claude path behind a port could regress a consumer. Mitigation: zero-behavior-change validation gated on typecheck + critical-path tests (Objective 3).

## Implementation Signals *(mandatory)*

- `NEW-API` — A new internal `ProviderRuntime` port and normalized `AgentEvent` contract become the interfaces consumed across the main process and renderer.
- `BREAKING-CHANGE` — The Claude runtime is re-routed behind the new port and consumers move to the normalized stream; an internal architecture seam change that MUST be behavior-preserving (no user-facing break).
- `NEW-CONFIG` — A version marker for the `AgentEvent` contract so additive evolution is tracked.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001** [OBJ1]: A conformance test instantiates the Claude adapter through the `ProviderRuntime` port and exercises start, send, stop, kill, getUsage, and event subscription with 100% of port methods covered, and asserts the capability-descriptor accessor returns the agreed empty `CapabilityDescriptor` shape.
- **SC-002** [OBJ2]: A contract test confirms every specified `AgentEvent` type and required field is emitted across a full session, and that `token-usage` samples are cumulative and monotonic (zero non-monotonic samples).
- **SC-003** [OBJ3]: A parity check shows zero regression vs. the pre-refactor baseline across avatar station transitions, per-agent token/cost telemetry, budget/breaker behavior, and the per-agent terminal stream.
- **SC-004** [OBJ2]: Adding a new event type and a new field requires no change to existing consumers (demonstrated by an additive-extension test that keeps typecheck green).
- **SC-005** [OBJ1]: A boundary/dependency check confirms no downstream consumer (avatars, telemetry, breaker, hive) references a provider-specific type.
- **SC-006** [OBJ3]: The normalized `stop` event triggers the existing hive inbox-drain autonomy in 100% of end-of-turn cases across the OBJ3 validation scenario (file read/edit + command run + turn end).

## Glossary *(include when spec introduces 2+ domain-specific terms)*

| Term | Definition |
|------|------------|
| ProviderRuntime | The provider-agnostic port representing one running agent; exposes lifecycle, input, usage, capability descriptor, and an event stream. |
| AgentEvent | The normalized, versioned event contract emitted by every runtime adapter and read by every downstream consumer. |
| Adapter | An implementation of the `ProviderRuntime` port for a specific runtime; the Claude adapter wraps PTY + Claude Code hooks. |
| Parity / zero behavior change | The requirement that, with the Claude adapter active, all consumers behave identically to the pre-refactor baseline. |
| Cumulative-monotonic usage | Token-usage samples that only ever increase within a session, so the breaker can diff consecutive samples for velocity. |

## Compliance Check

**Against**: `project-instructions.md` v1.0.0 · **Status**: PASS

| Principle | Verdict | Notes |
|-----------|---------|-------|
| I. Provider-Agnostic Parity | PASS | Vendor-neutral `ProviderRuntime` port (TR-001/TR-007) + single normalized `AgentEvent` contract (TR-002); SC-005 asserts no consumer references a provider-specific type; adding a provider stays additive (IP-002, TR-006). |
| II. Truthful Cost Governance | PASS (scoped) | `token-usage` carries input/output/cache/model/usd and is cumulative+monotonic (TR-003, SC-002) feeding the breaker; the dated-price-table + fail-loud recompute is E002-owned (Excluded), not violated. |
| III. Crash-Contained Isolation & Resilience | PASS (scoped) | Graceful stop + kill (TR-001), mid-turn termination edge case, `api-error(retryable)` in the contract; worker isolation + retry/backoff deferred to E003 (Excluded) as a scoped deferral. |
| IV. Agent Output Style | PASS | Required template sections only; no preamble/epilogue; within size budget. |
| V. Preserve the Proven Core & Type Safety | PASS | Zero-behavior-change is a hard constraint (TR-005, SC-003 parity check); stop-hook autonomy preserved (TR-008/SC-006); all deliverables under `/src`; typecheck-green gate named. |

**Layout/QC/Governance**: ENFORCE_SRC_ROOT honored (all deliverables under `/src`); critical-path conformance/parity/additive tests align with the Testing & Quality Policy; no out-of-scope items (auto-routing, failover, residency, keychain hardening, extra providers) introduced; no provider keys reach hive/transcripts/telemetry (ADR-0007). **Violations**: none. **Required remediations**: none.
