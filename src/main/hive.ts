/**
 * The Hive — the on-disk multi-agent coordination layer.
 *
 * Lives under `<harnessHome>/hive/` as a single git repo that ONLY this main
 * process commits to (agents never call git — they just write files). See
 * HIVE.md for the full design. Responsibilities:
 *   - per-agent workspace (identity.md, memory.md, inbox/, outbox/, cursor.json)
 *   - a roster (registry.json), shared blackboard (board.md), task ledger,
 *     and an append-only event log (log.jsonl)
 *   - a router that drains each agent's outbox into recipients' inboxes
 *
 * Human-in-the-loop is native to each agent's Claude Code session: permission
 * prompts surface in the agent's own terminal (and can be approved remotely via
 * `/remote-control`). The hive keeps no separate approval queue — a message aimed
 * at "human" is routed to the god/orchestrator, the human's proxy on the floor.
 *   - single-committer git with retry/backoff + stale-lock recovery
 *
 * Everything here runs in the Electron main process.
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync,
  readdirSync, statSync, rmSync, appendFileSync
} from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import type { AgentUsageSample } from './usage';
import type { AgentEvent } from '../shared/agentEvent';
import { COMMAND_GROUPS } from '../shared/claudeCommands';
// The mailbox + task-ledger vocabulary is owned by @jsh562/won-agent-core (so the extracted
// coding toolkit is host-agnostic); re-exported below so existing `import { HiveMessage }
// from '../hive'` consumers across the app are unchanged.
import { reconcileBlocked, roleCanEditCode, canIntegrate, canReview, boardCapabilityLine } from '@jsh562/won-agent-core';
import type { MessageAct, HiveMessage, HiveTask, AgentRole, FeatureStatus } from '@jsh562/won-agent-core';

// ─── Types ──────────────────────────────────────────────────────────────────

export type { MessageAct, HiveMessage, HiveTask, AgentRole };
export { roleCanEditCode, canIntegrate, canReview, boardCapabilityLine };

export interface AgentMeta {
  id: string;
  name: string;
  role?: string;
  capabilities?: string[];
  /** Capability roles (worker / integrator). Drives the integration gate + delegation.
   *  Separate from the god/assistant identity flags. Defaulted in `ensureAgent` when
   *  unset (god → ['integrator'], normal desk → ['worker'], assistant → []). */
  roles?: AgentRole[];
  cwd: string;
  isGod?: boolean;
  /** Michael's prep assistant — enriches prompts and forwards them to Michael.
   *  Send-only: excluded from broadcast fan-out so it never drains an inbox. */
  isAssistant?: boolean;
}

export interface RegistryAgent extends AgentMeta {
  status: 'idle' | 'working' | 'blocked' | 'gone';
  lastSeen: number;
  /** True once the agent's terminal/PTY tab is closed. The record is retained
   *  (not deleted) so its history/memory survive; only agents with a live PTY
   *  are 'active'. Broadcast fan-out + roster reads skip archived agents. */
  archived?: boolean;
  /** Most recent Claude Code session_id seen for this agent (Lane A #6.6a),
   *  captured from hook payloads. Doubles as the `--resume` key (idempotent
   *  resume after a crash/restart) AND the cost accounting/dedup key on every
   *  AgentUsageSample / cost-ledger row. */
  sessionId?: string;
}

export interface Registry {
  godId: string | null;
  agents: Record<string, RegistryAgent>;
}

/** Build env + extra spawn args that make a `claude` process hive-aware. */
export interface SpawnInjection {
  args: string[];
  env: Record<string, string>;
}

const HOP_CAP = 12;

function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

/** Filesystem- and sort-safe timestamp, e.g. 2026-05-30T14-03-11-123Z. */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function shortRand(): string {
  return randomBytes(3).toString('hex');
}

/** Non-memory files `mempalace mine` must not ingest (Claude Code hooks config,
 *  cursor, raw inbox/outbox JSON). `mempalace mine` honors .gitignore, so we drop
 *  one in each agent dir; written on birth here and refreshed by the mine loop. */
const MINE_IGNORE_LINES = ['settings.json', 'cursor.json', 'inbox/', 'outbox/'];

/** Idempotently ensure `<agentDir>/.gitignore` excludes the non-memory files.
 *  Append-only: writes only the missing lines, leaving any existing entries. */
function ensureMineIgnore(agentDir: string): void {
  const path = join(agentDir, '.gitignore');
  let existing = '';
  try { if (existsSync(path)) existing = readFileSync(path, 'utf8'); } catch { return; }
  const have = new Set(existing.split('\n').map((l) => l.trim()));
  const missing = MINE_IGNORE_LINES.filter((l) => !have.has(l));
  if (missing.length === 0) return;
  const prefix = existing && !existing.endsWith('\n') ? existing + '\n' : existing;
  try { writeFileSync(path, prefix + missing.join('\n') + '\n', 'utf8'); } catch { /* best-effort */ }
}

// ─── HiveManager ────────────────────────────────────────────────────────────

export class HiveManager {
  /**
   * @param getHome  Lazily resolve harnessHome so the hive follows config changes.
   * @param emit     Optional sink for renderer-facing events (set by the main
   *                 process to `webContents.send`). Used to animate routed
   *                 messages on the office floor; a no-op in tests/headless.
   */
  constructor(
    private getHome: () => string | null,
    private emit?: (channel: string, payload: unknown) => void
  ) {}

  private routerTimer: NodeJS.Timeout | null = null;

  /** Resolve a desk's PROJECT repo (its origin repo for an isolated desk, else its cwd) so
   *  task notifications can match reviewers/integrators "for that project". Defaults to the
   *  registry cwd; the main process injects a worktree-origin-aware resolver. */
  private repoFor: (id: string) => string | null = (id) => this.registry().agents[id]?.cwd ?? null;
  setRepoResolver(fn: (id: string) => string | null): void { this.repoFor = fn; }

  /** Resolve an SDDP feature's on-disk phase from `<repo>/specs/<feature>/`, injected by the
   *  main process (scanFeatureStatus). Drives the planner/qc auto-routing (what's done). Default
   *  returns null ⇒ no resolver ⇒ feature status unknown (planner ping still fires for an
   *  un-started feature; qc ping fires unless we can confirm `.qc-passed`). */
  private featureStatusFor: (repo: string | null, feature: string) => FeatureStatus | null = () => null;
  setFeatureStatusResolver(fn: (repo: string | null, feature: string) => FeatureStatus | null): void { this.featureStatusFor = fn; }

  /** Is a desk actually RUNNING right now (a live worker/PTY), injected by the main process?
   *  Lets task routing prefer a LIVE role-holder over a dead/idle one. Default returns false (no
   *  resolver ⇒ no preference; routing falls back to all eligible holders — today's behavior). */
  private isRunning: (id: string) => boolean = () => false;
  setRunningResolver(fn: (id: string) => boolean): void { this.isRunning = fn; }
  /** SDDP planner-kickoff dedupe: feature keys (`project::feature`) already nudged to a planner
   *  this session, so a feature lacking tasks.md is nudged ONCE (not on every board write). */
  private nudgedPlannerFeatures = new Set<string>();

  /** The embedded OTLP collector's loopback URL, set by the main process once the
   *  collector is bound (telemetry.ts). null = telemetry off → no OTel env is
   *  injected at spawn (the transcript reconciler remains the cost source). */
  private _otelEndpoint: string | null = null;
  /** Point newly-spawned agents at the live telemetry collector. Call after the
   *  collector starts; only affects spawns made afterwards. */
  setOtelEndpoint(url: string | null): void {
    this._otelEndpoint = url;
  }
  /** The collector URL agents are pointed at, or null when telemetry is off. */
  otelEndpoint(): string | null {
    return this._otelEndpoint;
  }

  // — paths —
  root(): string | null {
    const home = this.getHome();
    return home ? join(home, 'hive') : null;
  }
  enabled(): boolean {
    return this.root() !== null;
  }
  private agentDir(id: string): string {
    return join(this.root()!, 'agents', id);
  }
  /** IPC endpoint the cth-hook shim talks to (Phase 1 autonomy).
   *  On POSIX this is a Unix-domain socket file under the hive root. On Windows,
   *  Node's `net` IPC uses named pipes (a flat `\\.\pipe\` namespace, not the
   *  filesystem), so a raw file path fails to bind with EACCES — derive a stable,
   *  per-root pipe name instead. Both the server (`listen`) and the shim
   *  (`createConnection`) read this same value, so they stay in sync. */
  sockPath(): string | null {
    const root = this.root();
    if (!root) return null;
    if (process.platform === 'win32') {
      const id = createHash('sha1').update(root).digest('hex').slice(0, 12);
      return `\\\\.\\pipe\\munder-difflin-${id}`;
    }
    return join(root, 'hooks.sock');
  }
  private shimPath(): string | null {
    const root = this.root();
    return root ? join(root, 'bin', 'cth-hook.cjs') : null;
  }

  // — bootstrap —

  /** Create the hive skeleton + git repo if missing. Idempotent. */
  ensureHive(): void {
    const root = this.root();
    if (!root) return;
    mkdirSync(join(root, 'agents'), { recursive: true });

    const protocol = join(root, 'PROTOCOL.md');
    if (!existsSync(protocol)) writeFileSync(protocol, PROTOCOL_MD, 'utf8');

    const registry = join(root, 'registry.json');
    if (!existsSync(registry)) {
      this.writeJson(registry, { godId: null, agents: {} } as Registry);
    }
    const board = join(root, 'board.md');
    if (!existsSync(board)) {
      writeFileSync(board, '# Hive board\n\n_Shared plans live here. The god agent is the scribe._\n', 'utf8');
    }
    const tasks = join(root, 'tasks.json');
    if (!existsSync(tasks)) this.writeJson(tasks, { tasks: [] });
    const log = join(root, 'log.jsonl');
    if (!existsSync(log)) writeFileSync(log, '', 'utf8');

    // The Claude Code command reference Michael consults (refreshed each bootstrap
    // so it tracks the bundled list).
    writeFileSync(join(root, 'COMMANDS.md'), COMMANDS_MD, 'utf8');

    // Keep the churny/ephemeral live files out of the hive git repo.
    const gitignore = join(root, '.gitignore');
    const want = ['fleet.json', 'hooks.sock', '.DS_Store'];
    let lines: string[] = [];
    if (existsSync(gitignore)) { try { lines = readFileSync(gitignore, 'utf8').split('\n'); } catch { lines = []; } }
    const missing = want.filter((w) => !lines.includes(w));
    if (missing.length) writeFileSync(gitignore, [...lines.filter(Boolean), ...missing].join('\n') + '\n', 'utf8');

    // The hook shim: a dumb pipe between a `claude` hook and our UDS. Refreshed
    // on every bootstrap so it tracks code changes.
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(this.shimPath()!, HOOK_SHIM, 'utf8');

    if (!existsSync(join(root, '.git'))) {
      this.git(['init', '-q'], root);
      this.commit('hive: init');
    }
  }

  /**
   * Ensure an agent's workspace + registry entry, returning the spawn injection
   * (extra `claude` args + env) that makes the process hive-aware.
   */
  ensureAgent(meta: AgentMeta, opts: { semanticMemory?: boolean; theme?: 'light' | 'dark'; sddp?: boolean } = {}): SpawnInjection {
    const root = this.root();
    if (!root) return { args: [], env: {} };
    this.ensureHive();

    const dir = this.agentDir(meta.id);
    mkdirSync(join(dir, 'inbox', '.done'), { recursive: true });
    mkdirSync(join(dir, 'outbox', '.sent'), { recursive: true });

    const identity = join(dir, 'identity.md');
    writeFileSync(identity, this.identityText(meta), 'utf8'); // refresh on each spawn

    const memory = join(dir, 'memory.md');
    if (!existsSync(memory)) {
      writeFileSync(memory, `# Memory — ${meta.name} (${meta.id})\n\n_Append durable facts, decisions, and context below._\n`, 'utf8');
    }
    ensureMineIgnore(dir); // keep settings.json / cursor / messages out of mempalace's index
    const cursor = join(dir, 'cursor.json');
    if (!existsSync(cursor)) this.writeJson(cursor, { lastProcessed: null });

    // upsert registry
    const reg = this.registry();
    const prev = reg.agents[meta.id];
    // Capability roles: an explicit spawn value wins; else PRESERVE what's in the registry
    // (so a role the operator set survives a respawn); else default by identity.
    const defaultRoles: AgentRole[] = meta.isGod ? ['integrator', 'reviewer'] : meta.isAssistant ? [] : ['worker'];
    reg.agents[meta.id] = {
      ...meta,
      capabilities: meta.capabilities ?? [],
      role: meta.role ?? (meta.isGod ? 'orchestrator' : 'agent'),
      roles: meta.roles ?? prev?.roles ?? defaultRoles,
      status: 'idle',
      // A (re)spawn always means a live terminal — clear any prior archived flag.
      archived: false,
      lastSeen: Date.now()
    };
    if (meta.isGod) reg.godId = meta.id;
    this.writeJson(join(root, 'registry.json'), reg);

    this.appendLog({ kind: 'spawn', agentId: meta.id, name: meta.name, isGod: !!meta.isGod });
    this.commit(`hive: register ${meta.id}`);

    const env: Record<string, string> = {
      AGENT_ID: meta.id,
      AGENT_NAME: meta.name,
      HIVE_ROOT: root,
      AGENT_DIR: dir
    };

    // Stage 7A — first-party Claude Code telemetry → the embedded loopback OTLP
    // collector (telemetry.ts). Pure env, no --settings change. Only injected
    // once the collector is up (otelEndpoint set), so telemetry-off installs and
    // tests spawn exactly as before. http/json (no protobuf dep). The resource
    // attrs are the agent↔event join key the collector reads. NOTE: Claude Code
    // reads these at process start, so they apply only to NEW spawns — an agent
    // already running won't emit until respawned.
    if (this._otelEndpoint) {
      env.CLAUDE_CODE_ENABLE_TELEMETRY = '1';
      env.OTEL_METRICS_EXPORTER = 'otlp';
      env.OTEL_LOGS_EXPORTER = 'otlp';
      env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/json';
      env.OTEL_EXPORTER_OTLP_ENDPOINT = this._otelEndpoint;
      env.OTEL_METRIC_EXPORT_INTERVAL = '5000'; // 5s — near-live without spamming
      env.OTEL_LOGS_EXPORT_INTERVAL = '2000';
      env.OTEL_RESOURCE_ATTRIBUTES = `agent.id=${meta.id},agent.name=${meta.name}`;
    }
    const args = ['--append-system-prompt', this.injectedPrompt(meta, dir, root, opts.semanticMemory ?? false, opts.sddp ?? false)];

    // Phase 1 — autonomy: attach lifecycle hooks via --settings (no edits to the
    // user's repo) so the agent reports activity and drains its inbox on Stop.
    const sock = this.sockPath();
    const shim = this.shimPath();
    if (sock && shim) {
      env.HIVE_SOCK = sock;
      const settingsPath = join(dir, 'settings.json');
      this.writeJson(settingsPath, this.hookSettings(shim, opts.theme));
      args.push('--settings', settingsPath);
    }
    return { args, env };
  }

  /**
   * Flip an agent's archived flag and persist the registry. Closing a terminal
   * tab archives the agent (retained + flagged, NOT deleted); a (re)spawn clears
   * it. No-op if the agent isn't registered or the flag is already set the way
   * asked. Best-effort — never throws, so a dying PTY/kill handler can't crash.
   */
  setArchived(id: string, archived: boolean): void {
    const root = this.root();
    if (!root) return;
    try {
      const reg = this.registry();
      const agent = reg.agents[id];
      if (!agent || agent.archived === archived) return;
      agent.archived = archived;
      agent.lastSeen = Date.now();
      this.writeJson(join(root, 'registry.json'), reg);
      this.appendLog({ kind: 'archive', agentId: id, archived });
      this.commit(`hive: ${archived ? 'archive' : 'unarchive'} ${id}`);
    } catch { /* best-effort — never crash a lifecycle handler */ }
  }

  /**
   * Set an agent's capability roles (worker / integrator). Durable in the registry, so
   * the integration gate (read live per tool call) takes effect immediately; the agent's
   * role-specific PROMPT only changes on its next (re)spawn. No-op if unregistered.
   */
  setRoles(id: string, roles: AgentRole[]): void {
    const root = this.root();
    if (!root) return;
    try {
      const reg = this.registry();
      const agent = reg.agents[id];
      if (!agent) return;
      agent.roles = roles;
      agent.lastSeen = Date.now();
      this.writeJson(join(root, 'registry.json'), reg);
      this.appendLog({ kind: 'roles', agentId: id, roles });
      this.commit(`hive: roles ${id} = [${roles.join(', ')}]`);
    } catch { /* best-effort */ }
  }

  /**
   * Persist the agent's Claude Code session_id (Lane A #6.6a). Captured from hook
   * payloads; written only when it actually changes (a new session), so this is a
   * no-op on the vast majority of hook events. The id is the `--resume` key for
   * idempotent resume after a crash/restart AND the accounting/dedup key for cost
   * samples. Best-effort — never throws into a hook handler.
   */
  recordSession(agentId: string, sessionId: string): void {
    const root = this.root();
    if (!root || !sessionId) return;
    try {
      const reg = this.registry();
      const agent = reg.agents[agentId];
      if (!agent || agent.sessionId === sessionId) return; // unknown agent or unchanged → no write
      agent.sessionId = sessionId;
      agent.lastSeen = Date.now();
      this.writeJson(join(root, 'registry.json'), reg);
      this.appendLog({ kind: 'session', agentId, sessionId });
      this.commit(`hive: session ${agentId}`);
    } catch { /* best-effort — never crash a hook handler */ }
  }

  /** The last known session_id for an agent, or undefined. Used to build a
   *  `claude --resume <id>` spawn so a restarted agent resumes its thread. */
  lastSession(agentId: string): string | undefined {
    return this.registry().agents[agentId]?.sessionId;
  }

  /** Claude Code settings that route every relevant hook through the shim. */
  private hookSettings(shim: string, theme?: 'light' | 'dark'): unknown {
    const cmd = `node "${shim}"`;
    const entry = (matcher?: string) => ({
      ...(matcher ? { matcher } : {}),
      hooks: [{ type: 'command', command: cmd }]
    });
    return {
      // Match the TUI's truecolor palette to the harness terminal theme —
      // PER SESSION, so the user's global Claude theme (their own terminals
      // outside the app) is never touched.
      ...(theme ? { theme } : {}),
      // The status line gets the session status JSON after every response —
      // including context_window.{total_input_tokens,context_window_size},
      // the only clean programmatic source for the session's REAL context
      // window. The shim prints a compact in-terminal gauge and forwards the
      // payload to the harness (agent-card context gauge, exact limit).
      statusLine: { type: 'command', command: `${cmd} --status`, padding: 0 },
      hooks: {
        Stop: [entry()],
        SubagentStop: [entry()],
        PreToolUse: [entry('*')],
        PostToolUse: [entry('*')],
        UserPromptSubmit: [entry()],
        Notification: [entry()],
        SessionStart: [entry()],
        // #5C: surface mid-`/compact` so an agent boxing up its context reads as
        // 'compacting' on the floor instead of looking frozen.
        PreCompact: [entry()],
        PostCompact: [entry()]
      }
    };
  }

  /**
   * Drain an agent's inbox for the Stop hook. Returns whether to block-to-continue
   * and the message text to feed back. Uses the per-agent cursor so a message is
   * surfaced exactly once (no infinite loop).
   */
  drainForStop(agentId: string): { block: boolean; reason?: string } {
    const dir = this.agentDir(agentId);
    if (!existsSync(dir)) return { block: false };
    const cursorPath = join(dir, 'cursor.json');
    const cursor = this.readJson<{ lastProcessed: string | null }>(cursorPath, { lastProcessed: null });
    const fresh = this.inbox(agentId)
      .filter((m) => !cursor.lastProcessed || m.id > cursor.lastProcessed)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    if (fresh.length === 0) return { block: false };

    cursor.lastProcessed = fresh[fresh.length - 1].id;
    this.writeJson(cursorPath, cursor);
    this.appendLog({ kind: 'drain', agentId, count: fresh.length });

    const lines = fresh.map((m) => `- [from ${m.from}, ${m.act}] ${m.subject}: ${m.body}`).join('\n');
    const reason = [
      `You have ${fresh.length} new hive message(s) in your inbox. Address them before finishing:`,
      lines,
      `Act on each; reply with hive_send_message if one needs a response. Re-read your inbox anytime with hive_read_inbox. (These won't be shown again — no need to open inbox files.)`
    ].join('\n');
    return { block: true, reason };
  }

  // — agent-facing text —

  private identityText(meta: AgentMeta): string {
    const caps = (meta.capabilities ?? []).join(', ') || '—';
    return [
      `# ${meta.name} (${meta.id})`,
      '',
      `- Role: ${meta.role ?? (meta.isGod ? 'orchestrator (god)' : 'agent')}`,
      `- Capabilities: ${caps}`,
      `- Working directory: ${meta.cwd}`,
      meta.isGod ? '- You are the **god / orchestrator**. You run the floor — keep awareness of the whole team, delegate execution, and personally own only the important calls (decomposition, sign-offs, conflicts, integration), not the grunt work.' : '',
      meta.isGod ? '- Monitor the team with `fleet.json` (live per-agent status/tokens/cost/breaker) and `registry.json`; full command reference in `COMMANDS.md`. `claude agents` does NOT list your hive siblings.' : '',
      ''
    ].filter(Boolean).join('\n');
  }

  /**
   * The system-prompt prefix injected into every spawn via --append-system-prompt.
   *
   * 🔒 PROMPT-CACHE INVARIANT — keep this prefix VOLATILE-FREE. It interpolates
   * only values stable for an agent's whole lifetime (name, id, dir, root,
   * semanticMemory). Do NOT add dates, UUIDs, counters, board/registry state, or
   * any `Date.now()`-derived text here: a prefix that changes per spawn defeats
   * Anthropic's prompt cache (re-priming the whole system prompt every turn).
   * Volatile context belongs on the live channels — the inbox (hive messages) and
   * the PTY — never baked into this prefix. (Lane A #6.1.)
   */
  /**
   * The SPEC-DRIVEN (SDDP) role line for a Claude desk — the mode's lifecycle + this desk's
   * phase responsibilities. A Claude desk additionally has the real `/sddp-*` slash-skills
   * (which fan out to the `sddp-*` sub-agents), so this names them as an accelerator a native
   * (DeepSeek) desk can't use. The hive plumbing (protocol/guardrails/memory) is added by the
   * caller and is mode-independent.
   */
  private sddpRoleLine(meta: AgentMeta, root: string): string {
    const lifecycle = 'SPEC-DRIVEN (SDDP) MODE is active: work flows per FEATURE through a strict, gated lifecycle with artifacts in specs/<feature>/ — Specify (spec.md) → Clarify → Plan (plan.md) → Tasks (tasks.md) → Implement → QC (.qc-passed) → Integrate. Never skip a phase; preserve artifact IDs (T###, FR-###, SC-###) and checkbox state ([ ]→[X]); never delete [NEEDS CLARIFICATION] markers. The specs/ folder is the SHARED feature workspace in the base repo — write/read it with the normal relative path specs/<feature>/... and it is shared across every desk regardless of your worktree; implement CODE on your branch, put feature ARTIFACTS in specs/.';
    if (meta.isGod) {
      return [
        'You are the GOD / ORCHESTRATOR of this hive in ' + lifecycle,
        `Drive each feature through the lifecycle and ENFORCE the gates — assign each phase to the desk holding the right role; orchestrate, do NOT author or implement. (1) Assign Specify→Clarify→Plan→Tasks to a PLANNER desk (it writes spec.md/plan.md/tasks.md); answer its clarification questions. (2) SPEC/PLAN gate: a REVIEWER reads the artifacts and approves or bounces. (3) Once tasks.md exists, turn its tasks into kanban cards for WORKER desks (P1 first; parallelize independent tasks). (4) CODE gate: a REVIEWER reviews each implemented slice. (5) A QC desk runs tests/lint/security + verifies stories vs spec → sets .qc-passed or files bug tasks. (6) An INTEGRATOR merges only AFTER .qc-passed. Run features as a PIPELINE (one in Plan while another is in QC) and parallelize Implement across workers. COLD ≠ GONE: a desk in hive_list_agents holding a role but showing running:false is COLD (parked), not gone — it wakes when you delegate/message it; treat a cold planner/reviewer/qc/integrator as AVAILABLE and route to it, never stall a feature for lack of a role-holder that exists on the floor. You ALSO have the real SDDP slash-skills — you MAY run /sddp-specify, /sddp-clarify, /sddp-plan, /sddp-tasks, /sddp-analyze, /sddp-implement-qc-loop (they fan out to the sddp-* sub-agents) to execute or accelerate any phase yourself. Monitor the floor via ${root}/fleet.json + ${root}/registry.json; keep board.md + tasks.json accurate; ask the human only for the genuinely critical.`
      ].join(' ');
    }
    if (meta.isAssistant) {
      // The prep assistant is mode-agnostic — same read-only enrich-and-route contract.
      return 'You are Michael\'s PREP ASSISTANT. You will be handed short, possibly vague instructions (each begins with "ENRICH TASK:"). For each one: (1) figure out which project it concerns and cd into the most relevant repo — you start in Michael\'s home directory; (2) gather concrete context READ-ONLY (exact file paths, current state, relevant code, conventions, active branch, gotchas) — NEVER modify, create, or delete files; (3) rewrite the instruction into ONE clear, self-contained prompt that Michael can execute autonomously, preserving the user\'s original intent without inventing scope. Then deliver it: write ONE message JSON into your outbox with "to":"god", "act":"request", a short subject, and the finished prompt as the body. Do NOT perform the task yourself — your only output is the improved prompt sent to Michael.';
    }
    const roles = meta.roles ?? [];
    return [
      lifecycle,
      roles.includes('planner')
        ? 'You hold the SDDP PLANNER role: AUTHOR a feature\'s spec → plan → tasks in specs/<feature>/ (you do not implement). Specify: write spec.md (problem, scope, FR-###/TR-### requirements, SC-### success criteria with measurable Given/When/Then; mark unknowns [NEEDS CLARIFICATION]). Clarify: resolve those markers in ONE batch with god/operator, then add a ## Clarifications section. Plan: write plan.md (tech stack, data model, API contracts, ADRs). Tasks: write tasks.md ("- [ ] T### [P?] [US#|OBJ#] {FR-###} Description [after:T###]", grouped by phase, P1 = a viable MVP, every task independently testable). You MAY run /sddp-specify, /sddp-clarify, /sddp-plan, /sddp-tasks to do this. Then tell god it is ready for the spec review.'
        : '',
      roles.includes('worker')
        ? 'You hold the SDDP WORKER role: IMPLEMENT from tasks.md (you do not change the spec). Take a task assigned to you, do EXACTLY that task, respect after:T### ordering, run the build/tests, mark its checkbox [ ]→[X] in tasks.md, commit on your agent/<id> branch, then move the card doing→review. You MAY run /sddp-implement-qc-loop. If a task is wrong/under-specified, do NOT guess — message god to route it back to the planner.'
        : '',
      roles.includes('reviewer')
        ? 'You hold the SDDP REVIEWER role (read-only, two gates). SPEC/PLAN gate: read spec.md/plan.md/tasks.md — complete? testable? every FR-### covered by tasks? Approve or send back to the planner. CODE gate: review an implemented slice before QC — comment via the card, approve to QC/integrate or send back to the worker. You never edit code.'
        : '',
      roles.includes('qc')
        ? 'You hold the SDDP QC role: run the automated QC phase. Run build/tests/lint/security; verify each user story / SC-### against the code + results; write specs/<feature>/qc-report.md. If all pass, create the .qc-passed marker; else file bug tasks ("- [ ] T### [BUG:severity] {FR-###} [category] desc — file:line") into tasks.md and send the work back to the worker(s). You MAY run /sddp-analyze and the QC half of /sddp-implement-qc-loop. You run + verify; you do not implement fixes.'
        : '',
      roles.includes('integrator')
        ? 'You hold the SDDP INTEGRATOR role: merge a feature ONLY after it has .qc-passed. Merge the feature branch into the repo base (git in your shell) and sign its cards off to "done". On conflict, resolve it (conflict-only edits) or send it back.'
        : ''
    ].filter(Boolean).join(' ');
  }

  private injectedPrompt(meta: AgentMeta, dir: string, root: string, semanticMemory: boolean, sddp = false): string {
    const memoryLine = semanticMemory
      ? 'Semantic memory: the whole hive shares a searchable MemPalace at $MEMPALACE_PALACE_PATH. To recall relevant past knowledge across the team, run `mempalace search "<query>"`; run `mempalace wake-up` at the start of a task for a memory digest. Your notes in memory.md are mined into the palace automatically — write durable facts there.'
      : '';
    // The role line is mode-dependent: standard freeform flow, or — when the floor is in
    // SDDP mode — the spec-driven lifecycle. A Claude desk additionally has the real
    // /sddp-* slash-skills (which fan out to the sddp-* sub-agents), so its SDDP prompt
    // names them as an accelerator a native desk can't use.
    const godLine = sddp
      ? this.sddpRoleLine(meta, root)
      : meta.isGod
      ? 'You are the GOD / ORCHESTRATOR of this hive — your job is to ORCHESTRATE, not to implement: maintain live situational awareness and delegate the work. (1) AWARENESS — always know what is going on: keep an accurate picture of every agent (active vs archived/idle), the task board, and all in-flight work; drain your inbox continually and triage every other agent\'s requests, answering clarifications so the team runs autonomously. (2) DELEGATE — decompose work and fan it out to the hive agents via their inboxes (route messages and assign owners; do not do their jobs); do NOT take on grunt implementation yourself. (3) OWN ONLY THE IMPORTANT, high-leverage things — task decomposition, dispatch decisions, sign-offs, conflict resolution, branch integration, and final QA — and remain the sole scribe of board.md. You are otherwise fully autonomous — there is NO separate approval queue. For the genuinely critical (destructive actions, spending real money, scope changes, unresolvable conflicts), ask the human directly in your own session and let the tool-permission prompt gate the action; the human approves natively, including remotely from their phone via /remote-control. Keep the team unblocked. COLD ≠ GONE: a desk in your roster holding a role but shown not-running is COLD (parked), not gone — it wakes when you delegate/message it; treat a cold role-holder as AVAILABLE and delegate to it, never unassign or declare "no desk available" for a role a floor desk holds. When you DISPATCH a task, write it as a 4-part contract so the agent can run autonomously: (1) OBJECTIVE — the concrete goal; (2) OUTPUT — the expected deliverable/format; (3) TOOLS — what to use or avoid, and any references to read instead of re-deriving; (4) BOUNDARIES — scope limits + the definition of done. Pass references (file paths, message ids, board sections), not pasted content — keep dispatches short.'
        + ` MONITOR the floor by reading ${root}/fleet.json (live per-agent tokens, cost, status, last tool, breaker level, inbox backlog) and ${root}/registry.json — note that running 'claude agents' will NOT list your hive's sibling agents. A full Claude Code command reference is at ${root}/COMMANDS.md (slash commands act ONLY on your own session; CLI commands run in your shell and can target the fleet). You periodically receive scheduler / "Heartbeat" standup requests — on each, review every agent via fleet.json, re-engage anyone stalled, over-budget, or breaker-armed, and keep board.md and tasks.json accurate. Steward the token budget. THE FLOW: a worker does its slice + runs tests then sets a card "review"; a reviewer (role-holder, else you) comments and approves it to "integrate"; an integrator (role-holder, else you) re-runs the tests as the merge gate, merges the branch, and signs it off "done" — "done" means tested. The system auto-pings the project's reviewer on "review" and ONE integrator on "integrate"; if no such desk exists it pings you as the standing fallback.`
      : meta.isAssistant
      ? 'You are Michael\'s PREP ASSISTANT. You will be handed short, possibly vague instructions (each begins with "ENRICH TASK:"). For each one: (1) figure out which project it concerns and cd into the most relevant repo — you start in Michael\'s home directory; (2) gather concrete context READ-ONLY (exact file paths, current state, relevant code, conventions, active branch, gotchas) — NEVER modify, create, or delete files; (3) rewrite the instruction into ONE clear, self-contained prompt that Michael can execute autonomously, preserving the user\'s original intent without inventing scope. Then deliver it: write ONE message JSON into your outbox with "to":"god", "act":"request", a short subject, and the finished prompt as the body. Do NOT perform the task yourself — your only output is the improved prompt sent to Michael.'
      : [
          'As a WORKER, the task board flows doing → (run build/tests) → review → integrate → done: do your slice, RUN the tests, commit on your agent/<id> branch, then set the card to "review" — a reviewer comments and approves it to "integrate", where an integrator merges + signs off. Do NOT advance past "review" or mark a card "done" yourself; if a card comes back to you, read its latest comment and address it. For anything ambiguous, cross-cutting, or needing sign-off, address a message to "god".',
          (meta.roles ?? []).includes('reviewer')
            ? 'You also hold the REVIEWER role: on a card in "review", read the author\'s agent/<id> branch READ-ONLY (do not change their code), check the tests cover the change and pass, comment on the card, then approve it to "integrate" or send it back to "doing" with exactly what to fix. You never merge or mark "done".'
            : '',
          (meta.roles ?? []).includes('integrator')
            ? 'You also hold the INTEGRATOR role: on a card in "integrate", run the test suite as the merge gate, then merge the author\'s agent/<id> branch into the repo base (git in your shell) and mark the card "done"; route conflicts or red tests back to the author. You may edit only to resolve a conflict.'
            : ''
        ].filter(Boolean).join(' ');
    const guardrailsLine = 'Guardrails: a circuit breaker watches the floor — a "Circuit breaker: steer/constrain" message means you are looping or overspending, so STOP repeating, summarize what you tried, and follow it. Be token-frugal (a floor-wide or per-agent token budget can pause you). The shared plan has two parts: board.md (freeform; god is the sole scribe) and tasks.json (structured kanban — todo/doing/blocked/review/integrate/done).';
    // "Know before you attempt": the board transitions this desk's roles allow on the kanban, so it
    // doesn't try a move the hook/execution gate would reject. Non-god/non-assistant only — the god
    // line already covers its delegator powers (incl. reassign), which this would contradict.
    const boardLine = !meta.isGod && !meta.isAssistant ? boardCapabilityLine(meta.roles) : '';
    return [
      `You are "${meta.name}" (${meta.id}), an autonomous agent in a collaborating hive of Claude agents.`,
      `Your private workspace is ${dir}. The shared hive is ${root}. Full protocol: ${root}/PROTOCOL.md.`,
      '',
      'HIVE PROTOCOL — follow it every task:',
      `1. At the START of a task, read ${dir}/memory.md and EVERY file in ${dir}/inbox/ (messages other agents sent you). After handling an inbox message, move its file into ${dir}/inbox/.done/.`,
      `2. Record durable facts, decisions, and context by appending to ${dir}/memory.md.`,
      `3. To ask another agent for something or share information, write ONE message JSON into ${dir}/outbox/ (schema in PROTOCOL.md). NEVER write into another agent's folder — the orchestrator delivers your outbox.`,
      '4. At the END of a task, append what you learned to memory.md so future-you remembers.',
      guardrailsLine,
      memoryLine,
      godLine,
      boardLine,
      `Env vars available to you: AGENT_ID, AGENT_NAME, HIVE_ROOT, AGENT_DIR.`
    ].filter(Boolean).join('\n');
  }

  // — messaging —

  /** Normalize a partial message into a full HiveMessage. */
  private normalize(partial: Partial<HiveMessage>, from: string): HiveMessage {
    const act = (partial.act ?? 'inform') as MessageAct;
    return {
      id: partial.id ?? `${stamp()}-${shortRand()}`,
      conversation: partial.conversation ?? `conv-${shortRand()}`,
      in_reply_to: partial.in_reply_to ?? null,
      from: partial.from ?? from,
      to: partial.to ?? 'god',
      act,
      subject: partial.subject ?? '',
      body: partial.body ?? '',
      hops: typeof partial.hops === 'number' ? partial.hops : 0,
      requires_reply: partial.requires_reply ?? ['request', 'query', 'propose'].includes(act),
      needs_human: partial.needs_human ?? false,
      created_at: partial.created_at ?? new Date().toISOString()
    };
  }

  /** Atomically deliver a message into a recipient agent's inbox. Returns false when the
   *  recipient has no inbox (unknown / never-spawned / force-deleted id) so the caller can
   *  dead-letter rather than silently swallow it. */
  private deliver(msg: HiveMessage, toId: string): boolean {
    const inbox = join(this.agentDir(toId), 'inbox');
    if (!existsSync(inbox)) return false; // unknown recipient — caller dead-letters
    this.atomicWriteJson(join(inbox, `${msg.id}.json`), msg);
    return true;
  }

  /** Inject a message directly (used by the orchestrator / UI / tests). */
  send(partial: Partial<HiveMessage>, from = 'system'): HiveMessage {
    const msg = this.normalize(partial, from);
    this.routeMessage(msg);
    this.commit(`hive: msg ${msg.from}→${msg.to} (${msg.act})`);
    return msg;
  }

  private routeMessage(msg: HiveMessage): void {
    if (msg.hops > HOP_CAP) {
      // loop guard — drop a runaway message rather than let agents ping-pong.
      // There's no human queue to fall back on; the god agent owns conflicts.
      this.appendLog({ kind: 'drop', reason: 'hop-cap', from: msg.from, to: msg.to, id: msg.id });
      return;
    }
    const reg = this.registry();
    const godId = reg.godId ?? 'god';
    const godExists = !!reg.godId && existsSync(join(this.agentDir(godId), 'inbox'));
    // The hive has no separate human-approval queue — approvals are native to
    // each agent's Claude Code session (and approvable remotely). A message aimed
    // at "human" is handled by the god/orchestrator, the human's proxy here.
    const resolveTo = (to: string): string => (to === 'human' || to === 'god' ? godId : to);
    // Surface a 'god'/'human' message that can't resolve (no god spawned) instead of
    // silently dropping it.
    if ((msg.to === 'god' || msg.to === 'human') && !godExists) {
      this.appendLog({ kind: 'drop', reason: 'no-god', from: msg.from, to: msg.to, id: msg.id });
    }
    const targets = msg.to === 'broadcast'
      // The roster for fan-out is the ACTIVE registry: skip the send-only prep
      // assistant and any archived agent (closed tab) so mail never piles into a
      // dead inbox no one will read.
      ? Object.keys(reg.agents).filter((a) => a !== msg.from && !reg.agents[a]?.isAssistant && !reg.agents[a]?.archived)
      // Never deliver to self — guards a god → "human" message looping back to god.
      : [resolveTo(msg.to)].filter((t) => t !== msg.from);
    for (const t of targets) {
      // Enforce the assistant's send-only contract AT THE ROUTER: it has no
      // composer, is excluded from the inbox-wake nudge, and never reads an
      // inbox — yet direct mail used to be delivered there anyway, where it
      // rotted unread (observed live: a task brief plus the follow-up
      // reprimand about the unread inbox, both unread for hours). Bounce such
      // mail to god instead, so the sender's intent surfaces immediately and
      // nothing is silently lost.
      if (reg.agents[t]?.isAssistant) {
        this.deliver({
          ...msg,
          to: godId,
          subject: `[bounced — "${t}" is the send-only prep assistant; route work to a real agent] ${msg.subject}`
        }, godId);
        continue;
      }
      // If the target has no inbox (unknown / never-spawned / force-deleted id), the message
      // would silently vanish. Dead-letter a notice to the god so it can reassign/restore —
      // loop-safe: written straight to the god's inbox, never back through routeMessage, and
      // skipped when the dead target IS the god.
      if (!this.deliver(msg, t)) {
        this.appendLog({ kind: 'drop', reason: 'undeliverable', from: msg.from, to: t, id: msg.id });
        if (godExists && t !== godId) {
          this.deliver(this.normalize({
            to: godId,
            act: 'inform',
            subject: `Undeliverable: ${msg.to}`,
            body: `Couldn't deliver ${msg.from}'s message "${msg.subject}" to "${t}" — no such desk/inbox. Reassign its work to a live desk or restore it.`
          }, 'system'), godId);
        }
      }
    }
    this.appendLog({ kind: 'message', from: msg.from, to: msg.to, act: msg.act, subject: msg.subject, id: msg.id });
    this.emitMessage(msg, targets);
  }

  /** Tell the renderer a message was routed, with its resolved recipients, so
   *  the floor can fly an envelope from the sender to each one. Best-effort. */
  private emitMessage(msg: HiveMessage, targets: string[]): void {
    this.emit?.('hive:message', {
      id: msg.id,
      from: msg.from,
      to: msg.to,
      act: msg.act,
      subject: msg.subject,
      targets,
      // Coral-tints the floor envelope for a message the agent flagged for the
      // human (now routed to the god proxy). Cosmetic only — no queue behind it.
      needsHuman: msg.to === 'human'
    });
  }

  // — router: drain outboxes → inboxes —

  /** Poll-based router. Cheap and robust vs fs.watch quirks on macOS. */
  startRouter(intervalMs = 1500): void {
    if (this.routerTimer || !this.enabled()) return;
    this.routerTimer = setInterval(() => {
      try { this.routeOnce(); } catch { /* keep the loop alive */ }
    }, intervalMs);
  }
  stopRouter(): void {
    if (this.routerTimer) { clearInterval(this.routerTimer); this.routerTimer = null; }
  }

  routeOnce(): number {
    const root = this.root();
    if (!root) return 0;
    const agentsDir = join(root, 'agents');
    if (!existsSync(agentsDir)) return 0;
    let routed = 0;
    for (const id of readdirSync(agentsDir)) {
      const outbox = join(agentsDir, id, 'outbox');
      if (!existsSync(outbox)) continue;
      for (const f of readdirSync(outbox)) {
        if (!f.endsWith('.json')) continue;
        const full = join(outbox, f);
        try {
          const partial = JSON.parse(readFileSync(full, 'utf8')) as Partial<HiveMessage>;
          const msg = this.normalize(partial, id);
          msg.from = id; // sender is authoritative — the owning directory
          this.routeMessage(msg);
          renameSync(full, join(outbox, '.sent', f)); // archive, don't reprocess
          routed++;
        } catch {
          // malformed file — quarantine so we don't spin on it
          try { renameSync(full, join(outbox, '.sent', `bad-${f}`)); } catch { /* noop */ }
        }
      }
    }
    if (routed > 0) this.commit(`hive: routed ${routed} message(s)`);
    return routed;
  }

  // — read helpers (for IPC / UI) —

  registry(): Registry {
    const root = this.root();
    if (!root) return { godId: null, agents: {} };
    return this.readJson<Registry>(join(root, 'registry.json'), { godId: null, agents: {} });
  }
  board(): string {
    const root = this.root();
    return root && existsSync(join(root, 'board.md')) ? readFileSync(join(root, 'board.md'), 'utf8') : '';
  }
  tasks(): unknown {
    const root = this.root();
    return root ? this.readJson(join(root, 'tasks.json'), { tasks: [] }) : { tasks: [] };
  }

  /** The current task ledger as a typed array (empty when none). */
  private taskList(): HiveTask[] {
    const t = this.tasks() as { tasks?: HiveTask[] } | undefined;
    return Array.isArray(t?.tasks) ? t!.tasks : [];
  }

  /** Desks holding `role` "for the task's project": prefer those whose repo matches the
   *  task's project (the assignee's repo); else any non-archived holder; else — when NO
   *  dedicated holder exists — the god (who holds integrator+reviewer by default and, as
   *  `isGod`, can advance any card regardless of role). The card's own assignee is always
   *  excluded. Returns desk ids, sorted by id so a single-pick is deterministic. */
  private roleHoldersForTask(role: AgentRole, task: HiveTask, godFallback = true): string[] {
    const reg = this.registry();
    const holders = Object.values(reg.agents).filter(
      (a) => !a.archived && a.id !== task.assignee && (a.roles ?? []).includes(role)
    );
    const project = task.assignee ? this.repoFor(task.assignee) : null;
    const sameProject = project ? holders.filter((a) => this.repoFor(a.id) === project) : [];
    const chosen = sameProject.length ? sameProject : holders;
    if (chosen.length) {
      // Prefer LIVE holders so a card routes to a desk that's actually up — not a dead/idle one
      // (the operator's "the integrator is there but the god can't find/use it" case). When none
      // of the eligible holders are running, fall back to all of them (so the work still routes).
      const running = chosen.filter((a) => this.isRunning(a.id));
      return (running.length ? running : chosen).map((a) => a.id).sort();
    }
    // Zero dedicated holders for the project ⇒ the god is the standing fallback — EXCEPT the SDDP
    // planner/qc phases (godFallback=false), where the operator's rule is "no role-holder ⇒ nobody
    // does it" (the god is a delegator that can't author specs or run QC).
    if (!godFallback) return [];
    return reg.godId && reg.godId !== task.assignee ? [reg.godId] : [];
  }

  /** Fire best-effort notifications on task transitions (diff prev→next), from 'system'
   *  (so the router never drops a self-send): auto-unblocked or sent-back → assignee;
   *  entered `review` → the project's reviewer(s); entered `integrate` → the integrator. */
  private notifyTaskTransitions(prev: HiveTask[], next: HiveTask[]): void {
    const before = new Map(prev.map((t) => [t.id, t]));
    const ping = (to: string, act: HiveMessage['act'], subject: string, body: string) =>
      this.send({ to, act, subject, body }, 'system');
    // A lane with NO live role-holder must not rot silently: log it AND escalate to god + human
    // (needs_human) so the operator revives a desk or gives an active desk the role. Fires once
    // per status transition (so a card escalates when it enters the starved lane, not repeatedly).
    const escalateNoHandler = (role: AgentRole, t: HiveTask, lane: string): void => {
      this.appendLog({ kind: 'drop', reason: 'no-handler', to: role, id: t.id });
      this.send({
        to: 'god', act: 'request', needs_human: true,
        subject: `No active ${role} — "${t.title}" stuck in ${lane}`,
        body: `Card "${t.title}" (${t.id}) reached ${lane} but NO active desk holds the ${role} role, so it can't proceed. Revive a ${role} desk, or give an ACTIVE desk the ${role} role (Add-Agent, the desk's role toggle, or restore team).`
      }, 'system');
    };
    for (const t of next) {
      const was = before.get(t.id);
      const wasStatus = was?.status;
      if (wasStatus === t.status) continue; // only act on a status change

      if (wasStatus === 'blocked' && t.status === 'todo' && t.assignee) {
        ping(t.assignee, 'inform', `Unblocked: ${t.title}`,
          `Task "${t.title}" (${t.id}) is unblocked — its blocker(s) are done. You can resume it.`);
      }
      if (t.status === 'review') {
        const reviewers = this.roleHoldersForTask('reviewer', t);
        for (const to of reviewers) {
          ping(to, 'request', `Review: ${t.title}`,
            `Task "${t.title}" (${t.id}) is ready for REVIEW. Read its branch (read-only), comment via hive_update_task note; approve by setting it to 'integrate', or send it back with status 'doing' and what to fix.`);
        }
        // No reviewer AND no god fallback ⇒ the card would sit unwatched — escalate, don't drop.
        if (reviewers.length === 0) escalateNoHandler('reviewer', t, 'review');
      }
      if (t.status === 'integrate') {
        // SDDP: a feature card can't be merged until QC passes (.qc-passed). If it's missing,
        // route to a QC desk to run the QC phase FIRST (no god fallback — no qc desk ⇒ nobody;
        // the integrate gate keeps the card from merging until .qc-passed appears, and the
        // integrator picks it up on its next scan once it does). Otherwise (no feature, or QC
        // already passed) ping the integrator as usual.
        const repo = t.project ?? (t.assignee ? this.repoFor(t.assignee) : null);
        const fstat = t.feature ? this.featureStatusFor(repo, t.feature) : null;
        if (t.feature && fstat && !fstat.qcPassed) {
          const qcs = this.roleHoldersForTask('qc', t, false);
          for (const to of qcs) {
            ping(to, 'request', `QC: ${t.title}`,
              `Feature "${t.feature}" (card ${t.id}) is implemented and awaiting QC before integrate. Run build/tests/lint + verify the stories/SC-### against the spec, write specs/${t.feature}/qc-report.md, then create the .qc-passed marker (or file bug tasks back to the worker).`);
          }
          if (qcs.length === 0) escalateNoHandler('qc', t, 'integrate (awaiting QC)');
        } else {
          // ONE integrator only (parallel hive_integrate would double-merge). Use REAL
          // role-holders (godFallback=false): the god counts only if it actually HOLDS the
          // integrator role — a pure-delegator god does not, so we escalate instead of pinging a
          // god that can't merge (the operator's "no active integrator" case). roleHoldersForTask
          // already prefers a LIVE holder, so this routes to the integrator that's actually up.
          const to = this.roleHoldersForTask('integrator', t, false)[0] ?? null;
          if (to) {
            ping(to, 'request', `Integrate: ${t.title}`,
              `Task "${t.title}" (${t.id}) is approved and ready to INTEGRATE. Find its repo + branch via hive_list_agents, run the test suite as the merge gate, then hive_integrate (preview → apply), resolve any conflict or send it back, then mark it 'done'.`);
          } else {
            escalateNoHandler('integrator', t, 'integrate');
          }
        }
      }
      if (t.status === 'doing' && (wasStatus === 'review' || wasStatus === 'integrate') && t.assignee) {
        // Hand the worker the actual feedback (newest comment), not just "see the card".
        const last = t.comments?.at(-1);
        const feedback = last ? ` Latest feedback (${last.by}): "${last.text}"` : ' See the card comments and address them.';
        ping(t.assignee, 'inform', `Changes requested: ${t.title}`,
          `Task "${t.title}" (${t.id}) was sent back to you (from ${wasStatus}).${feedback}`);
      }
    }

    // SDDP PLANNER KICKOFF — separate from status transitions: a feature that has cards but no
    // tasks.md still needs Specify→Plan→Tasks. Ping a planner ONCE per feature (deduped); no god
    // fallback (no planner desk ⇒ nobody plans). Re-evaluated each write, so a planner added later
    // gets pinged on the next board change (we only mark a feature nudged once we actually ping).
    const featureCards = new Map<string, HiveTask>(); // key project::feature → a representative card
    for (const t of next) {
      if (!t.feature) continue;
      const repo = t.project ?? (t.assignee ? this.repoFor(t.assignee) : null);
      const key = `${repo ?? ''}::${t.feature}`;
      if (!featureCards.has(key)) featureCards.set(key, t);
    }
    for (const [key, t] of featureCards) {
      if (this.nudgedPlannerFeatures.has(key)) continue;
      const repo = t.project ?? (t.assignee ? this.repoFor(t.assignee) : null);
      const fstat = this.featureStatusFor(repo, t.feature!);
      if (fstat?.hasTasks) { this.nudgedPlannerFeatures.add(key); continue; } // planning done — stop checking
      const planners = this.roleHoldersForTask('planner', t, false);
      if (planners.length === 0) continue; // no planner ⇒ nobody plans; retry on a later write
      for (const to of planners) {
        ping(to, 'request', `Plan feature: ${t.feature}`,
          `Feature "${t.feature}" needs its spec → plan → tasks before implementation. Author specs/${t.feature}/spec.md (mark unknowns [NEEDS CLARIFICATION] and ask god/operator), then plan.md and tasks.md, in the SHARED base-repo specs/. Use hive_feature_status to track the phase.`);
      }
      this.nudgedPlannerFeatures.add(key);
    }
  }

  /** Persist the task ledger to hive/tasks.json and commit it. Auto-reconciles blockers
   *  (drops done blockers; flips a fully-unblocked card back to todo) BEFORE persisting,
   *  then notifies on transitions (unblocked → assignee; entered review → integrator). The
   *  single chokepoint for both the agent tool path and the renderer IPC. */
  writeTasks(tasks: HiveTask[]): void {
    const root = this.root();
    if (!root) return;
    this.ensureHive();
    const prev = this.taskList();
    const next = reconcileBlocked(tasks);
    this.writeJson(join(root, 'tasks.json'), { tasks: next });
    this.appendLog({ kind: 'tasks', count: next.length });
    this.commit(`hive: tasks (${next.length})`);
    try { this.notifyTaskTransitions(prev, next); } catch (e) { console.error('[hive] task notify failed:', e); }
  }
  memory(id: string): string {
    const p = join(this.agentDir(id), 'memory.md');
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
  }
  /** Append a timestamped block to an agent's memory.md and single-commit it. This
   *  is the single-committer write path behind a native desk's `write_memory` tool
   *  (Principle III) — it mirrors what a Claude desk does by editing the file with
   *  its own tools, so a native desk's durable notes survive a reload and are mined
   *  into the MemPalace exactly the same way. No-op on empty text or no hive root. */
  appendMemory(id: string, text: string): void {
    const t = (text ?? '').trim();
    if (!t || !this.root()) return;
    const dir = this.agentDir(id);
    try { mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
    const block = `\n\n## ${new Date().toISOString()}\n${t}\n`;
    try { appendFileSync(join(dir, 'memory.md'), block, 'utf8'); } catch { /* noop */ }
    this.appendLog({ kind: 'memory', agent: id, bytes: t.length });
    this.commit(`hive: memory (${id})`);
  }
  inbox(id: string): HiveMessage[] {
    return this.listMessages(join(this.agentDir(id), 'inbox'));
  }
  /** Count undrained inbox messages for an agent (cheap — for the fleet snapshot). */
  inboxBacklog(id: string): number {
    const dir = join(this.agentDir(id), 'inbox');
    if (!existsSync(dir)) return 0;
    try { return readdirSync(dir).filter((f) => f.endsWith('.json')).length; } catch { return 0; }
  }
  /** Write the live fleet snapshot Michael reads (`fleet.json`, gitignored).
   *  Best-effort — called from a timer, must never throw. */
  writeFleetSnapshot(snapshot: unknown): void {
    const root = this.root();
    if (!root) return;
    try { writeFileSync(join(root, 'fleet.json'), JSON.stringify(snapshot, null, 2), 'utf8'); } catch { /* noop */ }
  }
  logTail(n = 200): unknown[] {
    const root = this.root();
    if (!root || !existsSync(join(root, 'log.jsonl'))) return [];
    const lines = readFileSync(join(root, 'log.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  }

  private listMessages(dir: string): HiveMessage[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')) as HiveMessage; } catch { return null; } })
      .filter((m): m is HiveMessage => m !== null);
  }

  // — log —
  appendLog(event: Record<string, unknown>): void {
    const root = this.root();
    if (!root) return;
    const line = JSON.stringify({ ts: Date.now(), ...event }) + '\n';
    try { appendFileSync(join(root, 'log.jsonl'), line, 'utf8'); } catch { /* noop */ }
  }

  /**
   * Append one cost sample to the durable, append-only ledger at
   * `<root>/cost-ledger.jsonl` (Lane A #6.6d). This is the SOLE durable cost
   * store; its row is exactly the shape Kevin (#4) reserves for the cost_ledger
   * SQLite table, so migration is a mechanical INSERT…SELECT.
   *
   * 🔒 PII: persist ONLY the allowlisted AgentUsageSample — NEVER a raw OTel
   * record (those carry user.email / account / org / hashed-user-id). The sample
   * is PII-free by construction upstream (the provider's normalize step), so we
   * add no redaction here; we just must not widen what we write. The file lives
   * at the hive ROOT, so `mempalace mine` (which only scans per-agent dirs) never
   * ingests it — no palace noise, no MINE_IGNORE entry needed.
   *
   * Like appendLog: append to disk now (durable immediately), let it ride the
   * next natural commit. Best-effort — never throws into the beat.
   */
  appendCostLedger(sample: AgentUsageSample): void {
    const root = this.root();
    if (!root) return;
    // Fully snake_case so the row maps 1:1 onto Kevin's (#4) cost_ledger SQLite
    // columns (agent_id, session_id, ts, input, output, cache_read,
    // cache_creation, model, usd) — migration is a straight INSERT…SELECT.
    const row = {
      agent_id: sample.agentId,
      session_id: sample.sessionId,
      ts: sample.ts,
      input: sample.input,
      output: sample.output,
      cache_read: sample.cacheRead,
      cache_creation: sample.cacheCreation,
      model: sample.model,
      usd: sample.usd
    };
    try { appendFileSync(join(root, 'cost-ledger.jsonl'), JSON.stringify(row) + '\n', 'utf8'); } catch { /* noop */ }
  }

  // — native-events run log (E008 {FR-016/038/040}) —

  /**
   * The per-agent native AgentEvent run log at
   * `<hiveRoot>/agents/<agentId>/native-events.jsonl`.
   *
   * Mirrors `cost-ledger.jsonl`: a DURABLE, APPEND-ONLY JSONL stream, ONE FILE per
   * agent, single-writer (this main process). The file is KEYED by `agentId` (one
   * file each) and SEGMENTED by `sessionId` — the session is not in the path, it
   * rides each line via the AgentEvent envelope (`{v,agentId,sessionId,ts,kind}`),
   * so a new session appends to the SAME file (FR-038). It is replayed top-to-
   * bottom on panel reopen/restart (no rotation/pruning within scale, FR-040).
   *
   * Returns null when the hive is disabled (no harnessHome) — the caller treats a
   * null path as "persistence off", exactly like the cost ledger.
   */
  nativeEventsPath(agentId: string): string | null {
    const root = this.root();
    if (!root || !agentId) return null;
    return join(root, 'agents', agentId, 'native-events.jsonl');
  }

  /**
   * Append ONE native `AgentEvent` line to the agent's run log (E008 {FR-016/037/
   * 038/040/043}). Like `appendCostLedger`/`appendLog`: durable immediately
   * (append-on-event), single-writer (main), naturally ordered by arrival/`ts`.
   *
   * 🔒 SECRET-FREE (ADR-0007/FR-041): the persisted line is the `AgentEvent`
   * envelope + payload AS-IS — this method NEVER injects an API key, auth header,
   * or any credential at any nesting depth. Credentials ride spawn `env`, never the
   * AgentEvent bus, so nothing here can leak one (the bridge is the sole caller and
   * forwards the same untouched event).
   *
   * Ensures the agent dir exists (a native worker may not have a hive-provisioned
   * workspace yet). Best-effort — never throws into the event path. Returns whether
   * the line was committed to disk, so the caller can order persist-before-forward.
   */
  appendNativeEvent(event: AgentEvent): boolean {
    const agentId = event?.agentId;
    const path = agentId ? this.nativeEventsPath(agentId) : null;
    if (!path) return false;
    try {
      mkdirSync(join(this.root()!, 'agents', agentId), { recursive: true });
      appendFileSync(path, JSON.stringify(event) + '\n', 'utf8');
      return true;
    } catch {
      return false; // best-effort — a disk error never breaks the event stream
    }
  }

  // — json + atomic io —
  private readJson<T>(p: string, fallback: T): T {
    try { return JSON.parse(readFileSync(p, 'utf8')) as T; } catch { return fallback; }
  }
  private writeJson(p: string, data: unknown): void {
    writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
  }
  private atomicWriteJson(p: string, data: unknown): void {
    const tmp = `${p}.tmp-${shortRand()}`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, p);
  }

  // — git (single committer, retry + stale-lock recovery) —
  private git(args: string[], cwd: string): { ok: boolean; out: string; err: string } {
    const res = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=Hive', '-c', 'user.email=hive@local', ...args], {
      cwd, encoding: 'utf8', timeout: 8000
    });
    return { ok: res.status === 0, out: res.stdout ?? '', err: res.stderr ?? '' };
  }

  /** Commit all hive changes. No-op if there is nothing staged. */
  commit(message: string): void {
    const root = this.root();
    if (!root || !existsSync(join(root, '.git'))) return;
    for (let attempt = 0; attempt < 5; attempt++) {
      this.clearStaleLock(root);
      const add = this.git(['add', '-A'], root);
      const commit = this.git(['commit', '-q', '-m', message], root);
      if (commit.ok) return;
      if (/nothing to commit/i.test(commit.out + commit.err)) return;
      if (!add.ok || /index\.lock/i.test(commit.err)) { sleepSync(50 * (attempt + 1)); continue; }
      return; // a non-lock failure — give up quietly, the next mutation retries
    }
  }

  private clearStaleLock(root: string): void {
    const lock = join(root, '.git', 'index.lock');
    try {
      if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > 10_000) rmSync(lock);
    } catch { /* noop */ }
  }
}

// ─── PROTOCOL.md (written into the hive, readable by every agent) ────────────

/** The Claude Code command reference written to <hive>/COMMANDS.md, rendered from
 *  the SAME source as the UI "commands" tab so they never drift. Leads with the
 *  orchestrator note: slash = own session only, cli = shell/fleet; monitor
 *  siblings via fleet.json (claude agents does NOT see them). */
function renderCommandsMd(): string {
  const lines: string[] = [
    '# Claude Code commands',
    '',
    'Reference of the Claude Code commands available to you. Two kinds:',
    '- **slash** commands act ONLY on your own session — you CANNOT run them on another agent\'s terminal.',
    '- **cli** commands run in your shell (Bash) and can target the fleet, spawn, or query.',
    '',
    'To MONITOR the other agents in this hive, read `fleet.json` in the hive root (live per-agent tokens, cost, status, last tool, breaker level, inbox backlog) plus `registry.json` — `claude agents` does NOT list your hive siblings. Use `claude -p "..." --output-format json` for a one-off headless query.',
    ''
  ];
  for (const g of COMMAND_GROUPS) {
    lines.push(`## ${g.title}`, '');
    for (const it of g.items) {
      lines.push(`- \`${it.cmd.trim()}\` _(${it.kind})_ — ${it.desc}${it.usage ? ` e.g. \`${it.usage}\`` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
const COMMANDS_MD = renderCommandsMd();

const PROTOCOL_MD = `# Hive protocol

You are one of several Claude agents sharing this hive. Coordination is entirely
file-based; the harness (main process) is the only thing that runs git and the
only thing that moves messages between agents.

## Your workspace — \`agents/<your-id>/\`
- \`identity.md\`  — who you are (read-only; the harness writes it).
- \`memory.md\`    — your long-term memory. Read at the start of a task; append to it as you learn.
- \`inbox/\`       — messages addressed to you. Read them at the start of a task.
- \`inbox/.done/\` — move a message here once you've handled it.
- \`outbox/\`      — drop messages here to send them. The harness delivers them.

**Never write into another agent's folder.** Write to your own \`outbox/\`; the
orchestrator routes it. This keeps every file single-writer.

## Sending a message
Write one JSON file into \`outbox/\` (any filename ending in \`.json\`):

\`\`\`json
{
  "to": "<agent-id> | god | broadcast",
  "act": "request | inform | propose | query | agree | refuse | done",
  "subject": "one-line summary",
  "body": "the details",
  "conversation": "carry this across a thread (optional)",
  "in_reply_to": "<message id you're replying to> (optional)"
}
\`\`\`

The harness fills in \`id\`, \`from\`, \`hops\`, and timestamps.

## Rules of the road
- Only \`request\`, \`query\`, and \`propose\` expect a reply. \`inform\` and \`done\` are terminal —
  don't reply to them, or two agents will loop forever.
- For anything ambiguous, cross-cutting, or needing sign-off, message \`god\` — the
  god agent clarifies answers for you so you rarely need the human directly.
- There is NO separate human-approval queue. Human-in-the-loop is native to Claude
  Code: a tool you run that needs permission prompts in your own session (the human
  can approve it remotely from their phone via \`/remote-control\`). If you genuinely
  need a human decision, raise it with \`god\` (a message \`"to": "human"\` is routed to
  the god/orchestrator, the human's proxy on the floor).
- \`board.md\` is the shared plan. Don't edit it directly — \`propose\` changes to \`god\`,
  who is its sole scribe.
- Re-reading a message you already moved to \`.done/\` is a no-op. Don't reprocess.

## The work: board.md vs tasks.json
There are two shared surfaces, both in the hive root:
- \`board.md\` — the freeform narrative plan. The god agent is its sole scribe; others \`propose\` edits.
- \`tasks.json\` — the structured task ledger (a kanban: \`todo / doing / blocked / done\`, with title,
  assignee, priority, deps). Keep the task you're working reflected in its status.

## Guardrails: circuit breaker & token budgets
A circuit breaker watches every agent for runaway behavior (looping on the same tool, error storms,
overspending). It escalates gently: \`steer\` → \`constrain\` → \`stop\`. If a \`Circuit breaker: steer\`
or \`Circuit breaker: constrain\` message lands in your inbox, you ARE the problem it caught — stop
repeating, summarize what you've tried, and do exactly what the message says (constrain = go read-only
and get god's sign-off before more tool calls). Be **token-frugal**: the floor has a token budget and
each agent can have its own token limit; crossing it trips the breaker. Prefer references over pasted
content, and \`/compact\` your own session when context gets heavy.

## Fleet monitoring (orchestrator)
You (god) are responsible for situational awareness. To see the live state of every agent, read
\`fleet.json\` in the hive root — it is refreshed continuously with each agent's tokens, cost, status,
breaker level, last tool, last-active time, and inbox backlog. Pair it with \`registry.json\` (the roster)
and \`log.jsonl\` (the event feed). IMPORTANT: \`claude agents\` will NOT show your hive's sibling
sessions (they're spawned independently) — \`fleet.json\` is your source of truth for them. For a deeper
look at one agent, read its \`agents/<id>/memory.md\` and \`inbox/\`, or send it a \`query\`. A full
Claude Code command reference (slash = your own session only; CLI = your shell, can target the fleet)
is in \`COMMANDS.md\` in the hive root.

## Semantic memory (optional — when \`mempalace\` is installed)
When \`MEMPALACE_PALACE_PATH\` is set in your environment, the hive shares a
searchable MemPalace and you have the \`mempalace\` CLI:
- \`mempalace search "<query>"\` — recall relevant past knowledge across the whole
  team by meaning (not just keywords). Add \`--wing <agent-id>\` to scope to one
  agent, \`--results N\` to widen.
- \`mempalace wake-up\` — a short digest of what matters, good at the start of a task.

Your \`memory.md\` is mined into the palace automatically, so the durable facts you
write there become searchable by every agent. You don't run \`mine\` yourself.
`;

// ─── cth-hook shim (written to <hive>/bin/cth-hook.cjs) ──────────────────────
// A minimal pipe: read the hook payload on stdin, tag it with this agent's id,
// forward it to the hive's UDS, and relay the response back to `claude`. All the
// real logic lives in the main process (HookServer). Never blocks a stop on error.
const HOOK_SHIM = `#!/usr/bin/env node
'use strict';
const net = require('net');
const isStatus = process.argv.includes('--status');
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', () => {
  let payload = {};
  try { payload = JSON.parse(data || '{}'); } catch (_) {}
  if (!payload.agent_id) payload.agent_id = process.env.AGENT_ID || null;
  const sock = process.env.HIVE_SOCK;
  if (isStatus) {
    // Status-line mode: Claude Code pipes the session status JSON (incl.
    // context_window.total_input_tokens / .context_window_size) after every
    // response. Print the in-terminal gauge IMMEDIATELY (the TUI is waiting),
    // then forward the payload to the harness fire-and-forget so the agent
    // card's context gauge updates push-based, with the EXACT window size.
    payload.hook_event_name = 'Status';
    const cw = payload.context_window || {};
    const used = cw.total_input_tokens, size = cw.context_window_size;
    if (typeof used === 'number' && typeof size === 'number' && size > 0) {
      const pct = Math.round((used / size) * 100);
      process.stdout.write('ctx ' + Math.round(used / 1000) + 'k/' + Math.round(size / 1000) + 'k (' + pct + '%)');
    }
    if (sock) {
      try {
        const c = net.createConnection(sock, () => { c.end(JSON.stringify(payload) + '\\n'); });
        c.on('error', () => {});
        c.on('close', () => process.exit(0));
      } catch (_) { process.exit(0); }
    } else {
      process.exit(0);
    }
    setTimeout(() => process.exit(0), 1500).unref();
    return;
  }
  if (!sock) { process.exit(0); }
  let resp = '';
  const done = (code) => { if (resp) process.stdout.write(resp); process.exit(code); };
  const c = net.createConnection(sock, () => c.write(JSON.stringify(payload) + '\\n'));
  c.setEncoding('utf8');
  c.on('data', (d) => { resp += d; });
  c.on('end', () => done(0));
  c.on('error', () => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});
`;
