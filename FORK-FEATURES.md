# Fork Additions — Munder Difflin

A detailed catalog of everything this fork adds on top of upstream
[`chaitanyagiri/munder-difflin`](https://github.com/chaitanyagiri/munder-difflin). This is the
engineering-level companion to the high-level summary in the README.

---

## Context

- **Fork base:** upstream commit `5b00734` (v0.2.2, 2026-06-07).
- **Upstream today:** v0.3.3.
- **Scale of this fork's work:** ~99 commits; ~+22,000 lines across `src/`, **plus** ~5,150 lines in
  the extracted `packages/won-agent-core/` runtime (gitignored here, developed as a separate
  package). Roughly **95% new files, ~5% additive edits** to pre-existing files.

### The one idea underneath everything

Upstream runs **every agent as a CLI subprocess in a PTY** — `claude`, `codex`, `opencode`, etc. do
the model calls, tool calls, and edits, and the app watches their terminal output and hooks.

This fork adds a **second way to run an agent**: an **in-process agentic loop** that calls the LLM
provider's HTTP API directly, parses the stream, and executes tool calls inside the app. Almost every
other feature below (the tool harness, typed roles, the spec-driven pipeline, the richer task board)
is built on top of that runtime.

The two models coexist through one interface (`ProviderRuntime`): the existing Claude PTY path is
wrapped behind the same port, so nothing in the CLI world regresses.

---

## Feature catalog

### 1. Native in-process provider runtime (`won-agent-core`)

**What.** A provider-agnostic agent runtime that runs the agentic loop in-process and calls the LLM
API directly. Native adapters for **DeepSeek** and **Minimax** ship today; Anthropic/Claude remains on
the CLI+PTY path but is represented in the registry for pricing/capabilities.

**Why.** Upstream's "DeepSeek support" is a model slug routed through a third-party CLI (opencode /
crush / pi). This fork makes the app itself the agent, so a new provider is one adapter file rather
than a whole CLI integration, and API-only providers (e.g. Bedrock-style endpoints) become reachable.

**Package layout** — `packages/won-agent-core/src/` (~5,151 lines, **zero runtime npm dependencies**):

| Dir | Lines | Contents |
|---|---|---|
| `contracts/` | 809 | Versioned `AgentEvent` union; `ProviderRuntime` port; `ProviderCall` seam; a data-driven **provider/model registry** with dated, context-tiered price rows (fails loud on unknown ids); `assignment.ts` (explicit → fleet-default → role-based model resolution). |
| `runtime/` | 1,949 | `agentLoop.ts` (the request → tool_use → tool_result cycle); `adapters/deepseekAdapter.ts` (500, OpenAI-style function calling); `adapters/minimaxAdapter.ts` (567, Anthropic-style `input_schema`); `sseParser.ts`; `reliability.ts` (retry classification, full-jitter backoff, `Retry-After`); `capabilityGate.ts` (degrade instead of throw); `selectAdapter.ts`; `stubProvider.ts`. |
| `coordination/` | 1,043 | Multi-agent vocabulary: `types.ts` (roles + capability predicates), `subAgents.ts`, `sddpTemplates.ts`, `projectPlan.ts`, `bugTasks.ts`, `analyze.ts`. |
| `toolkit/` | 1,306 | Tool implementations: `agentTools.ts` (coding tools), `hiveTools.ts` (coordination tools), `agentToolCatalog.ts` (the advertised catalog + native system preamble). |

**Host wiring** — `src/main/runtime/` (1,513 lines, 12 files):

- `nativeRuntime.ts` — registry of native workers, peer to `ClaudeRuntime`.
- `nativeAgentWorker.ts` — main-process handle fronting one worker behind `ProviderRuntime`.
- `worker/agentWorker.ts` — the **Electron `utilityProcess` entry** that runs the loop off the main thread.
- `electronWorkerTransport.ts` — the only file here importing `electron`; forks the worker.
- `nativeEventBridge.ts` — single-writer main→renderer bridge; appends each event to
  `agents/<id>/native-events.jsonl`, then forwards it. Secret-free by construction.
- `claudeAdapter.ts` / `claudeRuntime.ts` — wrap the **existing** Claude PTY+hooks path behind the
  same `ProviderRuntime` port so both agent kinds share one interface.
- `toolGating.ts` — filters the advertised tool catalog by role.
- `ipcTranslator.ts`, `eventBus.ts`, `subAgentRunner.ts`, `subAgentExecutor.ts`.

**Provider selection.** Env-driven: `NATIVE_PROVIDER_ID`, `NATIVE_PROVIDER_API_KEY`,
`NATIVE_PROVIDER_MODEL`; the endpoint is derived from the registry, never from env.

**Security posture.** The worker **never touches the hive git repo.** It emits a `toolRequest` over
IPC; the main process executes it behind a layered gate — **permission gate → circuit breaker →
executor** — and replies with `toolResult`. `keyNonLeak.test.ts` asserts the API key never reaches an
event, usage record, or turn payload.

**Renderer.** Upstream shows an xterm terminal; this fork adds a narrative transcript:

- `NativeTranscriptView.tsx` (850) — virtualized narrative card list.
- `foldEvents.ts` (721, **pure, no React/DOM**) — the single deterministic
  `AgentEvent[] → TranscriptEntry[]` projection used for both live IPC and JSONL replay.
- `StructuredRunTab.tsx`, `transcriptWindow.ts`, `toolSummary.ts`, `ProviderModelPicker.tsx`,
  `ToolWaterfall.tsx`.

---

### 2. In-app agent tool harness (19 tools)

**What.** Because a native agent has no CLI providing tools, the app implements and governs them
in-process. 19 tools are advertised to the model:

**Coding / system:**
`read_file`, `write_file`, `edit_file` (unique-match enforced exact replace), `list_dir`,
`grep` (skips `node_modules`/`.git`/binaries), `bash` (opt-in, destructive-command screened,
real Git Bash on Windows), `write_memory` (appends to the desk's `memory.md`),
`web_search` (opt-in), `spawn_subagent` (SDDP specialists), `hive_integrate` (integrator role only).

**Hive coordination:**
`hive_read_memory`, `hive_read_inbox`, `hive_send_message`, `hive_list_tasks`, `hive_add_task`,
`hive_update_task`, `hive_import_tasks`, `hive_list_agents`, `hive_feature_status`.

**Why it's distinct from upstream.** Upstream has **no** model-facing hive tools — agents coordinate
by writing files. Here, coordination is first-class tool calls, and a conformance test asserts the
advertised catalog never drifts from the executor.

---

### 3. Typed agent roles + role-based tool gating

**What.** Upstream's `role` is a free-text string whose only consumer is a Haiku-vs-Sonnet regex.
This fork introduces a typed role set — **`worker | integrator | reviewer | planner | qc`** — in
`coordination/types.ts` (343 lines) with capability predicates: `roleCanEditCode`, `roleAuthorsCode`,
`roleCanWriteFiles`, `canIntegrate`, `canReview`, `roleCanSpawnSubagents`.

**Why.** Roles decide which tools an agent is even *offered* (`toolGating.ts`). A reviewer that never
sees an edit tool cannot accidentally author code on the branch it is reviewing. This finally encodes
in code the policy upstream only states in comments ("the god is the sole integrator").

**Isolation policy.** Only authors (worker/planner/qc) get a worktree; integrator/reviewer gate and
merge rather than authoring. Each card gets its own branch via `agentTaskBranch(agentId, cardId)` →
`agent/<id>-<cardId>`.

---

### 4. Git worktree orchestration

**What.** `src/main/git.ts` grew from 16 → 29 exports (310 → 455 lines). New capabilities:

- `listWorktrees`, `repoTrunk`, `branchCommitsAhead`, `shortHash`.
- `planWorktree` (pure), `addWorktree`, `removeWorktree`.
- `previewMerge` / `mergeBranch`, `deleteMergedBranch`.
- `classifyWorktree` + `worktreeHealth` — diagnostics that classify each worktree (clean / dirty /
  ahead / squash-merged) and mark only provably-reclaimable trees.
- `prepareQcTree` / `resetBaseToTrunk` — the QC-integration worktree (see SDDP).

**UI.** `AgentWorkspaceControl.tsx`, `DeskOptionsModal.tsx`, a worktree review + bulk-delete panel,
and a projects×teams matrix board. Task handover carries branch provenance and warns before deleting
unmerged worktrees.

---

### 5. Task board / kanban enhancements

**What.** `TasksKanban.tsx` (469 → **887** lines):

- **6 columns** — adds `review` (worker→reviewer hand-off) and `integrate` (reviewer→integrator) to
  the upstream `todo / doing / blocked / done`.
- **`blockedBy` chips + jump-to-blocker** — a blocked card renders which cards it waits on; clicking a
  chip highlights and scrolls to the blocker. Plus a blocker picker; moving out of `blocked` clears blockers.
- **Role-gated lanes** — a card is only editable by an agent holding the right role (`'no edit role'`),
  with a "no live role-holder" health line that escalates stuck lanes.
- **`FeatureBanner`** — a per-feature SDDP phase tracker (Specify → … → Integrate ladder) with live
  step-status pills and per-step pause/stop/manual/resume controls.

**Supporting UI.** `TaskBoardOverlay.tsx`, `FleetControls.tsx` (Pause-all / Resume-all / Stop-all),
`AgentRoleControl.tsx`, reusable `Markdown.tsx` and `ModalOverlay.tsx`.

---

### 6. SDDP — spec-driven development pipeline

**What.** An optional, per-floor mode that swaps the freeform decompose→code→review flow for a
**gated per-feature lifecycle**:

```
Specify → Clarify → Plan → Checklist(opt) → Tasks → Analyze(opt) → Implement → QC → Integrate
```

**Engine.** `src/main/sddpPipeline.ts` (597) + `src/main/sddpPrompts.ts`. The feature epic card's
`milestones[]` is the program; the pipeline is the interpreter. Electron-free (host concerns injected).

**Gates are enforced against the filesystem, not model memory** — marker files under
`specs/<feature>/` (`spec.md`, `plan.md`, `tasks.md`, `.completed`, `.qc-passed`) must exist before
the next phase runs.

**QC bug-task loop.** A `qc-auditor` sub-agent runs build/tests (plus lint/security/coverage by
strictness), files `[BUG:…]` cards to workers, waits for fixes, and re-runs — bounded by
`maxQcIterations`. The bug-card grammar (`coordination/bugTasks.ts`) supports
`[RECURRING] / [ESCALATED] / [DEFERRED]` tags and cross-run signature matching.

**QC-integration worktree.** `prepareQcTree` resolves the deadlock where QC needs merged code but the
merge can't touch trunk until QC passes: it merges each implement branch into a throwaway detached
worktree, reports conflicts back to authors, and lets QC run against the merged result.

**Config (`sddpConfig`).** `qcStrictness` (minimal/standard/strict), `coverageTarget`, `maxChecklist`,
`maxQcIterations` — surfaced in Settings when SDDP is on.

**Sub-agents.** ~18 specialist prompts (`coordination/subAgents.ts`) forked one-shot via
`spawn_subagent`. The `sddp27/` kit and seeded `specs/` project workspace are the methodology source.

---

### 7. Secrets vault + runtime environment

**What.** `src/main/secrets.ts` (61) + `src/main/credentials.ts` (90). Encrypted-at-rest provider
keys injected only at spawn, `redactConfig` / `SafeConfig` to keep keys out of anything crossing to
the renderer or event stream, and runtime env support for proxy/CA (including a native-fetch proxy).

---

### 8. Per-desk build/cache environment layering

**What.** `src/shared/deskEnv.ts` (94) + host wiring. User-definable build/cache env vars layered
**global → per-repo → per-agent**, with a `${env:VAR}` token syntax, redirecting desk build output to
one AV-excludable cache root per worktree.

> Note: upstream PR #108 ("per-agent environment variables") covers overlapping ground.

---

### 9. Cross-provider cost telemetry

**What.** `src/main/telemetry.ts` (851, up from ~450) plus `costVectors` tests. Normalizes usage and
cost across Claude/DeepSeek/Minimax into a durable ledger, versus upstream's Claude-centric
`pricing.ts`.

---

### 10. Web search for agents

**What.** `src/main/webSearch.ts` (146). A keyless DuckDuckGo HTML endpoint backing the opt-in
`web_search` tool, so native agents can research without a paid search key.

---

### 11. Real shell for `bash` on Windows

**What.** `src/main/bashShell.ts` (90). Routes the agent `bash` tool through a real Git Bash shell on
Windows with an environment-aware preamble, instead of failing on POSIX commands.

---

### 12. Terminal DOM renderer

**What.** A DOM-based terminal renderer with a bundled Departure Mono font for reliable text
selection, layered on the existing xterm terminal pool (`terminalPool.ts`).

---

### 13. Test + lint infrastructure

**What.** Vitest (`pool: 'forks'`) with **56 test files** across `src/` and `packages/`, ESLint 10 +
typescript-eslint + react-hooks, and scripts `npm test`, `npm run test:run`, `npm run test:e2e`,
`npm run lint`. Notably **no jsdom** — every renderer test targets an extracted pure module (which is
why `foldEvents.ts` and `transcriptWindow.ts` exist as standalone files).

Highlights: `sddpFullStack.test.ts` (814, real agentic loop with only the provider faked),
`sddpPipelineE2e.test.ts` (341, real git/fs), `deepseekAdapter`/`minimaxAdapter` wire tests,
`keyNonLeak.test.ts`, and catalog↔executor `conformance.test.ts`.

---

## New main-process files (summary)

`src/main/runtime/*` (12), `sddpPipeline.ts`, `sddpPrompts.ts`, `secrets.ts`, `credentials.ts`,
`deskEnv.ts`, `webSearch.ts`, `bashShell.ts`, `paths.ts`.

New shared: `agentEvent.ts`, `assignment.ts`, `deskEnv.ts`, `missionTemplates.ts`, `workerProtocol.ts`,
and 5 re-export shims (`providerRegistry`, `providerCall`, `providerRuntime`, plus contracts) that keep
existing `@shared/…` imports resolving after the runtime extraction.

New renderer: `NativeTranscriptView`, `StructuredRunTab`, `ProviderModelPicker`, `foldEvents`,
`toolSummary`, `transcriptWindow`, `FleetControls`, `AgentRoleControl`, `AgentWorkspaceControl`,
`DeskOptionsModal`, `TaskBoardOverlay`, `Markdown`, `ModalOverlay`, `ToolWaterfall`.

## Pre-existing files this fork modifies (additively)

Mostly `src/main/index.ts` (the primary wiring site), `hive.ts`, `git.ts`, `config.ts`, `hooks.ts`,
`pty.ts` (only an additive data observer), `preload/index.ts`, and renderer seams: `App.tsx`,
`store/store.ts`, `store/config.ts`, `hooks/useHive.ts`, `TasksKanban.tsx`, `SettingsModal.tsx`,
`AddAgentModal.tsx`, `AgentStrip.tsx`, `CommandCenterPanel.tsx`.

---

## Feature dependency graph

Not every feature is independent — this matters for any effort to upstream them one at a time:

- **Independent** (stand on upstream's existing primitives): git worktree toolkit, kanban blocked-by
  chips, fleet controls.
- **Needs the native runtime:** the tool harness, `spawn_subagent`, role *enforcement* (tool-gating).
- **Needs roles:** kanban REVIEW / INTEGRATE lanes, role-gated lane editing.
- **Needs everything:** SDDP.

---

## Running / verifying

```bash
npm test           # all vitest suites
npm run test:e2e   # SDDP real-git end-to-end (sddpPipelineE2e + sddpFullStack)
npm run lint       # eslint over src + packages
npm run typecheck  # node + web + package TS projects
```

Native runtime requires `NATIVE_PROVIDER_ID` / `NATIVE_PROVIDER_API_KEY` / `NATIVE_PROVIDER_MODEL`
(or it falls back to the deterministic stub provider used by the tests).
