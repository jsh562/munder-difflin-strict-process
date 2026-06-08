---
adr_id: ADR-0003
status: accepted
date: 2026-06-07
tags: [multi-provider, isolation, electron, runtime]
supersedes: []
superseded_by: ""
related_artifacts: [specs/prd.md, specs/sad.md]
---

# ADR-0003: Native agent isolation via Electron utilityProcess

## Status

Accepted.

## Context

Each Claude agent already runs as its own OS process (node-pty), giving crash containment and a responsive main/UI loop. Native SDK agents (ADR-0001) run a long-lived, network-bound agentic loop and need a symmetric execution home that does not block the Electron main process and that scales to 5–15 concurrent agents.

## Decision Drivers

- Crash containment — one agent must not kill the harness.
- Main/UI-loop responsiveness under fleet load.
- Lifecycle/kill parity with node-pty.
- Per-agent resource visibility.
- Reuse of structured IPC.

## Considered Options

### Option A: Electron `utilityProcess.fork()` — one worker per native agent

- **Pros**: Real OS process (true crash containment, SIGTERM kill, exit/error lifecycle mirroring pty.ts onExit); full Node for provider SDKs + network I/O; structured IPC via parentPort/MessagePortMain; per-agent visibility in app.getAppMetrics; Electron's blessed API.
- **Cons**: Electron-specific; per-worker IPC + lifecycle plumbing.

### Option B: `child_process.fork`

- **Pros**: Familiar, framework-agnostic.
- **Cons**: Electron steers away from it; no Chromium-services isolation; no getAppMetrics integration; cannot use Electron IPC.

### Option C: `worker_threads`

- **Pros**: Lightest weight.
- **Cons**: No crash containment (one crash/OOM kills the main process); designed for CPU-bound compute, not long-lived network-bound loops.

## Decision Outcome

Chosen option: **Option A: Electron `utilityProcess.fork()` — one worker per native agent** — one `utilityProcess.fork()` per native agent, IPC over MessagePortMain, lifecycle mirroring the node-pty onExit teardown/archive path; pass `--max-old-space-size` via execArgv and enforce floor-wide concurrency + per-worker event-queue backpressure in the main process.

## Consequences

### Positive

- Symmetric isolation with the PTY plane.
- Crash containment.
- Per-agent metrics for cost/resource monitoring.

### Negative

- Electron-specific API.
- Per-worker IPC and lifecycle management to build.

### Neutral

- Backpressure and resource limits become explicit main-process responsibilities.

## Links

- PRD CAP-015.
- Related ADR-0001 (port).
- Related ADR-0004 (autonomy).
- Related ADR-0009 (reliability).
