# Orchestration model — As-is → To-be

How the hive coordinates work: agents & their working directories, status/control, delegation, integration, and the shared task board. Each section gives the **current** (shipped) behavior; "Later" notes call out what is still deferred.

Cast: **God** (`Michael`, the orchestrator — a singleton) and **workers** (DeepSeek/Minimax "native" desks, or Claude PTY desks). The god runs on the native runtime when the fleet default is a non-Anthropic model.

---

## 1. Agents & workspaces

- Every agent is created with one working directory (`cwd`), chosen in the Add-Agent dialog. Its file tools (`read_file`/`write_file`/`edit_file`/`bash`/`grep`/`list_dir`) are sandboxed to that `cwd`.
- **To split one project across agents:** spawn the collaborators **on the same repo**; each gets its own **git worktree** on an `agent/<id>` branch so parallel edits don't collide. This is **automatic** — a worker spawned into a repo that already hosts another agent is isolated for you; the **first** agent stays on the repo's main tree (the integration base), and the explicit "isolate" checkbox still forces it. Use separate repos only for genuinely separate projects.
- **Worktrees persist.** On agent exit the worktree + its branch are **kept** (committed work survives for the god to integrate); review and bulk-delete stale ones in **Settings → Worktrees**. (They are no longer force-removed on exit.)
- The **god** runs in its own neutral **scratch workspace** — `config.godWorkspace`, else `<harnessHome>/workspace` — separate from both the hive bookkeeping (`registry.json`, `board.md`, `tasks.json`, `agents/<id>/memory.md`, inboxes) and any worker's repo. It never *implements* in a repo; it integrates via the governed tool in §5.
- Caveat: `bash` runs in a real shell, so it can currently reach outside the sandboxed `cwd`. Sandbox isolation is therefore partial.
- **Later:** "god spawns workers on demand" (auto-provision a team into a project); retroactively isolating the *first* agent when a second arrives; tightening the `bash` sandbox.

## 2. Status & control

- A native desk's `agent.status` is driven by its live event stream: a global subscription sets `turn-start → working`, `turn-end`/`stop → idle` (skipped while paused / god-stopped / breaker-armed). One `displayStatus(agent, paused, godDesired)` derivation feeds the badge, the strip card, and the transcript — **god-stopped → idle**, **paused → waiting**, **streaming → working**, else **idle** — so they never disagree.
- The transcript's "working…" spinner shows only while `pendingTurn && !paused && !stopped`.
- **Stop** kills the worker (a synthetic terminal `stop` settles the transcript) and keeps it down across reloads until **Start**. **Pause** denies tools + parks the desk (the wake/drain leave it alone). A stopped *worker* revives on the next delegation/message (revive-on-demand).

## 3. Delegation & escalation

- The god delegates with **`hive_send_message`** — the actual dispatch into a worker's inbox. (The Tasks tab's "assign" button just pre-fills a message *to the god*; all human dispatch routes through the god.) A worker is woken by the inbox-wake loop and its end-of-turn drain delivers the content.
- **`hive_list_agents`** gives the god a host-mediated roster (`id, name, role, archived, running, repo, branch`) so it picks the best **available** desk instead of delegating blind. The god's loop: read roster + board, **decompose** a request into slices, create one **task card per slice** assigned to a desk, `hive_send_message` each. It can split one task across desks, assign different tasks to different desks, and re-route when a desk is blocked.
- **Escalation (worker → god).** A worker raises a blocker, ambiguity, conflict, or sign-off request by `hive_send_message {to:'god', act:'request'|'query'}`; it routes to the god's inbox and wakes it. This is the right channel — the god owns decisions/conflicts; workers don't guess or block silently.

## 4. The task board (`tasks.json` → Tasks tab)

Messages move work; the board records it — a living, single-source-of-truth with a role protocol:
- Statuses: `todo | doing | blocked | review | done`.
- **`hive_update_task`** `{ id, status?, assignee?, title?, priority?, note? }`, **role-enforced**:
  - **Worker** — may update only a card **assigned to itself**, and only to `doing` / `blocked` / `review`. It may **not** set `done` or reassign.
  - **God** — may update **any** card to **any** status, including `done`/reopen, plus reassign and reprioritize.
- **Ownership lanes** (no write races — the hive is single-committer, the convention keeps lanes clean):
  - **God owns** create, assign, and **sign-off**.
  - **Workers own** progress on their own cards.
- **Validation loop**: a worker finishes → sets its card **`review`** and pings the god → the **god verifies the deliverable** → sets **`done`** (or reopens to `doing`). No worker self-declares done; the god confirms.

```
todo ─(god assigns)─▶ doing ─(worker)─▶ review ─(integrator verifies+merges)─▶ done
                        │                              │
                        └─(worker: blocked)─▶ blocked  └─(integrator: reopen)─▶ doing
```
(the integrator is the god by default, or a dedicated desk holding the integrator role)

## 5. Roles & integration (who merges the work)

Integration is a **role**, not a hard-coded god power. Each desk carries a small, extensible set of **capability roles** (separate from the god/assistant *identity*):
- **`worker`** — eligible for delegated implementation (the god assigns slices here).
- **`integrator`** — may review+merge another desk's branch (`hive_integrate`) and **sign tasks off** (`done`). The **god holds it by default**; it is **reassignable** — un-toggle it on the god and toggle it on a dedicated desk to make an integration agent, or keep both.

Assign roles in **Add-Agent** (Worker / Integrator checkboxes) or per-desk on the Command Center Floor roster. They persist in the registry; the **capability gate applies immediately** (read live), while the role's **prompt** re-injects on the desk's next (re)start. A desk can be a worker, an integrator, both, or neither.

Integration itself never hand-edits a repo — it uses one governed, registered-repo-scoped tool:
- **`hive_integrate { repo, branch, apply? }`** (allowed only with the **integrator** role): `apply` omitted/false **previews** (commits + diffstat vs base); `apply:true` **merges** into the repo's base branch. A **conflict aborts cleanly** and is reported, so the integrator routes the work back to the author. Get each desk's `repo` + `branch` from `hive_list_agents`.
- Flow: worker commits its slice + sets its card `review` → the **integrator** (the god by default, or a dedicated desk) `hive_integrate` (preview) → `apply:true` → `hive_update_task done`; conflicts go back to the worker. The god still **delegates** integration if it doesn't hold the role.
- Worktrees persist (§1), so integration is never blocked by an exited worker. A dedicated integrator agent is now first-class (assign the role); more roles (reviewer/tester) can be added later.

---

## Implementation map
- **Roles:** `packages/agent-core/src/coordination/types.ts` (`AgentRole`), `hive.ts` (`roles` on AgentMeta/registry, `ensureAgent` defaults, `setRoles`), `hiveTools.ts` (`canIntegrate`, `RosterEntry.roles`, board sign-off rule), `agentTools.ts` (`hive_integrate` gate), `index.ts` (`canIntegrate` dep, role-conditional `nativeGodPrompt` + `NATIVE_AGENT_INTEGRATOR_PROMPT` via `workerEnv`, `hive:setRoles` IPC), `agentWorker.ts` (prepend integrator prompt), `store.ts` (`Agent.roles` + `setAgentRoles`), `AddAgentModal.tsx` (role checkboxes), `CommandCenterPanel.tsx` (`AgentRoleControl`).
- **Status:** `src/renderer/src/hooks/useHive.ts` (status-from-events effect), `src/renderer/src/lib/agentStatus.ts` (`displayStatus`), `AgentStrip.tsx`/`AgentCard.tsx`, `CommandCenterPanel.tsx`, `NativeTranscriptView.tsx`.
- **Board + roster + integrate tool:** `packages/agent-core/src/toolkit/hiveTools.ts` (`hive_update_task`, `hive_list_agents`, `RosterEntry`, role rules), `agentToolCatalog.ts` (`hive_integrate` spec + worker preamble), `agentTools.ts` (`integrate` dep + handler), `coordination/types.ts` (`review`), `src/renderer/src/components/TasksKanban.tsx` (review column).
- **Worktrees + integration host wiring:** `src/main/git.ts` (`listWorktrees`, `previewMerge`, `mergeBranch`, `agentBranchFor`), `src/main/index.ts` (auto-isolate, keep-on-exit, `git:listWorktrees`/`git:removeWorktree` IPC, `roster()`/`isGod()`/`integrate()` deps, god prompt), `src/renderer/src/components/SettingsModal.tsx` (Worktrees panel).
