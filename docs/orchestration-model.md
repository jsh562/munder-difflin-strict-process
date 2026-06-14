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
- Statuses: `todo | doing | blocked | review | integrate | done`.
- **`hive_update_task`** `{ id, status?, assignee?, title?, priority?, note?, blockedBy? }`, **role-enforced**:
  - **Worker** — may update only a card **assigned to itself**, and only to `doing` / `blocked` / `review` (submit for review). It may **not** advance past `review`, set `done`, or reassign.
  - **Reviewer** — on a card in `review` (even if not the assignee) may add a `note` and either **approve** it to `integrate` or **send it back** to `doing`. It may not merge or set `done`.
  - **Integrator** — advances `integrate` cards, sets **`done`**/reopen.
  - **God** — may update **any** card to **any** status, plus reassign and reprioritize.
- **Blocked-by:** a `blocked` card carries **`blockedBy`** — the task id(s) it's waiting on (set when marking it blocked; auto-cleared on unblock). The board shows it as a coral **"⛔ blocked by ＜title＞"** chip that jumps to the blocker. Distinct from `dependsOn` (planning-time ordering). Non-task blocks use a free-text `note` + a message to god.
- **Ownership lanes** (no write races — the hive is single-committer, the convention keeps lanes clean):
  - **God owns** create, assign, and (with the role) **sign-off**.
  - **Workers own** progress on their own cards (up to `review`).
  - **Reviewers own** the `review` gate; **integrators own** the `integrate`→`done` merge + sign-off.
- **Validation loop**: a worker finishes its slice → sets its card **`review`** → the project's **reviewer** is auto-pinged, reads it (read-only) and either **approves** (→`integrate`) or **sends it back** (→`doing`) → on `integrate` the project's **integrator** is auto-pinged, merges the branch, and sets **`done`** (or sends it back). No worker self-declares done.

```
todo ─(god assigns)─▶ doing ─(worker)─▶ review ─(reviewer approves)─▶ integrate ─(integrator merges)─▶ done
                        │                  │                              │
                        │                  └─(reviewer: back)─▶ doing     └─(integrator: back/reopen)─▶ doing
                        └─(worker: blocked + blockedBy)─▶ blocked
```
(reviewer + integrator default to the god, or dedicated desks holding those roles; pings are matched per project)

## 5. Roles: who writes, who reviews, who merges

Work moves through three **capability roles** (separate from the god/assistant *identity*) — each desk can hold any combination:
- **`worker`** — writes the code. Eligible for delegated implementation; the god assigns slices here. **Can edit code** (write_file/edit_file/bash).
- **`reviewer`** — reviews a `review` card and **comments only** — it is **read-only**: write_file/edit_file/bash are **denied** for a pure reviewer. It reads the branch, leaves a `hive_update_task` note, then **approves** (→`integrate`) or **sends back** (→`doing`). It never merges and never sets `done`.
- **`integrator`** — merges an `integrate` card's branch (`hive_integrate`) and **signs tasks off** (`done`). May edit **only to resolve a merge conflict**. The **god holds `integrator` + `reviewer` by default**; both are **reassignable** — un-toggle on the god and toggle on a dedicated desk, or keep both.

Assign roles in **Add-Agent** (Worker / Reviewer / Integrator checkboxes) or per-desk via the desk's **gear → Desk options** modal. They persist in the registry; the **capability gate applies immediately** (read live), and changing a role **auto-restarts that desk** (~1s, debounced) so its role prompt re-injects — no app restart. A desk can hold any mix of worker/reviewer/integrator, or none.

Integration itself never hand-edits a repo (except to settle a conflict) — it uses one governed, registered-repo-scoped tool:
- **`hive_integrate { repo, branch, apply? }`** (allowed only with the **integrator** role): `apply` omitted/false **previews** (commits + diffstat vs base); `apply:true` **merges** into the repo's base branch. A **conflict aborts cleanly** and is reported, so the integrator either resolves it (conflict-only edits) or routes the work back to the author. Get each desk's `repo` + `branch` from `hive_list_agents`.
- Flow: worker commits + sets card `review` → **reviewer** (auto-pinged) reads it and approves to `integrate` (or sends back) → **integrator** (auto-pinged) `hive_integrate` (preview) → `apply:true` → `hive_update_task done`; conflicts resolved or sent back. The god **delegates** review/integration for roles it doesn't hold.
- **Per-project routing:** the `→review` and `→integrate` pings go to the role-holder(s) **for the task's project** (matched via the assignee's repo — an isolated desk matches its worktree's *origin* repo), falling back to any holder, then the god.
- Worktrees persist (§1), so integration is never blocked by an exited worker. Dedicated reviewer + integrator agents are first-class (assign the role); more roles (e.g. tester) can be added later.

---

## Implementation map
- **Roles:** `packages/agent-core/src/coordination/types.ts` (`AgentRole` = worker/reviewer/integrator), `hive.ts` (`roles` on AgentMeta/registry, `ensureAgent` god default `['integrator','reviewer']`, `setRoles`), `hiveTools.ts` (`canIntegrate`/`canReview`, `RosterEntry.roles`, board rules), `agentTools.ts` (`canEditCode` reviewer read-only gate + `hive_integrate` gate), `index.ts` (`canIntegrate`/`canReview`/`canEditCode` deps, role-conditional `nativeGodPrompt` + `NATIVE_AGENT_REVIEWER_PROMPT`/`NATIVE_AGENT_INTEGRATOR_PROMPT` via `workerEnv`, `hive:setRoles` IPC), `agentWorker.ts` (prepend reviewer/integrator prompts), `store.ts` (`Agent.roles` + `setAgentRoles`), `AddAgentModal.tsx` (role checkboxes), `DeskOptionsModal.tsx`/`AgentRoleControl.tsx` (gear modal + chips + auto-restart via `scheduleDeskRestart`).
- **Status:** `src/renderer/src/hooks/useHive.ts` (status-from-events effect), `src/renderer/src/lib/agentStatus.ts` (`displayStatus`), `AgentStrip.tsx`/`AgentCard.tsx`, `CommandCenterPanel.tsx`, `NativeTranscriptView.tsx`.
- **Board + roster + integrate tool:** `packages/agent-core/src/toolkit/hiveTools.ts` (`hive_update_task` review/integrate rules, `hive_list_agents`, `RosterEntry`, `TASK_STATUSES`), `agentToolCatalog.ts` (`hive_integrate` spec + worker preamble flow), `agentTools.ts` (`integrate` dep + handler, `canEditCode`), `coordination/types.ts` (`review`/`integrate` statuses), `src/renderer/src/components/TasksKanban.tsx` (review + integrate columns).
- **Notifications (per-project):** `src/main/hive.ts` (`repoFor` resolver + `setRepoResolver`, `roleHoldersForTask`, `notifyTaskTransitions`: `→review`→reviewers, `→integrate`→integrator, send-back/unblock→assignee), `src/main/index.ts` (`setRepoResolver` wired from `worktreeOrigins`).
- **Worktrees + integration host wiring:** `src/main/git.ts` (`listWorktrees`, `previewMerge`, `mergeBranch`, `agentBranchFor`), `src/main/index.ts` (auto-isolate, keep-on-exit, `git:listWorktrees`/`git:removeWorktree` IPC, `roster()`/`isGod()`/`integrate()` deps, god prompt), `src/renderer/src/components/SettingsModal.tsx` (Worktrees panel).
