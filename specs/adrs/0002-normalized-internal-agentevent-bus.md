---
adr_id: ADR-0002
status: accepted
date: 2026-06-07
tags: [multi-provider, event-contract, observability]
supersedes: []
superseded_by: ""
related_artifacts: [specs/prd.md, specs/sad.md]
---

# ADR-0002: Normalized internal AgentEvent bus

## Status

Accepted.

## Context

Avatars (station mapping), telemetry (token/cost + tool-span waterfall), the circuit breaker (loop/error/cost signals), and the hive (autonomy) are today driven by Claude Code hook payloads (PreToolUse/PostToolUse/Stop) plus raw PTY bytes. Native SDK agents have neither hooks nor a byte stream. A single canonical internal event vocabulary is needed that every ProviderRuntime adapter (ADR-0001) emits and every downstream consumer reads unchanged.

## Decision Drivers

- One contract for all downstream consumers.
- Must carry enough to drive station-mapping, cost attribution, the autonomy loop, and the transcript view.
- Stable and versioned.
- Keep provider-specific semantics out of the bus.

## Considered Options

### Option A: A normalized AgentEvent union owned by the harness

- **Pros**: Decouples downstream from providers; single contract; versionable.
- **Cons**: Must normalize divergent provider semantics in adapters.

### Option B: Adopt Claude Code's hook JSON shape as the canonical event format

- **Pros**: Zero change to current consumers.
- **Cons**: Couples the whole system to an external tool's evolving private format; poor fit for SDK-native events.

### Option C: Per-consumer ad-hoc events

- **Pros**: Flexible.
- **Cons**: N×M coupling; no single contract; drift.

## Decision Outcome

Chosen option: **Option A: A normalized AgentEvent union owned by the harness** — it decouples every downstream consumer from provider specifics behind one versionable contract, at the cost of pushing normalization into the adapters.

Canonical event set: turn-start, turn-end, thinking-start, thinking-delta, text-delta, tool-start (toolName/toolInput/toolCallId), tool-end (success/durationMs/error), token-usage (input/output/cacheRead/cacheCreation/model/usd — CUMULATIVE and MONOTONIC because the breaker diffs consecutive samples for velocity), api-error (retryable), stop (reason + stop_hook_active-equivalent), needs-input/notification. Adapters own all reassembly/normalization (streamed tool_call fragment assembly; reasoning/thinking semantics; cumulative-vs-delta usage); the bus only sees normalized events.

## Consequences

### Positive

- Downstream consumers are provider-agnostic.
- One place to evolve the contract.

### Negative

- Adapters must normalize cumulative-vs-delta usage, provider thinking/reasoning differences, and streamed tool-call assembly.
- The contract must be versioned.

### Neutral

- Replaces, for native agents, the raw-byte transcript with a synthesized one (ADR-0010).

## Links

- PRD CAP-015, CAP-016, CAP-017.
- Related ADR-0001 (port), ADR-0004 (autonomy), ADR-0006 (OTel), ADR-0010 (rendering).
