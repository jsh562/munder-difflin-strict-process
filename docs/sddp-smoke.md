# SDDP smoke test — run the full pipeline end-to-end without touching your real project

There are two ways to exercise the host-driven SDDP engine end-to-end. Use both — they cover
different layers.

## 1. Automated (no app, no API, nothing permanent)

```
npm run test:e2e        # both suites, one ✓ line per case  (SDDP_E2E_TRACE=1 for a per-milestone trace)
```

Two complementary suites run against a throwaway `git init` repo in the OS temp dir, then delete it.
Deterministic, free, repeatable.

- **`src/main/__tests__/sddpPipelineE2e.test.ts`** (12 cases) — the engine over **real** `git.ts`
  (`prepareQcTree` does an actual `git worktree add` + merges) + **real** fs, driven by a COARSE
  scripted provider (each sub-agent just writes the artifact it would). Broad + fast: it sweeps every
  engine branch (happy → integrate, merge-conflict, the bug loop with `[RECURRING]`, analyze-CRITICAL,
  optional-skip, clarify autopilot-OFF, the control paused/manual/stopped + idempotent + in-flight-lock
  paths).
- **`src/main/__tests__/sddpFullStack.test.ts`** (16 cases) — the FULL composed stack with **only the
  provider faked**: engine → `makeSpawnSubAgent` (deny-list + cwd-override) → `runOneShotSubAgent` →
  `NativeAgentWorker` → the **real `runAgentLoop`** → the **real toolkit** (`executeAgentTool`) → real
  fs/git. Each specialist READS before it authors; the QC sub-agents' bash + write run cwd-OVERRIDDEN
  into the merged worktree; genuine tool failures are fed back and the loop recovers; the **real
  DeepSeek + Minimax adapters** are each driven over a mocked SSE stream (request-build + SSE parse +
  reasoning composed, only the socket faked); a single turn returning **multiple tool calls** runs them
  all; **every one of the 20 registered sub-agents** is spawned and its write is allowed/denied per its
  role; the integrator's **real `hive_integrate` git merge** lands on trunk; and a **persistent desk**
  runs two turns through the real loop with a `block:true` drain continuation + cross-turn memory.

### Coverage matrix — what the automated suites actually exercise

| Layer / behavior | Status | Where / why |
|---|---|---|
| Engine lifecycle + every branch (clarify/analyze/optional/conflict/recurring/control) | **COVERED-COMPOSED** | both suites |
| Real git worktree (`prepareQcTree`) + merge + integrator `hive_integrate` merge to trunk | **COVERED-COMPOSED** | E2E + full-stack #12 |
| One-shot sub-agent loop (`runOneShotSubAgent` → `runAgentLoop`) | **COVERED-COMPOSED** | full-stack |
| Persistent desk loop: multi-turn + `block:true` drain continuation + cross-turn memory | **COVERED-COMPOSED** | full-stack #16 |
| Real toolkit: read_file / list_dir / grep / write_file / edit_file / bash / hive_* / write_memory / web_search | **COVERED-COMPOSED** | full-stack |
| cwd-override (QC sub-agents act in the merged tree) + specs/ redirect | **COVERED-COMPOSED** | full-stack #1 |
| Deny-list + role gating for **all 20** registered sub-agents | **COVERED-COMPOSED** | full-stack #15 |
| Tool-execution failure → fed back → loop recovers (not a deny refusal) | **COVERED-COMPOSED** | full-stack #10 |
| Multiple tool-uses in one provider turn | **COVERED-COMPOSED** | full-stack #13 |
| DeepSeek adapter wire-level (request build, SSE parse, reasoning→thinking) | **COVERED-COMPOSED** | full-stack #11 |
| Minimax adapter wire-level (Anthropic-style SSE, tool_use assembly) | **COVERED-COMPOSED** | full-stack #14 |
| Provider retry/circuit-breaker + capability-gate internals | UNIT-ONLY | `reliability`/`capabilityGate`/adapter tests |
| deskEnv / secrets-vault / proxy env assembly | UNIT-ONLY | `index.ts` builds the spawn env (electron-coupled); see deskEnv/secrets unit tests |
| Per-sub-agent telemetry breakdown | UNIT-ONLY | composed test asserts the rollup fires; `telemetryNormalize`/`costVectors` test the accounting |
| **The native worker process** (`agentWorker.ts` utilityProcess) + `NativeRuntime.spawn()` lifecycle | **SANDBOX-ONLY** | electron-coupled (`process.parentPort`; `spawn` hardcodes the electron transport) — vitest can't fork a utilityProcess, so the composed tests run the loop in-process |
| **God creates the epic + worker→reviewer→integrator ping choreography** | **SANDBOX-ONLY** | both suites hand-seed the epic; the notifier dance needs live desks |
| **Whether the prompts elicit correct behavior** | **SANDBOX-ONLY** | the stub ignores each sub-agent's `systemPrompt` — only a live model tests prompt efficacy. The irreducible one. |

### The ceiling (SANDBOX-ONLY) — exercise these in section 2

The three SANDBOX-ONLY rows above are the irreducible boundary, not coverage holes: the **electron
worker + `NativeRuntime` lifecycle** (real child process + IPC), the **god/notifier orchestration**
(live desks moving cards `doing → review → integrate → done`), and **prompt efficacy** (does a
specialist's prompt actually make a real model do the right thing). No vitest test can close these —
run the live disposable sandbox below.

## 2. Live disposable sandbox (real DeepSeek desk, throwaway state)

This runs the *actual* app + a real provider, but every byte it creates lives under a temp
`harnessHome` you delete afterward. Nothing touches `S:\md\numrs` or your real `S:\munderdiff` hive.

### Why it's safe
Everything the harness creates is derived from `harnessHome`:
`<harnessHome>/hive` (registry/board/tasks/memory), `<harnessHome>/worktrees`,
`<harnessHome>/qc-worktrees`, `<harnessHome>/build-cache`. Point `harnessHome` at a temp dir and the
whole run is isolated there.

### Steps
1. **Note your real home.** Settings → it shows the current `harnessHome` (e.g. `S:\munderdiff`). Write
   it down — you'll switch back at the end.
2. **Make a throwaway repo.** A tiny git project with one trivial passing test, e.g.:
   ```
   mkdir S:\tmp\sddp-scratch && cd S:\tmp\sddp-scratch
   git init -b main
   # add a minimal project with ONE fast test (e.g. a package.json + a passing test, or a Cargo crate
   # with one #[test]). Keep it tiny so QC's build/test is seconds, not minutes.
   git add . && git commit -m init
   ```
3. **Switch the harness to a temp home.** Settings → **Change home folder** → pick e.g.
   `S:\tmp\sddp-home` → mode **fresh**. The app relaunches; hive + worktrees + qc-worktrees +
   build-cache now all live under `S:\tmp\sddp-home`.
4. **Register the scratch repo.** Settings → Project repos → add `S:\tmp\sddp-scratch`.
5. **Turn on the engine, unattended.** Settings → enable **SDDP mode** + **autopilot** (autopilot
   auto-resolves the Clarify human-gate so it runs without you). Add a **DeepSeek** API key (Settings →
   credentials), then spawn a **DeepSeek desk** with roles `planner` + `worker` + `qc` + `integrator`
   (one desk holding all of them is fine for a smoke).
6. **Kick it off.** Give the god (Michael) a one-line feature request, e.g. *"Add a function that
   returns the nth Fibonacci number, with a test."* The god creates the feature epic card; the engine
   takes over.
7. **Watch the pills.** On the Tasks board, the feature's milestone pills should advance
   `spec → clarify → … → analyze → implement → qc → done`. Inspect what got created under the scratch
   repo (`specs/<feature>/spec.md`, `plan.md`, `tasks.md`, `analysis-report.md`, `qc-report.md`,
   `.qc-passed`) and the QC tree under `S:\tmp\sddp-home\qc-worktrees\`.
8. **Tear down.** Settings → **Change home folder** → back to your real `harnessHome` (from step 1),
   mode **move** or **fresh** (it just re-binds). Then delete `S:\tmp\sddp-home` and
   `S:\tmp\sddp-scratch`. Done — your real project and hive were never touched.

### What to watch for (failure modes)

| Symptom on the board / logs | Cause | Fix |
|---|---|---|
| Desk shows **needs credentials** | DeepSeek key not set for the desk's provider | Settings → add the key, respawn the desk |
| Engine **escalates "no usable native owner"** | the epic isn't assigned to a spawned non-Claude desk with a model | assign the epic to the DeepSeek desk (or let auto-assign pick a `planner`) |
| Stuck at **Clarify** (status *awaiting clarification*) | autopilot is OFF (human-gated) | turn on autopilot, or answer + advance the clarify milestone |
| **Analyze** holds, `analysis-report.md` shows `critical: N` | a requirement has no task, or policy-auditor FAILed | fix the gap (add a task / resolve the violation), delete the report to re-analyze, or set Analyze to manual |
| **Implement** won't start, status *checklist k/total* | checklist items unresolved | resolve the items in `specs/<feature>/checklists/`, or autopilot proceeds |
| **QC** holds, status *merge conflicts* | implement branches conflict | route those branches back to their authors to rebase, then re-run |
| **QC** holds, `[BUG]` cards filed | the suite failed in the merged tree | workers fix the bug cards; QC re-runs when they're all closed; `[ESCALATED]`/`[DEFERRED]` tags appear by attempt |

### Notes
- A native desk with **no key/model** falls back to a stub provider that makes no API calls — but the
  stub won't author real artifacts, so the gates won't pass. A *dry* (no-cost) full run is the
  automated test (option 1), not the sandbox.
- The build-cache redirect means QC/build output lands under `<temp home>/build-cache` — exclude that
  one folder from antivirus if a real build (e.g. cargo) trips it.
