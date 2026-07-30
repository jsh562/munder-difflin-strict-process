<!-- template-version: 2 -->
# Munder Difflin Project Instructions

## Core Principles

### I. Provider-Agnostic Parity

Every fleet capability — memory, coordination, autonomy, avatars, telemetry, budgets, and the circuit breaker — MUST behave identically regardless of which model vendor (Claude, DeepSeek, or Minimax M3) powers an agent. Provider-specific logic MUST live behind the ProviderRuntime adapter boundary and emit the normalized AgentEvent stream; adding a provider MUST NOT require changes to downstream consumers. — Model choice is a per-desk setting, not a fork; provider-agnostic parity is the core promise of the multi-provider product and the only way a heterogeneous fleet stays manageable.

### II. Truthful Cost Governance

Per-agent and fleet cost MUST be computed once, at the usage seam, from real token counts × a dated per-provider price table — never from a vendor's self-reported approximation. An unknown model id MUST fail loud (surface a parity warning), never default to another vendor's price. Budgets and the steer→constrain→stop breaker MUST act on this true cost. — Cost governance is only trustworthy when computed spend matches the real bill across providers; the ≤5% cost-attribution release gate depends on it.

### III. Crash-Contained Isolation & Resilience

Each agent MUST run in its own OS process or worker; an agent's crash, hang, or error storm MUST NOT take down the harness or other agents. Transient provider errors MUST be retried with bounded, jittered backoff; only exhausted/non-retryable errors and cost overruns MAY trip the breaker. The single-committer main process MUST remain the only writer of shared hive/coordination state. — A 5–15 agent fleet stays responsive and safe only with hard isolation and a breaker that does not false-trip on transient blips.

### IV. Agent Output Style

All agent output MUST be concise and outcome-oriented. This principle supersedes any verbose defaults.

- **Progress reports**: Facts and outcomes only — no narration, no restating the task.
- **Artifacts**: Emit required sections only — no preamble paragraphs, no summary epilogues.
- **Reasoning**: Omit unless the user asks "why" or the decision is non-obvious.
- **Errors / blockers**: State the problem, the attempted fix, and the result — nothing else.
- **Phase-boundary reports**: ≤ 5 bullet points.
- **Preserve without compressing**: Artifact template structure and required sections; explicit decision / registration / validation guidance in shared skills; delegation constraints and sub-agent role definitions; existing size limits (spec ≤ 1000 KB, research ≤ 400 KB, stories ≤ 200 words).

### V. Preserve the Proven Core & Type Safety

The existing two-plane architecture (terminal plane + event/hive plane) and shipped v0.2.x capabilities MUST NOT regress when extended. All project source MUST live under `/src`. `npm run typecheck` (node + web) MUST stay green as the hard gate, and every agent's work MUST remain observable on the floor (visible-by-default). — The multi-provider release extends a working product; protecting the proven core, type safety, and observability prevents the extension from destabilizing what already ships.

## Technology Stack

- **Language/Runtime**: TypeScript 5.6 on Node (Electron 32 main/preload; React 18 renderer). CI runs Node 20.
- **Frameworks**: Electron 32 + electron-vite/Vite 5; React 18; Pixi.js 8 (office floor); xterm.js 5 (terminal view); node-pty 1 (Claude agent processes); zustand 4 (renderer state); provider SDKs (Anthropic, DeepSeek / OpenAI-compatible, Minimax) for native adapters; OpenTelemetry (loopback collector).
- **Storage**: SQLite (better-sqlite3) durable store, cost ledger, and provider/model registry; on-disk single-committer git "hive" of plain files (per-agent memory, mailboxes, blackboard, task ledger); optional MemPalace semantic-recall index (degrade-to-noop when absent).
- **Infrastructure**: Local-first desktop application; packaged with electron-builder for macOS (signed), Windows, and Linux; GitHub Actions CI. No server tier.

## Testing & Quality Policy

- **Coverage Target**: none — no numeric coverage enforcement.
- **Required QC Categories**: linting (static analysis), performance.
- **Test Strategy**: Type-checking (`npm run typecheck`, node + web) is the hard gate. Targeted unit/integration tests cover critical paths — provider-accurate cost recompute, live model/provider switch parity, the native autonomy loop, and circuit-breaker trips. No blanket coverage mandate.
- **Linting / Formatting**: Static analysis (linting) is a required QC gate. TODO(LINTER): no linter is configured yet — adopt ESLint or Biome and wire it into CI to satisfy this gate.

## Source Code Layout

- **Policy**: ENFORCE_SRC_ROOT
- **Convention**: All project source resides under `/src` — `src/main` (Electron main process), `src/preload` (contextBridge → typed `window.cth`), `src/renderer` (React UI, Pixi scene). Build/config files at repo root; tests co-located or under a `tests/` root when introduced.

## Development Workflow

- **Branching**: Feature branches from `main`; pull requests squash-merged into `main`.
- **Commit Convention**: Conventional Commits.
- **CI Requirements**: `npm run typecheck` (node + web) MUST pass on every pull request to `main` (blocking). The production build runs in CI and is currently non-blocking due to the native node-pty rebuild. A linting gate is to be added once a linter is adopted (see Testing & Quality Policy).

## Governance

- Project instructions supersede all other documentation and practices.
- Amendments require a version bump with ISO-dated changelog entry.
- All implementations MUST pass the Instructions Check gate during planning.
- Complexity beyond these principles MUST be justified and documented.
- Out-of-scope items recorded in the PRD/SAD (automatic cost-aware model routing, cross-provider failover, data-residency enforcement, OS-keychain secret hardening, providers beyond the three validated) MUST NOT be introduced without an explicit scope decision and an accepted ADR.
- Provider API keys MUST NOT be written to the git hive, transcripts, or telemetry output (per ADR-0007); the plaintext-config secret store is an accepted MVP risk pending keychain hardening.

**Version**: 1.0.0 | **Last Amended**: 2026-06-07
