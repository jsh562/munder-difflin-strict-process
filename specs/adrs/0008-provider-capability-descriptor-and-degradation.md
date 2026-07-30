---
adr_id: ADR-0008
status: accepted
date: 2026-06-07
tags: [multi-provider, capabilities, degradation]
supersedes: []
superseded_by: ""
related_artifacts: [specs/prd.md, specs/sad.md]
---

# ADR-0008: Provider capability descriptor with warn-at-assignment and runtime graceful degradation

## Status

Accepted.

## Context

DeepSeek and Minimax do not uniformly support features the Claude plane assumes — image input, MCP tools, web search, and prompt caching are unsupported or partial over their endpoints/SDKs. The PRD principle is "degrade gracefully, never silently break," and the product must keep any desk runnable on any provider.

A decision is needed now because work can be assigned to any provider, and an unsupported capability request must not silently break the agent. We need a single source of truth for what each provider/model can do, and consistent enforcement both before assignment and at runtime.

## Decision Drivers

- Keep every desk runnable on any provider.
- Never silently break on an unsupported capability.
- Give the operator/GOD an informed choice before assignment.
- One source of truth for what a provider can do.

## Considered Options

### Option A: Per-provider capability descriptor driving both pre-assignment warning and runtime graceful degradation

A per-provider capability descriptor (`supportsImages` / `supportsMcpTools` / `supportsWebSearch` / `supportsCaching` / ...) that drives BOTH a pre-assignment warning AND runtime graceful degradation (unsupported tool paths no-op/skip with a clear notice).

- **Pros**: Informed assignment + runnable everywhere + no silent breakage.
- **Cons**: Descriptor must be kept accurate per provider/model; two enforcement points to build.

### Option B: Runtime degradation only

- **Pros**: Simplest; always runs.
- **Cons**: Operator only discovers limits after assignment.

### Option C: Restrict assignment up front only (block incompatible work)

- **Pros**: No runtime surprises.
- **Cons**: Less flexible; needs capability-aware routing everywhere; can't degrade a mid-run capability request.

## Decision Outcome

Chosen option: **Option A** — each provider/model declares a capability descriptor; the UI and GOD warn when assigning work that needs an unsupported capability; at runtime, unsupported tool paths degrade safely (skip/no-op with a clear notice) instead of erroring the agent. This is the only option that satisfies all four drivers simultaneously: informed assignment (warn-at-assignment), runnable everywhere (graceful degradation), and no silent breakage (clear notice), all backed by one descriptor as the source of truth.

## Consequences

### Positive

- Any desk stays runnable on any provider.
- Operators choose with eyes open — assignment warnings surface unsupported capabilities before work is committed.
- Failures are graceful — unsupported tool paths skip/no-op with a clear notice instead of erroring the agent.

### Negative

- Capability descriptors must be maintained per provider/model and kept current with provider changes.
- Two enforcement points (assignment-time warning and runtime degradation) must be built and kept consistent.

### Neutral

- The descriptor is part of the provider/model registry (ADR-0005).

## Links

- PRD CAP-018
- Related: ADR-0001 (port capability descriptor)
- Related: ADR-0005 (provider/model registry)
- Related: ADR-0010 (rendering notices)
