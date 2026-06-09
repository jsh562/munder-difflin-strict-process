# Product Requirements Document: Munder Difflin

> Date: 2026-06-07 | Status: Draft

## Product Overview

Munder Difflin is a **local desktop harness that runs a self-coordinating team of autonomous coding agents** on your own machine. Each agent is a real coding-agent process with long-term memory, a mailbox, and a desk on a shared 2D office floor; a **GOD orchestrator** — the single agent you talk to — routes work between them, resolves routine requests itself, and escalates only critical decisions to you. Agents coordinate through an on-disk "hive" (per-agent memory, atomic-file mailboxes, a shared blackboard, a task ledger), and everything they do is visible: avatars move, messages fly desk-to-desk, and live token/cost telemetry tracks every session.

The product serves developers and small teams who want to **run and supervise fleets of autonomous coding agents** without stitching together terminals, memory, routing, and cost tracking by hand. Its value is making a multi-agent coding fleet **observable, controllable, affordable, and coordinated** from one surface.

This release elevates a new headline capability: **agents are no longer tied to a single model vendor.** Any desk on the floor can be staffed with **Claude, DeepSeek, or Minimax M3**, running natively, with the same memory, coordination, budgets, telemetry, and avatar behavior regardless of which model powers it.

## Vision and Why Now

**Vision:** a heterogeneous fleet of autonomous coding agents — different vendors' models working side by side on one floor — that you supervise, budget, and trust as a single team.

**Why now:** the harness is a working prototype (v0.2.0) with autonomy, memory, observability, budgets, and a circuit breaker already shipping, but every agent is locked to one model vendor. Meanwhile, frontier-class, ~1M-context, tool-capable models from **DeepSeek** and **Minimax** are now available at a small fraction of single-vendor pricing. The change this product should create: let an operator **staff each desk with the right model at the right price** — cheap bulk work on one provider, premium reasoning on another — without losing the coordination, memory, and cost-governance that make a fleet manageable. Vendor independence stops being a migration project and becomes a per-desk choice.

## Problem Statement

Running a productive fleet of autonomous coding agents forces an operator into two bad trades:

1. **Vendor lock-in vs. capability.** Tooling that wraps a single coding-agent CLI ties the whole fleet to one model vendor's pricing, availability, and capabilities. Diversifying means abandoning the coordination, memory, and observability layer and rebuilding it per vendor.
2. **Autonomy vs. control.** Letting agents run unattended risks runaway spend and silent drift; keeping a human in every loop destroys the point of a fleet.

Munder Difflin already addresses the second trade. The cost of leaving the first unsolved: operators overpay for routine work, cannot exploit one model's strengths for one role and another's for another, and remain exposed to a single vendor's outages, price changes, and data-handling terms — all while any attempt to mix vendors would throw away the harness's memory, routing, telemetry, and budget governance.

## Background and Evidence

- **Product maturity.** The harness ships today with real-terminal agents, the on-disk hive, the GOD orchestrator with native human-in-the-loop, markdown-first + semantic memory with reflection, an office-floor visualization, per-agent token/cost telemetry with a durable ledger, per-agent budgets, a cost/runaway circuit breaker (steer → constrain → stop), a task kanban, scheduled missions with a heartbeat, GitHub/CI ingestion, and SQLite-backed durable persistence (`README.md`, `HIVE.md`).
- **Single-vendor coupling is structural, not incidental.** Autonomy and avatars are driven by one vendor's agent-CLI hook events; token/cost telemetry reads that vendor's local transcripts; the pricing layer maps that vendor's model ids to USD; per-agent model selection assumes that vendor's model ids. Adding other vendors natively touches the runtime, telemetry, cost, and credential planes — not just a dropdown.
- **Market signal.** DeepSeek and Minimax now publish tool-capable, ~1M-context coding models at materially lower per-token prices than incumbent single-vendor options, with rotating promotional pricing and dated model-deprecation schedules (external provider research, June 2026). This makes per-desk model choice an economically significant lever and makes a maintained, dated pricing table a real operational need.
- **Cost-attribution caveat.** A coding-agent CLI's self-reported cost figure is an approximation priced against its own vendor's assumptions; when an agent runs on a different provider, that figure is wrong. Trustworthy fleet budgeting requires the harness to compute true cost from token counts against a per-provider price table (external provider research, June 2026).

## Target Users, Stakeholders, and Core Personas

### Target Users

- Individual developers and indie builders who run autonomous coding-agent fleets locally, often unattended (e.g. overnight), and watch cost closely.
- Small engineering teams who want a shared, observable, budget-governed multi-agent workflow on local machines.

### Stakeholders

- **Operator / fleet owner** — runs the floor, sets budgets, approves escalations, pays the provider bills.
- **Reviewers / teammates** — consume the agents' output (PRs, tasks) and the activity/audit trail.
- **Model providers** — Anthropic (Claude), DeepSeek, Minimax — as external API dependencies with their own pricing, limits, and data-handling terms.

### Core Personas

- **The cost-conscious fleet runner** — runs 5–15 agents at once; wants to offload routine desks to cheap models and reserve premium models for hard work, with provider-accurate spend visibility and a breaker that stops runaways. Pain: today every agent costs the same single-vendor rate.
- **The vendor-independent builder** — wants to not be hostage to one model vendor's price, availability, or capabilities, and to switch a desk's model without re-tooling. Pain: mixing vendors means losing memory/coordination/observability.
- **The supervisor** — talks only to the GOD agent, wants routine work handled autonomously and only critical decisions (spend, destructive ops, scope changes) surfaced. Pain: unsupervised fleets drift and overspend.

## User Needs / Jobs To Be Done

- "When I add or reconfigure an agent, let me **choose which provider and model it runs on** (per agent, and as a fleet default) the same way I choose any other setting."
- "Let agents on **any provider participate in the hive as full peers** — read memory, drain a mailbox, take orders from GOD, appear and act on the floor — with no second-class behavior."
- "Show me **provider-accurate cost** per agent and across the fleet, so my budgets and the circuit breaker actually reflect what I'll be billed."
- "Let me **switch a desk's model or provider** without losing its memory, budget, telemetry, or place on the floor."
- "Let me **mix vendors to control cost** — cheap models for bulk work, premium models where it matters — on one screen."
- "Keep me out of routine loops; **escalate only what's critical**, on any provider."

## Product Principles or UX Principles

- **Provider-agnostic by design**: every fleet capability — memory, coordination, telemetry, budgets, breaker, avatars — must behave identically regardless of which vendor powers an agent. Model choice is a setting, not a fork.
- **Parity is the bar**: a non-Claude agent is not "supported" until it reaches feature parity with a Claude agent on autonomy, visibility, and governance. Degrade gracefully where a provider lacks a capability; never silently break.
- **Truthful cost above convenient cost**: fleet spend, budgets, and the breaker run on cost computed from real token counts and a maintained per-provider price table — never on a vendor's mispriced approximation.
- **Autonomy with a human seam**: routine work runs unattended; critical decisions surface natively to the operator. This holds across providers.
- **Local-first and auditable**: state lives in local files and a single-committer git hive; every action is visible and replayable.
- **Visible work**: if an agent is doing something — thinking, calling a tool, compacting, looping, waiting — the floor shows it, on every provider.

## Scope Summary

This release makes Munder Difflin a **native multi-provider fleet**: any agent can be assigned and run on **Claude, DeepSeek, or Minimax M3**, with **full parity** on memory, coordination, autonomy, avatars, telemetry, budgets, and the circuit breaker. Non-Claude agents run on the **providers' own SDKs/APIs directly** (not by wrapping a single vendor's CLI); the autonomy loop, avatar lifecycle, and token/cost telemetry are re-derived from each provider's native streaming/tool events to achieve parity. The validation bar for the release is **zero-regression model/provider switching** and **provider-accurate cost attribution**.

Out of the box the release validates exactly three providers (Claude, DeepSeek, Minimax M3) through an **extensible provider/model registry**. Smarter automation on top of multi-provider — automatic cost-aware routing and cross-provider failover — is explicitly deferred to the roadmap.

### In-Scope Capabilities

- Provider/model **registry** (known providers, models, context windows, dated price rows) — extensible, three providers validated.
- **Per-agent and fleet-default provider/model assignment** in the agent lifecycle and UI.
- **Multi-provider credential and endpoint management** (per-provider API keys, secrets at rest).
- **Native non-Claude agent runtimes**: run an agent directly on DeepSeek / Minimax M3 with a **parity autonomy loop** (the finish-and-drain-inbox behavior) and a **parity avatar lifecycle** derived from each provider's native streaming/tool events.
- **Cross-provider true-cost and token telemetry**: provider-accurate USD recompute from token counts against the per-provider price table, feeding the existing observability, ledger, and budgets.
- **Budget and circuit-breaker parity** across providers (steer → constrain → stop fires on true cost).
- **Graceful per-provider capability degradation** where a provider lacks a feature the Claude plane assumes (e.g. image, MCP tools, web search, prompt caching).
- **Model/provider switch parity** — switching a live desk preserves memory, mailbox, budget, telemetry, breaker state, and avatar.
- All existing v0.2.0 capabilities remain in scope and functional.

### Out-of-Scope Items

- **Automatic cost-aware model routing** (e.g. GOD auto-selecting cheap vs. premium models per task) — deferred to roadmap.
- **Cross-provider failover / fallback** when a provider errors or hits a budget — deferred to roadmap.
- **Full data-residency allow/deny policy enforcement** — recorded as a risk for this release; policy depth deferred to roadmap.
- **Providers beyond Claude, DeepSeek, and Minimax M3** in this release — the registry is extensible, but only these three are validated now.
- Commercial distribution of the product while it ships the non-commercial bundled pixel-art assets — a known licensing boundary, unchanged by this release.

## Product Capability Map

Project-level execution anchors used by `specs/project-plan.md`. Capability clusters, not feature-level user stories. `CAP-012`–`CAP-019` are this release's headline multi-provider work; `CAP-001`–`CAP-011` are the existing product foundation.

| Capability ID | Capability | Priority | Outcome |
|---------------|------------|----------|---------|
| CAP-001 | Real-process agent runtime | P1 | Each agent runs as a real, streamable process with full lifecycle control; many run at once. |
| CAP-002 | On-disk hive coordination | P1 | Agents coordinate via local files — per-agent memory, atomic mailboxes, shared blackboard, task ledger — under a single-committer git audit trail. |
| CAP-003 | GOD orchestration & native HITL | P1 | A single orchestrator agent adjudicates traffic, routes work, and escalates only critical items to the operator natively. |
| CAP-004 | Long-term & semantic memory | P1 | Agents retain long-term memory and recall it fast; memory is bounded over time by reflection. |
| CAP-005 | Office-floor visualization | P2 | Agents appear as avatars that move to stations and exchange visible messages reflecting real work. |
| CAP-006 | Per-agent control surface | P2 | Operator can watch, type into, browse files of, and inspect git history for any agent. |
| CAP-007 | Token/cost telemetry & observability | P1 | Real token counts and cost per agent/session, with live observability and a durable cost ledger. |
| CAP-008 | Per-agent budgets & circuit breaker | P1 | Per-agent budgets plus a cost/runaway breaker that steers, constrains, then stops misbehaving agents. |
| CAP-009 | Task orchestration & scheduling | P2 | Dependency-aware task board, recurring missions, and a heartbeat that re-engages an idle floor. |
| CAP-010 | External integration (GitHub/CI) | P3 | Ingest GitHub issues and watch CI status for registered repos. |
| CAP-011 | Durable persistence & restore | P2 | Window state, history, cost ledger, and session ids survive restarts; last team is restorable in one click. |
| CAP-012 | Provider & model registry | P1 | Known providers and models (context windows, dated price rows) are described in one extensible registry; three providers validated. |
| CAP-013 | Per-agent & fleet-default model assignment | P1 | Any agent can be assigned a provider/model per desk and as a fleet default through the normal agent lifecycle. |
| CAP-014 | Multi-provider credential & endpoint management | P1 | Per-provider API keys and endpoints are managed and stored securely; agents authenticate to the right provider. |
| CAP-015 | Native non-Claude agent runtimes | P1 | Agents run directly on DeepSeek / Minimax M3 with a parity autonomy loop and avatar lifecycle derived from provider-native streaming/tool events. |
| CAP-016 | Cross-provider true-cost telemetry | P1 | Per-agent and fleet cost is computed provider-accurately from token counts × a maintained per-provider price table. |
| CAP-017 | Budget & breaker parity across providers | P1 | Budgets and the steer→constrain→stop breaker fire on true cost for non-Claude agents, with no false trips. |
| CAP-018 | Graceful per-provider capability degradation | P2 | Capabilities a provider lacks (image, MCP tools, web search, caching) degrade safely instead of breaking the agent. |
| CAP-019 | Model/provider switch parity | P1 | Switching a live desk's model/provider preserves memory, mailbox, budget, telemetry, breaker state, and avatar with zero regression. |

## Success Metrics / KPIs / Desired Outcomes

Headline measures (the release validation gate) are marked **★**.

| Metric | Target | Why It Matters | Measurement Window |
|--------|--------|----------------|--------------------|
| ★ Switch-parity pass rate | 100% zero-regression | A model/provider switch on a live desk preserves memory, mailbox, budget, telemetry, breaker, and avatar — the core promise of provider-agnostic design. | Per release |
| ★ Cost-attribution accuracy | Harness USD within ≤5% of provider-billed | Budgets and the breaker are only trustworthy if computed cost matches the real bill across providers. | Per release; monthly in use |
| % of fleet runnable on non-Claude models | ≥90% of desks assignable + running with no harness error | Proves multi-provider is real, not nominal. | Per release |
| Blended cost-per-task vs. all-Claude baseline | Material reduction on offloadable work | Quantifies the cost lever that justifies the release. | Per release; ongoing |
| Telemetry parity coverage | 100% of non-Claude agents emit complete token/cost/tool-span data | Observability must not regress when an agent isn't Claude. | Per release |
| Task-success parity | Non-Claude completion / tool-call success within a target band of a Claude control | Cheaper is only useful if work still completes. | Per release; ongoing |
| Budget/breaker fidelity on non-Claude agents | Breaker trips at correct true-cost thresholds; no false trips | Mispriced cost would make governance fire wrongly. | Per release |

## Assumptions

- Operators supply their own provider API keys for Claude, DeepSeek, and Minimax M3.
- **DeepSeek (current V4-class models)** and **Minimax M3** are the validated non-Claude models for this release; the registry is extensible to more later.
- Each provider exposes per-request token counts sufficient to recompute cost; where a usage field (e.g. cache-token split) is missing, cost degrades to a best-effort estimate rather than failing.
- Target fleet size is ~5–15 concurrent agents.
- The product remains local-first desktop software (macOS-first; Windows/Linux supported).

## Constraints

- The new multi-provider plane must coexist with the existing Claude-Code-based plane; existing v0.2.0 behavior must not regress.
- State lives in local files and a single-committer git hive; coordination integrity depends on preserving that model.
- Provider endpoints are external, paid, rate-limited APIs with differing capabilities and data-handling terms; the harness cannot guarantee a provider's availability or feature set.
- Pricing is volatile (promotional rates, dated model deprecations); the per-provider price table must be maintainable and dated, and unknown model ids must fail loudly rather than default to a wrong price.
- Bundled pixel-art assets remain under a non-commercial license, bounding commercial use until replaced.

## Dependencies

- **Provider APIs/SDKs**: Anthropic (Claude), DeepSeek, Minimax M3 — their model availability, tool-use support, streaming/usage reporting, and auth schemes.
- **Per-provider pricing data** — a maintained, dated price table per provider/model.
- Existing runtime/UX foundations: pseudo-terminal process management, the office-floor renderer, the SQLite durable store, the semantic-memory recall index, and the `gh` CLI for GitHub ingestion.

## Risks

- **(Critical) Direct-SDK native means rebuilding the Claude-only plane per provider.** The autonomy loop (finish → drain inbox → continue), the avatar lifecycle, native HITL, and token/cost telemetry are today driven by one vendor's CLI hook/transcript mechanisms. Running natively on DeepSeek/Minimax requires re-deriving all of these from each provider's own streaming/tool events. This is the largest scope and schedule risk of the release.
- **(Critical) Cost-attribution correctness.** A coding-agent CLI's self-reported cost is priced against its own vendor; trusting it for another provider corrupts budgets and the breaker. Cost must be recomputed from token counts × a per-provider price table, and the "unknown model id" path must fail loud, not default to a wrong vendor's price.
- **(High) Data residency / provider origin.** DeepSeek and Minimax are PRC-hosted; some operators cannot send code to them. This release **records the exposure as a risk only** — there is no residency enforcement in the MVP. Operators must understand where their code goes.
- **(High) Pricing drift & model deprecation.** Providers run rotating promotional pricing and deprecate model ids on dated schedules; a stale price table silently mis-bills and mis-governs the fleet.
- **(High) Multi-provider secret management.** Several providers' API keys must be stored and used securely at rest, replacing the single-vendor login assumption.
- **(Medium) Capability gaps per provider.** Image input, MCP tools, web search, and prompt caching are not uniformly available across providers; agents on a provider lacking a capability must degrade gracefully, not break.
- **(Medium) Telemetry field parity.** Some providers may not report the cache-token split (or equivalent) the cost/observability layer expects; cost accuracy may degrade for those providers.
- **(Medium) Quality/tool-reliability variance.** Models differ in agentic-coding reliability; a cheaper model may complete fewer tasks, offsetting cost savings if applied to the wrong work.
- **(Low–Medium) Rate limits & long-run timeouts.** Per-provider rate limits and long autonomous runs require provider-specific timeout/limit handling.

## Open Questions

- What is the exact **parity autonomy-loop and avatar-lifecycle mechanism** for a non-Claude runtime — how to reproduce the finish-and-drain-inbox behavior and station/tool-bubble movements from each provider's native streaming/tool events? (For technical design.)
- Should GOD be allowed to **staff cheap models on routine desks and premium models on hard ones** as a manual coordination pattern in this release, given automatic routing is deferred? (Borders the deferred roadmap item.)
- Which **usage fields** (e.g. cache-token split, prompt-cache reporting) do DeepSeek and Minimax M3 actually return, and what is the cost-accuracy fallback when they are absent? (Needs a build-time spike against live responses.)
- What is **Minimax M3's official per-token price and max output**, beyond promotional/third-party figures? (Confirm at build time.)
- How deep should a future **data-residency policy** go (origin labeling → allow/deny by region)? (Roadmap.)

## Release or Validation Approach

- **Gate the release on the two headline metrics**: zero-regression model/provider switch parity (CAP-019) and ≤5% cost-attribution accuracy (CAP-016) across all three validated providers.
- **Provider-by-provider parity validation**: bring up DeepSeek, then Minimax M3, each to demonstrated parity with a Claude control agent on autonomy, avatars, telemetry, budgets, and the breaker before it is considered "supported."
- **Mixed-fleet pilot**: run a heterogeneous fleet (Claude + DeepSeek + Minimax M3 desks) on a real workload, measuring blended cost-per-task vs. an all-Claude baseline and task-success parity.
- **Build-time spikes** resolve the open questions on provider usage fields and pricing before the cost plane is finalized.
- Existing v0.2.0 capabilities are regression-checked to confirm the multi-provider plane did not disturb the Claude plane.

## Domain Glossary / Terminology

- **Harness**: the Munder Difflin desktop application that runs and supervises the agent fleet.
- **Hive**: the on-disk, single-committer git layer agents coordinate through (memory, mailboxes, blackboard, task ledger).
- **GOD agent**: the always-on orchestrator/supervisor agent the operator talks to; routes work and escalates critical items.
- **Desk / agent**: one autonomous coding-agent participant on the floor; now assignable to any supported provider/model.
- **Provider**: a model vendor whose API powers an agent — Claude (Anthropic), DeepSeek, or Minimax M3 in this release.
- **Provider/model registry**: the extensible description of supported providers and models, including context windows and dated price rows.
- **Parity**: a non-Claude agent behaving identically to a Claude agent on memory, coordination, autonomy, avatars, telemetry, budgets, and the breaker.
- **True cost / cost attribution**: USD computed from real token counts against a per-provider price table, as opposed to a vendor's self-reported approximation.
- **Switch parity**: changing a live desk's model/provider with zero regression in memory, budget, telemetry, breaker, or avatar state.
- **Circuit breaker**: the cost/runaway guard with a steer → constrain → stop ladder.

## Handoff Guidance

Context that downstream architecture design or governance work must preserve.

- **Product intent to preserve**: any agent runs on any supported provider with **full parity**; model choice is a setting, never a second-class path. Cost governance must be **provider-accurate**.
- **Scope boundaries to respect**: MVP = assign + run + parity for Claude, DeepSeek, Minimax M3 via **direct provider SDKs/APIs**. Automatic cost-aware routing, cross-provider failover, and residency-policy enforcement are **out of scope** (roadmap). Only three providers are validated; the registry is extensible but unvalidated beyond them.
- **Critical constraints**: do not regress the existing Claude plane; recompute cost from tokens × a dated per-provider price table (fail loud on unknown ids); store multiple providers' secrets securely; degrade gracefully on capability gaps.
- **Open decisions needing technical input**: the parity autonomy-loop / avatar mechanism for non-Claude runtimes; which provider usage fields are available for cost attribution; confirmed Minimax M3 pricing and limits; whether manual model-diversity staffing by GOD is in this release.

## Project Context Baseline Updates

- **Agent assignment model**: A desk's provider/model is a per-agent setting with a house-wide **fleet default** that newly created agents inherit; existing agents keep their explicit choice and are never retroactively re-assigned when the default changes. This `AgentAssignment` (per-agent + fleet default) is a shared product concept consumed by later provider-execution and rendering work.
- **Warn-at-assignment guardrail**: "Degrade gracefully, never silently break" has an assignment-time half — when an operator assigns a model that lacks a capability (images, MCP tools, web search, caching), a clear, non-blocking warning names the gap so the choice is informed; the warning never blocks the assignment (runtime degradation is the separate execution-time half).
- **GOD-agent parity for operator actions**: Operator-facing configuration actions (e.g., assigning a provider/model) are also reachable programmatically by the GOD agent through the same mechanism, so orchestration and manual control stay consistent.
- **Full-peer parity for every provider**: A desk running on any provider (Claude, DeepSeek, Minimax M3) is a full hive peer — memory, mailbox, autonomy, avatars, telemetry, and the circuit breaker behave identically and no part of the floor knows which provider backs a desk. "Model choice is a setting, not a fork" is realized by isolating all per-provider behavior behind one adapter boundary that emits a single normalized event stream.
- **Trustworthy cross-provider cost**: Every desk's cost is provider-accurate — computed once from real token counts × a maintained per-provider price table (never a vendor's self-reported figure), within the ≤5% cost-attribution gate. An unknown model fails loud rather than billing a wrong default, so budgets and the breaker act on cost the operator can trust regardless of provider.
