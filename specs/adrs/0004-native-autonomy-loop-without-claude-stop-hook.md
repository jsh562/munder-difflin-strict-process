---
adr_id: ADR-0004
status: accepted
date: 2026-06-07
tags: [multi-provider, autonomy, hive]
supersedes: []
superseded_by: ""
related_artifacts: [specs/prd.md, specs/sad.md]
---

# ADR-0004: Native autonomy loop without the Claude Stop hook

## Status

Accepted.

## Context

The harness's autonomy loop is implemented as a Claude Code Stop hook that returns `{"decision":"block","reason":...}` to keep an agent draining its hive inbox (guarded by `stop_hook_active` to prevent infinite loops). Native SDK agents (ADR-0001) have no Claude hooks, so the finish → drain-inbox → continue behavior must be reproduced inside the worker loop to achieve parity.

## Decision Drivers

- Parity autonomy for non-Claude agents.
- Reuse the existing hive drain logic (`drainForStop` in `hive.ts`) as the single source of truth.
- Prevent infinite loops.
- Respect hop/turn caps.

## Considered Options

### Option A: Worker-side end-of-turn callback into drainForStop

When the model returns end-of-turn with no tool call, the worker emits a `stop` event and calls the harness `drainForStop(agentId)`; if it returns block (fresh inbox messages), the worker injects the drain reason as the next user turn and continues; otherwise it goes idle. A `stop_hook_active`-equivalent guard prevents re-draining a turn that a drain itself created.

- **Pros**: parity; reuses hive drain unchanged; explicit loop guard.
- **Cons**: must replicate the `stop_hook_active` guard plus caps in the worker.

### Option B: Poll the inbox on a timer from the main process

- **Pros**: no worker callback.
- **Cons**: latency/races; duplicates the drain trigger; not turn-aligned.

### Option C: No autonomy for native agents

- **Pros**: trivial.
- **Cons**: breaks the PRD parity guarantee.

## Decision Outcome

Chosen option: **Option A: Worker-side end-of-turn callback into drainForStop** — the worker calls back into the existing hive drain at each end-of-turn; continuation injects the drain reason as the next user message; a loop guard plus hop/turn caps bound it.

## Consequences

### Positive

- Native agents drain inboxes and stay autonomous exactly like Claude agents.
- The hive drain stays the one implementation.

### Negative

- The worker must faithfully replicate the `stop_hook_active` guard and caps, or risk infinite loops.

### Neutral

- The `stop` event in the normalized contract (ADR-0002) carries the guard state.

## Links

- PRD CAP-002.
- PRD CAP-015.
- Related ADR-0002 (event bus).
- Related ADR-0003 (worker).
