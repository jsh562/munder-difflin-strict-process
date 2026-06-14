# Orchestration model — As-is → To-be

How the hive coordinates work: agents & their working directories, status/control, delegation, integration, and the shared task board. Each section gives the **current** (shipped) behavior; "Later" notes call out what is still deferred.

Cast: **God** (`Michael`, the orchestrator — a singleton) and **workers** (DeepSeek/Minimax "native" desks, or Claude PTY desks). The god runs on the native runtime when the fleet default is a non-Anthropic model.

---

## 1. Agents & workspaces

- Every agent is created with one working directory (`cwd`), chosen in the Add-Agent dialog. **File access is two-axis (read wide, write narrow):** a desk may **READ** its own `cwd` *plus every registered repo + worktree + the whole hive home* (`<harnessHome>` — its own `memory.md`/`inbox`, `board.md`, `tasks.json`, and peers' dirs), so it can compare versions, read a peer's branch, or read its inbox. It may **WRITE** (`write_file`/`edit_file`) inside its own `cwd` (project code — gated by a code-editing role, see §5) **and** inside its own hive folder `<harnessHome>/hive/agents/<id>/` (`memory.md`, `inbox`, scratch — *ungated*, memory is everyone's). It may not write elsewhere; the shared `tasks.json`/`registry.json` change only through the hive tools (single-committer), so direct edits can't race the kanban. `bash` stays `cwd`-only + role-gated.
- **To split one project across agents:** spawn the collaborators **on the same repo**; each gets its own **git worktree** on an `agent/<id>` branch so parallel edits don't collide. This is **automatic** — a worker spawned into a repo that already hosts another agent is isolated for you; the **first** agent stays on the repo's main tree (the integration base), and the explicit "isolate" checkbox still forces it. Use separate repos only for genuinely separate projects.
- **Worktrees persist.** On agent exit the worktree + its branch are **kept** (committed work survives for the god to integrate); review and bulk-delete stale ones in **Settings → Worktrees**. (They are no longer force-removed on exit.)
- The **god** runs in its own neutral **home workspace** — `config.godWorkspace`, else `<harnessHome>/workspace` — separate from both the hive bookkeeping (`registry.json`, `board.md`, `tasks.json`, `agents/<id>/memory.md`, inboxes) and any worker's repo. It is a neutral base, *not* where the projects live: the god **reads** the project repos/worktrees to decompose + review, and only **edits** if the operator gives it a `worker`/`integrator` role (off by default → it delegates; see §5).
- Caveat: `bash` runs in a real shell, so when a desk *has* bash (a worker/integrator) it can reach outside its `cwd` for writes. The write sandbox is therefore partial for edit-capable desks; a role-less desk (god/reviewer/assistant) has no bash at all.
- **Later:** "god spawns workers on demand" (auto-provision a team into a project); retroactively isolating the *first* agent when a second arrives; tightening the `bash` write sandbox for workers.

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
- **Comments:** a `note` is recorded as an **attributed comment** `{ by, at, text }` on the card's thread (not a freeform `description` append), rendered on the kanban card and **embedded in the send-back ping** so the worker is handed the feedback directly.
- **Blocked-by:** a `blocked` card carries **`blockedBy`** — the task id(s) it's waiting on (set when marking it blocked; auto-cleared on unblock). The board shows it as a coral **"⛔ blocked by ＜title＞"** chip that jumps to the blocker. Distinct from `dependsOn` (planning-time ordering). Non-task blocks use a free-text `note` + a message to god.
- **Project + orphan triage:** a card carries **`project`** (the repo it belongs to), stamped from the assignee's repo when it's **assigned** (and re-stamped on a god reassign) — never on drift. The kanban flags a card with a coral **"⚠"** chip when its assignee no longer fits: **inactive** (archived/gone), **no edit role** (a `todo`/`doing`/`blocked` card on a desk holding neither worker nor integrator), or **off-project** (`repoFor(assignee) ≠ project`). The toolbar's **"fix assignments"** button (and a `Fix assignments` schedule template) dispatches the god to reassign each to a capable available desk, or **unassign** (→ `todo`) + flag when there's no fit or the assignee is inactive/lacks permission.
- **Ownership lanes** (no write races — the hive is single-committer, the convention keeps lanes clean):
  - **God owns** create, assign, and (with the role) **sign-off**.
  - **Workers own** progress on their own cards (up to `review`).
  - **Reviewers own** the `review` gate; 
  - **integrators own** the `integrate`→`done` merge + sign-off.
- **Validation loop**: a worker finishes its slice (**runs the tests**, records the result as a comment) → sets its card **`review`** → the project's **reviewer(s)** are auto-pinged, read it (read-only), confirm tests cover + pass, and either **approve** (→`integrate`) or **send it back** (→`doing`) → on `integrate` **one** project **integrator** is auto-pinged, **re-runs the suite as the merge gate**, merges the branch, and sets **`done`** (or sends it back). No worker self-declares done; "done" means tested.

```
todo ─(god assigns)─▶ doing ─(worker)─▶ review ─(reviewer approves)─▶ integrate ─(integrator merges)─▶ done
                        │                  │                              │
                        │                  └─(reviewer: back)─▶ doing     └─(integrator: back/reopen)─▶ doing
                        └─(worker: blocked + blockedBy)─▶ blocked
```
(reviewer + integrator default to the god, or dedicated desks holding those roles; pings are matched per project)

## 5. Roles: who writes, who reviews, who merges

Work moves through three **capability roles** (separate from the god/assistant *identity*) — each desk can hold any combination:
- **`worker`** — writes the code **and its tests**. Eligible for delegated implementation; the god assigns slices here. **Can edit code** (write_file/edit_file/bash).
- **`reviewer`** — reviews a `review` card and **comments only** — it is **read-only**: write_file/edit_file/bash are **denied**. It reads the branch, leaves a `hive_update_task` note, then **approves** (→`integrate`) or **sends back** (→`doing`). It never merges and never sets `done`.
- **`integrator`** — merges an `integrate` card's branch (`hive_integrate`) and **signs tasks off** (`done`). **Can edit code** — it runs the test suite as the merge gate and writes the code that resolves merge conflicts.

**The code-editing gate (`canEditCode`) = `worker` OR `integrator`.** A desk holding neither (a pure reviewer, the assistant, or an orchestrator-only god) is **write-disabled** — `write_file`/`edit_file`/`bash` are denied; it comments and delegates. (It can still **read** any project — see §1's two-axis access — so a hands-off god/reviewer reads the code to orchestrate/review without being able to change it.) This is the **god's delegation lever**: the **god holds `integrator` + `reviewer` by default** (so it merges out of the box), but because *both* worker and integrator grant editing, a god that should only orchestrate must have **both turned off** (leave `reviewer`) — then it physically cannot implement and must delegate. (The floor-roster role control shows this hint on the god.) Give the god the `worker` role to let it implement directly (solo mode).

Assign roles in **Add-Agent** (Worker / Reviewer / Integrator checkboxes) or per-desk via the desk's **gear → Desk options** modal. They persist in the registry; the **capability gate applies immediately** (read live), and changing a role **auto-restarts that desk** (~1s, debounced) so its role prompt re-injects — no app restart. A desk can hold any mix of worker/reviewer/integrator, or none.

Integration itself never hand-edits a repo (except to settle a conflict) — it uses one governed, registered-repo-scoped tool:
- **`hive_integrate { repo, branch, apply? }`** (allowed only with the **integrator** role): `apply` omitted/false **previews** (commits + diffstat vs base); `apply:true` **merges** into the repo's base branch. A **conflict aborts cleanly** and is reported, so the integrator either resolves it (conflict-only edits) or routes the work back to the author. Get each desk's `repo` + `branch` from `hive_list_agents`.
- Flow: worker tests + commits + sets card `review` → **reviewer** (auto-pinged) reads it and approves to `integrate` (or sends back) → **integrator** (auto-pinged) runs the suite, `hive_integrate` (preview) → `apply:true` → `hive_update_task done`; conflicts or red tests sent back. The god **delegates** review/integration for roles it doesn't hold.
- **Per-project routing:** the `→review` ping goes to **all** project reviewers (parallel review is fine — single-committer means only the first advance lands); the `→integrate` ping goes to **one** deterministic integrator (so two integrators don't double-merge). Both match the role-holder(s) **for the task's project** (via the assignee's repo — an isolated desk matches its worktree's *origin* repo), falling back to any holder, then **the god** (the standing fallback when no dedicated holder exists — it holds both roles by default and, as `isGod`, can advance any card).
- **Testing** lives in the pipeline, not a role: the **worker** runs the build/tests before `review` ("done" = tested), the **reviewer** verifies tests exist + cover + are green (read-only — it can't re-run), and the **integrator** re-runs the full suite as the **merge gate** before `apply`. A dedicated `tester` role can be added later if independent test authoring is wanted.
- Worktrees persist (§1) and a desk **reattaches** to its existing worktree on restart (so a role-toggle auto-restart never drops it into the shared tree); a workspace change to a different repo isolates at a repo-discriminated path, leaving the old worktree registered in its old repo. Dedicated reviewer + integrator agents are first-class (assign the role).

---

## Implementation map
- **Roles:** `packages/agent-core/src/coordination/types.ts` (`AgentRole` = worker/reviewer/integrator), `hive.ts` (`roles` on AgentMeta/registry, `ensureAgent` god default `['integrator','reviewer']`, `setRoles`), `hiveTools.ts` (`canIntegrate`/`canReview`, `RosterEntry.roles`, board rules), `agentTools.ts` (`canEditCode` reviewer read-only gate + `hive_integrate` gate), `index.ts` (`canIntegrate`/`canReview`/`canEditCode` deps, role-conditional `nativeGodPrompt` + `NATIVE_AGENT_REVIEWER_PROMPT`/`NATIVE_AGENT_INTEGRATOR_PROMPT` via `workerEnv`, `hive:setRoles` IPC), `agentWorker.ts` (prepend reviewer/integrator prompts), `store.ts` (`Agent.roles` + `setAgentRoles`), `AddAgentModal.tsx` (role checkboxes), `DeskOptionsModal.tsx`/`AgentRoleControl.tsx` (gear modal + chips + auto-restart via `scheduleDeskRestart`).
- **Status:** `src/renderer/src/hooks/useHive.ts` (status-from-events effect), `src/renderer/src/lib/agentStatus.ts` (`displayStatus`), `AgentStrip.tsx`/`AgentCard.tsx`, `CommandCenterPanel.tsx`, `NativeTranscriptView.tsx`.
- **Board + roster + integrate tool:** `packages/agent-core/src/toolkit/hiveTools.ts` (`hive_update_task` review/integrate rules + `note`→`HiveComment`, `hive_list_agents`, `RosterEntry`, `TASK_STATUSES`), `agentToolCatalog.ts` (`hive_integrate` spec + worker preamble flow incl. test-before-review), `agentTools.ts` (`integrate` dep + handler, `canEditCode`), `coordination/types.ts` (`review`/`integrate` statuses, `HiveComment`/`comments[]`), `src/renderer/src/components/TasksKanban.tsx` (review + integrate columns, comment render).
- **Notifications (per-project):** `src/main/hive.ts` (`repoFor` resolver + `setRepoResolver`, `roleHoldersForTask`/`roleHolderForTask`, `notifyTaskTransitions`: `→review`→all reviewers, `→integrate`→ONE integrator, send-back embeds the newest comment, unblock→assignee, god fallback when no holder), `src/main/index.ts` (`setRepoResolver` wired from `worktreeOrigins`).
- **Worktrees + integration host wiring:** `src/main/git.ts` (`listWorktrees`, `previewMerge`, `mergeBranch`, `agentBranchFor`), `src/main/index.ts` (`provisionWorktree` reattach-or-isolate + cross-repo hashed path, keep-on-exit, `git:listWorktrees`/`git:removeWorktree` IPC, `roster()`/`isGod()`/`integrate()` deps, god/reviewer/integrator prompts incl. test gate), `src/renderer/src/components/SettingsModal.tsx` (Worktrees panel).
