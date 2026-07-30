---
adr_id: ADR-0001
status: accepted
date: 2026-06-07
tags: [multi-provider, architecture-boundary, adapters]
supersedes: []
superseded_by: ""
related_artifacts: [specs/prd.md, specs/sad.md]
---

# ADR-0001: ProviderRuntime ports-and-adapters boundary

## Status

Accepted.

## Context

Munder Difflin (Electron multi-agent harness, v0.2.2) is tightly coupled to the `claude` CLI — every agent is a node-pty process driven by Claude Code hooks. The PRD adds native multi-provider support (Claude, DeepSeek, Minimax M3) running on the providers' own SDKs directly, with FULL PARITY on memory, coordination, autonomy, avatars, telemetry, budgets, and the breaker. A structural boundary is needed so all downstream consumers stay provider-agnostic rather than reaching into the Claude PTY+hooks implementation.

## Decision Drivers

- Provider-agnostic downstream consumers — avatars, telemetry, breaker, and the hive must not know which provider backs an agent.
- Isolate per-provider differences in one place.
- Extensibility — adding a provider should mean adding an adapter only, not editing downstream code.
- Maximal reuse of the existing Claude PTY+hooks plane.
- Honor the PRD principle "model choice is a setting, not a fork."

## Considered Options

### Option A: Ports-and-adapters ProviderRuntime port

One port interface (start/stop/kill/send/getUsage/event-subscription plus a capability descriptor); a Claude adapter wraps today's PTY+hooks path; DeepSeek/Minimax adapters run the agentic loop on the provider SDK inside a worker; all adapters emit one normalized AgentEvent stream.

- **Pros**: Downstream consumers stay provider-agnostic; new providers are additive (adapter only); per-provider change is isolated behind the port; reuses the existing Claude PTY+hooks plane.
- **Cons**: Must define and version a stable internal event contract; the Claude path must be retrofitted behind the port.

### Option B: Per-provider Claude-Code-compatible shim

A local runner per provider that imitates Claude Code's hook/transcript surface so downstream code sees the same surface regardless of provider.

- **Pros**: Near-zero downstream change.
- **Cons**: Re-implements an external tool's private/undocumented surface; brittle to drift as Claude Code evolves; awkward for SDK-native features that have no hook/transcript analogue.

### Option C: Fork the plane per provider

Stand up a separate copy of the agent plane for each provider.

- **Pros**: Maximal per-provider control.
- **Cons**: Multiplies surface area; guarantees drift across forks; violates the provider-agnostic principle.

## Decision Outcome

Chosen option: **Option A: Ports-and-adapters ProviderRuntime port** — one ProviderRuntime port; the Claude adapter wraps the existing PTY+hooks path; native adapters run the SDK loop in a per-agent worker and emit the normalized AgentEvent stream defined in ADR-0002. Avatars, telemetry, the breaker, and the hive consume the normalized stream unchanged.

## Consequences

### Positive

- Downstream features are provider-agnostic; consumers depend on the port and the normalized stream, not on any provider's mechanics.
- New providers are additive — adding a provider is implementing one more adapter.
- Provider quirks are contained inside their adapter.

### Negative

- Requires defining and versioning the AgentEvent contract (ADR-0002).
- The existing Claude code paths must be refactored behind the port.

### Neutral

- Requires a provider/model registry (ADR-0005).
- Requires per-agent worker isolation (ADR-0003).

## Links

- PRD capabilities: CAP-012, CAP-013, CAP-015, CAP-019
- ADR-0002 (event bus / normalized AgentEvent contract)
- ADR-0003 (per-agent worker isolation)
- ADR-0005 (provider/model registry and pricing)
- specs/prd.md
- specs/sad.md
