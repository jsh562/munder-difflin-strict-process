---
adr_id: ADR-0010
status: accepted
date: 2026-06-07
tags: [multi-provider, ui, renderer]
supersedes: []
superseded_by: ""
related_artifacts: [specs/prd.md, specs/sad.md]
---

# ADR-0010: Native-agent rendering — synthesized terminal plus structured tab

## Status

Accepted.

## Context

Claude agents render in the per-agent panel as a live xterm view fed by raw PTY bytes. Native SDK agents (ADR-0001) have no terminal byte stream — their activity arrives as normalized AgentEvents (ADR-0002: text-delta, tool-start/end, thinking, token-usage). The per-agent panel must present native agents coherently while preserving the floor's uniform "every desk is a terminal" feel.

## Decision Drivers

- Visual parity with Claude agents.
- Richer truthful view of the SDK loop when wanted.
- Minimal divergence in the per-agent panel.
- Reuse of the existing xterm component.

## Considered Options

### Option A: Synthesized terminal transcript plus optional structured tab

Render a synthesized terminal transcript in the existing xterm view by default, PLUS an optional structured tab (turns, tool calls, token usage).

- **Pros**: visual parity by default plus richer option; reuses the panel.
- **Cons**: two rendering paths to build/maintain; the synthesized transcript is an approximation, not authentic bytes.

### Option B: Terminal only (synthesized transcript)

- **Pros**: one path; uniform feel.
- **Cons**: loses structured detail native events make available.

### Option C: Structured view only

- **Pros**: truest to the SDK loop.
- **Cons**: breaks the uniform terminal feel; a second distinct per-agent UX.

## Decision Outcome

Chosen option: **Option A: Synthesized terminal transcript plus optional structured tab** — render text-delta/tool/thinking events as a terminal-style transcript in the existing xterm view (default), with an optional structured timeline tab; Claude agents continue to show authentic PTY bytes. Capability-degradation notices (ADR-0008) surface inline in both views.

## Consequences

### Positive

- Native agents look and feel like Claude agents while a structured tab exposes the richer event detail.

### Negative

- Two rendering paths to maintain.
- The synthesized terminal is a rendered approximation (no raw ANSI / interactive TUI).

### Neutral

- Depends on the normalized AgentEvent contract (ADR-0002).

## Links

- PRD CAP-015, CAP-018.
- Related ADR-0002 (event bus), ADR-0008 (capability notices).
