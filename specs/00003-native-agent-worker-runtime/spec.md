---
feature_branch: "00003-native-agent-worker-runtime"
created: "2026-06-08"
input: "E003 Native agent worker runtime"
spec_type: "technical"
spec_maturity: "draft"
epic_id: "E003"
epic_sources: "{SAD:ADR-0003,ADR-0004}{PRD:CAP-015}"
---

# Feature Specification: Native Agent Worker Runtime

**Feature Branch**: `00003-native-agent-worker-runtime`  
**Created**: 2026-06-08  
**Status**: Draft  
**Spec Type**: technical  
**Spec Maturity**: draft  
**Epic ID**: E003  
**Epic Sources**: {SAD:ADR-0003,ADR-0004}{PRD:CAP-015}  
**Product Document**: specs/prd.md

## Problem Statement *(mandatory)*

Today every agent is a `claude` CLI process in a PTY, driven by Claude Code hooks. A non-Claude agent (DeepSeek, Minimax) has no PTY and no hooks, so it has nowhere to run, no autonomy loop, and no way to feed the avatars/telemetry/hive. Without an isolated worker runtime that runs a provider-agnostic agentic loop and reproduces the finish-and-drain-inbox autonomy, native agents cannot exist as full peers on the floor — which is the foundation the entire multi-provider release depends on (and the release's largest single risk). This epic builds that runtime; the actual provider model calls plug into it later (E006).

## Scope *(mandatory)*

### Included

- A `NativeAgentWorker` that runs each non-Claude agent in its own Electron `utilityProcess`, with spawn/kill/exit lifecycle mirroring the existing node-pty teardown/archive, and crash containment (a worker failure never crashes the main process).
- The worker fronted by the E001 `ProviderRuntime` port, so consumers treat a native agent identically to a Claude agent, and structured IPC carrying the normalized `AgentEvent` stream.
- A provider-agnostic agent-loop scaffold driving request → tool_use → execute → tool_result → repeat until end-of-turn, emitting `AgentEvent`s at each boundary, with a pluggable provider-call seam (the contract a provider adapter implements) and a stub provider to exercise the loop end-to-end.
- Native autonomy continuation: at end-of-turn the worker calls the hive drain (`drainForStop`), continues on fresh inbox messages, and is guarded against infinite loops (a `stop_hook_active`-equivalent flag + hop/turn caps).
- Bounded per-worker memory and event-queue backpressure, with a floor-wide concurrency cap.

### Excluded

- Real DeepSeek/Minimax provider adapters (SDK calls, tool schemas, streaming) — E006; E003 ships only the pluggable seam + a stub provider.
- Per-agent / fleet model & provider assignment, and credential/key injection — E004/E005.
- Cross-provider cost/telemetry recompute, budget/breaker parity — E007/E009.
- Native-agent panel rendering — E008; and live model/provider switch — E010.
- Any change to the existing Claude PTY runtime (it stays as-is).

### Edge Cases & Boundaries

- A worker crashes, hangs, or OOMs mid-turn → its exit triggers the same teardown/archive as a dead PTY; other agents and the main process are unaffected.
- The agent loop reaches the hop/turn cap → it stops cleanly (no infinite loop), surfacing a terminal stop.
- A drain-created continuation turn ends → it does NOT re-drain (the `stop_hook_active`-equivalent guard), so autonomy converges.
- The provider-call seam errors or is slow → surfaced as an `api-error` event / bounded by a per-turn wall-clock budget (retry policy itself is E009).
- The event queue floods under a busy loop → backpressure bounds memory; events are not dropped silently.
- A kill arrives while the worker is mid-tool → the worker terminates and the lifecycle teardown runs.

## Technical Objectives *(mandatory for technical specs only)*

### Objective 1 - Isolated worker runtime & lifecycle (Priority: P1)

Run each native agent in its own `utilityProcess`, fronted by the E001 `ProviderRuntime` port, with PTY-equivalent lifecycle, crash containment, structured IPC, and bounded resources.

**Why this priority**: The runtime home is the foundation — E006/E007/E008/E009/E010 all build on a native agent that exists and is controllable like a Claude agent.

**Rationale**: Per-process isolation is the only way to contain a crashing/looping network-bound agent loop while keeping the main/UI loop responsive at fleet scale.

**Deliverables**:
- A `NativeAgentWorker` (Electron `utilityProcess`) + a main-process manager handling spawn/kill/exit and teardown/archive, under `/src`.
- A `ProviderRuntime` implementation fronting the worker (start/stop/kill/send/getUsage/subscribe/capabilities).
- Worker IPC channel; per-worker memory limit (`execArgv`) and a floor-wide concurrency cap.

**Validation Criteria**:
1. **Given** a native agent, **When** it is spawned and then killed (or it crashes), **Then** its exit runs the same teardown/archive as a PTY exit and the main process stays alive.
2. **Given** a running native worker, **When** driven through every `ProviderRuntime` method, **Then** it behaves like any agent (no provider-specific surface leaks to the consumer).

### Objective 2 - Provider-agnostic agent-loop scaffold (Priority: P1)

Provide the agentic loop (request → tool_use → execute → tool_result → repeat) that emits normalized `AgentEvent`s and invokes a pluggable provider-call seam.

**Why this priority**: The loop is the engine that turns a model into a working agent; without it the worker is an empty shell.

**Rationale**: Keeping the loop provider-agnostic (provider calls injected) lets E006 add DeepSeek/Minimax without touching the runtime, and lets E003 validate end-to-end with a stub.

**Deliverables**:
- An agent-loop scaffold that runs the tool-use cycle and emits `AgentEvent`s (turn, text-delta, tool-start/end, token-usage, stop) over IPC.
- A pluggable provider-call seam (the interface a provider adapter implements) + a stub/fake provider that drives the loop deterministically.

**Validation Criteria**:
1. **Given** the stub provider, **When** the loop runs a request that yields a tool call then an end-of-turn, **Then** it emits the expected `AgentEvent`s in order (turn-start → tool-start → tool-end → … → stop).
2. **Given** the emitted stream, **When** validated against the E001 contract, **Then** token-usage is cumulative-monotonic and tool/stop events carry their required fields.

### Objective 3 - Native autonomy continuation (Priority: P1)

Reproduce the Stop-hook autonomy without Claude Code: end-of-turn drains the hive inbox and continues, guarded against infinite loops.

**Why this priority**: Parity autonomy is what makes a native agent a self-coordinating peer; without it native agents go idle and never process their inbox.

**Rationale**: Reusing the existing hive `drainForStop` keeps one autonomy implementation; the loop guard is the safety that prevents runaway.

**Deliverables**:
- A worker-side end-of-turn callback into the hive drain (`drainForStop`), injecting fresh inbox messages as the next turn or going idle.
- A `stop_hook_active`-equivalent guard plus hop/turn caps.

**Validation Criteria**:
1. **Given** a finished turn with fresh inbox messages, **When** end-of-turn fires, **Then** the worker continues with the drained messages; with an empty inbox it goes idle.
2. **Given** a continuation loop, **When** it would otherwise recur forever, **Then** the guard + caps terminate it (a drain-created turn does not re-drain).

### Technical Constraints

- A worker crash, hang, or OOM MUST NOT crash the main process or affect other agents.
- The autonomy loop MUST be bounded by a `stop_hook_active`-equivalent guard and hop/turn caps (no infinite loops).
- Each worker MUST enforce a bounded memory limit and event-queue backpressure; the floor MUST cap concurrency (~5–15 agents).
- The existing Claude PTY runtime MUST NOT change.
- The provider model call is a pluggable seam — E003 validates with a stub; real adapters are E006.
- All source under `/src`; `npm run typecheck`, `npm run lint`, and `npm run test:run` stay green.

## Integration Points *(mandatory for technical and operational specs)*

- **IP-001**: Consumes the E001 `ProviderRuntime` port and `AgentEvent` contract (`src/shared/providerRuntime.ts`, `src/shared/agentEvent.ts`); the worker is fronted by the port and emits `AgentEvent`s over IPC.
- **IP-002**: Lifecycle mirrors `src/main/pty.ts` (`PtyManager` spawn/`onExit`/`setExitHandler` teardown/archive); the main process manages native workers alongside PTY agents.
- **IP-003**: End-of-turn calls `src/main/hive.ts` `drainForStop(agentId)`; the autonomy replicates the `stop_hook_active` guard from `src/main/hooks.ts`.
- **IP-004**: The provider-call seam is implemented by E006 (DeepSeek/Minimax adapters); E007/E008/E009/E010 consume the worker's `AgentEvent`s, usage, and lifecycle.

## Requirements *(mandatory)*

### Technical Requirements *(technical specs only)*

- **TR-001**: System MUST run each native agent in its own Electron `utilityProcess`; the main process MUST manage spawn/kill, and a worker exit (crash or normal) MUST trigger the same teardown/archive lifecycle as a node-pty exit without crashing or destabilizing the main process.
- **TR-002**: The native worker MUST be fronted by the E001 `ProviderRuntime` port (start/stop/kill/send/getUsage/subscribe/capabilities) so consumers treat it identically to a Claude agent, with no provider-specific type leaking to consumers.
- **TR-003**: The worker MUST communicate with the main process over structured IPC and emit the normalized `AgentEvent` stream (E001 contract) over it.
- **TR-004**: A provider-agnostic agent-loop scaffold MUST drive the agentic cycle (request → tool_use → execute → tool_result → repeat until end-of-turn) and emit `AgentEvent`s at each boundary.
- **TR-005**: The loop MUST expose a pluggable provider-call seam (the contract a provider adapter implements); a stub/fake provider MUST be able to drive the loop end-to-end for validation.
- **TR-006**: At end-of-turn the worker MUST call the hive drain (`drainForStop` equivalent); on fresh inbox messages it MUST continue with them, otherwise go idle.
- **TR-007**: The autonomy loop MUST be guarded by a `stop_hook_active`-equivalent flag (a drain-created turn does not re-drain) plus hop/turn caps so it can never loop forever.
- **TR-008**: Each worker MUST enforce a bounded memory limit and event-queue backpressure, and the main process MUST bound floor-wide worker concurrency.

### Key Entities *(include for product or technical specs if feature involves data)*

- **NativeAgentWorker**: The isolated `utilityProcess` running one native agent's loop; fronted by a `ProviderRuntime`; lifecycle managed by the main process.
- **AgentLoopScaffold**: The provider-agnostic agentic loop (request → tool_use → execute → tool_result) that emits `AgentEvent`s.
- **ProviderCall seam**: The pluggable contract a provider adapter (E006) implements — a model call returning tool-use/text/usage; stubbed in E003.
- **AgentEvent** *(from E001)*: The normalized events the worker emits over IPC.

## Assumptions & Risks *(mandatory)*

### Assumptions

- Electron `utilityProcess` (Electron 32) is the chosen isolation primitive (ADR-0003) and is available.
- The E001 `ProviderRuntime` port and `AgentEvent` contract are stable and consumed as-is.
- The hive `drainForStop(agentId)` seam exists and is the autonomy drain (it does, in `hooks.ts`/`hive.ts`).
- A stub/fake provider is sufficient to validate the loop and autonomy in E003; real providers arrive in E006.
- Target fleet is ~5–15 concurrent native workers.

### Risks

- **Reproducing the Claude-only plane for a non-Claude runtime** *(likelihood: medium, impact: high)*: autonomy, lifecycle, and event emission must be rebuilt off-CLI. Mitigation: front the worker with the E001 port, reuse `drainForStop`, validate with a stub + parity-style tests. (PRD-flagged Critical.)
- **Runaway autonomy loop** *(likelihood: medium, impact: high)*: an imperfect guard/cap loops forever. Mitigation: explicit `stop_hook_active`-equivalent guard + hop/turn caps + a test that would loop without them.
- **Worker crash/hang destabilizing the harness** *(likelihood: low-medium, impact: high)*: Mitigation: `utilityProcess` isolation + exit teardown + per-turn wall-clock budget.

## Implementation Signals *(mandatory)*

- `NEW-WORKER` — the `NativeAgentWorker` (`utilityProcess`) running the agent loop, one per native agent.
- `NEW-API` — the worker IPC protocol, the provider-call seam, and the worker's `ProviderRuntime` implementation (internal interfaces).
- `NEW-CONFIG` — per-worker resource limits (memory cap) + the floor-wide concurrency cap.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001** [OBJ1]: A native agent runs in its own `utilityProcess`; killing it or crashing it triggers the same teardown/archive as a PTY exit and the main process stays alive (verified by a spawn + kill/crash test).
- **SC-002** [OBJ1]: A native worker is drivable through 100% of the E001 `ProviderRuntime` methods identically to a Claude agent, with no provider-specific type exposed to the consumer (conformance test).
- **SC-003** [OBJ2]: Driven by the stub provider, the loop completes a request → tool_use → execute → tool_result → end-of-turn cycle and emits the expected `AgentEvent`s in order (test).
- **SC-004** [OBJ3]: At end-of-turn the worker continues on fresh inbox messages and goes idle on an empty inbox, across the scenario (test).
- **SC-005** [OBJ3]: The autonomy loop always terminates — a drain-created turn does not re-drain and hop/turn caps bound it; a test that would loop forever without the guard halts.
- **SC-006** [OBJ1]: 5 concurrent native workers run stably with bounded memory, and a single worker crash does not affect the others (test/soak).
- **SC-007** [OBJ2]: `AgentEvent`s emitted over IPC conform to the E001 contract — token-usage cumulative-monotonic, tool-start/end and stop carry their required fields (contract test).

## Glossary *(include when spec introduces 2+ domain-specific terms)*

| Term | Definition |
|------|------------|
| NativeAgentWorker | The isolated Electron `utilityProcess` running one non-Claude agent's loop. |
| utilityProcess | Electron's blessed child-process primitive — real OS process, crash containment, structured IPC. |
| Agent-loop scaffold | The provider-agnostic agentic loop (request → tool_use → execute → tool_result → repeat). |
| Provider-call seam | The pluggable contract a provider adapter implements (the model call); stubbed in E003, real in E006. |
| drainForStop | The hive autonomy drain — returns fresh inbox messages to continue a turn, or signals idle. |
| stop_hook_active-equivalent guard | The flag that prevents a drain-created turn from re-draining, so autonomy converges. |
| Backpressure | Bounding the worker's event queue so a busy loop cannot grow memory without limit. |

## Compliance Check

**Result**: PASS — `project-instructions.md` v1.0.0 · **Audited**: 2026-06-08

| Principle | Verdict |
|-----------|---------|
| I. Provider-Agnostic Parity | PASS |
| II. Truthful Cost Governance | N/A (deferred E007/E009) |
| III. Crash-Contained Isolation & Resilience | PASS |
| IV. Agent Output Style | N/A |
| V. Preserve the Proven Core & Type Safety | PASS |
| Source Layout (ENFORCE_SRC_ROOT) | PASS |
| Governance Out-of-Scope Guard | PASS |

- Worker fronted by the E001 `ProviderRuntime` port; no provider-specific type leaks; emits normalized `AgentEvent`s only (I).
- One `utilityProcess` per agent; crash/hang/OOM triggers PTY-equivalent teardown without crashing main; bounded memory + event-queue backpressure + floor concurrency cap; autonomy bounded by a `stop_hook_active`-equivalent guard + hop/turn caps (III — the core of this epic).
- Existing Claude PTY runtime unchanged; all source under `/src`; typecheck/lint/test gated (V).
- Implements accepted ADR-0003 (utilityProcess isolation) + ADR-0004 (native autonomy loop). Scoped deferrals (real adapters→E006, assignment/credentials→E004/E005, cost/budget/breaker→E007/E009, rendering→E008, switch→E010) are bounded, not violations.

**Remediations**: None.
