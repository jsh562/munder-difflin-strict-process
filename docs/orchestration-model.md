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
todo ──(god assigns)──▶ doing ──(worker)──▶ review ──(god verifies+integrates)──▶ done
                          │                                  │
                          └──(worker: blocked)──▶ blocked    └──(god: reopen)──▶ doing
```

## 5. Integration (who merges the work)

Workers do slices in their own worktree branches; **the god integrates** them — its high-leverage job, *not* implementation. The god has no write access to any repo and never hand-edits; instead it uses one governed, registered-repo-scoped tool:

- **`hive_integrate { repo, branch, apply? }`** (god-only, rejected for workers): `apply` omitted/false **previews** (the commits + diffstat the branch brings vs the repo's base); `apply:true` **merges** the branch into the repo's base branch. A **conflict aborts cleanly** (the tree is left untouched) and is reported, so the god routes the work back to the author. The god gets each desk's `repo` + `branch` from `hive_list_agents`.
- Flow: worker commits its slice + sets its card `review` → god `hive_integrate` (preview) → if good, `hive_integrate apply:true` → `hive_update_task done`; if conflicted/insufficient, send it back to the worker.
- **For now the god is the integrator.** A dedicated **integrator agent** is a possible later step; the worktrees persist (§1), so integration is never blocked by an exited worker.

---

## Implementation map
- **Status:** `src/renderer/src/hooks/useHive.ts` (status-from-events effect), `src/renderer/src/lib/agentStatus.ts` (`displayStatus`), `AgentStrip.tsx`/`AgentCard.tsx`, `CommandCenterPanel.tsx`, `NativeTranscriptView.tsx`.
- **Board + roster + integrate tool:** `packages/agent-core/src/toolkit/hiveTools.ts` (`hive_update_task`, `hive_list_agents`, `RosterEntry`, role rules), `agentToolCatalog.ts` (`hive_integrate` spec + worker preamble), `agentTools.ts` (`integrate` dep + handler), `coordination/types.ts` (`review`), `src/renderer/src/components/TasksKanban.tsx` (review column).
- **Worktrees + integration host wiring:** `src/main/git.ts` (`listWorktrees`, `previewMerge`, `mergeBranch`, `agentBranchFor`), `src/main/index.ts` (auto-isolate, keep-on-exit, `git:listWorktrees`/`git:removeWorktree` IPC, `roster()`/`isGod()`/`integrate()` deps, god prompt), `src/renderer/src/components/SettingsModal.tsx` (Worktrees panel).
