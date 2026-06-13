# Orchestration model — As-is → To-be

How the hive coordinates work: agents & their working directories, status/control, delegation, and the shared task board. Each section states the **current** behavior and the **target** this change moves toward. The "to-be" items map to Parts A/B of the implementation.

Cast: **God** (`Michael`, the orchestrator — a singleton) and **workers** (DeepSeek/Minimax "native" desks, or Claude PTY desks). The god runs on the native runtime when the fleet default is a non-Anthropic model.

---

## 1. Agents & workspaces

**As-is**
- Every agent is created with one working directory (`cwd`), chosen in the Add-Agent dialog. Its file tools (`read_file`/`write_file`/`edit_file`/`bash`/`grep`/`list_dir`) are sandboxed to that `cwd`.
- Multiple agents can point at the **same repo**; the dialog's **"isolate"** option gives each its own **git worktree** (an `agent/<id>` branch) so parallel edits don't collide.
- The **god** runs in its own neutral **scratch workspace** — `config.godWorkspace`, else `<harnessHome>/workspace` — deliberately separate from both the hive bookkeeping (`registry.json`, `board.md`, `tasks.json`, `agents/<id>/memory.md`, inboxes) and any worker's repo, so it can't corrupt state or clobber code.
- Caveat: `bash` runs in a real shell, so it can currently reach outside the sandboxed `cwd` (the god read its own inbox via `ls`/`cat`). Sandbox isolation is therefore partial.

**To-be**
- Same model, documented as the **recommended pattern**: to split one project across agents, spawn the collaborators **on that repo, each with "isolate"**; the god decomposes, assigns slices, and integrates via the workers (it does not edit the repo itself). Use separate repos only for genuinely separate projects.
- Deferred: "god spawns workers on demand" (auto-provision a team into a project), and tightening the `bash` sandbox.

## 2. Status & control

**As-is**
- A native desk's `agent.status` in the store is **never driven by its event stream** — only the transcript fold (`useNativeAgentEvents`, per-mounted panel) knows a turn is open. So the badge/card show **"idle" while the god is working**.
- **Pause** (`control.pause`) only denies the next tool call; it emits no terminal event, so the transcript keeps blinking **"working…"**.
- **Stop** kills the worker and emits a synthetic `stop` event (so the transcript settles), and clears the strip card — but the badge/card otherwise read the frozen store status.
- Revive-on-demand + Stop/Start + Pause already exist (a stopped god stays down across reloads until Start; a stopped worker revives on the next delegation/message).

**To-be** (Part A)
- A single global subscription drives `agent.status` from native events: `turn-start → working`, `turn-end`/`stop → idle` (skipped while paused / god-stopped / breaker-armed).
- One `displayStatus(agent, paused, godDesired)` derivation feeds the badge, the strip card, and the transcript: **god-stopped → idle/stopped**, **paused → waiting/paused**, **streaming → working**, else **idle**.
- The transcript's "working…" indicator is gated on `pendingTurn && !paused && !stopped`; paused/stopped show a small status line instead.

## 3. Delegation

**As-is**
- The god delegates with **`hive_send_message`** — the actual dispatch into a worker's inbox. (The Tasks tab's "assign" button just pre-fills a message *to the god*; all human dispatch routes through the god.)
- A worker is woken to act on inbox mail by the renderer's inbox-wake loop; its end-of-turn drain delivers the message content.
- The god is **blind to the roster**: a native god has no file access to `fleet.json`/`registry.json`, so it can't see who exists, who's alive, or who's free.

**To-be** (Part B)
- Add **`hive_list_agents`** — a host-mediated roster (`id, name, role, archived, isGod/isAssistant, running`) so the god picks the best available desk instead of delegating blind.
- The god's loop: at turn start, read the **roster** and the **board**, **decompose** a request into slices, create one **task card per slice** assigned to a desk, and **`hive_send_message`** each. It can split parts of one task across desks, assign whole tasks to different desks, and re-route when a desk is blocked.

## 4. The task board (`tasks.json` → Tasks tab)

**As-is**
- The board is a shared ledger of `HiveTask` rows (`todo | doing | blocked | done`). Agents have **`hive_add_task`** (append) and **`hive_list_tasks`** (read) only — **no update**. Cards therefore only change when the **human** drags them in the kanban, so the board **drifts** from reality.
- Messages move work; the board is meant to record it — but today it's effectively a static to-do list the god seeds and the human maintains.

**To-be** (Part B) — a living, single-source-of-truth board with a role protocol:
- Add a **`review`** status: `todo | doing | blocked | review | done`.
- Add **`hive_update_task`** `{ id, status?, assignee?, title?, priority?, note? }`, **role-enforced**:
  - **Worker** — may update only a card **assigned to itself**, and only to `doing` / `blocked` / `review`. It may **not** set `done` or reassign.
  - **God** — may update **any** card to **any** status, including `done`/reopen, plus reassign and reprioritize.
- **Ownership lanes** (no write races — the hive is single-committer, the convention keeps lanes clean):
  - **God owns** create, assign, and **sign-off**.
  - **Workers own** progress on their own cards.
- **Validation loop**: a worker finishes → sets its card **`review`** and pings the god → the **god verifies the deliverable** → sets **`done`** (or reopens to `doing`). No worker self-declares done; the god confirms.

```
todo ──(god assigns)──▶ doing ──(worker)──▶ review ──(god verifies)──▶ done
                          │                                  │
                          └──(worker: blocked)──▶ blocked    └──(god: reopen)──▶ doing
```

---

## Implementation map
- **Part A — status:** `src/renderer/src/hooks/useHive.ts` (status-from-events effect), a `displayStatus` helper, `AgentStrip.tsx`/`AgentCard.tsx`, `CommandCenterPanel.tsx`, `NativeTranscriptView.tsx`.
- **Part B — board + roster:** `packages/agent-core/src/toolkit/hiveTools.ts` (catalog + dispatcher + role rules), `packages/agent-core/src/coordination/types.ts` (`review`), `src/renderer/src/components/TasksKanban.tsx` (review column), `src/main/index.ts` (`roster()`/`isGod()` deps + god prompt), `src/main/hive.ts` (orchestrator role), worker preamble in `packages/agent-core/src/toolkit/agentToolCatalog.ts`.
