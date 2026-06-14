import { app, BrowserWindow, clipboard, dialog, ipcMain, powerSaveBlocker, screen, shell, Notification } from 'electron';
import { spawn } from 'node:child_process';
import { rmSync, existsSync, readFileSync, readdirSync, statSync, cpSync, mkdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { PtyManager, type SpawnOptions } from './pty';
import {
  readConfig, writeConfig, resetConfig, ensureHarnessHome, ensureClaudePermissionsAccepted,
  modelForRole, OPS_STANDUP_MISSION, HEARTBEAT_MISSION, type HarnessConfig, type ScheduledMission
} from './config';
import { listDir, readFileText, writeFileText } from './fs';
import {
  getBranch, getStatus, getLog, getBranches, getAheadBehind, isRepo,
  addWorktree, removeWorktree, listWorktrees, planWorktree, type GitWorktree,
  previewMerge, mergeBranch, agentBranchFor
} from './git';
import { HiveManager, roleCanEditCode, type AgentMeta, type HiveMessage, type HiveTask, type AgentRole } from './hive';
import { HookServer } from './hooks';
import { CircuitBreaker, type BreakerInput } from './breaker';
import type { UsageProvider } from './usage';
import { MemoryManager } from './memory';
import { MemoryReflector, type ReflectSettings } from './reflect';
import { PersistStore } from './db';
import { enrichMessage } from './assistant';
import { readAgentUsage, readContextTokens } from './transcript';
import { listIssues, listCIRuns } from './github';
import { SlackWebhookServer } from './slack';
import { TelemetryCollector } from './telemetry';
import { ControlRegistry } from './control';
import { ClaudeRuntime } from './runtime/claudeRuntime';
import { NativeRuntime } from './runtime/nativeRuntime';
import { createNativeEventBridge, loadNativeEvents } from './runtime/nativeEventBridge';
import { executeAgentTool, type AgentToolDeps, type FeatureStatus } from '@jsh562/agent-core';
import { redactConfig, injectionEnvForProvider, keyPresence, setKeyInConfig, clearKeyInConfig, WEB_SEARCH_KEY_ID, type SafeConfig } from './credentials';
import { searchWebDuckDuckGo } from './webSearch';
import { resolveBashEnv, describeBashEnv } from './bashShell';
import { listProviders } from '../shared/providerRegistry';
import { deriveProviderId } from '../shared/assignment';
import type { AgentInput } from '../shared/providerRuntime';

const isDev = !!process.env.ELECTRON_RENDERER_URL;
const ptyManager = new PtyManager();
/** Live PTY id → its hive agent id, recorded at spawn. The pty:kill handler only
 *  gets the PTY id, so this lets a closed tab archive the right registry agent. */
const ptyToAgent = new Map<string, string>();
/** E005 {FR-008} — agent id → the providerId DERIVED from the model the agent was
 *  spawned with (explicit `--model` → defaultModel → role-based). Provider is
 *  DERIVED from the model via the E002 registry, NOT stored on the agent record
 *  (DR-1). Recorded at the spawn seam so the E006 native runtime
 *  (`nativeRuntime.spawn(agentId, providerId?)`) can consume it; E005 records only
 *  — it does not wire native execution. Absent ⇒ unresolvable/role-based model. */
const agentProviderIds = new Map<string, string>();
/** E005 {FR-008} — the providerId derived from an agent's spawned model, or
 *  `undefined` when none resolved (role-based/unresolvable). The E006 native
 *  runtime seam reads this to call `nativeRuntime.spawn(agentId, providerId)`. */
export function providerIdForAgent(agentId: string): string | undefined {
  return agentProviderIds.get(agentId);
}

/** E005 {FR-013 / DR-10} — the GOD assignment seam. Records a programmatic
 *  per-agent provider+model assignment and forwards it to the renderer to apply
 *  through the SAME agent-update path the operator uses (the renderer store's
 *  `reassignAgentModel`, which writes `model` + `assignmentSource='explicit'` and
 *  persists). Provider is DERIVED from the model id, NEVER stored on the record
 *  (DR-1): here it is only recorded in `agentProviderIds` for the E006 native
 *  runtime seam, exactly like the spawn path. No separate programmatic path and no
 *  secret channel — same persistence + warning behavior as an operator pick (the
 *  renderer's ProviderModelPicker surfaces the capability-gap warning on the next
 *  open). `modelId` undefined/blank is rejected (an assignment must name a model);
 *  a stale id is forwarded verbatim and preserved+flagged by the renderer, never
 *  remapped (DR-5).
 *
 *  GOD invokes this via the `agent:assign` IPC channel (see the handler below) or
 *  by importing this function in-process. Returns the derived providerId (or null
 *  for an unresolvable/stale model — still recorded as a pending assignment). */
export function assignAgentModel(agentId: string, modelId: string | undefined):
  { ok: boolean; providerId: string | null; error?: string } {
  if (typeof agentId !== 'string' || !agentId.trim()) {
    return { ok: false, providerId: null, error: 'agentId required' };
  }
  const id = (modelId ?? '').trim();
  if (!id) return { ok: false, providerId: null, error: 'modelId required' };
  // Derive + record the provider for the E006 native runtime seam (DR-1); a stale
  // model derives null and records nothing, but the assignment still forwards.
  const providerId = deriveProviderId(id);
  if (providerId) agentProviderIds.set(agentId, providerId);
  else agentProviderIds.delete(agentId);
  // Forward to the renderer to apply via the existing agent-update path. The
  // renderer's useHive subscriber calls reassignAgentModel(agentId, id), so the
  // GOD path writes the SAME fields and persists the SAME way as an operator pick.
  // (Distinct channel from the `agent:assign` INVOKE handler — this is the push.)
  try { liveWebContents()?.send('agent:assigned', { agentId, modelId: id }); }
  catch { /* window tore down — the recorded providerId still stands */ }
  return { ok: true, providerId };
}
const hive = new HiveManager(
  () => readConfig().harnessHome,
  (channel, payload) => { try { liveWebContents()?.send(channel, payload); } catch { /* window tore down */ } }
);
// #7C — operator control state (pause/gate/steer/halt), read by the HookServer
// when deciding hook returns.
const control = new ControlRegistry();
// Stage 7A — the live observability tap. Receives Claude Code's first-party OTel
// over loopback OTLP/JSON and exposes the locked usage-provider seam. resolveCwd
// lets the transcript fallback find an agent's cwd from the hive registry.
const telemetry = new TelemetryCollector({
  emit: (channel, payload) => { try { liveWebContents()?.send(channel, payload); } catch { /* window tore down */ } },
  resolveCwd: (agentId) => hive.registry().agents[agentId]?.cwd ?? null
});
// Usage provider (Seam 1) — the INTEGRATION swap: Oscar's telemetry collector (#7)
// IS the provider, replacing Lane A's interim StubUsageProvider. Same
// getAgentUsage(agentId) pull seam, so the breaker + cost ledger consumers are
// untouched; telemetry has a transcript fallback built in, so it works before any
// live OTel arrives.
const usageProvider: UsageProvider = telemetry;
// Circuit breaker (Lane A #6.6b) — the REAL policy (replaces Lane C's interim
// glue). POLICY only; the heartbeat beat feeds it signals (via usageProvider) +
// enforces its decisions. Config read live so a settings change applies next beat.
const breaker = new CircuitBreaker(() => {
  const c = readConfig();
  return { ...(c.circuitBreaker ?? {}), costCapUsd: c.costCapUsd, costCapTokens: c.costCapTokens, agentTokenCaps: c.agentTokenCaps };
});
// Always-on beats (decoupled from the optional heartbeat): the live fleet snapshot
// Michael reads + the breaker beat, so guardrails + monitoring work even when the
// heartbeat mission is disabled (it ships off).
let fleetTimer: ReturnType<typeof setInterval> | null = null;
let breakerBeatTimer: ReturnType<typeof setInterval> | null = null;
// Feed the breaker's api_error-storm trip from Oscar's OTel api_error spans —
// Jim's one breaker input with no on-branch source (telemetry.onApiError seam).
telemetry.onApiError((agentId) => breaker.recordError(agentId));
// E001 — provider-runtime seam: one Claude adapter per agent behind the
// ProviderRuntime port, fed additively by the hook + PTY signals below. The
// adapter emits the normalized AgentEvent stream; the translator can reproduce
// the legacy hive:hookEvent payload but its live send stays OFF here, so the
// existing IPC + autonomy paths are byte-identical (zero behavior change).
const claudeRuntime = new ClaudeRuntime({
  usage: usageProvider,
  ptyWrite: (id, text) => { ptyManager.write(id, text); },
  ptyKill: (id) => { ptyManager.kill(id); },
  sessionIdFor: (id) => hive.registry().agents[id]?.sessionId ?? null
});
ptyManager.setDataObserver((id, data) => claudeRuntime.ingestPtyData(id, data));
// HookServer needs BOTH: Oscar's control registry (HITL pause/gate/steer/halt via
// hook returns) AND Jim's breaker (feed recordToolUse on each PostToolUse).
const hookServer = new HookServer(
  hive, () => liveWebContents(), () => readConfig(), control, breaker,
  (p) => claudeRuntime.ingestHook(p)
);
const memory = new MemoryManager(
  () => readConfig().harnessHome,
  () => { const c = readConfig(); return { enabled: c.semanticMemory !== false, model: c.embeddingModel ?? 'minilm' }; }
);
/** Reads the reflect tunables from config each tick (defaults baked in here so a
 *  pre-existing config.json without the keys still gets sane values). */
function reflectSettings(): ReflectSettings {
  const c = readConfig();
  return {
    enabled: c.reflectEnabled !== false,
    intervalMs: c.reflectIntervalMs ?? 1_800_000,
    byteTriggerPct: c.reflectByteTriggerPct ?? 50,
    sectionTrigger: c.reflectSectionTrigger ?? 50,
    recentKeep: c.reflectRecentKeep ?? 12,
    minBytes: c.reflectMinBytes ?? 16_384
  };
}
// Finishes the janitor's missing condense half: bounds each agent's memory.md
// (Haiku tail-summary, backup→verify→atomic-swap) so it never grows unbounded.
const reflector = new MemoryReflector(
  () => readConfig().harnessHome,
  () => readConfig().defaultCommand ?? 'claude',
  () => memory.env(),
  reflectSettings,
  (event) => { try { hive.appendLog(event); } catch { /* best-effort */ } }
);
// Durable harness state (SQLite, main process). Phase A: window bounds (kv) +
// net-new command history. Opened in whenReady, closed in the teardown blocks.
const persist = new PersistStore();
let mainWindow: BrowserWindow | null = null;

/** When true, skip the quit interceptor (user already confirmed). */
let allowQuit = false;

/** Agents spawned with `isolate: true` get a dedicated git worktree; this maps
 *  the agent/pty id → the worktree path so we can tear it down on kill. */
const worktreePaths = new Map<string, string>();
/** id → the original repo cwd the worktree was created from (needed to run
 *  `git worktree remove` from the parent tree, not the worktree itself). */
const worktreeOrigins = new Map<string, string>();

// Tell the hive how to resolve a desk's *project repo* (used to match a task's
// reviewer/integrator to the project it belongs to). An isolated desk's cwd is its
// worktree, so prefer the worktree's ORIGIN repo; otherwise the desk's registry cwd.
/** Resolve a desk's *project repo*: an isolated desk's cwd is its worktree, so prefer the
 *  worktree's ORIGIN repo; otherwise the desk's registry cwd. Used both by the hive (to match
 *  a task's reviewer/integrator to its project) and by the scheduler (per-project missions). */
function repoForId(id: string): string | null {
  return worktreeOrigins.get(`pty-${id}`) ?? hive.registry().agents[id]?.cwd ?? null;
}
hive.setRepoResolver(repoForId);

/**
 * Reattach-or-isolate a worker desk's git worktree. The desk's worktree path is keyed by its
 * (slugified) agent id, so a RESTART of a previously-isolated desk must REUSE the existing
 * worktree — not try to re-create it (which fails because the path is taken, then the desk
 * silently runs in the shared tree and loses its `agent/<id>` branch). The pure decision lives
 * in `planWorktree` (git.ts, unit-tested); this wires the real git/fs around it. Best-effort:
 * any failure returns null (fall back to the shared cwd rather than blocking the spawn).
 */
async function provisionWorktree(
  origCwd: string, agentId: string, forceNew: boolean
): Promise<{ path: string; origin: string } | null> {
  try {
    const wtRoot = join(readConfig().harnessHome ?? origCwd, 'worktrees');
    const list = await listWorktrees(origCwd);
    const registered = Array.isArray(list) ? list.map((w) => w.path) : [];
    const plan = planWorktree({ wtRoot, agentId, origCwd, forceNew, registered, exists: existsSync });
    if (plan.action === 'skip') return null;
    if (plan.action === 'reattach') return { path: plan.path, origin: origCwd };
    // create
    const br = await getBranch(origCwd);
    const baseBranch = 'current' in br && br.current ? br.current : 'main';
    const wt = await addWorktree(origCwd, plan.path, baseBranch);
    if (wt.ok) return { path: plan.path, origin: origCwd };
    console.error('[worktree] addWorktree failed:', wt.error);
    return null;
  } catch (e) {
    console.error('[worktree] provision failed:', e);
    return null;
  }
}

/**
 * Tear down everything tied to a PTY id: archive its hive agent, remove its
 * isolated git worktree, and drop the bookkeeping-map entries. Runs on BOTH an
 * explicit `pty:kill` AND a natural PTY exit (the child finished, crashed, or
 * was killed externally) — without this the agent stays "active" (broadcasts
 * keep mailing a dead inbox), the worktree orphans (plus a dangling `git
 * worktree` registration in the user's real repo), and the maps leak an entry
 * per dead PTY.
 *
 * Idempotent: guarded on map presence and the already-idempotent
 * `hive.setArchived`, so the second call (kill() also makes node-pty fire
 * onExit) is a harmless no-op. Best-effort — every step is wrapped so a teardown
 * error can never crash the caller (an IPC handler or node-pty's onExit).
 */
/** Archive an agent on exit — drop its breaker state and flag it archived in the
 *  hive. agentId-keyed, so PTY exits and native-worker exits share one lifecycle
 *  (E003 AD-004). Best-effort. */
function archiveAgent(agentId: string): void {
  try { breaker.forget(agentId); } catch { /* best-effort */ }
  if (hive.enabled()) {
    try { hive.setArchived(agentId, true); } catch (e) { console.error('[hive] setArchived failed:', e); }
  }
}

function teardownPty(id: string): void {
  // 1) Archive the agent — retained + flagged; only live-PTY agents are active.
  const agentId = ptyToAgent.get(id);
  if (agentId) {
    ptyToAgent.delete(id);
    // E005 — drop the derived-provider record alongside the agent (no leak).
    agentProviderIds.delete(agentId);
    archiveAgent(agentId);
  }
  // 2) An isolated agent's worktree is INTENTIONALLY KEPT on exit (it was force-removed
  //    before, which orphaned committed work). The branch + checkout survive so the god
  //    can integrate it and the operator can review/bulk-delete stale ones from the
  //    Worktrees panel (Settings). Only drop the live in-memory mapping here; the panel
  //    lists from `git worktree list`, so on-disk state is the source of truth.
  worktreePaths.delete(id);
  worktreeOrigins.delete(id);
  syncKeepAwake();
}
// A natural PTY exit must run the same teardown as an explicit kill.
ptyManager.setExitHandler(teardownPty);

// E008 {FR-016/037/043} — the native-event bridge: the SINGLE-WRITER main→renderer
// seam for native agent activity. Each native worker's normalized AgentEvent stream
// is fed in here (via NativeRuntime.onAgentEvent); per event it APPEND-AND-COMMITS
// the line to the per-agent JSONL run log BEFORE forwarding it to the renderer over
// the per-agent `agent:event:<agentId>` channel (mirrors `pty:data:<id>`). Main is
// the sole writer of the log; the renderer subscribes via preload `onAgentEvent` and
// backfills on reopen via `loadNativeEvents`. Secret-free (ADR-0007): only AgentEvent
// fields are persisted/forwarded — never a key/header (credentials ride spawn env).
const nativeEventBridge = createNativeEventBridge({
  persist: (event) => (hive.enabled() ? hive.appendNativeEvent(event) : false),
  forward: (event) => {
    try { liveWebContents()?.send(`agent:event:${event.agentId}`, event); } catch { /* window tore down */ }
  }
});
// SDDP feature scan — read a feature's real markers from `<repo>/specs/<feature>/` so the
// lifecycle gate + the board phase reflect the FILESYSTEM, not model memory (the key lever for
// native desks). Returns null when the feature dir doesn't exist (callers fail open). The
// `feature` is treated as a single path segment (no traversal) — a feature like `../etc` can't
// escape the repo's specs dir.
function scanFeatureStatus(repo: string | null, feature: string): FeatureStatus | null {
  if (!repo) return null;
  const safe = feature.replace(/[\\/]/g, '_').trim();
  if (!safe || safe === '.' || safe === '..') return null;
  const dir = join(repo, 'specs', safe);
  if (!existsSync(dir)) return null;
  const has = (f: string) => existsSync(join(dir, f));
  let hasClarifications = false;
  const specPath = join(dir, 'spec.md');
  const hasSpec = existsSync(specPath);
  if (hasSpec) {
    try { hasClarifications = /^##\s+Clarifications/im.test(readFileSync(specPath, 'utf8')); } catch { /* unreadable ⇒ treat as none */ }
  }
  return {
    feature: safe,
    hasSpec,
    hasClarifications,
    hasPlan: has('plan.md'),
    hasTasks: has('tasks.md'),
    completed: has('.completed'),
    qcPassed: has('.qc-passed')
  };
}

// The native coding toolkit's injected deps: the hive surface (arrow-wrapped to keep
// `this`), the cwd resolver (= the sandbox root), the memory-append committer, and the
// bash opt-in (off by default). Built once; cwd + bash are read live per tool call.
const agentToolDeps: AgentToolDeps = {
  enabled: () => hive.enabled(),
  memory: (id) => hive.memory(id),
  inbox: (id) => hive.inbox(id),
  send: (partial, from) => hive.send(partial, from),
  tasks: () => hive.tasks(),
  writeTasks: (tasks) => hive.writeTasks(tasks),
  // Roster for hive_list_agents — registry meta enriched with live presence (a native
  // worker in the runtime, or a live PTY mapped to the desk) so the god delegates with
  // sight. `isGod` gates the privileged task-board updates (done/reassign/reprioritize).
  roster: () => {
    const reg = hive.registry();
    const livePtys = new Set(ptyManager.list().map((p) => p.id));
    return Object.values(reg.agents).map((a) => {
      // Worktree maps are keyed by the spawn id (`pty-<id>` for both Claude PTYs and
      // native desks). An isolated desk reports its origin repo + agent/<id> branch so
      // the god can review + integrate it; a non-isolated worker reports its cwd as repo.
      const wtKey = `pty-${a.id}`;
      const origin = worktreeOrigins.get(wtKey);
      const wtPath = worktreePaths.get(wtKey);
      const isWorker = a.isGod !== true && a.isAssistant !== true;
      return {
        id: a.id,
        name: a.name,
        role: a.role,
        archived: a.archived === true,
        isGod: a.isGod === true,
        isAssistant: a.isAssistant === true,
        roles: a.roles ?? [],
        running:
          nativeRuntime.runtimeFor(a.id) !== undefined ||
          [...ptyToAgent.entries()].some(([ptyId, aid]) => aid === a.id && livePtys.has(ptyId)),
        repo: origin ?? (isWorker ? a.cwd : undefined),
        branch: wtPath ? agentBranchFor(wtPath) : undefined
      };
    });
  },
  isGod: (id) => {
    const reg = hive.registry();
    return reg.agents[id]?.isGod === true || reg.godId === id;
  },
  // Holds the `integrator` role? Gates hive_integrate + task sign-off. Read live from the
  // registry so toggling a role takes effect immediately (no respawn needed for the gate).
  canIntegrate: (id) => (hive.registry().agents[id]?.roles ?? []).includes('integrator'),
  // Holds the `reviewer` role? Lets it approve/send-back a card in `review`.
  canReview: (id) => (hive.registry().agents[id]?.roles ?? []).includes('reviewer'),
  // A desk's project repo — stamps a task's `project` on assignment (off-project detection).
  repoFor: (id) => repoForId(id),
  // SDDP mode (read live) gates the lifecycle hard-checks in hive_update_task; the feature
  // scan backs both those gates and the hive_feature_status tool with the real on-disk markers.
  sddpMode: () => readConfig().sddpMode === true,
  featureStatus: (repo, feature) => scanFeatureStatus(repo, feature),
  // May edit code (write_file/edit_file/bash)? Role-driven, NO god/assistant special-case:
  // the `worker` role (writes features + tests) and the `integrator` role (writes merge-fix
  // code) grant editing; a reviewer / no-edit-role / assistant desk is read-only. This is the
  // god's delegation lever — a god holding neither worker nor integrator (e.g. reviewer-only)
  // physically cannot implement, so it must delegate. Read live so a role toggle applies at once.
  canEditCode: (id) => {
    const a = hive.registry().agents[id];
    if (!a) return true; // unknown desk → don't over-restrict
    return roleCanEditCode(a.roles);
  },
  // Extra READ roots: every desk may READ any registered project repo + any worktree (to
  // compare versions or read a peer's branch — the god/reviewer especially need this), while
  // WRITES stay confined to the desk's own cwd (resolveInsideCwd). Read wide, write narrow.
  readRoots: () => {
    const home = readConfig().harnessHome;
    return Array.from(new Set<string>([
      ...(home ? [home] : []), // the hive home: every desk reads memory/inbox/board/tasks + peers'
      ...(readConfig().registeredRepos ?? []),
      ...worktreeOrigins.values(),
      ...worktreePaths.values()
    ]));
  },
  // A desk may WRITE its OWN hive agent dir (memory.md, inbox/.done, scratch) — ungated by
  // canEditCode (memory is everyone's). Shared hive files (tasks.json/registry.json) sit in the
  // hive ROOT, not under agents/<id>, so they stay tool-managed (single-committer).
  agentDir: (id) => { const r = hive.root(); return r ? join(r, 'agents', id) : null; },
  // The god's integration seam (hive_integrate): review/merge a worker's branch into its
  // repo. Scoped to REGISTERED repos (+ live worktree origins) for safety; git runs in
  // main (single-committer). apply:false previews, true merges (conflicts abort + report).
  integrate: async (repo, branch, apply) => {
    const allowed = new Set<string>([...(readConfig().registeredRepos ?? []), ...worktreeOrigins.values()]);
    if (!allowed.has(repo)) return { content: `repo is not registered (cannot integrate): ${repo}`, success: false };
    if (!apply) {
      const p = await previewMerge(repo, branch);
      if (!p.ok) return { content: `preview failed: ${p.error}`, success: false };
      return {
        content: `Preview — merge ${branch} into ${p.base}:\n\nCommits:\n${p.commits || '(none)'}\n\nFiles:\n${p.diffstat || '(none)'}`,
        success: true
      };
    }
    const m = await mergeBranch(repo, branch);
    if (!m.ok) {
      return {
        content: m.conflict
          ? `merge CONFLICT — aborted, repo left clean. Send ${branch} back to its author to rebase/resolve.\n${m.error}`
          : `merge failed: ${m.error}`,
        success: false
      };
    }
    return { content: `merged ${branch} into ${m.base}`, success: true };
  },
  appendMemory: (id, text) => hive.appendMemory(id, text),
  resolveCwd: (id) => hive.registry().agents[id]?.cwd ?? null,
  bashEnabled: () => readConfig().nativeBashEnabled === true,
  // Run the bash tool through a real shell (Git Bash on Windows) so ls/grep/find/pipes
  // work — instead of Node's cmd.exe default. Detected once at startup.
  bashShell: () => resolveBashEnv().shell,
  // web_search routes through the host (provider + formatting). Free + keyless via
  // DuckDuckGo; config is read live per call so the operator's enable/disable takes
  // effect at once. Throws a clear note when disabled — the executor turns that into a
  // recoverable success:false tool-result.
  searchWeb: (query, opts) => searchWebDuckDuckGo(query, opts, readConfig())
};

// The orchestrator ROLE injected into a NATIVE god's system prompt (Michael on a
// non-Claude provider). The Claude god gets its role via `--append-system-prompt`
// (hive.injectedPrompt); a native god has no CLI, so it orchestrates purely through the
// hive TOOLS — this prompt is written for those (no fleet.json CLI / slash commands).
// The native god's orchestrator prompt. Integration guidance is CONDITIONAL on the god
// holding the `integrator` role (it does by default, but the operator can reassign it to a
// dedicated integrator desk): with the role the god reviews+merges+signs-off; without it,
// the god delegates integration to whichever desk holds the role.
function nativeGodPrompt(godRoles: AgentRole[]): string {
  const godIntegrates = godRoles.includes('integrator');
  const godReviews = godRoles.includes('reviewer');
  const godCanEdit = roleCanEditCode(godRoles); // holds worker or integrator
  return [
    'You are the GOD / ORCHESTRATOR of this hive of agents (you are "Michael"). Your job is to ORCHESTRATE, not implement: keep awareness of the whole team and delegate the work.',
    '- KNOW THE TEAM: before delegating, call hive_list_agents to see who exists, who is running, and each desk\'s roles — assign to the best AVAILABLE desk, never blind.',
    '- DELEGATE: decompose a request into slices; for each, hive_add_task (a card assigned to a worker desk) and hive_send_message that desk a short 4-part brief (objective / output / tools+references / boundaries+done). Different slices can go to different desks in parallel. Do NOT do the grunt implementation yourself.',
    '- THE FLOW (worker → reviewer → integrator): a WORKER writes + commits its slice on its own branch, RUNS the build/tests, and moves the card "doing"→"review". A REVIEWER reads it (read-only, comments only) and either approves it to "integrate" or sends it back to "doing". An INTEGRATOR re-runs the test suite as the merge gate, merges an "integrate" card, and signs it off to "done". "Done" means tested. Keep cards moving along this chain.',
    '- RUN THE BOARD (live source of truth): at turn start reconcile it — hive_list_tasks, fix stale cards with hive_update_task. You set assign/reprioritize. When several reviewers exist, all are pinged but only the first to advance a card lands; integration is routed to ONE integrator to avoid a double-merge.',
    godReviews
      ? '- REVIEW work (you hold the reviewer role): when a card enters "review", read the desk\'s branch (read-only), confirm tests exist + cover the change + the worker\'s reported run is green, comment via a hive_update_task note, then approve it to "integrate" or send it back to "doing" with what to fix.'
      : '- REVIEW is delegated: prefer a desk holding "reviewer" (auto-pinged on "review"). But if NO reviewer desk exists you are the standing fallback — the system pings YOU, so review it yourself (read-only) and approve to "integrate" or send it back.',
    godIntegrates
      ? '- INTEGRATE approved work (you hold the integrator role): each worker commits its slice on its own worktree branch (hive_list_agents shows each desk\'s repo + branch). On an "integrate" card, RUN the test suite as the merge gate, hive_integrate (no apply) to inspect the commits/diff, then hive_integrate apply:true to merge into the repo\'s base — then mark the card "done". A reported conflict (or red tests) means resolve it yourself (you may edit only to resolve the conflict) or send it back to the author. You own sign-off (done/reopen).'
      : '- INTEGRATION is delegated: prefer a desk holding "integrator" (auto-pinged on "integrate"). But if NO integrator desk exists you are the standing fallback — the system pings YOU, so merge it yourself: run the tests, hive_integrate (preview → apply), then mark "done".',
    '- READ TO ORCHESTRATE: you CAN read any project repo + worktree (read_file/list_dir/grep with the repo/branch paths from hive_list_agents) — use that to decompose work and review branches. Your own working directory is just a neutral home base, not where the projects live.',
    godCanEdit
      ? '- DO NOT IMPLEMENT: building feature code is the WORKERS\' job — always delegate it. You hold an editing role, but use write_file/edit_file/bash ONLY to merge / resolve conflicts — never to build a feature slice yourself.'
      : '- YOU CANNOT EDIT CODE: you hold no worker/integrator role, so write_file / edit_file / bash / hive_integrate are DISABLED for you and will be DENIED ("read-only"). Do NOT attempt them. If a card needs implementation, reassign it to a worker (hive_update_task assignee) or — if none exists — tell the operator which desk to spawn, then move on. If any edit/bash call is denied as "read-only", STOP retrying it immediately and delegate; never loop on a denied tool.',
    '- A DEV CARD IS NOT YOURS TO CODE: if a card assigned to you needs implementation, reassign it to a worker — you own orchestration, not the coding. A card stays with its assigned worker through review and send-back (the code lives on that worker\'s `agent/<id>` worktree branch); only reassign a worker\'s card if that worker is genuinely gone, and then hand the branch over explicitly.',
    '- IF NO WORKER DESKS ARE ALIVE to take the work, do NOT attempt it yourself — tell the operator exactly which team/desks to spawn, then orchestrate once they are up.',
    '- COORDINATE: answer agents\' questions so the team runs autonomously; read a peer\'s memory with hive_read_memory when you need context; record durable decisions with write_memory.',
    'The human operator is watching this transcript and can message you directly — surface anything genuinely critical to them.'
  ].join('\n');
}

// Injected into a desk that holds the `reviewer` role. A reviewer is READ-ONLY: it cannot
// edit code or run bash (the toolkit denies write_file/edit_file/bash for a pure reviewer) —
// it comments and routes the card.
const NATIVE_AGENT_REVIEWER_PROMPT = [
  'You also hold the REVIEWER role: you REVIEW other desks\' finished work — you READ and COMMENT, you do NOT change code (write_file/edit_file/bash are blocked for you).',
  '- You are PINGED automatically when a card enters "review"; you should ALSO, on each wake, scan hive_list_tasks for cards in "review" and review them — don\'t wait to be asked. If several reviewers exist you may all look, but only the first to advance the card lands — so check it\'s still in "review" before acting.',
  '- hive_list_agents shows each desk\'s repo + worktree branch. Read the branch\'s diff/files (read_file/list_dir/grep — read-only). CHECK THE TESTS: confirm tests exist, cover the change, and the worker recorded a green run (you cannot run them yourself — you are read-only). Leave your feedback as a hive_update_task `note` (it becomes an attributed comment on the card; the worker is handed it automatically on send-back).',
  '- APPROVE: when it\'s good (and tested), hive_update_task the card to "integrate" (an integrator will merge it). REQUEST CHANGES: send it back with status "doing" and a `note` of exactly what to fix. You never merge and never mark "done".'
].join('\n');

// Injected into a NON-god desk that holds the `integrator` role (a dedicated integrator).
const NATIVE_AGENT_INTEGRATOR_PROMPT = [
  'You also hold the INTEGRATOR role: you MERGE other desks\' approved work and sign it off (you do not re-implement it). You are the project\'s last quality gate.',
  '- You are PINGED automatically when a card enters "integrate" (one integrator is picked, so no double-merge); you should ALSO, on each wake, scan hive_list_tasks for any cards in "integrate" and merge them — don\'t wait to be asked.',
  '- hive_list_agents shows each desk\'s repo + worktree branch. For an "integrate" card: FIRST run the test suite (bash) as the merge gate — if it is red, send the card back to its author (status "doing") with a `note`; do not merge red work. If green, hive_integrate (no apply) to inspect commits + diff, then hive_integrate apply:true to merge into the repo\'s base branch, then hive_update_task it to "done".',
  '- A reported merge conflict aborts cleanly — resolve it yourself (you may edit ONLY to settle the conflict) or send the card back to its author (status "doing", with a `note`) to rebase/resolve; never force it.'
].join('\n');

// ─── SPEC-DRIVEN (SDDP) mode prompts ─────────────────────────────────────────
// When the floor is in SDDP mode, desks follow the spec-driven lifecycle. These REPLACE
// the standard role prompts (selected in workerEnv). The methodology is ported from the
// sddp27 kit as prompts so a NATIVE (DeepSeek) desk can follow it without the Claude-only
// /sddp-* skills. The phases + gates are additionally machine-checkable via hive_feature_status.
const SDDP_LIFECYCLE = [
  'SPEC-DRIVEN (SDDP) MODE is active. Work flows per FEATURE through a strict, gated lifecycle, with artifacts kept in `specs/<feature>/`:',
  'Specify (spec.md) → Clarify → Plan (plan.md) → Tasks (tasks.md) → Implement → QC (.qc-passed) → Integrate.',
  'Never skip a phase: each phase reads the prior artifact and writes the next. Preserve artifact IDs (T###, FR-###, SC-###) and checkbox state (`[ ]`→`[X]` only); never delete `[NEEDS CLARIFICATION]` markers. Check a feature\'s current phase + the next unmet gate with hive_feature_status.'
].join('\n');

function nativeSddpGodPrompt(): string {
  return [
    'You are the GOD / ORCHESTRATOR in SPEC-DRIVEN mode (you are "Michael"). Drive each feature through the lifecycle and ENFORCE the gates — assign each phase to the desk that holds the right role; never let work jump ahead:',
    SDDP_LIFECYCLE,
    '- Specify→Clarify→Plan→Tasks: assign to a PLANNER desk (it authors spec.md, resolves clarifications, plan.md, tasks.md). Answer its clarification questions.',
    '- SPEC/PLAN gate: have a REVIEWER read spec.md/plan.md/tasks.md (read-only) and approve, or send back to the planner.',
    '- Implement: once tasks.md exists, turn its tasks into cards (hive_import_tasks if available, else hive_add_task) assigned to WORKER desks — P1 first, independent tasks in parallel.',
    '- CODE gate: a REVIEWER reviews each implemented slice.',
    '- QC: a QC desk runs tests/lint/security + verifies stories vs spec → it sets .qc-passed, or files bug tasks back to workers.',
    '- Integrate: an INTEGRATOR merges only AFTER .qc-passed, then signs off (done).',
    '- You ORCHESTRATE + GATE; you do not author or implement. Use hive_feature_status to see each feature\'s phase. Run features as a PIPELINE (one in Plan while another is in QC) and parallelize Implement across workers.',
    'The human operator is watching this transcript and can message you — surface anything genuinely critical.'
  ].join('\n');
}

// Per-role SDDP guidance for a NON-god desk (a desk may hold several SDDP roles).
const NATIVE_SDDP_PLANNER_PROMPT = [
  'You hold the SDDP PLANNER role: you AUTHOR a feature\'s spec → plan → tasks in `specs/<feature>/` — you do NOT implement.',
  '- Specify: write spec.md — problem, scope, requirements (FR-### functional / TR-### technical), success criteria (SC-### with measurable Given/When/Then). Mark unknowns `[NEEDS CLARIFICATION]`.',
  '- Clarify: resolve those markers — ask "god"/operator the few highest-impact questions in ONE batch, then update spec.md (add a `## Clarifications` section).',
  '- Plan: write plan.md — tech stack, data model, API contracts, and architecture decisions (ADRs).',
  '- Tasks: write tasks.md — `- [ ] T### [P?] [US#|OBJ#] {FR-###} Description [after:T###]`, grouped by phase (Setup/Foundational/Delivery/Polish), with P1 = a viable MVP and every task independently testable. Preserve all IDs.',
  '- Self-check the spec for completeness + testability + requirement coverage, then message "god" that it is ready for the spec review.'
].join('\n');

const NATIVE_SDDP_WORKER_PROMPT = [
  'You hold the SDDP WORKER role: you IMPLEMENT from tasks.md (you do not change the spec).',
  '- Take a task assigned to you, do EXACTLY that task, respect `after:T###` ordering, run the build/tests, then mark its checkbox `[ ]`→`[X]` in tasks.md and commit on your branch.',
  '- Move your card doing→review when the slice is done. If a task is wrong or under-specified, do NOT guess — message "god" to route it back to the planner.'
].join('\n');

const NATIVE_SDDP_REVIEWER_PROMPT = [
  'You hold the SDDP REVIEWER role: read-only, two gates.',
  '- SPEC/PLAN gate: read spec.md/plan.md/tasks.md — is it complete, testable, and does every requirement (FR-###) have tasks? Approve to proceed or send back to the planner with a `note`.',
  '- CODE gate: review an implemented slice before QC — comment via hive_update_task `note`; approve to "integrate"/QC or send back to the worker ("doing"). You never edit code.'
].join('\n');

const NATIVE_SDDP_QC_PROMPT = [
  'You hold the SDDP QC role: run the automated QC phase on an implemented feature.',
  '- Run the build, tests, linter, and security checks (bash); verify each user story / success criterion (SC-###) against the code + test results.',
  '- Write `specs/<feature>/qc-report.md`. If everything passes, create the `.qc-passed` marker (the feature is ready to integrate). If anything fails, file bug tasks (`- [ ] T### [BUG:severity] {FR-###} [category] desc — file:line`) into tasks.md and send the work back to the worker(s).',
  '- You RUN + VERIFY; you do not implement fixes (those go to workers).'
].join('\n');

const NATIVE_SDDP_INTEGRATOR_PROMPT = [
  'You hold the SDDP INTEGRATOR role: merge a feature ONLY after it has `.qc-passed`.',
  '- Then hive_integrate (preview → apply) to merge the feature\'s branch into the repo base, and sign its cards off to "done". On conflict, resolve it (conflict-only edits) or send it back.'
].join('\n');

/** Assemble the SDDP preamble for a NON-god desk from the roles it holds. */
function nativeSddpRolePrompt(roles: AgentRole[]): string {
  const parts = [SDDP_LIFECYCLE];
  if (roles.includes('planner')) parts.push(NATIVE_SDDP_PLANNER_PROMPT);
  if (roles.includes('worker')) parts.push(NATIVE_SDDP_WORKER_PROMPT);
  if (roles.includes('reviewer')) parts.push(NATIVE_SDDP_REVIEWER_PROMPT);
  if (roles.includes('qc')) parts.push(NATIVE_SDDP_QC_PROMPT);
  if (roles.includes('integrator')) parts.push(NATIVE_SDDP_INTEGRATOR_PROMPT);
  return parts.join('\n\n');
}

// E003 — native (non-Claude) agents run in isolated utilityProcess workers,
// fronted by the ProviderRuntime port. The drain runs in MAIN (single-committer
// hive); a worker exit reuses the same archive path as a PTY exit (AD-004).
const nativeRuntime = new NativeRuntime({
  drainForStop: (id) => (hive.enabled() ? hive.drainForStop(id) : { block: false }),
  // A native worker requests a tool; MAIN executes it against the GOVERNED, cwd-
  // sandboxed toolkit so a native desk is a full hive peer with parity to a Claude
  // desk. Every call is routed through the SAME guardrails a Claude desk hits:
  //  (1) the permission gate — operator pause / halt / gated-tool deny (parity with
  //      Claude's PreToolUse hook, which native calls otherwise bypassed);
  //  (2) the circuit breaker — feed the loop/cost guard (parity with PostToolUse);
  //  (3) executeAgentTool — single-committer I/O, cwd-sandboxed, bash opt-in.
  executeToolFor: async (id, req) => {
    if (control.shouldHalt(id)) return { content: 'halted by operator', success: false };
    const decision = control.toolDecision(id, req.toolName);
    if (decision.deny) return { content: decision.reason ?? 'denied by operator', success: false };
    // The attempt is recorded BEFORE execution, so a desk hammering an identical denied tool
    // still feeds the breaker's loop guard.
    breaker.recordToolUse(id, req.toolName, req.toolInput);
    const result = await executeAgentTool(agentToolDeps, id, req);
    // Visibility (#edit-gate): make a read-only role denial observable in the main log, so
    // "is the god actually writing?" is a fact, not a guess.
    if (!result.success && (req.toolName === 'write_file' || req.toolName === 'edit_file' || req.toolName === 'bash')
        && /read-only/.test(result.content)) {
      console.log(`[edit-gate] denied ${req.toolName} for ${id} roles=[${(hive.registry().agents[id]?.roles ?? []).join(',')}]`);
    }
    return result;
  },
  onWorkerExit: (id) => { archiveAgent(id); syncKeepAwake(); },
  usageFor: (id) => usageProvider.getAgentUsage(id),
  credentialEnvFor: (providerId) => injectionEnvForProvider(readConfig(), providerId),
  // Per-desk native preamble additions (the worker prepends these to its system prompt):
  // the shell/OS note for every desk; the orchestrator ROLE for a native god (with its
  // integration guidance conditional on the god holding the `integrator` role); and the
  // INTEGRATOR preamble for a dedicated (non-god) integrator desk. Identity + roles come
  // from the hive registry (set at ensureAgent / setRoles).
  workerEnv: (id) => {
    const env: Record<string, string> = { NATIVE_AGENT_ENV_NOTE: describeBashEnv() };
    const agent = hive.registry().agents[id];
    const roles = agent?.roles ?? [];
    // SDDP mode is a WHOLESALE switch: when on, desks get the spec-driven preamble set
    // instead of the standard role prompts (a desk is either standard or SDDP, never mixed).
    const sddp = readConfig().sddpMode === true;
    if (agent?.isGod) {
      env.NATIVE_AGENT_GOD_PROMPT = sddp ? nativeSddpGodPrompt() : nativeGodPrompt(roles);
    } else if (sddp) {
      // One SDDP preamble assembled from the roles the desk holds (planner/worker/
      // reviewer/qc/integrator). agentWorker prepends it to the system prompt.
      env.NATIVE_AGENT_SDDP_PROMPT = nativeSddpRolePrompt(roles);
    } else {
      // A non-god desk can hold reviewer and/or integrator on top of (or instead of) worker;
      // inject each role's preamble so its responsibilities are spelled out.
      if (roles.includes('reviewer')) env.NATIVE_AGENT_REVIEWER_PROMPT = NATIVE_AGENT_REVIEWER_PROMPT;
      if (roles.includes('integrator')) env.NATIVE_AGENT_INTEGRATOR_PROMPT = NATIVE_AGENT_INTEGRATOR_PROMPT;
    }
    return env;
  },
  // E007 T011/T017 {FR-008/011} — forward each native worker's usage + tool spans
  // into the loopback collector's gen_ai.* branch (single-writer in main, AD-002),
  // so a DeepSeek/Minimax desk produces the SAME AgentUsageSample + ToolSpan as a
  // Claude desk and reaches telemetry parity through the unchanged consumers.
  telemetry,
  // E008 T004/T005 {FR-016/037/043} — forward each native worker's AgentEvent
  // stream into the single-writer bridge (persist-then-forward over `agent:event`).
  onAgentEvent: (event) => nativeEventBridge.ingest(event),
  maxConcurrent: 15,
  maxOldSpaceMb: 512
});

/** Keep the system from suspending the harness while agents are running.
 *  Windows Modern Standby suspends desktop apps (and their child `claude`
 *  processes!) shortly after the display sleeps/locks — the whole hive froze
 *  mid-turn until unlock. `prevent-app-suspension` blocks exactly that while
 *  still letting the display turn off and the session lock. Held only while at
 *  least one PTY is alive, so an idle harness doesn't pin a laptop awake. */
let keepAwakeId: number | null = null;
function syncKeepAwake(): void {
  const live = ptyManager.list().length > 0;
  if (live && keepAwakeId === null) {
    keepAwakeId = powerSaveBlocker.start('prevent-app-suspension');
    console.log('[power] keep-awake ON — agents running');
  } else if (!live && keepAwakeId !== null) {
    try { if (powerSaveBlocker.isStarted(keepAwakeId)) powerSaveBlocker.stop(keepAwakeId); } catch { /* noop */ }
    keepAwakeId = null;
    console.log('[power] keep-awake off — no agents');
  }
}

/** A mission's live scheduler handles: the initial `setTimeout` that waits out
 *  the time remaining until its next due fire, and the steady `setInterval`
 *  armed once it has fired. Both are tracked so shutdown can clear whichever is
 *  pending. */
interface MissionTimer {
  timeout?: NodeJS.Timeout;
  interval?: NodeJS.Timeout;
}

/** Active scheduler timers keyed by mission id. */
const missionTimers = new Map<string, MissionTimer>();

/** Clear and forget every armed mission timer (both the setTimeout and the
 *  setInterval handle). Safe to call from syncMissions and from shutdown
 *  teardown so a tick never fires into half-torn-down services. */
function clearMissionTimers(): void {
  for (const t of missionTimers.values()) {
    if (t.timeout) clearTimeout(t.timeout);
    if (t.interval) clearInterval(t.interval);
  }
  missionTimers.clear();
}

/** Rebuild the scheduler from persisted config: clear every existing timer,
 *  then arm each enabled mission honoring its lastFiredAt — a setTimeout for the
 *  time remaining until its next due fire, which then settles into a steady
 *  interval. Each tick dispatches the mission to its target agent and stamps
 *  lastFiredAt back into config. Called on boot (after the router starts) and
 *  after every missions:save. */
/** Dispatch a mission once: send its body to its target(s) — the single `to` recipient, or,
 *  when `project` is set, EVERY non-archived desk whose project repo matches (per-project
 *  scoping) — then run auto-compact and stamp lastFiredAt. Shared by the interval timer and
 *  the on-demand "fire now" IPC. Best-effort; never throws into the timer. */
function fireMission(m: ScheduledMission): void {
  try {
    if (hive.enabled()) {
      const targets = m.project
        ? Object.values(hive.registry().agents)
            .filter((a) => !a.archived && repoForId(a.id) === m.project)
            .map((a) => a.id)
        : [m.to];
      for (const to of targets) {
        hive.send({ to, act: 'request', subject: m.label, body: m.body }, 'scheduler');
      }
    }
    // Auto-compact: do NOT jam /compact into busy terminals. Hand it to the renderer, which
    // queues a /compact per agent (deduped — never two at once) and delivers it only when
    // that agent goes idle (its drain loop), so a working agent compacts between steps.
    if (m.autoCompact) {
      try { liveWebContents()?.send('mission:autoCompact'); } catch { /* window gone */ }
    }
    const current = readConfig().missions ?? [];
    const next = current.map((x) => (x.id === m.id ? { ...x, lastFiredAt: Date.now() } : x));
    writeConfig({ missions: next });
    // Let the SCHEDULES panel refresh its "last fired" without a reload (#2.3).
    try { liveWebContents()?.send('missions:updated'); } catch { /* window gone */ }
  } catch (e) {
    console.error('[scheduler] mission', m.id, e);
  }
}

function syncMissions(): void {
  clearMissionTimers();
  const missions = readConfig().missions ?? [];
  for (const m of missions) {
    if (!m.enabled || !(m.intervalMs > 0)) continue;
    // Heartbeat (Lane A #1) opts out of the fixed setInterval and self-reschedules
    // with an adaptive cadence. Registered into the same missionTimers map so
    // clearMissionTimers() tears it down identically on quit/reset.
    if (m.kind === 'heartbeat') { armHeartbeat(m); continue; }
    const fire = (): void => fireMission(m);
    // Honor lastFiredAt so a partially-elapsed interval is not restarted from
    // zero on reboot or when an unrelated mission is edited: wait only the time
    // remaining until the next due fire, then settle into a steady interval.
    const remaining = Math.max(0, m.intervalMs - (Date.now() - (m.lastFiredAt ?? 0)));
    const entry: MissionTimer = {};
    entry.timeout = setTimeout(() => {
      fire();
      entry.interval = setInterval(fire, m.intervalMs);
    }, remaining);
    missionTimers.set(m.id, entry);
  }
}

/** One-time migration: ensure the built-in hourly ops standup exists for installs
 *  that predate it. Guarded by `opsStandupSeeded` so a user who later deletes the
 *  mission doesn't get it re-added on every boot. Stamps lastFiredAt = now so the
 *  first standup waits a full interval instead of firing (and compacting every
 *  terminal) immediately on launch. */
function ensureDefaultMissions(): void {
  const cfg = readConfig();
  if (!cfg.opsStandupSeeded) {
    const missions = cfg.missions ?? [];
    const has = missions.some((m) => m.id === OPS_STANDUP_MISSION.id);
    writeConfig({
      missions: has ? missions : [...missions, { ...OPS_STANDUP_MISSION, lastFiredAt: Date.now() }],
      opsStandupSeeded: true
    });
  }
  // Seed the built-in heartbeat (Lane A #1) once. Shipped DISABLED, so it just
  // appears in the SCHEDULES panel for the user to turn on; lastFiredAt = now so
  // it doesn't fire on the very first launch after a user enables it.
  const cfg2 = readConfig();
  if (!cfg2.heartbeatSeeded) {
    const missions = cfg2.missions ?? [];
    const has = missions.some((m) => m.id === HEARTBEAT_MISSION.id);
    writeConfig({
      missions: has ? missions : [...missions, { ...HEARTBEAT_MISSION, lastFiredAt: Date.now() }],
      heartbeatSeeded: true
    });
  }
}

// ─── Heartbeat (Lane A #1) + circuit-breaker beat (#6.6b) ────────────────────

/** Is the floor quiet? Derived ONLY from signals the main process owns or can
 *  stat — log.jsonl mtime (the master signal: every routed msg/drain/spawn/task
 *  append touches it), each agent's inbox + outbox/.sent mtimes, and every live
 *  PTY's lastOutputAt (an agent printing/thinking counts as activity). Crucially
 *  NOT registry.status, which is written 'idle' once at spawn and never
 *  transitions in main — reading it would see the floor quiet forever. */
function isFloorQuiet(thresholdMs: number): boolean {
  const root = hive.root();
  if (!root) return false;
  const times: number[] = [];
  const pushMtime = (p: string): void => { try { times.push(statSync(p).mtimeMs); } catch { /* missing */ } };
  pushMtime(join(root, 'log.jsonl'));
  const agentsDir = join(root, 'agents');
  if (existsSync(agentsDir)) {
    for (const id of readdirSync(agentsDir)) {
      pushMtime(join(agentsDir, id, 'inbox'));
      pushMtime(join(agentsDir, id, 'outbox', '.sent'));
    }
  }
  for (const t of ptyManager.list()) times.push(t.lastOutputAt);
  if (times.length === 0) return false; // nothing to judge → don't fire
  return Date.now() - Math.max(...times) > thresholdMs;
}

/** Newest coordination-file mtime for one agent (inbox, outbox/.sent, memory.md)
 *  — FILES only, deliberately excluding PTY output, so "no-progress" means "not
 *  coordinating" even while the agent is busy printing tokens. */
function lastCoordinationAt(agentId: string): number {
  const root = hive.root();
  if (!root) return 0;
  const times: number[] = [0];
  const pushMtime = (p: string): void => { try { times.push(statSync(p).mtimeMs); } catch { /* missing */ } };
  const dir = join(root, 'agents', agentId);
  pushMtime(join(dir, 'inbox'));
  pushMtime(join(dir, 'outbox', '.sent'));
  pushMtime(join(dir, 'memory.md'));
  return Math.max(...times);
}

/** PTY id owning a given agent id, or undefined. */
function ptyForAgent(agentId: string): string | undefined {
  for (const [ptyId, a] of ptyToAgent) if (a === agentId) return ptyId;
  return undefined;
}

/** "Stuck" = some worker's PTY is actively printing (recent output) while its
 *  coordination files have gone stale — working-but-not-coordinating. Tightens
 *  the heartbeat cadence so we notice a wedged agent sooner. */
function looksStuck(windowMs: number): boolean {
  const reg = hive.registry();
  const now = Date.now();
  for (const [id, a] of Object.entries(reg.agents)) {
    if (a.archived || a.isAssistant || id === reg.godId) continue;
    const ptyId = ptyForAgent(id);
    if (!ptyId) continue;
    const idle = ptyManager.idleFor(ptyId) ?? Infinity;
    if (idle < 15_000 && now - lastCoordinationAt(id) > windowMs) return true;
  }
  return false;
}

/** Bounded digest for god — paths + counts, never full files (reference-passing,
 *  #6.2). A few hundred tokens at most. */
function buildHeartbeatDigest(quietMs: number): string {
  const reg = hive.registry();
  const active = Object.entries(reg.agents).filter(([id, a]) => !a.archived && !a.isAssistant && id !== reg.godId);
  const names = active.map(([, a]) => a.name).join(', ') || '—';
  const boardHead = hive.board().split('\n').slice(0, 10).join('\n').trim();
  const log = hive.logTail(8).map((e) => { try { return JSON.stringify(e); } catch { return ''; } }).filter(Boolean).join('\n');
  const withInbox = active.filter(([id]) => hive.inbox(id).length > 0).map(([, a]) => a.name);
  return [
    `Floor heartbeat — quiet ~${Math.round(quietMs / 60000)}m.`,
    `Active agents (${active.length}): ${names}.`,
    withInbox.length ? `Undrained inbox: ${withInbox.join(', ')}.` : 'No undrained inboxes.',
    '',
    'Board (head):',
    boardHead || '(empty)',
    '',
    'Recent log:',
    log || '(none)',
    '',
    'Re-engage anyone stalled or blocked and keep the board accurate — or rest if the work is genuinely done.'
  ].join('\n');
}

/** Re-engage a quiet floor: drop a durable digest into god's inbox. We never
 *  type directly into god's PTY here — if he's busy that would jam mid-step. The
 *  inbox message is delivered by the renderer's busy-aware inbox-wake (it nudges
 *  god to read his inbox only once he's idle), so the heartbeat defers around a
 *  working god instead of interrupting him. */
function reengageGod(digest: string): void {
  if (!hive.enabled()) return;
  hive.send({ to: 'god', act: 'request', subject: 'Heartbeat', body: digest }, 'heartbeat');
}

/** A native toast for breaker constrain/stop, gated on the notifications setting. */
function breakerToast(title: string, body: string): void {
  if (!readConfig().notifications) return;
  try { if (Notification.isSupported()) new Notification({ title, body }).show(); }
  catch { /* unsupported platform */ }
}

/** One circuit-breaker beat: pull a fresh usage sample per active agent, append
 *  it to the durable cost ledger (the SOLE durable cost store), tick the breaker,
 *  emit each BreakerState on control:breakerState (Seam 2), and enforce any
 *  escalation. God is in the LEDGER (cost visibility) but NOT the breaker inputs
 *  (the heartbeat manages god; we never auto-steer/kill the orchestrator). */
function runBreakerBeat(progressWindowMs: number): void {
  if (!hive.enabled()) return;
  const reg = hive.registry();
  const now = Date.now();
  const inputs: BreakerInput[] = [];
  for (const [id, a] of Object.entries(reg.agents)) {
    if (a.archived || a.isAssistant) continue;
    const sample = usageProvider.getAgentUsage(id);
    if (sample) hive.appendCostLedger(sample); // ledger covers everyone incl. god
    if (id === reg.godId) continue;            // breaker skips god
    inputs.push({ agentId: id, sample, progressing: now - lastCoordinationAt(id) < progressWindowMs });
  }
  for (const d of breaker.tick(inputs, now)) {
    try { liveWebContents()?.send('control:breakerState', d.state); } catch { /* window gone */ }
    if (d.action === 'none') continue;
    const name = reg.agents[d.state.agentId]?.name ?? d.state.agentId;
    const reason = d.state.reason;
    if (d.action === 'steer') {
      hive.send({ to: d.state.agentId, act: 'request', subject: 'Circuit breaker: steer',
        body: `Automated guardrail: ${reason}. Re-check your approach — if you're looping or stuck, STOP repeating, summarize what you've tried, and ask god for direction.` }, 'breaker');
    } else if (d.action === 'constrain') {
      hive.send({ to: d.state.agentId, act: 'request', subject: 'Circuit breaker: constrain',
        body: `Automated guardrail escalated: ${reason}. Stop active work now: switch to read-only/plan, write a short plan of your next step, and send it to god for sign-off BEFORE running more tools.` }, 'breaker');
      breakerToast(`${name} constrained`, reason);
    } else if (d.action === 'stop') {
      const ptyId = ptyForAgent(d.state.agentId);
      if (ptyId) { try { ptyManager.kill(ptyId); } catch { /* already gone */ } teardownPty(ptyId); }
      breakerToast(`${name} stopped by circuit breaker`, reason);
    }
  }
}

/** Build + write the live fleet snapshot Michael reads (`<hive>/fleet.json`).
 *  Always-on (independent of the heartbeat) since `claude agents` can't see the
 *  hive's sibling sessions. PII-free; never throws (called from a timer). */
function writeFleetSnapshot(): void {
  if (!hive.enabled()) return;
  try {
    const reg = hive.registry();
    const snap = telemetry.snapshot();
    const usageById = new Map(snap.usage.map((u) => [u.agentId, u]));
    const now = Date.now();
    const agents = Object.entries(reg.agents)
      .filter(([, a]) => !a.archived)
      .map(([id, a]) => {
        const u = usageById.get(id);
        const spans = snap.spans[id] ?? [];
        const tokens = u ? u.input + u.output + u.cacheRead + u.cacheCreation : 0;
        return {
          id,
          name: a.name,
          role: a.role ?? (a.isGod ? 'orchestrator' : a.isAssistant ? 'assistant' : 'agent'),
          cwd: a.cwd,
          isGod: !!a.isGod,
          isAssistant: !!a.isAssistant,
          breaker: breaker.levelFor(id),
          tokens,
          // `u.usd === null` = unpriced (unknown model): surface null, never $0,
          // so the fleet snapshot doesn't read an unpriced desk as free (FR-006).
          usd: u && u.usd != null ? Number(u.usd.toFixed(4)) : null,
          lastTool: spans.length ? spans[spans.length - 1].tool : null,
          lastActiveSecAgo: u ? Math.round((now - u.ts) / 1000) : null,
          inboxBacklog: hive.inboxBacklog(id)
        };
      });
    hive.writeFleetSnapshot({ ts: now, agents });
  } catch (e) {
    console.error('[fleet] snapshot failed:', e);
  }
}

/** Arm the heartbeat with an adaptive, self-rescheduling cadence (recursive
 *  setTimeout instead of a fixed setInterval). Each beat runs the cost/breaker
 *  pass, re-engages a quiet floor, stamps lastFiredAt, then re-arms: ~base on a
 *  normal beat, base/4 (min 30s) when an agent looks stuck, base*2.5 right after
 *  a re-engage. Registered into missionTimers so shutdown tears it down. */
function armHeartbeat(m: ScheduledMission): void {
  const base = m.intervalMs;
  const quiet = m.quietThresholdMs ?? 300_000;
  const beat = (): void => {
    let next = base;
    try {
      // (the breaker beat + cost ledger now run on their own always-on timer)
      if (isFloorQuiet(quiet)) {
        reengageGod(buildHeartbeatDigest(quiet));
        next = Math.round(base * 2.5);            // back off after re-engaging
      } else if (looksStuck(quiet)) {
        next = Math.max(30_000, Math.round(base / 4)); // tighten when an agent is wedged
      }
      const cur = readConfig().missions ?? [];
      writeConfig({ missions: cur.map((x) => (x.id === m.id ? { ...x, lastFiredAt: Date.now() } : x)) });
      try { liveWebContents()?.send('missions:updated'); } catch { /* window gone */ }
    } catch (e) {
      console.error('[heartbeat]', e);
    }
    const entry = missionTimers.get(m.id) ?? {};
    entry.timeout = setTimeout(beat, next);
    missionTimers.set(m.id, entry);
  };
  const remaining = Math.max(0, base - (Date.now() - (m.lastFiredAt ?? 0)));
  missionTimers.set(m.id, { timeout: setTimeout(beat, remaining) });
}

/** The live renderer webContents, or null if the window is gone/destroyed.
 *  Anything that emits to the renderer from a timer/socket/child callback must
 *  route through here — during quit the window can be destroyed while those
 *  callbacks are still in flight, and `.send()` on a destroyed webContents
 *  throws "Object has been destroyed" (the main-process crash dialog). */
function liveWebContents(): Electron.WebContents | null {
  const wc = mainWindow?.webContents;
  return wc && !wc.isDestroyed() ? wc : null;
}

// ─── Slack webhook server (Slack message → Michael's queue) ──────────────────
/** The running Slack ingestion server, or null when disabled/stopped. */
let slackServer: SlackWebhookServer | null = null;

/** Build a SlackWebhookServer from the current config and start it, replacing
 *  any running instance, and return the start result (incl. the public tunnel
 *  URL the user pastes into Slack). No-op + error result when the integration is
 *  disabled or the signing secret is unset. */
async function startSlackServer(): Promise<{ ok: boolean; url?: string; error?: string }> {
  const cfg = readConfig();
  if (!cfg.slackEnabled || !cfg.slackSigningSecret) {
    return { ok: false, error: 'slack disabled or missing signing secret' };
  }
  slackServer?.stop();
  slackServer = new SlackWebhookServer({
    port: cfg.slackPort && cfg.slackPort > 0 ? cfg.slackPort : 3847,
    signingSecret: cfg.slackSigningSecret,
    channelId: cfg.slackChannelId,
    // Fires from the HTTP server's event loop (not the IPC thread); route through
    // liveWebContents() so a message arriving during window teardown can't throw.
    onMessage: (text) => {
      try { liveWebContents()?.send('slack:incomingMessage', { text }); }
      catch { /* window torn down */ }
    }
  });
  const res = await slackServer.start();
  // ok:false means we never bound the port → drop the instance. ok:true with no
  // url just means the tunnel is unavailable; the local handler is still live.
  if (!res.ok) slackServer = null;
  return res;
}

/** Stop and forget the Slack server. Best-effort; safe to call when not running. */
function stopSlackServer(): void {
  try { slackServer?.stop(); } catch (e) { console.error('[slack] stop failed:', e); }
  slackServer = null;
}

/** The persisted main-window geometry (kv key `window.bounds`). */
interface WindowBounds { x?: number; y?: number; width: number; height: number }

const DEFAULT_WIN = { width: 1440, height: 900 };
const MIN_WIN = { width: 1280, height: 800 };

/** Validate + clamp restored bounds: enforce the minimum size, and drop a
 *  position that no longer lands on any connected display (monitor unplugged) so
 *  the window can't open off-screen. Returns null for unusable input. */
function clampBounds(b: unknown): WindowBounds | null {
  if (!b || typeof b !== 'object') return null;
  const r = b as Partial<WindowBounds>;
  if (typeof r.width !== 'number' || typeof r.height !== 'number') return null;
  const width = Math.max(MIN_WIN.width, Math.round(r.width));
  const height = Math.max(MIN_WIN.height, Math.round(r.height));
  if (typeof r.x !== 'number' || typeof r.y !== 'number') return { width, height };
  const x = Math.round(r.x), y = Math.round(r.y);
  // Keep the position only if the window rect overlaps some display's work area.
  const onScreen = screen.getAllDisplays().some((d) => {
    const wa = d.workArea;
    return x < wa.x + wa.width && x + width > wa.x && y < wa.y + wa.height && y + height > wa.y;
  });
  return onScreen ? { x, y, width, height } : { width, height };
}

/** Minimal trailing-edge debounce for the move/resize flood. */
function debounce(fn: () => void, ms: number): () => void {
  let t: NodeJS.Timeout | null = null;
  return () => { if (t) clearTimeout(t); t = setTimeout(() => { t = null; fn(); }, ms); };
}

function createWindow(): void {
  // Restore the last window geometry (kv), falling back to the default size.
  let saved: WindowBounds | null = null;
  try { saved = clampBounds(persist.getKv('window.bounds')); } catch { saved = null; }

  const win = new BrowserWindow({
    width: saved?.width ?? DEFAULT_WIN.width,
    height: saved?.height ?? DEFAULT_WIN.height,
    ...(saved && saved.x !== undefined && saved.y !== undefined ? { x: saved.x, y: saved.y } : {}),
    minWidth: MIN_WIN.width,
    minHeight: MIN_WIN.height,
    title: 'Munder Difflin',
    backgroundColor: '#FFF8E7',
    titleBarStyle: 'hiddenInset',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // The renderer runs the hive's heartbeat loops (inbox nudge, message
      // flush, telemetry polls). Chromium throttles timers in occluded windows
      // — incl. behind the LOCK SCREEN — which silently stalls the hive while
      // the user is away. Don't.
      backgroundThrottling: false
    }
  });

  mainWindow = win;

  // Persist geometry as the user drags/resizes (debounced) and on close. Skip
  // while maximized/minimized so a restore doesn't save the fullscreen rect.
  const saveBounds = debounce(() => {
    if (win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
    try { persist.setKv('window.bounds', win.getBounds()); } catch { /* DB best-effort */ }
  }, 400);
  win.on('resized', saveBounds);
  win.on('moved', saveBounds);
  win.on('close', () => {
    if (win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
    try { persist.setKv('window.bounds', win.getBounds()); } catch { /* DB best-effort */ }
  });

  win.once('ready-to-show', () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // On macOS, the red-X "close" event by default destroys the window — and on
  // a single-window app, that effectively quits. Intercept it the same way we
  // intercept before-quit so PTY users get the warning.
  win.on('close', (e) => {
    if (allowQuit) return;
    const count = ptyManager.list().length;
    if (count === 0) return;
    e.preventDefault();
    win.focus();
    win.webContents.send('app:closeRequested', { ptyCount: count });
  });

  ptyManager.attachWebContents(win.webContents);

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
}

// ─── IPC: pty lifecycle ─────────────────────────────────────────────────────
ipcMain.handle('pty:spawn', async (_evt, opts: SpawnOptions & { hive?: AgentMeta; isolate?: boolean; resume?: boolean }) => {
  if (!opts || typeof opts.id !== 'string' || typeof opts.cwd !== 'string' || typeof opts.command !== 'string') {
    return { ok: false, error: 'invalid SpawnOptions' };
  }
  // Git isolation: give the agent its own worktree on an `agent/<id>` branch so it can't
  // clobber other agents' (or the user's) working tree. AUTO-isolate when the target repo
  // already hosts another (non-archived) worker — the newcomer gets a worktree while the
  // FIRST agent keeps the main tree (the integration base); the explicit "isolate" checkbox
  // forces it regardless. A RESTART of an already-isolated desk REATTACHES to its existing
  // worktree (see provisionWorktree) even when neither flag is set, so a role-toggle
  // auto-restart never silently drops a desk back into the shared tree. Best-effort — a
  // failure falls back to the shared cwd. (The god/assistant never isolate; their cwd isn't a repo.)
  const isWorkerDesk = !!opts.hive && !opts.hive.isGod && !opts.hive.isAssistant;
  const repoOccupied =
    isWorkerDesk &&
    ([...worktreeOrigins.values()].includes(opts.cwd) ||
      Object.values(hive.registry().agents).some(
        (a) => !a.archived && a.cwd === opts.cwd && a.id !== opts.hive!.id
      ));
  if (isWorkerDesk && await isRepo(opts.cwd)) {
    const wt = await provisionWorktree(opts.cwd, opts.hive?.id ?? opts.id, opts.isolate === true || repoOccupied);
    if (wt) {
      opts.cwd = wt.path;
      worktreePaths.set(opts.id, wt.path);
      worktreeOrigins.set(opts.id, wt.origin);
    }
  }
  // If the agent carries hive metadata, provision its workspace and inject the
  // identity + protocol (extra --append-system-prompt args + AGENT_* env).
  if (opts.hive && hive.enabled()) {
    // Ensure the agent's working dir exists before it spawns there — chiefly the god's
    // dedicated workspace (a sibling of the hive bookkeeping), which won't exist on the
    // first run. A no-op for an existing project cwd / the harness home.
    try { mkdirSync(opts.cwd, { recursive: true }); } catch { /* best-effort */ }
    try {
      const inj = hive.ensureAgent(
        { ...opts.hive, cwd: opts.cwd },
        { semanticMemory: memory.active(), theme: readConfig().terminalTheme ?? 'light', sddp: readConfig().sddpMode === true }
      );
      opts.args = [...(opts.args ?? []), ...inj.args];
      // Point the agent's mempalace CLI at the shared palace (no-op if inactive).
      opts.env = { ...(opts.env ?? {}), ...inj.env, ...memory.env() };
    } catch (e) {
      // Hive provisioning is best-effort; never block a spawn on it.
      console.error('[hive] ensureAgent failed:', e);
    }
  }
  // Long-run guardrails + tiering (Lane A #6.4/#6.6). All additive to the args
  // already assembled (incl. the hive injection); an explicit choice always wins.
  if (opts.hive) {
    const cfg = readConfig();
    const args = opts.args ?? [];
    // Model precedence (UNCHANGED, DR-8): an explicit per-agent --model (from the
    // renderer) wins; else the user's global defaultModel; else the role-based
    // default tier. Track the explicit value so we can record its provider below.
    const explicitIdx = args.indexOf('--model');
    const explicitModel = explicitIdx >= 0 ? args[explicitIdx + 1] : undefined;
    if (explicitIdx < 0) {
      const m = cfg.defaultModel ?? modelForRole(opts.hive);
      if (m) args.push('--model', m);
    }
    // E005 {FR-008} — derive + record the providerId for the resolved model (the
    // explicit --model when present, else the precedence result just pushed) so the
    // E006 native runtime seam can consume it. Provider is DERIVED, never stored on
    // the agent record (DR-1); an unresolvable/role-based model derives null and we
    // simply record nothing. This does NOT change spawn behavior (Claude/PTY path
    // is unaffected) — it only records a derivation for downstream.
    const resolvedModel = explicitModel ?? cfg.defaultModel ?? modelForRole(opts.hive);
    const providerId = deriveProviderId(resolvedModel);
    if (providerId) agentProviderIds.set(opts.hive.id, providerId);
    else agentProviderIds.delete(opts.hive.id);
    // E006 {FR-008} — spawn router: a desk assigned to a NATIVE provider (a derived
    // providerId that is not Claude/anthropic) LAUNCHES on that provider via the
    // native worker + the adapter selected from the injected env, NOT the Claude PTY
    // path. A Claude/anthropic desk (or an unresolvable/role-based model) falls
    // through to the existing PTY spawn below, unchanged.
    if (providerId && providerId !== 'anthropic') {
      // T021 {FR-008} — missing-key guard: nativeRuntime.spawn returns
      // 'needs-credentials' when no key is stored (E004 presence false); surface a
      // clear "needs credentials" state to the operator rather than a broken loop.
      const spawnRes = nativeRuntime.spawn(opts.hive.id, providerId, resolvedModel ?? undefined);
      if (!spawnRes.ok) {
        if (spawnRes.error === 'needs-credentials') {
          try {
            liveWebContents()?.send('agent:needsCredentials', {
              agentId: opts.hive.id,
              providerId,
              model: resolvedModel ?? null
            });
          } catch { /* window tore down — the operator still sees the failed spawn */ }
          // Drop the PTY→agent record we never created and report the gap.
          ptyToAgent.delete(opts.id);
          return { ok: false, error: `needs credentials for provider "${providerId}"` };
        }
        return { ok: false, error: spawnRes.error };
      }
      // Native desk launched on its provider; the Claude PTY path is bypassed.
      // (No PTY ⇒ no keep-awake change here; native exit teardown runs syncKeepAwake.)
      return { ok: true, native: true };
    }
    // Coarse runaway cap.
    if (typeof cfg.maxTurns === 'number' && cfg.maxTurns > 0 && !args.includes('--max-turns')) {
      args.push('--max-turns', String(cfg.maxTurns));
    }
    // Idempotent resume (#6.6a): only when explicitly requested and we have a
    // prior session id for this agent.
    if (opts.resume === true) {
      const sid = hive.lastSession(opts.hive.id);
      if (sid && !args.includes('--resume')) args.push('--resume', sid);
    }
    opts.args = args;
  }
  // Remember which agent owns this PTY so closing the tab can archive it. A
  // live terminal means active — ensureAgent above already cleared `archived`.
  if (opts.hive?.id) ptyToAgent.set(opts.id, opts.hive.id);
  // Pre-accept Claude Code's bypass-mode warning + folder-trust dialog so the
  // agent (spawned with --permission-mode bypassPermissions) doesn't stall on an
  // interactive prompt it can't answer and exit code 1. Best-effort, never blocks.
  try { ensureClaudePermissionsAccepted(opts.cwd); } catch { /* never block spawn */ }
  const res = ptyManager.spawn(opts);
  syncKeepAwake(); // arm the power-save blocker while ≥1 agent PTY is alive (#18)
  return res;
});
ipcMain.handle('pty:write', (_evt, id: string, data: string) => {
  if (typeof id !== 'string' || typeof data !== 'string') return { ok: false, error: 'invalid args' };
  return ptyManager.write(id, data);
});
ipcMain.handle('pty:resize', (_evt, id: string, cols: number, rows: number) => {
  if (typeof id !== 'string' || typeof cols !== 'number' || typeof rows !== 'number') return { ok: false, error: 'invalid args' };
  return ptyManager.resize(id, cols, rows);
});
ipcMain.handle('pty:kill', (_evt, id: string) => {
  if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
  // Kill the process, then run the shared lifecycle teardown (archive the agent,
  // remove its isolated worktree, drop the maps). teardownPty is idempotent, so
  // node-pty firing onExit once the child actually dies is a harmless no-op.
  const res = ptyManager.kill(id);
  teardownPty(id);
  return res;
});
ipcMain.handle('pty:list', () => ptyManager.list());

// ─── IPC: worktrees (review + bulk cleanup) ─────────────────────────────────-
// Isolated agents' worktrees are KEPT on exit (so committed work survives for the god
// to integrate); this surface lets the operator review + delete stale ones. Origins are
// the registered repos plus any live worktree origins this session; each repo's worktrees
// are enumerated from git itself (the source of truth, survives restarts).
ipcMain.handle('git:listWorktrees', async (): Promise<Array<GitWorktree & { repo: string }>> => {
  const origins = new Set<string>([...(readConfig().registeredRepos ?? []), ...worktreeOrigins.values()]);
  const out: Array<GitWorktree & { repo: string }> = [];
  for (const repo of origins) {
    const res = await listWorktrees(repo);
    if (Array.isArray(res)) for (const w of res) { if (!w.isMain) out.push({ ...w, repo }); }
  }
  return out;
});
ipcMain.handle('git:removeWorktree', async (_evt, repo: unknown, wtPath: unknown) => {
  if (typeof repo !== 'string' || typeof wtPath !== 'string') return { ok: false, error: 'invalid args' };
  return removeWorktree(repo, wtPath);
});

// ─── IPC: clipboard ─────────────────────────────────────────────────────────
ipcMain.handle('app:copyToClipboard', (_evt, text: unknown) => {
  if (typeof text !== 'string') return { ok: false, error: 'invalid text' };
  try { clipboard.writeText(text); return { ok: true }; }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
});
ipcMain.handle('app:readClipboard', () => {
  try { return clipboard.readText(); } catch { return ''; }
});
// NOTE: the terminal theme is mirrored into each agent's per-session Claude
// settings at spawn (hive.ensureAgent theme option) — deliberately NOT via
// `claude config set -g theme`, which would also restyle the user's own
// Claude sessions outside the app.

// ─── IPC: folder picker ─────────────────────────────────────────────────────
ipcMain.handle('dialog:chooseFolder', async (evt) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (!win) return { ok: false as const, error: 'no window' };
  const res = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Pick a folder'
  });
  if (res.canceled || res.filePaths.length === 0) return { ok: false as const, error: 'cancelled' };
  return { ok: true as const, path: res.filePaths[0] };
});

// ─── IPC: open a desk's working directory (folder / editor / terminal) ───────
// Cross-platform actions on an agent's cwd. `folder:reveal` + `folder:openInEditor` use a
// detached child + resolve immediately (the launcher exits even though the app stays open).

/** Launch a detached process; resolve ok unless the spawn itself errors (ENOENT). */
function launch(cmd: string, args: string[], opts: { cwd?: string; shell?: boolean } = {}): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    try {
      const p = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false, ...opts });
      p.on('error', (e) => resolve({ ok: false, error: e.message }));
      p.unref();
      // No 'close' wait — a launcher (open/explorer/wt) exits fast; treat a clean spawn as ok.
      setTimeout(() => resolve({ ok: true }), 150);
    } catch (e) {
      resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
}

ipcMain.handle('folder:reveal', async (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string' || !cwd) return { ok: false, error: 'invalid cwd' };
  const err = await shell.openPath(cwd); // '' on success
  return err ? { ok: false, error: err } : { ok: true };
});

ipcMain.handle('folder:openInEditor', async (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string' || !cwd) return { ok: false, error: 'invalid cwd' };
  // VS Code's `code` launcher (a .cmd shim on Windows → needs shell:true). Fall back to
  // revealing the folder if `code` isn't on PATH.
  const res = await launch('code', [cwd], { shell: process.platform === 'win32' });
  if (res.ok) return res;
  const err = await shell.openPath(cwd);
  return err ? { ok: false, error: `no 'code' on PATH; ${err}` } : { ok: true };
});

ipcMain.handle('terminal:openAtFolder', async (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string' || !cwd) return { ok: false, error: 'invalid cwd' };
  if (process.platform === 'darwin') return launch('open', ['-a', 'Terminal', cwd]);
  if (process.platform === 'win32') {
    // Prefer Windows Terminal (`wt -d <cwd>`); fall back to a cmd window at the folder.
    const wt = await launch('wt', ['-d', cwd], { shell: true });
    return wt.ok ? wt : launch('cmd', ['/c', 'start', 'cmd', '/k', `cd /d "${cwd}"`], { shell: true });
  }
  const xterm = await launch('x-terminal-emulator', ['--working-directory', cwd]);
  return xterm.ok ? xterm : launch('xdg-open', [cwd]);
});

// ─── IPC: config ────────────────────────────────────────────────────────────
// E004 — config:get is REDACTED: the renderer never receives provider key values,
// only presence (providerKeyPresence). Keys live in config.json + a worker's
// spawn env, never anywhere the renderer can read.
ipcMain.handle('config:get', (): SafeConfig => redactConfig(readConfig()));
ipcMain.handle('config:update', (_evt, patch: Partial<HarnessConfig>) => writeConfig(patch));

// E004 — provider credentials. Set/clear validate against the E002 registry; the
// renderer only ever learns presence, never values.
ipcMain.handle('credentials:set', (_evt, providerId: unknown, key: unknown) => {
  if (typeof providerId !== 'string' || typeof key !== 'string' || !key) return { ok: false, error: 'invalid' };
  try {
    // The web-search API key is a reserved non-provider credential (redacted like any
    // key); allow it alongside the registry provider ids.
    const known = [...listProviders().map((p) => p.id), WEB_SEARCH_KEY_ID];
    writeConfig({ providerKeys: setKeyInConfig(readConfig(), providerId, key, known).providerKeys });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});
ipcMain.handle('credentials:clear', (_evt, providerId: unknown) => {
  if (typeof providerId !== 'string') return { ok: false, error: 'invalid' };
  writeConfig({ providerKeys: clearKeyInConfig(readConfig(), providerId).providerKeys });
  return { ok: true };
});
ipcMain.handle('credentials:presence', () => keyPresence(readConfig(), [...listProviders().map((p) => p.id), WEB_SEARCH_KEY_ID]));
ipcMain.handle('config:ensureHome', (_evt, path: unknown) => {
  if (typeof path !== 'string' || path.length === 0) return { ok: false, error: 'invalid path' };
  return ensureHarnessHome(path);
});

// Change the harnessHome folder. Because every derived path (hive root, palace,
// sock, agent dirs) resolves lazily through getHome(), the only real work is
// optionally MOVING the existing hive + palace and relaunching so every service
// re-binds against the new root. mode: 'move' copies the data (old kept as a
// safety net), 'fresh' just re-points and bootstraps an empty home.
ipcMain.handle('config:changeHome', async (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { newHome?: unknown; mode?: unknown };
  if (typeof p.newHome !== 'string' || !p.newHome) return { ok: false, error: 'invalid newHome' };
  const mode: 'move' | 'fresh' = p.mode === 'fresh' ? 'fresh' : 'move';
  const newHome = resolve(p.newHome);
  const oldRaw = readConfig().harnessHome;
  const oldHome = oldRaw ? resolve(oldRaw) : null;

  // Guard against same-folder / nested-folder (a move would self-copy forever).
  if (oldHome) {
    if (newHome === oldHome) return { ok: false, error: 'That is already the current home folder.' };
    const a = newHome + sep, b = oldHome + sep;
    if (a.startsWith(b) || b.startsWith(a)) {
      return { ok: false, error: 'Pick a folder that is not inside (or a parent of) the current home.' };
    }
  }

  const ensured = ensureHarnessHome(newHome);
  if (!ensured.ok) return ensured;

  // Tear down everything bound to the OLD root before copying, so nothing writes
  // mid-copy — a live git commit into hive/.git would otherwise be copied as a
  // half-written object and corrupt the moved repo.
  try { clearMissionTimers(); } catch (e) { console.error('[changeHome] clearMissionTimers:', e); }
  try { hive.stopRouter(); } catch (e) { console.error('[changeHome] stopRouter:', e); }
  try { hookServer.stop(); } catch (e) { console.error('[changeHome] hookServer.stop:', e); }
  try { stopSlackServer(); } catch (e) { console.error('[changeHome] slack.stop:', e); }
  try { memory.stop(); } catch (e) { console.error('[changeHome] memory.stop:', e); }
  try { reflector.stop(); } catch (e) { console.error('[changeHome] reflector.stop:', e); }

  if (mode === 'move' && oldHome) {
    try {
      for (const sub of ['hive', 'palace']) {
        const src = join(oldHome, sub);
        if (!existsSync(src)) continue;
        // cpSync copies the whole tree incl. .git and is cross-device safe (unlike
        // renameSync, which throws EXDEV across volumes). We COPY, never delete —
        // the old folder stays as a safety net the user removes manually.
        cpSync(src, join(newHome, sub), { recursive: true, force: true, dereference: false });
      }
    } catch (e) {
      // Copy failed: recover IN PLACE against the unchanged old home (config never
      // repointed) so the user loses nothing, and surface the error — no relaunch.
      bootstrapHiveServices();
      const cfg = readConfig();
      if (cfg.slackEnabled && cfg.slackSigningSecret) void startSlackServer();
      return { ok: false, error: `Could not copy data: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  // Repoint config and relaunch so every service re-bootstraps against newHome.
  // (Identical recovery path to resetAll — relaunch is the clean re-bind.)
  allowQuit = true;
  writeConfig({ harnessHome: newHome });
  try { ptyManager.killAll(); } catch (e) { console.error('[changeHome] killAll:', e); }
  app.relaunch();
  app.exit(0);
  return { ok: true as const }; // unreachable (process exits) — typed for the renderer
});

// ─── IPC: filesystem (sandboxed to a root) ──────────────────────────────────
ipcMain.handle('fs:listDir', (_evt, root: unknown, rel: unknown) => {
  if (typeof root !== 'string' || typeof rel !== 'string') return { ok: false, error: 'invalid args' };
  return listDir(root, rel);
});
ipcMain.handle('fs:readFile', (_evt, root: unknown, rel: unknown) => {
  if (typeof root !== 'string' || typeof rel !== 'string') return { ok: false, error: 'invalid args' };
  return readFileText(root, rel);
});
ipcMain.handle('fs:writeFile', (_evt, root: unknown, rel: unknown, content: unknown) => {
  if (typeof root !== 'string' || typeof rel !== 'string' || typeof content !== 'string') {
    return { ok: false, error: 'invalid args' };
  }
  return writeFileText(root, rel, content);
});

// ─── IPC: git ───────────────────────────────────────────────────────────────
ipcMain.handle('git:isRepo', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return false;
  return isRepo(cwd);
});
ipcMain.handle('git:branch', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid cwd' };
  return getBranch(cwd);
});
ipcMain.handle('git:status', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid cwd' };
  return getStatus(cwd);
});
ipcMain.handle('git:log', (_evt, cwd: unknown, n: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid cwd' };
  const count = typeof n === 'number' ? Math.min(500, Math.max(1, n)) : 50;
  return getLog(cwd, count);
});
ipcMain.handle('git:branches', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid cwd' };
  return getBranches(cwd);
});
ipcMain.handle('git:aheadBehind', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid cwd' };
  return getAheadBehind(cwd);
});

// ─── IPC: hive (multi-agent coordination) ───────────────────────────────────
ipcMain.handle('hive:registry', () => hive.registry());
ipcMain.handle('hive:board', () => hive.board());
ipcMain.handle('hive:tasks', () => hive.tasks());
ipcMain.handle('hive:log', (_evt, n: unknown) => hive.logTail(typeof n === 'number' ? n : 200));
ipcMain.handle('hive:memory', (_evt, id: unknown) => (typeof id === 'string' ? hive.memory(id) : ''));
ipcMain.handle('hive:inbox', (_evt, id: unknown) => (typeof id === 'string' ? hive.inbox(id) : []));
ipcMain.handle('hive:send', (_evt, partial: Partial<HiveMessage>, from: unknown) => {
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  const msg = hive.send(partial ?? {}, typeof from === 'string' ? from : 'system');
  return { ok: true, message: msg };
});
ipcMain.handle('hive:writeTasks', (_evt, tasks: unknown) => {
  if (!Array.isArray(tasks)) return { ok: false, error: 'invalid tasks' };
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  hive.writeTasks(tasks as HiveTask[]);
  return { ok: true };
});
ipcMain.handle('hive:setArchived', (_evt, id: unknown, archived: unknown) => {
  if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  hive.setArchived(id, archived === true);
  return { ok: true };
});
ipcMain.handle('hive:setRoles', (_evt, id: unknown, roles: unknown) => {
  if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  const valid = Array.isArray(roles)
    ? roles.filter((r): r is AgentRole => r === 'worker' || r === 'reviewer' || r === 'integrator' || r === 'planner' || r === 'qc')
    : [];
  hive.setRoles(id, valid);
  return { ok: true };
});

// ─── IPC: enrichment assistant (headless Sonnet 1M prompt prep) ─────────────
ipcMain.handle('assistant:enrich', async (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { message?: unknown; cwd?: unknown };
  if (typeof p.message !== 'string' || !p.message.trim()) {
    return { ok: false, error: 'empty message' };
  }
  const cfg = readConfig();
  const cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : cfg.harnessHome;
  if (!cwd) return { ok: false, error: 'no working directory available' };
  try {
    return await enrichMessage({
      message: p.message,
      cwd,
      repos: cfg.registeredRepos ?? [],
      command: cfg.defaultCommand,
      env: memory.env()
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});

// ─── IPC: semantic memory (MemPalace CLI) ───────────────────────────────────
ipcMain.handle('hive:memoryStatus', () => { memory.resetBinCache(); return memory.status(); });
ipcMain.handle('hive:searchMemory', (_evt, query: unknown, wing: unknown) => {
  if (typeof query !== 'string' || !query.trim()) return { ok: false, output: '', error: 'empty query' };
  return memory.search(query, { wing: typeof wing === 'string' ? wing : undefined });
});
ipcMain.handle('hive:memoryWakeUp', (_evt, wing: unknown) =>
  memory.wakeUp(typeof wing === 'string' ? wing : undefined));
ipcMain.handle('hive:mineNow', () => { memory.mineNow(); return { ok: true }; });
// Condense memory.md on demand: an explicit id condenses that one agent (skips
// the size trigger — a "condense now" button); no id runs a full threshold scan.
ipcMain.handle('memory:reflectNow', (_evt, id: unknown) =>
  reflector.reflectNow(typeof id === 'string' && id ? id : undefined));

// ─── IPC: command history (SQLite — every prompt submitted to an agent) ──────
ipcMain.handle('history:add', (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { agentId?: unknown; cwd?: unknown; text?: unknown };
  if (typeof p.agentId !== 'string' || typeof p.text !== 'string') return { ok: false, error: 'invalid args' };
  try {
    persist.addHistory({ agentId: p.agentId, cwd: typeof p.cwd === 'string' ? p.cwd : null, text: p.text });
    return { ok: true };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
});
ipcMain.handle('history:list', (_evt, agentId: unknown, limit: unknown) =>
  persist.listHistory(
    typeof agentId === 'string' && agentId ? agentId : undefined,
    typeof limit === 'number' ? limit : undefined
  ));
ipcMain.handle('history:search', (_evt, query: unknown, limit: unknown) =>
  persist.searchHistory(typeof query === 'string' ? query : '', typeof limit === 'number' ? limit : undefined));

// ─── IPC: quit confirmation ─────────────────────────────────────────────────
ipcMain.handle('app:confirmClose', () => {
  allowQuit = true;
  // Each teardown step is best-effort: a throw here (e.g. a dying child or a
  // half-torn-down socket) must never abort the quit or pop a crash dialog.
  try { clearMissionTimers(); } catch (e) { console.error('[quit] clearMissionTimers:', e); }
  try { hive.stopRouter(); } catch (e) { console.error('[quit] stopRouter:', e); }
  try { hookServer.stop(); } catch (e) { console.error('[quit] hookServer.stop:', e); }
  try { telemetry.stop(); } catch (e) { console.error('[quit] telemetry.stop:', e); }
  try { stopSlackServer(); } catch (e) { console.error('[quit] slack.stop:', e); }
  try { memory.stop(); } catch (e) { console.error('[quit] memory.stop:', e); }
  try { reflector.stop(); } catch (e) { console.error('[quit] reflector.stop:', e); }
  try { persist.close(); } catch (e) { console.error('[quit] persist.close:', e); }
  try { ptyManager.killAll(); } catch (e) { console.error('[quit] killAll:', e); }
  try { nativeRuntime.killAll(); } catch (e) { console.error('[quit] nativeRuntime killAll:', e); }
  app.quit();
});
ipcMain.handle('app:cancelClose', () => {
  // no-op — modal will close on the renderer side
});

// ─── IPC: full reset (wipe data + config, relaunch into onboarding) ──────────
ipcMain.handle('app:resetAll', () => {
  allowQuit = true;
  // Tear everything down first so nothing writes back into the dirs we wipe.
  try { clearMissionTimers(); } catch (e) { console.error('[reset] clearMissionTimers:', e); }
  try { hive.stopRouter(); } catch (e) { console.error('[reset] stopRouter:', e); }
  try { hookServer.stop(); } catch (e) { console.error('[reset] hookServer.stop:', e); }
  try { telemetry.stop(); } catch (e) { console.error('[reset] telemetry.stop:', e); }
  try { stopSlackServer(); } catch (e) { console.error('[reset] slack.stop:', e); }
  try { memory.stop(); } catch (e) { console.error('[reset] memory.stop:', e); }
  try { reflector.stop(); } catch (e) { console.error('[reset] reflector.stop:', e); }
  try { persist.close(); } catch (e) { console.error('[reset] persist.close:', e); }
  try { ptyManager.killAll(); } catch (e) { console.error('[reset] killAll:', e); }
  // Erase the hive (Michael's + every agent's memory, inboxes, tasks, board,
  // git history) and the semantic-memory palace. Only these harness-created
  // subdirs are removed — never the user's whole harnessHome folder.
  for (const dir of [hive.root(), memory.palacePath()]) {
    if (!dir) continue;
    try { rmSync(dir, { recursive: true, force: true }); }
    catch (e) { console.error('[reset] rm', dir, e); }
  }
  // Back to first-run defaults, then relaunch clean so all in-memory services
  // re-bootstrap from scratch and the renderer lands on onboarding.
  resetConfig();
  app.relaunch();
  app.exit(0);
});

// ─── IPC: token telemetry (real usage + est. cost from CC transcripts) ───────
// Reconciler/fallback path: per-cwd transcript sum, now priced PER MODEL (cost
// bug #1 fixed in pricing.ts). Kept for back-compat with the existing UsageRow.
ipcMain.handle('hive:agentUsage', (_evt, cwd: unknown) =>
  typeof cwd === 'string' ? readAgentUsage(cwd) : null);
// Current context size (tokens) of an agent's LIVE session — the transcript
// path is learned from the agent's hook payloads (SessionStart fires right at
// spawn), so this works even when several agents share one cwd. Null until the
// first hook fires; a known-but-empty transcript reads as 0 so a freshly
// (re)started session zeroes the gauge instead of leaving a stale value up.
ipcMain.handle('hive:agentContext', (_evt, agentId: unknown) => {
  if (typeof agentId !== 'string') return null;
  const tp = hookServer.transcriptPath(agentId);
  if (!tp) return null;
  return readContextTokens(tp) ?? 0;
});

// ─── IPC: live telemetry (the OTel collector — the locked usage-provider seam) ─
// The fleet grid + span waterfall (#7B) read these; Lane A's breaker (#6)
// consumes getAgentUsage in-process via the provider, not over IPC.
ipcMain.handle('telemetry:usage', (_evt, agentId: unknown) =>
  typeof agentId === 'string' ? telemetry.getAgentUsage(agentId) : null);
ipcMain.handle('telemetry:spans', (_evt, agentId: unknown) =>
  typeof agentId === 'string' ? telemetry.getSpans(agentId) : []);
ipcMain.handle('telemetry:snapshot', () => telemetry.snapshot());

// ─── IPC: native run-log replay (E008 T005 {FR-016/039/042}) ──────────────────
// Backfill the persisted native AgentEvent stream when a panel (re)opens or the app
// restarts. A READ-ONLY pass over the append-only log (main is the sole writer):
// the renderer folds the returned events into the SAME views it builds from the
// live `agent:event` stream, so reopen reconstructs the run deterministically.
// Missing/partial/corrupt/truncated each degrade to a best-effort array, never an
// error (graceful degradation, FR-016/042).
ipcMain.handle('agent:loadEvents', (_evt, agentId: unknown) => {
  if (typeof agentId !== 'string' || !agentId) return [];
  return loadNativeEvents(hive.enabled() ? hive.nativeEventsPath(agentId) : null);
});

// ─── IPC: operator input/steer to a native agent (E008 T022 {FR-015/021}) ─────
// The renderer-reachable native send seam — the native-desk peer of `pty:write`
// for a Claude desk. Routes an operator turn into the running native worker via
// the ProviderRuntime port (`runtimeFor(agentId).send(AgentInput)`, AD-004).
//
// Prompt-vs-steer routing (FR-021): a PLAIN PROMPT is delivered as
// `{ kind:'operator' }` (a typed turn); a STEER is delivered as `{ kind:'steer' }`
// — mid-run guidance — AND mirrored into the ControlRegistry so a native desk's
// control snapshot reflects the steer the same way the Claude `control:steer`
// seam does (operator-control parity). The two kinds reach the worker through
// distinct `AgentInput.kind`s so each is handled unambiguously.
//
// Fail-soft ack (FR-022): returns `{ ok:false, error }` when there is no native
// runtime for the agent (worker missing/not started) so the renderer can surface
// distinct not-delivered feedback rather than appearing to send silently. The
// Claude `pty:write` path is untouched — this is an additive native branch.
ipcMain.handle('native:send', (_evt, agentId: unknown, input: unknown): { ok: boolean; error?: string } => {
  if (typeof agentId !== 'string' || !agentId) return { ok: false, error: 'invalid agentId' };
  const raw = (input ?? {}) as { kind?: unknown; text?: unknown };
  const text = typeof raw.text === 'string' ? raw.text : '';
  if (!text.trim()) return { ok: false, error: 'empty input' };
  // Only operator/steer reach this seam from the panel; drain is hive-internal.
  const kind: AgentInput['kind'] = raw.kind === 'steer' ? 'steer' : 'operator';

  const runtime = nativeRuntime.runtimeFor(agentId);
  if (!runtime) return { ok: false, error: 'no native runtime for agent' };

  // A steer is mirrored into the operator-control registry (parity with the
  // Claude `control:steer` surface) and ALSO delivered to the worker as the
  // native steer seam — native agents have no hook boundary, so the worker
  // `send({kind:'steer'})` is where the guidance actually lands.
  if (kind === 'steer') control.steer(agentId, text);
  runtime.send({ kind, text });
  return { ok: true };
});

// ─── IPC: stop ONE native worker (operator kill, peer to `pty:kill`) ──────────
// The renderer routes a stop by runtime kind: a native desk (incl. the god) → here;
// a Claude desk → `pty:kill`. Killing fires the worker's exit teardown (archive), so a
// stopped native worker is gone until respawned (revive-on-demand, or the god's Start).
ipcMain.handle('native:kill', (_evt, agentId: unknown): { ok: boolean; error?: string } => {
  if (typeof agentId !== 'string' || !agentId) return { ok: false, error: 'invalid agentId' };
  return nativeRuntime.kill(agentId);
});

// ─── IPC: circuit-breaker state (Lane A #6 policy → this lane's avatars/meter) ─
// Lane A's breaker calls this with a BreakerState; we fan it out to the renderer
// on `control:breakerState`, where the avatar adapter gives it precedence over
// hook-derived status (#5C looping/zombie). Defined here so the channel exists
// before Jim's policy lands; he produces, this lane consumes.
ipcMain.handle('control:setBreakerState', (_evt, state: unknown) => {
  try { liveWebContents()?.send('control:breakerState', state); } catch { /* window tore down */ }
  return { ok: true };
});

// ─── IPC: operator control over agents (#7C.1–7C.3) ─────────────────────────
// All return the agent's fresh control snapshot so the UI can reflect state.
ipcMain.handle('control:pause', (_evt, agentId: unknown, on: unknown) => {
  if (typeof agentId !== 'string') return null;
  control.pause(agentId, on === true);
  return control.snapshot(agentId);
});
ipcMain.handle('control:resume', (_evt, agentId: unknown) => {
  if (typeof agentId !== 'string') return null;
  control.resume(agentId);
  return control.snapshot(agentId);
});
ipcMain.handle('control:gateTool', (_evt, agentId: unknown, tool: unknown, on: unknown) => {
  if (typeof agentId !== 'string' || typeof tool !== 'string') return null;
  control.gateTool(agentId, tool, on === true);
  return control.snapshot(agentId);
});
ipcMain.handle('control:steer', (_evt, agentId: unknown, text: unknown) => {
  if (typeof agentId !== 'string' || typeof text !== 'string') return null;
  control.steer(agentId, text);
  return control.snapshot(agentId);
});
ipcMain.handle('control:halt', (_evt, agentId: unknown) => {
  if (typeof agentId !== 'string') return null;
  control.halt(agentId);
  return control.snapshot(agentId);
});
ipcMain.handle('control:snapshot', (_evt, agentId: unknown) =>
  typeof agentId === 'string' ? control.snapshot(agentId) : null);

// ─── IPC: scheduled missions (recurring auto-dispatch) ──────────────────────
ipcMain.handle('missions:list', () => readConfig().missions ?? []);
ipcMain.handle('missions:save', (_evt, missions) => {
  // lastFiredAt is scheduler-owned. The renderer loads missions once and later
  // sends back a STALE array, so a wholesale write would clobber every
  // lastFiredAt the scheduler has stamped since. Merge by id and keep the newer
  // lastFiredAt (almost always the persisted one) so the UI can never erase it.
  const incoming = (Array.isArray(missions) ? missions : []) as ScheduledMission[];
  const persistedById = new Map(
    (readConfig().missions ?? []).map((m) => [m.id, m] as const)
  );
  const merged = incoming.map((m) => {
    const prevLastFired = persistedById.get(m.id)?.lastFiredAt ?? 0;
    const lastFiredAt = Math.max(m.lastFiredAt ?? 0, prevLastFired) || undefined;
    return { ...m, lastFiredAt };
  });
  writeConfig({ missions: merged });
  syncMissions();
  return { ok: true };
});
// Fire a mission immediately (the SCHEDULES "fire now" button), independent of its
// interval — dispatches its body to the target(s) right now. lastFiredAt updates, so the
// next interval fire shifts accordingly. (Heartbeat fires on its own adaptive beat, but a
// manual fire still drops its prompt into god's inbox, which is a useful nudge.)
ipcMain.handle('missions:fireNow', (_evt, id: unknown) => {
  const m = (readConfig().missions ?? []).find((x) => x.id === id);
  if (!m) return { ok: false, error: 'no such mission' };
  fireMission(m);
  return { ok: true };
});

// ─── IPC: full-text search across hive files (board, tasks, memory) ──────────
ipcMain.handle('hive:textSearch', (_evt, query: unknown) => {
  if (typeof query !== 'string' || !query.trim()) return { ok: false, results: [] };
  const root = hive.root();
  if (!root) return { ok: false, results: [] };
  const q = query.toLowerCase();
  const results: Array<{ source: string; excerpt: string }> = [];
  // Each target file is (path, readable label). agents/<id>/memory.md is expanded below.
  const targets: Array<{ path: string; source: string }> = [
    { path: join(root, 'board.md'), source: 'board.md' },
    { path: join(root, 'tasks.json'), source: 'tasks.json' }
  ];
  const agentsDir = join(root, 'agents');
  if (existsSync(agentsDir)) {
    for (const id of readdirSync(agentsDir)) {
      targets.push({ path: join(agentsDir, id, 'memory.md'), source: `${id}/memory.md` });
    }
  }
  for (const { path, source } of targets) {
    if (!existsSync(path)) continue;
    let hits = 0;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (hits >= 3) break;
      const idx = line.toLowerCase().indexOf(q);
      if (idx === -1) continue;
      // ~40 chars of context on either side of the match.
      const excerpt = line.slice(Math.max(0, idx - 40), idx + q.length + 40).trim();
      results.push({ source, excerpt });
      hits++;
    }
  }
  return { ok: true, results };
});

// ─── IPC: GitHub issue ingestion (gh CLI) ────────────────────────────────────
ipcMain.handle('github:issues', (_evt, cwd: unknown) =>
  typeof cwd === 'string' ? listIssues(cwd) : { ok: false, error: 'no cwd' }
);

// ─── IPC: GitHub CI status watcher (gh CLI) ──────────────────────────────────
ipcMain.handle('github:ciRuns', (_evt, cwd: unknown) =>
  typeof cwd === 'string' ? listCIRuns(cwd) : { ok: false, error: 'no cwd' }
);

// ─── IPC: desktop notifications toggle ──────────────────────────────────────
ipcMain.handle('app:setNotifications', (_evt, val) => writeConfig({ notifications: val === true }));

// ─── IPC: Slack integration ─────────────────────────────────────────────────
ipcMain.handle('slack:start', () => startSlackServer());
ipcMain.handle('slack:stop', () => { stopSlackServer(); return { ok: true }; });
ipcMain.handle('slack:setConfig', (_evt, patch: unknown) => {
  const p = (patch ?? {}) as {
    signingSecret?: unknown; botToken?: unknown; channelId?: unknown; port?: unknown; enabled?: unknown;
  };
  const next: Partial<HarnessConfig> = {};
  // Trim string fields; an emptied field clears back to undefined.
  if (typeof p.signingSecret === 'string') next.slackSigningSecret = p.signingSecret.trim() || undefined;
  if (typeof p.botToken === 'string') next.slackBotToken = p.botToken.trim() || undefined;
  if (typeof p.channelId === 'string') next.slackChannelId = p.channelId.trim() || undefined;
  if (typeof p.port === 'number' && Number.isFinite(p.port)) next.slackPort = p.port;
  if (typeof p.enabled === 'boolean') next.slackEnabled = p.enabled;
  writeConfig(next);
  // Reconcile the running server: disabling (or clearing the secret) stops it. We
  // deliberately do NOT auto-(re)start here — the user presses Start in Settings
  // to fetch the fresh (ephemeral) tunnel URL.
  const cfg = readConfig();
  if (!cfg.slackEnabled || !cfg.slackSigningSecret) stopSlackServer();
  return { ok: true };
});

// E005 {FR-013 / DR-10} — the GOD assignment seam over IPC. GOD assigns a
// provider+model to an agent through the SAME mechanism as the operator: this
// records the derived provider and forwards the model to the renderer, which
// applies it via the existing agent-update path (reassignAgentModel). Provider is
// derived, never stored (DR-1); no secret channel. Args are validated at the
// boundary (defensive coding) before delegating to assignAgentModel.
ipcMain.handle('agent:assign', (_evt, agentId: unknown, modelId: unknown) => {
  if (typeof agentId !== 'string') return { ok: false, providerId: null, error: 'invalid agentId' };
  if (modelId != null && typeof modelId !== 'string') {
    return { ok: false, providerId: null, error: 'invalid modelId' };
  }
  return assignAgentModel(agentId, typeof modelId === 'string' ? modelId : undefined);
});

/** Start every hive-bound background service against the current harnessHome.
 *  Called on boot, and again to recover in place if a folder-change copy fails
 *  (config:changeHome tears these down before copying). No-op without a home. */
function bootstrapHiveServices(): void {
  if (!hive.enabled()) return;
  hive.ensureHive();
  hive.startRouter();
  ensureDefaultMissions(); // one-time: seed the built-in hourly ops standup
  syncMissions(); // arm recurring auto-dispatch missions now the router is live
  hookServer.start();
  // Bind the telemetry collector BEFORE the renderer spawns any agent, then point
  // the hive at it so every subsequent spawn is instrumented. Best-effort — a bind
  // failure just leaves telemetry off (transcript reconciler stays). No breaker.start():
  // the breaker is POLICY-only, ticked by the heartbeat beat (#1, ships disabled).
  void telemetry.start().then((r) => {
    if (r.ok && r.endpoint) { hive.setOtelEndpoint(r.endpoint); console.log('[telemetry] collector listening', r.endpoint); }
    else console.error('[telemetry] collector failed to start:', r.error);
  });
  memory.start(); // init shared palace + mine loop (no-op without mempalace)
  reflector.start(); // bound oversized memory.md files on a timer (no-op until threshold)

  // Always-on beats (decoupled from the optional heartbeat): the live fleet
  // snapshot Michael reads (~8s) + the breaker/cost-ledger beat (~30s). Guarded so
  // a re-bootstrap (changeHome recovery) can't stack duplicate timers.
  if (fleetTimer) clearInterval(fleetTimer);
  writeFleetSnapshot();
  fleetTimer = setInterval(writeFleetSnapshot, 8_000);
  if (breakerBeatTimer) clearInterval(breakerBeatTimer);
  breakerBeatTimer = setInterval(() => { try { runBreakerBeat(300_000); } catch (e) { console.error('[breaker beat]', e); } }, 30_000);
}

app.whenReady().then(() => {
  // Open the durable store first — createWindow() reads the saved window bounds.
  // Guarded: a DB failure (e.g. a bad native build) must degrade to defaults,
  // never block app startup.
  try { persist.open(); } catch (e) { console.error('[db] open failed:', e); }
  // Bootstrap the hive (if harnessHome is configured) and start the message router.
  bootstrapHiveServices();
  createWindow();
  // Auto-start the Slack webhook server when configured. Best-effort: a tunnel
  // failure (offline) is logged, not fatal. The tunnel URL is ephemeral and
  // changes per restart, so the user re-pastes it via Settings → Start.
  const slackCfg = readConfig();
  if (slackCfg.slackEnabled && slackCfg.slackSigningSecret) {
    void startSlackServer().then((r) => {
      if (!r.ok) console.error('[slack] auto-start failed:', r.error);
      else console.log('[slack] webhook listening', r.url ? `(tunnel: ${r.url})` : '(no tunnel)');
    });
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// before-quit covers Cmd-Q / dock-quit; the per-window close handler covers
// the red close button. Both routes hit the same warning UX.
app.on('before-quit', (e) => {
  if (allowQuit) return;
  const count = ptyManager.list().length;
  if (count === 0) return;
  e.preventDefault();
  if (mainWindow) {
    mainWindow.focus();
    mainWindow.webContents.send('app:closeRequested', { ptyCount: count });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    ptyManager.killAll();
    app.quit();
  }
});
