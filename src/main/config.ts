import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { DeskEnvEntry } from '../shared/deskEnv';

/** A recurring auto-dispatched mission fired on an interval by the scheduler. */
export interface ScheduledMission {
  id: string;
  label: string;
  intervalMs: number;
  to: string;
  body: string;
  enabled: boolean;
  /** When true, the scheduler also sends `/compact` to every live terminal when
   *  this mission fires — keeping each agent's context lean on a cadence. */
  autoCompact?: boolean;
  lastFiredAt?: number;
  /** Mission flavor. Absent ⇒ 'dispatch' (the classic interval-dispatch mission,
   *  e.g. the ops standup). 'heartbeat' (Lane A #1) is a context-aware beat: it
   *  observes live floor state, re-engages a quiet god, and ticks the circuit
   *  breaker — armed with an adaptive cadence, not a fixed setInterval. */
  kind?: 'dispatch' | 'heartbeat';
  /** Heartbeat only: a floor is "quiet" when no tracked signal (log.jsonl mtime,
   *  inbox/outbox mtimes, any PTY output) has moved in this many ms. Default
   *  ~5 min. NOT derived from registry.status (which never transitions in main). */
  quietThresholdMs?: number;
  /** Per-project scoping (a repo path). When set, the mission fires to every non-archived
   *  desk whose project matches this repo (instead of the single `to`), so a standup/triage
   *  can target one project's team. Absent ⇒ the plain `to` recipient. */
  project?: string;
}

/** The built-in hourly ops standup: god reviews who's doing what + whether tasks
 *  are on track and agents are running, and every terminal's context is compacted.
 *  Shipped enabled by default; users can toggle it off in the Command Center. */
export const OPS_STANDUP_MISSION: ScheduledMission = {
  id: 'ops-standup',
  label: 'Hourly ops standup',
  intervalMs: 3_600_000,
  to: 'god',
  body:
    'Hourly ops standup. Review every agent: who is doing what, and confirm each ' +
    'is still running (not stalled or idle-stale). Check the task board — are ' +
    'in-flight tasks on track, and is anything blocked or unowned? Flag stale ' +
    'agents and at-risk tasks, and keep the board accurate. (As part of this ' +
    "standup each working agent is asked to summarise its current task and the " +
    'next step, then compact and resume from the same point — so terminal ' +
    'contexts stay bounded without losing work. The compaction is queued and ' +
    'runs when an agent is idle, so it never interrupts work mid-step.)',
  enabled: true,
  autoCompact: true
};

/** The built-in heartbeat (Lane A #1). A context-aware beat that, each tick,
 *  observes live floor state and — only when the floor has gone quiet — drops a
 *  digest into god's inbox and (if god's PTY is genuinely idle) nudges it to
 *  re-engage anyone stalled. The same beat ticks the circuit breaker.
 *
 *  Shipped DISABLED by default (opt-in): unlike the standup, which only sends a
 *  hive message, the heartbeat types into god's PTY, so the user turns it on
 *  explicitly in the Command Center once they want active re-engagement.
 *  `intervalMs` is the normal-cadence base; the scheduler derives a tighter beat
 *  when an agent looks stuck and a slower one right after a re-engage. */
export const HEARTBEAT_MISSION: ScheduledMission = {
  id: 'heartbeat',
  label: 'Floor heartbeat',
  intervalMs: 120_000,
  to: 'god',
  body:
    'Floor heartbeat: the team has gone quiet. Review the digest in your inbox, ' +
    're-engage anyone stalled or blocked, and keep the board accurate — or rest ' +
    'if the work is genuinely done.',
  enabled: false,
  kind: 'heartbeat',
  quietThresholdMs: 300_000
};

/** Circuit-breaker thresholds (Lane A #6.6b). The breaker runs inside the
 *  heartbeat beat, so it only ticks when the heartbeat is enabled. Trip
 *  conditions are behavioral by default; `costCapUsd` is the only $-based one and
 *  is unset by default (a hardcoded dollar default would be arbitrary). Defaults
 *  are deliberately conservative and steer-first — `hardStop` is OFF unless the
 *  user opts in, so the breaker never auto-kills a healthy long-runner. */
export interface CircuitBreakerConfig {
  /** Master switch for breaker evaluation within the beat. Default true. */
  enabled?: boolean;
  /** Allow the top of the ladder (kill PTY + archive). Default false = the
   *  breaker may steer/constrain but never hard-stops until the user opts in. */
  hardStop?: boolean;
  /** Consecutive identical tool calls (same name+input) before tripping. */
  repeatedToolLimit?: number;
  /** Consecutive api_error / retry events before tripping. */
  errorStormLimit?: number;
  /** Output-token velocity (tokens/min, diffed across beats) before tripping. */
  tokenVelocityPerMin?: number;
}

export interface HarnessConfig {
  /** Has the user completed the first-run onboarding? */
  onboardingComplete: boolean;
  /** Folder where the harness keeps its own state (agent metadata, logs). */
  harnessHome: string | null;
  /** Optional working directory for a NATIVE god — its own scratch space, kept
   *  separate from the hive bookkeeping so its file writes can't pollute the registry
   *  / board / memory. Unset ⇒ auto-derived `<harnessHome>/workspace`. */
  godWorkspace?: string;
  /** One root for EVERY desk's redirected build output (Rust `target/`, …), keyed per working tree
   *  so heavy/churning build trees stay OUT of the worktrees and the repo — the operator excludes
   *  this single folder from antivirus. Unset ⇒ auto-derived `<harnessHome>/build-cache`. */
  buildCacheDir?: string;
  /** Per-desk env vars (GLOBAL base), injected into each desk's environment. Each value is a TEMPLATE
   *  with `${buildRoot}`/`${worktreeKey}`/`${cwd}`/`${agentId}`/`${harnessHome}` + `${env:NAME}` tokens
   *  the host expands per desk (so the user defines the parent folder once and the per-worktree
   *  structure is filled in automatically). General — any var, not just build dirs. Unset ⇒ the
   *  built-in default (`CARGO_TARGET_DIR`). See `src/shared/deskEnv.ts`. */
  deskEnv?: DeskEnvEntry[];
  /** Per-project-repo env OVERRIDES, keyed by the repo path (a `registeredRepos` string; matched
   *  case/separator-insensitively). For a desk whose project repo matches, these layer ON TOP of the
   *  global `deskEnv` (same `name` wins). Unset ⇒ only the global table applies. */
  deskEnvByRepo?: Record<string, DeskEnvEntry[]>;
  /** Per-agent env OVERRIDES, keyed by EXACT agent id. Layered ON TOP of global + per-repo for that
   *  desk (most specific wins). Unset ⇒ only the global + per-repo tables apply. */
  deskEnvByAgent?: Record<string, DeskEnvEntry[]>;
  /** Folders the user registered during onboarding (used as quick-picks). */
  registeredRepos: string[];
  /** When true, new agents are spawned with --permission-mode bypassPermissions. */
  autoMode: boolean;
  /** The command we run when spawning a new agent. */
  defaultCommand: string;
  /** Default model for newly spawned agents (e.g. 'claude-sonnet-4-6[1m]'); unset = CLI default.
   *  E005 FleetDefault (DR-1): this is the canonical, house-wide default MODEL id —
   *  the single stored value of the fleet default. The provider is NOT stored here;
   *  it is DERIVED from this model id at read time via the E002 registry
   *  (`lookupModelInfo`), so the two never drift. Absence ⇒ the role-based fallback
   *  applies (DR-8); a present-but-unresolvable id is a STALE default and falls
   *  through to the role-based fallback at creation, never auto-remapped (DR-11).
   *  Changing it is NON-RETROACTIVE — existing agents keep their snapshot (DR-4). */
  defaultModel?: string;
  /** Enable semantic memory (MemPalace CLI). No-op if mempalace isn't installed. */
  semanticMemory: boolean;
  /** Embedding model for the palace: lightweight 'minilm' or multilingual 'embeddinggemma'. */
  embeddingModel: 'minilm' | 'embeddinggemma';
  /** Recurring auto-dispatch missions handled by the scheduler. */
  missions?: ScheduledMission[];
  /** One-time guard: has the built-in hourly ops standup been seeded into an
   *  existing install's missions? Prevents re-adding it after a user deletes it. */
  opsStandupSeeded?: boolean;
  /** One-time guard for the built-in heartbeat mission (mirrors opsStandupSeeded
   *  so a user who deletes the heartbeat doesn't get it re-added every boot). */
  heartbeatSeeded?: boolean;
  /** Hard dollar ceiling across all active agents before the circuit breaker
   *  trips. UNSET by default (Lane A #6.6b decision): the breaker trips on
   *  behavioral signals; the $-cap is purely opt-in. Legacy — the UI now sets a
   *  token cap instead (see costCapTokens); both are enforced if present. */
  costCapUsd?: number;
  /** Hard TOKEN ceiling (total tokens across all active agents) before the
   *  breaker trips. The user-facing budget — set in Settings. Opt-in like the
   *  $-cap; total = input + output + cacheRead + cacheCreation, summed across the
   *  floor (the biggest token spender is blamed). */
  costCapTokens?: number;
  /** Per-agent total-token ceiling, keyed by agent id. When an agent's own total
   *  tokens exceed its cap the breaker trips that agent alone (independent of the
   *  floor budget). Set from each agent's card in the Command Center. */
  agentTokenCaps?: Record<string, number>;
  /** Passed to every spawned agent as `--max-turns <n>` when set; unset = no cap
   *  (Claude Code's default). A coarse runaway guard independent of the breaker. */
  maxTurns?: number;
  /** Circuit-breaker thresholds (Lane A #6.6b). Unset = conservative defaults. */
  circuitBreaker?: CircuitBreakerConfig;
  /** Fire native desktop notifications on agent lifecycle events (idle finish / waiting for input). */
  notifications?: boolean;
  /** Terminal theme — mirrored into each agent's per-session Claude settings
   *  ("theme" key) at spawn so the TUI's truecolor palette matches. Scoped to
   *  harness agents only; the user's global Claude theme is never touched. */
  terminalTheme?: 'light' | 'dark';
  /** Master toggle for the Slack → Michael's-queue integration. */
  slackEnabled?: boolean;
  /** Slack app signing secret (Basic Information → Signing Secret). Never logged. */
  slackSigningSecret?: string;
  /** Bot token (xoxb-…) — only needed if the bot ever replies; optional for now. */
  slackBotToken?: string;
  /** Restrict ingestion to one channel id; empty/undefined = any channel. */
  slackChannelId?: string;
  /** Local HTTP port the webhook server binds to (default 3847). */
  slackPort?: number;
  /** Per-provider API keys for native (non-Claude) providers (E004), keyed by
   *  provider id (src/shared/providerRegistry). Plaintext at rest — an ACCEPTED
   *  MVP risk (ADR-0007). NEVER sent to the renderer (redacted via redactConfig),
   *  the git hive, transcripts, or telemetry; injected only into a native worker's
   *  spawn env. A future OS-keychain backend swaps in behind the injection seam. */
  providerKeys?: Record<string, string>;
  /** Secret vault — named secret values referenced from env tables via `${secret:NAME}`. Encrypted at
   *  rest (`safeStorage`, `enc:`/`raw:` prefixed). NEVER sent to the renderer (redacted to names only);
   *  decrypted in main and injected into a desk's env. See `src/main/secrets.ts`. */
  secrets?: Record<string, string>;
  /** Runtime env (GLOBAL) — vars for the agent's OWN model + network calls (proxy / custom CA), e.g.
   *  `HTTPS_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`. Injected into the native worker process, the
   *  Claude PTY, and bash (so git/curl honor them too). Values may use `${env:NAME}`/`${secret:NAME}`.
   *  Distinct from `deskEnv` (which is for what desks RUN). */
  runtimeEnv?: DeskEnvEntry[];
  /** Opt-in: allow native (DeepSeek/Minimax) desks to run the `bash` tool. OFF by
   *  default — a native desk gets filesystem/search/memory tools unconditionally,
   *  but shell execution stays gated until the operator turns this on (the toolkit
   *  still cwd-sandboxes + breaker-watches every bash call when enabled). Claude
   *  desks are unaffected (their shell rides the CLI's own permission system). */
  nativeBashEnabled?: boolean;
  /** Opt-in: allow native desks to use the `web_search` tool. OFF by default. The
   *  API key lives in `providerKeys['web-search']` (redacted like any provider key);
   *  this flag is the operator gate. When off (or no key) the tool fails closed with
   *  a clear note. Claude desks are unaffected (they use their own web tooling). */
  webSearchEnabled?: boolean;
  /** Opt-in: put the whole floor in SPEC-DRIVEN (SDDP) mode. OFF by default. When on,
   *  desks follow the Specify→Clarify→Plan→Tasks→Implement→QC→Integrate lifecycle: role
   *  prompts switch to the SDDP variants, the `planner`/`qc` roles become meaningful, the
   *  kanban shows a feature-phase banner, and `hive_update_task` enforces the phase gates.
   *  A wholesale switch — when off, standard behaviour is unchanged. */
  sddpMode?: boolean;
  /** SDDP autopilot (mirrors sddp27's AUTOPILOT): when ON, the host engine AUTO-RESOLVES the
   *  human-in-the-loop gates instead of pausing for the operator — e.g. Clarify is resolved by the
   *  spec-author with documented reasonable defaults rather than asking. OFF by default (the human
   *  gates stay in the loop). See the Human-Gates Registry in docs/orchestration-model.md. */
  sddpAutopilot?: boolean;
  /** SDDP only: the model an ephemeral `spawn_subagent` specialist runs on. Lets the operator
   *  point sub-agents at a cheaper/faster model than the orchestrator desk. The provider +
   *  credentials are ALWAYS inherited from the calling desk; only the model id is overridden, and
   *  only when the override resolves to the SAME provider as the caller (a cross-provider override
   *  is ignored so the caller's key still works). Absent ⇒ sub-agents run on the caller's model. */
  sddpSubAgentModel?: string;
  /** SDDP policy knobs (mirrors sddp27's `.github/sddp-config.md`). `qcStrictness` selects the
   *  required QC categories (minimal=build/test; standard=+lint; strict=+security/coverage);
   *  `coverageTarget` is the % the QC auditor enforces; `maxChecklist` caps how many checklist files
   *  the checklist step authors; `maxQcIterations` bounds the implement↔QC bug loop before findings are
   *  deferred. All optional with built-in defaults. */
  sddpConfig?: {
    qcStrictness?: 'minimal' | 'standard' | 'strict';
    coverageTarget?: number;
    maxChecklist?: number;
    maxQcIterations?: number;
  };

  // ─── Memory reflection (the janitor's condense half) ───────────────────────
  /** Master toggle for the in-process MemoryReflector. Default on. */
  reflectEnabled?: boolean;
  /** How often to scan agent memory.md files for condensing (default 30 min). */
  reflectIntervalMs?: number;
  /** Condense when bytes exceed this percent of the 128 KB budget (matches the
   *  janitor's TRIGGER_PCT). DECIDED: 50. */
  reflectByteTriggerPct?: number;
  /** ...OR when `## ` section count exceeds this (AND bytes > floor). DECIDED: 50. */
  reflectSectionTrigger?: number;
  /** Newest K verbatim `## ` sections kept untouched on each condense. */
  reflectRecentKeep?: number;
  /** Never condense a file smaller than this; also the section-trigger byte floor.
   *  DECIDED: 16 KB. */
  reflectMinBytes?: number;
}

const DEFAULTS: HarnessConfig = {
  onboardingComplete: false,
  harnessHome: null,
  registeredRepos: [],
  autoMode: true,
  defaultCommand: 'claude',
  semanticMemory: true,
  embeddingModel: 'minilm',
  missions: [OPS_STANDUP_MISSION],
  notifications: false,
  webSearchEnabled: false,
  slackEnabled: false,
  slackSigningSecret: undefined,
  slackBotToken: undefined,
  slackChannelId: undefined,
  slackPort: undefined,
  // Memory reflection — preventive; nobody is over threshold today, so it sits
  // dark until an agent's memory crosses one of these (the verify gate is the
  // safety for the LLM step). Thresholds DECIDED by god 2026-06-06.
  reflectEnabled: true,
  reflectIntervalMs: 1_800_000,
  reflectByteTriggerPct: 50,
  reflectSectionTrigger: 50,
  reflectRecentKeep: 12,
  reflectMinBytes: 16_384
};

function configPath(): string {
  return join(app.getPath('userData'), 'config.json');
}

/** Migrate legacy keys in place so older configs keep working. `buildEnv`/`buildEnvByRepo` were
 *  renamed to `deskEnv`/`deskEnvByRepo` (the table is general, not build-only) — surface the old
 *  values under the new keys when the new ones are absent. New writes use the new keys; the stale old
 *  keys are harmless (ignored). */
function migrateConfig(cfg: HarnessConfig): HarnessConfig {
  const legacy = cfg as HarnessConfig & { buildEnv?: DeskEnvEntry[]; buildEnvByRepo?: Record<string, DeskEnvEntry[]> };
  if (cfg.deskEnv === undefined && legacy.buildEnv !== undefined) cfg.deskEnv = legacy.buildEnv;
  if (cfg.deskEnvByRepo === undefined && legacy.buildEnvByRepo !== undefined) cfg.deskEnvByRepo = legacy.buildEnvByRepo;
  return cfg;
}

export function readConfig(): HarnessConfig {
  const p = configPath();
  if (!existsSync(p)) return { ...DEFAULTS };
  try {
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    return migrateConfig({ ...DEFAULTS, ...parsed });
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeConfig(patch: Partial<HarnessConfig>): HarnessConfig {
  const current = readConfig();
  const next: HarnessConfig = { ...current, ...patch };
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/** Wipe the persisted config back to first-run defaults so the app boots into
 *  onboarding again. Used by the "reset & start over" flow. */
export function resetConfig(): HarnessConfig {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(DEFAULTS, null, 2), 'utf8');
  return { ...DEFAULTS };
}

/** Model ids by tier (Lane A #6.4). Kept in sync with AGENT_MODELS / ASSISTANT_MODEL
 *  in src/renderer/src/store/config.ts and ASSISTANT_MODEL in src/main/assistant.ts. */
const MODEL_GOD = 'claude-opus-4-8';                  // orchestration — highest capability
const MODEL_WORKER = 'claude-sonnet-4-6';             // general execution
const MODEL_ASSISTANT = 'claude-sonnet-4-6[1m]';      // large-context prep assistant
const MODEL_HELPER = 'claude-haiku-4-5-20251001';     // narrow, cheap helpers

/** Minimal structural shape for tiering — a subset of AgentMeta so config.ts
 *  stays free of a hive.ts import. */
export interface RoleHint {
  isGod?: boolean;
  isAssistant?: boolean;
  role?: string;
  capabilities?: string[];
}

/** Default model for an agent given its role (Lane A #6.4): Opus for the god,
 *  Sonnet·1M for the prep assistant, Haiku for narrow helpers (triage / routing /
 *  verification / formatting), Sonnet for general workers. Returns a model id
 *  (matching AGENT_MODELS) or undefined to fall back to the CLI default. This is
 *  only a DEFAULT — an explicit per-agent model selection always wins. */
export function modelForRole(meta: RoleHint): string | undefined {
  if (meta.isGod) return MODEL_GOD;
  if (meta.isAssistant) return MODEL_ASSISTANT;
  const hay = `${meta.role ?? ''} ${(meta.capabilities ?? []).join(' ')}`.toLowerCase();
  if (/\b(triage|rout|verif|lint|format|summar|classif|label)/.test(hay)) return MODEL_HELPER;
  return MODEL_WORKER;
}

/** E005 {FR-005} — the configured FleetDefault MODEL id, or undefined when unset
 *  (⇒ role-based fallback, DR-8). This reads the SINGLE stored value
 *  (`defaultModel`) of the house default; the provider is DERIVED from the model id
 *  at read time via the E002 registry (DR-1/HINT-001), never stored as a second
 *  editable field, so they cannot drift. A blank string is treated as unset. The
 *  id is returned VERBATIM — a present-but-unresolvable (stale) id is preserved and
 *  surfaced for re-selection, never auto-remapped (DR-11); honoring DR-11 at
 *  creation precedence is the resolver's job (src/shared/assignment.ts), which
 *  treats a stale fleet default as absent. */
export function fleetDefaultModel(config?: HarnessConfig): string | undefined {
  const cfg = config ?? readConfig();
  const id = (cfg.defaultModel ?? '').trim();
  return id.length ? id : undefined;
}

/** Auto-suggested command string given current autoMode preference. */
export function commandForAutoMode(config: HarnessConfig): string {
  if (config.autoMode) {
    return `${config.defaultCommand} --permission-mode bypassPermissions`;
  }
  return config.defaultCommand;
}

/** Ensure harnessHome exists on disk. */
export function ensureHarnessHome(path: string): { ok: boolean; error?: string } {
  try {
    mkdirSync(path, { recursive: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Idempotently pre-accept Claude Code's first-run prompts so agents spawned with
 *  `--permission-mode bypassPermissions` start cleanly. Without this, a fresh
 *  install shows an interactive "WARNING: Bypass Permissions mode … 1. No, exit /
 *  2. Yes, I accept" prompt that the PTY can't answer in time, so the agent exits
 *  code 1 on its own (reported by multiple users).
 *
 *  Two separate gates, written only when they aren't already satisfied (so we
 *  rarely touch files a running `claude` also writes):
 *   1. `~/.claude/settings.json` → `skipDangerousModePermissionPrompt` +
 *      `skipAutoPermissionPrompt` — these gate the bypass-mode warning (global).
 *   2. `~/.claude.json` → `projects[cwd].hasTrustDialogAccepted` — the per-folder
 *      "do you trust the files in this folder?" dialog. */
export function ensureClaudePermissionsAccepted(cwd?: string): void {
  const home = homedir();
  if (!home) return;
  // 1) Global bypass-mode warning gate.
  try {
    const dir = join(home, '.claude');
    const p = join(dir, 'settings.json');
    let s: Record<string, unknown> = {};
    if (existsSync(p)) {
      try { s = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>; } catch { s = {}; }
    }
    if (s.skipDangerousModePermissionPrompt !== true || s.skipAutoPermissionPrompt !== true) {
      s.skipDangerousModePermissionPrompt = true;
      s.skipAutoPermissionPrompt = true;
      mkdirSync(dir, { recursive: true });
      writeFileSync(p, JSON.stringify(s, null, 2), 'utf8');
    }
  } catch { /* best-effort; never block a spawn */ }
  // 2) Per-folder trust dialog gate (only when this cwd isn't already trusted).
  if (cwd) {
    try {
      const p = join(home, '.claude.json');
      let c: { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> } = {};
      if (existsSync(p)) {
        try { c = JSON.parse(readFileSync(p, 'utf8')); } catch { c = {}; }
      }
      if (c.projects?.[cwd]?.hasTrustDialogAccepted !== true) {
        c.projects = c.projects ?? {};
        c.projects[cwd] = { ...(c.projects[cwd] ?? {}), hasTrustDialogAccepted: true };
        writeFileSync(p, JSON.stringify(c, null, 2), 'utf8');
      }
    } catch { /* best-effort */ }
  }
}
