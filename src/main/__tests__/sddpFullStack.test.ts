/**
 * SDDP FULL-STACK composition — engine → REAL sub-agent runner → REAL agentic loop → REAL toolkit →
 * REAL fs/git, with ONLY the provider faked.
 *
 * The exhaustive E2E (`sddpPipelineE2e.test.ts`) mocks each sub-agent as a COARSE black box (name →
 * write a placeholder file): it proves the engine + real git/fs, but never runs the real sub-agent
 * runtime. This suite composes the SAME production glue the app wires, one layer deeper than a
 * hand-rolled transport: the in-process transport runs the **real `runAgentLoop`** driven by a
 * PROGRAMMABLE STUB PROVIDER (the only fake — it replays the token/tool turns a real DeepSeek desk
 * would emit). So the full chain runs for real:
 *   engine → `makeSpawnSubAgent` (deny-list + cwd-override) → `runOneShotSubAgent` (concurrency/abort/
 *   timeout) → `NativeAgentWorker` (toolRequest→toolResult round-trip) → **real `runAgentLoop`**
 *   (turn/hop caps, request→tool→result cycle, usage rollup, stop) → real `executeAgentTool`
 *   (read_file/list_dir/grep/write_file/edit_file/bash + hive_* + write_memory + web_search, cwd sandbox +
 *   specs/ redirect) → a throwaway `git init` repo.
 * Each specialist reads before it authors (matching its subAgents.ts prompt), so the toolkit's READ
 * path is exercised composed, not just in isolation; the qc-auditor's bash + write run with cwd
 * OVERRIDDEN into the merged QC worktree. Every meaningful engine branch (happy / deny-list / QC-fail /
 * merge-conflict / recurring-bug / analyze-CRITICAL / optional-skip / clarify-autopilot-OFF) runs
 * through this real stack; a focused case exercises the hive/web/memory tools.
 *
 * What's faked: only the provider's turns (the scripted stub). The loop, the worker plumbing, the
 * toolkit, the deny-list, the cwd-override, git, and fs are all real. The LIVE model + its prompts/
 * outputs remain un-automatable (sandbox only — docs/sddp-smoke.md). Requires `git` + `node` on PATH.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { SddpPipeline, type SddpPipelineDeps } from '../sddpPipeline';
import { prepareQcTree as gitPrepareQcTree, repoTrunk } from '../git';
import { makeSpawnSubAgent } from '../runtime/subAgentExecutor';
import {
  executeAgentTool, runAgentLoop, AGENT_TOOL_CATALOG, defaultMilestones, advanceMilestones,
  analyzeCoverage, agentTaskBranch, buildBugTitles, bugSignature,
  type AgentToolDeps, type HiveTask, type HiveMessage, type FeatureStatus,
  type ProviderCall, type ProviderTurn, type ToolResult
} from '@jsh562/won-agent-core';
import type { WorkerTransport } from '../runtime/nativeAgentWorker';
import type { WorkerCommand, WorkerMessage } from '../../shared/workerProtocol';
import type { AgentEvent } from '../../shared/agentEvent';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) { try { rmSync(r, { recursive: true, force: true }); } catch { /* best-effort */ } } });

/** A record of one tool call that completed the round-trip (loop → executor → toolkit → result). Its
 *  presence in the log is proof the real toolkit (or the deny-list) actually ran for that call. */
interface ToolLogEntry { agent: string; toolName: string; input: unknown; content: string; success: boolean }

/** The mutable flags a case flips to drive a branch (mirrors the E2E's E2EOpts). */
interface FsState { qcPass: boolean; autopilot: boolean; uncovered: boolean; skipOptional: boolean; conflict: boolean }

const USAGE = { input: 80, output: 16, cacheRead: 0, cacheCreation: 0 };

/** A PROGRAMMABLE stub provider: returns the next scripted `ProviderTurn` per call, clamping to the
 *  last (which must be `endOfTurn:true`) so the loop always terminates. This is the ONLY fake — it
 *  stands in for the model's token/tool stream. */
function makeScriptedProvider(turns: ProviderTurn[]): ProviderCall {
  let i = 0;
  return async () => turns[Math.min(i++, turns.length - 1)];
}

/**
 * A WorkerTransport that runs the REAL `runAgentLoop` in-process (no electron/utilityProcess) for one
 * sub-agent turn. It bridges the worker protocol to the loop: the loop's `executeTool` emits a
 * `toolRequest` message (which `NativeAgentWorker` routes back through the deny-list + real toolkit)
 * and resolves when the matching `toolResult` command arrives; the loop's `emit` becomes `event`
 * messages. `requestDrain` answers `block:false` directly (one-shot — the runner kills on `stop`
 * before a protocol drain could round-trip; the drain-message path stays covered by stopDrain.test.ts).
 */
function realLoopTransport(opts: { name: string; env: Record<string, string>; turns: ProviderTurn[]; toolLog: ToolLogEntry[]; eventLog: AgentEvent[] }): WorkerTransport {
  const { name, env, turns, toolLog, eventLog } = opts;
  let msgCb: ((m: WorkerMessage) => void) | null = null;
  let exitCb: ((c: number) => void) | null = null;
  let callSeq = 0;
  const pending = new Map<string, { resolve: (r: ToolResult) => void; toolName: string; input: unknown }>();
  const emit = (m: WorkerMessage) => msgCb?.(m);
  return {
    post: (c: WorkerCommand) => {
      if (c.type === 'send') {
        void runAgentLoop({
          agentId: name,
          sessionId: 's',
          model: env.NATIVE_PROVIDER_MODEL ?? 'deepseek-chat',
          providerCall: makeScriptedProvider(turns),
          executeTool: (use) => new Promise<ToolResult>((resolve) => {
            pending.set(use.toolCallId, { resolve, toolName: use.toolName, input: use.toolInput });
            emit({ type: 'toolRequest', callId: ++callSeq, toolCallId: use.toolCallId, toolName: use.toolName, toolInput: use.toolInput });
          }),
          emit: (event) => { eventLog.push(event); emit({ type: 'event', event }); },
          requestDrain: async () => ({ block: false }),
          caps: { maxTurns: Number(env.NATIVE_AGENT_MAX_TURNS) || 2, maxHops: Number(env.NATIVE_AGENT_MAX_HOPS) || 12 },
          systemPrompt: env.NATIVE_AGENT_SUBAGENT_PROMPT,
          tools: [...AGENT_TOOL_CATALOG]
        });
      } else if (c.type === 'toolResult') {
        const p = pending.get(c.toolCallId);
        if (p) {
          pending.delete(c.toolCallId);
          toolLog.push({ agent: name, toolName: p.toolName, input: p.input, content: c.content, success: c.success });
          p.resolve({ toolCallId: c.toolCallId, content: c.content, success: c.success });
        }
      }
    },
    onMessage: (cb) => { msgCb = cb; },
    onExit: (cb) => { exitCb = cb; },
    kill: () => { exitCb?.(0); }
  };
}

/** The faked model's turns for each specialist — its realistic READ-then-author sequence (matching its
 *  subAgents.ts prompt). Tool hops carry no text (text-deltas accumulate into the runner's final
 *  content); only the last turn carries the final text + `endOfTurn:true`. */
function subAgentTurns(name: string, state: FsState): ProviderTurn[] {
  let seq = 0;
  const hop = (toolName: string, toolInput: unknown): ProviderTurn =>
    ({ toolUses: [{ toolName, toolInput, toolCallId: `${name}-${++seq}` }], usage: USAGE, endOfTurn: false });
  const done = (text: string): ProviderTurn => ({ text, toolUses: [], usage: USAGE, endOfTurn: true });
  const F = 'specs/00001';
  switch (name) {
    case 'spec-author':
      return [hop('write_file', { path: `${F}/spec.md`, content: '# Spec\nFR-001: a\nFR-002: b\n' }), done('spec drafted')];
    case 'requirements-scanner':
      return [hop('read_file', { path: `${F}/spec.md` }), done('Q1: scope boundaries? Q2: error handling?')];
    case 'technical-researcher':
      return state.skipOptional ? [done('N/A — no open technical questions')]
        : [hop('read_file', { path: `${F}/spec.md` }), hop('web_search', { query: 'best approach for FR-001' }), hop('write_file', { path: `${F}/research.md`, content: '# Research\n' }), done('researched')];
    case 'database-administrator':
      return state.skipOptional ? [done('N/A — no data model needed')]
        : [hop('read_file', { path: `${F}/spec.md` }), hop('write_file', { path: `${F}/data-model.md`, content: '# Data\n' }), done('modeled')];
    case 'api-designer':
      return state.skipOptional ? [done('N/A — no API surface')]
        : [hop('read_file', { path: `${F}/spec.md` }), hop('write_file', { path: `${F}/contracts/api.yaml`, content: 'openapi: 3\n' }), done('contracts authored')];
    case 'adr-author':
      return state.skipOptional ? [done('N/A — no significant decisions')]
        : [hop('write_file', { path: `${F}/adrs/0001-x.md`, content: '# ADR-0001\n' }), done('adr recorded')];
    case 'plan-author':
      return [hop('read_file', { path: `${F}/spec.md` }), hop('list_dir', { path: F }), hop('write_file', { path: `${F}/plan.md`, content: '# Plan\n' }), done('planned')];
    case 'test-planner':
      return [hop('read_file', { path: `${F}/spec.md` }), hop('write_file', { path: `${F}/checklists/q.md`, content: '- [ ] CHK001 ok?\n' }), done('checklist authored')];
    case 'test-evaluator':
      return [hop('read_file', { path: `${F}/checklists/q.md` }), hop('edit_file', { path: `${F}/checklists/q.md`, old_string: '- [ ]', new_string: '- [X]' }), done('evaluated')];
    case 'wbs-generator':
      return [hop('read_file', { path: `${F}/spec.md` }), hop('read_file', { path: `${F}/plan.md` }),
        hop('write_file', { path: `${F}/tasks.md`, content: state.uncovered ? '- [ ] T001 {FR-001} do a\n' : '- [ ] T001 {FR-001} do a\n- [ ] T002 {FR-002} do b\n' }), done('tasks decomposed')];
    case 'policy-auditor':
      return [hop('read_file', { path: `${F}/spec.md` }), done('VERDICT: PASS')];
    case 'spec-validator':
      return [hop('read_file', { path: `${F}/spec.md` }), done('VERDICT: PASS')];
    case 'story-verifier':
      return [hop('read_file', { path: `${F}/spec.md` }), hop('grep', { pattern: 'FR-001' }), done('VERDICT: PASS')];
    case 'qc-auditor':
      return [hop('bash', { command: 'node -e "process.stdout.write(process.cwd())"' }),
        hop('write_file', { path: `${F}/qc-report.md`, content: state.qcPass ? '# QC\nall pass\n' : '# QC\n[BUG:ERROR] [test-failure] boom — a.ts:1\n' }),
        done(state.qcPass ? 'VERDICT: PASS' : 'VERDICT: FAIL')];
    default:
      return [done('ok')];
  }
}

/** A throwaway git repo + the engine wired to the REAL spawn → REAL loop → REAL toolkit composition.
 *  `opts` flips the same branch flags the E2E uses; `setTurns` overrides one sub-agent's faked turns. */
function setupFullStack(opts: Partial<FsState> = {}) {
  const state: FsState = {
    qcPass: opts.qcPass !== false,
    autopilot: opts.autopilot !== false,
    uncovered: !!opts.uncovered,
    skipOptional: !!opts.skipOptional,
    conflict: !!opts.conflict
  };
  const root = mkdtempSync(join(tmpdir(), 'sddp-fs-'));
  roots.push(root);
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('-c', 'init.defaultBranch=main', 'init');
  git('config', 'user.email', 'fs@test'); git('config', 'user.name', 'FS');
  writeFileSync(join(repo, 'README.md'), '# scratch\n');
  git('add', '.'); git('commit', '-m', 'init');
  if (state.conflict) { writeFileSync(join(repo, 'shared.txt'), 'base\n'); git('add', 'shared.txt'); git('commit', '-m', 'base'); }

  const abs = (feature: string, rel: string) => join(repo, 'specs', feature, rel);
  const read = (feature: string, rel: string) => { const p = abs(feature, rel); return existsSync(p) ? readFileSync(p, 'utf8') : null; };
  const write = (feature: string, rel: string, content: string) => { const p = abs(feature, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content); };
  const branchOf = (cid: string) => agentTaskBranch('worker', cid);

  // Per-sub-agent turn overrides (the focused hive/web case sets one directly).
  const turnsOverride = new Map<string, ProviderTurn[]>();
  const turnsFor = (name: string): ProviderTurn[] => turnsOverride.get(name) ?? subAgentTurns(name, state);
  const setTurns = (name: string, turns: ProviderTurn[]) => turnsOverride.set(name, turns);

  // The REAL toolkit deps over the temp repo. SDDP mode + repoFor anchor the specs/ redirect to the base
  // repo (so a sub-agent's `specs/...` write lands in the shared tree even from a QC worktree). The
  // caller-role gates are permissive (the owner desk holds authoring roles); the SUB-AGENT role gate is
  // the real deny-list applied in the executor wrapper. Memory/tasks/featureStatus/searchWeb back the
  // hive/web/memory tools.
  const mem = new Map<string, string>();
  const ledger = { tasks: [{ id: 'epic-1', title: 'Feature 00001', assignee: 'owner', status: 'doing', dependsOn: [], project: repo, feature: '00001', priority: 0, createdAt: '' }] as HiveTask[] };
  const baseToolDeps: AgentToolDeps = {
    enabled: () => true,
    memory: (id) => mem.get(id) ?? '',
    send: (partial, from = 'system') => ({ id: 'm1', from, to: String(partial.to), act: 'inform' } as unknown as HiveMessage),
    tasks: () => ledger,
    writeTasks: (t) => { ledger.tasks = t; },
    roster: () => [],
    isGod: () => false,
    canIntegrate: () => false,
    canReview: () => false,
    appendMemory: (id, text) => mem.set(id, (mem.get(id) ?? '') + '\n' + text),
    resolveCwd: () => repo,
    readRoots: () => [repo],
    repoFor: () => repo,
    sddpMode: () => true,
    bashEnabled: () => true,
    canEditCode: () => true,
    canWriteFiles: () => true,
    searchWeb: async (q) => `results for "${q}": [1] example.com`,
    featureStatus: (_r, feature): FeatureStatus => ({ feature, hasSpec: existsSync(abs(feature, 'spec.md')), hasClarifications: false, hasPlan: existsSync(abs(feature, 'plan.md')), hasTasks: existsSync(abs(feature, 'tasks.md')), completed: existsSync(abs(feature, '.completed')), qcPassed: existsSync(abs(feature, '.qc-passed')) })
  };
  const forwarded: string[] = [];        // tool names that REACHED the real toolkit (passed the deny-list)
  const toolLog: ToolLogEntry[] = [];     // every completed tool round-trip (incl. deny-list refusals)
  const eventLog: AgentEvent[] = [];      // every AgentEvent the real loop emitted (turn-start/stop/usage/…)
  let usageEvents = 0;                    // times the loop's token-usage rolled up to the caller
  const executeTool = (callerId: string, req: { toolCallId: string; toolName: string; toolInput: unknown }, cwdOverride?: string) => {
    forwarded.push(req.toolName);
    const deps: AgentToolDeps = cwdOverride
      ? { ...baseToolDeps, resolveCwd: () => cwdOverride, readRoots: (id: string) => [cwdOverride, ...(baseToolDeps.readRoots?.(id) ?? [])] }
      : baseToolDeps;
    return executeAgentTool(deps, callerId, req);
  };

  // The production spawn composition, provider-faked: a deepseek caller, the real-loop transport, the
  // real executor (deny-list + caller-scoped real toolkit).
  const spawn = makeSpawnSubAgent({
    providerOf: () => 'deepseek',
    modelOf: () => 'deepseek-chat',
    credentialEnvFor: () => ({ NATIVE_PROVIDER_API_KEY: 'test-key', NATIVE_PROVIDER_ID: 'deepseek' }),
    subAgentModelOverride: () => undefined,
    envNote: () => '',
    transportFactory: (_childId, env, name) => realLoopTransport({ name, env, turns: turnsFor(name), toolLog, eventLog }),
    executeTool,
    onUsage: () => { usageEvents++; }
  });

  let tasks: HiveTask[] = [...ledger.tasks.map((t) => ({ ...t, status: 'doing' as const, milestones: defaultMilestones() }))];
  const escalations: string[] = [];
  const asks: string[] = [];
  const doAdvance = (key: string) => {
    const i = tasks.findIndex((t) => t.id === 'epic-1');
    if (i < 0 || !tasks[i].milestones) return;
    const adv = advanceMilestones(tasks[i].milestones!, key);
    if (adv) tasks = tasks.map((t, j) => (j === i ? { ...t, milestones: adv } : t));
  };

  const deps: SddpPipelineDeps = {
    enabled: () => true,
    autopilot: () => state.autopilot,
    listTasks: () => tasks,
    repoForEpic: () => repo,
    ownerUsable: () => true,
    findDeskForRole: () => null,
    assignCard: () => { /* owner is usable; never auto-assigned here */ },
    featureArtifactExists: (_r, feature, rel) => existsSync(abs(feature, rel)),
    featureArtifactText: (_r, feature, rel) => read(feature, rel),
    writeFeatureArtifact: (_r, feature, rel, content) => write(feature, rel, content),
    analyzeFeature: (_r, feature) => ({ uncovered: analyzeCoverage(read(feature, 'spec.md') ?? '', read(feature, 'tasks.md') ?? '').uncovered }),
    checklistStatus: (_r, feature) => {
      const dir = abs(feature, 'checklists');
      if (!existsSync(dir)) return { total: 0, checked: 0 };
      let total = 0, checked = 0;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.md')) continue;
        for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
          if (/^\s*-\s*\[ \]/.test(line)) total++; else if (/^\s*-\s*\[[xX]\]/.test(line)) { total++; checked++; }
        }
      }
      return { total, checked };
    },
    advanceMilestone: (_epicId, key) => doAdvance(key),
    seedImplementCards: () => {
      const cids = ['c1', 'c2'];
      for (const cid of cids) {
        const br = branchOf(cid);
        git('checkout', '-b', br, 'main');
        if (state.conflict) { writeFileSync(join(repo, 'shared.txt'), `${cid} change\n`); git('add', 'shared.txt'); }
        else { writeFileSync(join(repo, `${cid}.txt`), `work ${cid}\n`); git('add', `${cid}.txt`); }
        git('commit', '-m', `work ${cid}`);
        git('checkout', 'main');
      }
      tasks = [...tasks, ...cids.map((cid) => ({ id: cid, title: `T-${cid}`, assignee: 'worker', status: 'todo' as const, dependsOn: [], project: repo, branch: branchOf(cid), feature: '00001', priority: 0, createdAt: '' }))];
      return cids.length;
    },
    escalate: (_f, m) => escalations.push(m),
    askHuman: (_f, q) => asks.push(q),
    spawnSubAgent: (caller, name, input, signal) => spawn(caller, name, input, signal),
    prepareQcTree: async () => {
      const branches = [...new Set(tasks.filter((t) => t.feature === '00001' && t.id !== 'epic-1' && t.branch && !/\[BUG/i.test(t.title)).map((t) => t.branch!))];
      const base = await repoTrunk(repo);
      const path = join(root, 'qc-worktrees', '00001');
      const res = await gitPrepareQcTree(repo, path, base, branches);
      return { ok: res.ok, path: res.ok ? path : null, conflicts: res.conflicts };
    },
    removeQcTree: (p) => { try { git('worktree', 'remove', '--force', p); } catch { /* */ } try { rmSync(p, { recursive: true, force: true }); } catch { /* */ } },
    spawnSubAgentInTree: (caller, name, input, treePath, signal) => spawn(caller, name, input, signal, treePath),
    sddpPolicy: () => ({ qcStrictness: 'standard', maxQcIterations: 10 }),
    seedBugCards: (_epic, report, attempt) => {
      const found = report.split('\n').map((l) => l.trim()).filter((l) => /\[BUG:/i.test(l));
      const findings = found.length ? found : ['[BUG:ERROR] QC failed — see qc-report.md'];
      const priorSigs = new Set(tasks.filter((t) => t.feature === '00001' && /\[BUG/i.test(t.title)).map((t) => bugSignature(t.title)));
      const titles = buildBugTitles(findings, priorSigs, attempt, 10);
      tasks = [...tasks, ...titles.map((title, i) => ({ id: `bug-${tasks.length + i}`, title, assignee: 'worker', status: 'todo' as const, dependsOn: [], project: repo, feature: '00001', priority: 1, createdAt: '' }))];
      return titles.length;
    },
    openBugCards: () => tasks.filter((t) => t.feature === '00001' && t.status !== 'done' && /\[BUG/i.test(t.title)).length,
    debounceMs: 0
  };

  const pipeline = new SddpPipeline(deps);
  const ms = (key: string) => tasks[0].milestones!.find((m) => m.key === key)!.status;
  const closeBugCards = () => { tasks = tasks.map((t) => (/\[BUG/i.test(t.title) && t.status !== 'done' ? { ...t, status: 'done' as const } : t)); };
  const trace = !!process.env.SDDP_E2E_TRACE;
  const drive = async ({ until = () => ms('qc') === 'done', answerClarify = false, maxIters = 40 }: { until?: () => boolean; answerClarify?: boolean; maxIters?: number } = {}) => {
    let last = '';
    for (let i = 0; i < maxIters; i++) {
      await pipeline.advanceFeature(repo, '00001');
      if (answerClarify && ms('clarify') === 'active' && asks.length > 0) doAdvance('clarify');
      if (trace) {
        const active = tasks[0].milestones!.find((m) => m.status === 'active');
        const cur = active ? `${active.key}:${active.status}` : 'complete';
        if (cur !== last) { console.log(`  ✓ ${cur}`); last = cur; }
      }
      const hasImpl = tasks.some((t) => t.feature === '00001' && t.id !== 'epic-1' && !(t.milestones?.length) && !/\[BUG/i.test(t.title));
      if (hasImpl && !existsSync(abs('00001', '.completed'))) writeFileSync(abs('00001', '.completed'), '');
      if (until()) return true;
    }
    return false;
  };

  return {
    pipeline, root, repo, state, abs, read, write, ms, drive, closeBugCards, setTurns, spawn,
    getTasks: () => tasks, operatorAdvance: doAdvance,
    escalations, asks, forwarded, toolLog, eventLog, usage: () => usageEvents
  };
}

describe('SDDP engine — full-stack composition (real runner + real loop + real toolkit + real fs/git, provider faked)', () => {
  it('1. happy path: the REAL loop drives each specialist; read+write+edit+bash+grep+web all run via the real toolkit; QC bash is cwd-overridden into the merged tree; .qc-passed lands', async () => {
    const h = setupFullStack();
    expect(await h.drive()).toBe(true);

    // The pipeline completed — every milestone done, no escalations.
    expect(h.getTasks()[0].milestones!.every((m) => m.status === 'done')).toBe(true);
    expect(h.escalations).toHaveLength(0);

    // The REAL agentic loop ran (not a hand-emitted stream): its event shape + usage rollup are present.
    expect(h.eventLog.some((e) => e.kind === 'turn-start')).toBe(true);
    expect(h.eventLog.some((e) => e.kind === 'tool-start')).toBe(true);
    expect(h.eventLog.some((e) => e.kind === 'tool-end')).toBe(true);
    expect(h.eventLog.some((e) => e.kind === 'stop')).toBe(true);
    expect(h.usage()).toBeGreaterThan(0); // the loop's token-usage rolled up to the caller per hop

    // Every tool class actually executed through the real toolkit (READ path included, not just writes).
    const ok = (tool: string) => h.toolLog.some((e) => e.toolName === tool && e.success);
    for (const t of ['read_file', 'list_dir', 'grep', 'write_file', 'edit_file', 'bash', 'web_search']) expect(ok(t)).toBe(true);

    // The artifacts exist BECAUSE the real toolkit wrote them, and a real read preceded the authoring.
    expect(h.read('00001', 'spec.md')).toMatch(/FR-001/);
    expect(h.read('00001', 'tasks.md')).toMatch(/\{FR-002\}/);
    expect(h.read('00001', 'checklists/q.md')).toMatch(/- \[X\] CHK001/); // real edit_file flipped it

    // QC: the qc-auditor's bash ran cwd-OVERRIDDEN into the merged worktree (process.cwd() proves it)…
    const qcBash = h.toolLog.find((e) => e.agent === 'qc-auditor' && e.toolName === 'bash');
    expect(qcBash?.success).toBe(true);
    expect(qcBash?.content).toMatch(/qc-worktrees/);
    // …and qc-report.md was REDIRECTED to the shared base specs/ (anchored to repoFor, not the tree).
    expect(h.read('00001', 'qc-report.md')).toMatch(/all pass/);
    expect(existsSync(h.abs('00001', '.qc-passed'))).toBe(true);
    expect(h.ms('qc')).toBe('done');
  });

  it('2. deny-list composes through the loop: spawn_subagent + hive_integrate are refused before the toolkit; the loop gets the refusal + proceeds; allowed tools still run', async () => {
    const h = setupFullStack();
    h.setTurns('plan-author', [
      { toolUses: [{ toolName: 'spawn_subagent', toolInput: { name: 'spec-author', input: 'recurse' }, toolCallId: 'p-1' }], usage: USAGE, endOfTurn: false },
      { toolUses: [{ toolName: 'hive_integrate', toolInput: { branch: 'x', apply: true }, toolCallId: 'p-2' }], usage: USAGE, endOfTurn: false },
      { toolUses: [{ toolName: 'write_file', toolInput: { path: 'specs/00001/plan.md', content: '# Plan\n' }, toolCallId: 'p-3' }], usage: USAGE, endOfTurn: false },
      { text: 'planned', toolUses: [], usage: USAGE, endOfTurn: true }
    ]);

    const res = await h.spawn('owner', 'plan-author', 'go');
    expect(res.success).toBe(true);

    // Both forbidden tools were refused IN THE EXECUTOR — never forwarded to the real toolkit.
    const refusals = h.toolLog.filter((e) => /a sub-agent may not call/.test(e.content) && !e.success);
    expect(refusals.map((e) => e.toolName).sort()).toEqual(['hive_integrate', 'spawn_subagent']);
    expect(h.forwarded).not.toContain('spawn_subagent');
    expect(h.forwarded).not.toContain('hive_integrate');
    // The loop kept going after the refusals and the allowed write_file really wrote the file.
    expect(h.forwarded).toContain('write_file');
    expect(h.read('00001', 'plan.md')).toMatch(/# Plan/);
  });

  it('3. QC FAIL via the real stack: real bash + real qc-report write, FAIL verdict ⇒ no .qc-passed + a [BUG] card; close + flip ⇒ re-run PASS', async () => {
    const h = setupFullStack({ qcPass: false });
    await h.drive({ until: () => h.getTasks().some((t) => /\[BUG/i.test(t.title)) });

    expect(h.toolLog.some((e) => e.agent === 'qc-auditor' && e.toolName === 'bash' && e.success)).toBe(true);
    expect(h.read('00001', 'qc-report.md')).toMatch(/\[BUG:ERROR\]/);
    expect(existsSync(h.abs('00001', '.qc-passed'))).toBe(false);
    expect(h.ms('qc')).toBe('active');
    expect(h.getTasks().filter((t) => /\[BUG/i.test(t.title))).toHaveLength(1);

    h.closeBugCards(); h.state.qcPass = true;
    await h.pipeline.advanceFeature(h.repo, '00001');
    expect(existsSync(h.abs('00001', '.qc-passed'))).toBe(true);
    expect(h.ms('qc')).toBe('done');
  });

  it('4. merge CONFLICT: QC escalates, no .qc-passed, the QC sub-agents never run, the tree is torn down', async () => {
    const h = setupFullStack({ conflict: true });
    await h.drive({ until: () => h.escalations.some((m) => /conflict/i.test(m)) });
    expect(h.escalations.some((m) => /conflict/i.test(m))).toBe(true);
    expect(existsSync(h.abs('00001', '.qc-passed'))).toBe(false);
    expect(h.ms('qc')).toBe('active');
    expect(h.toolLog.some((e) => e.agent === 'qc-auditor')).toBe(false); // never reached the QC sub-agents
    expect(existsSync(join(h.root, 'qc-worktrees', '00001'))).toBe(false);
  });

  it('5. recurring bug loop: a second real QC FAIL re-files the same finding tagged [RECURRING]', async () => {
    const h = setupFullStack({ qcPass: false });
    await h.drive({ until: () => h.getTasks().some((t) => /\[BUG/i.test(t.title)) });
    expect(h.getTasks().find((t) => /\[BUG/i.test(t.title))!.title).not.toMatch(/\[RECURRING\]/);

    h.closeBugCards();
    await h.pipeline.advanceFeature(h.repo, '00001'); // re-QC (attempt 2) → real qc stack FAILs again
    const bugs = h.getTasks().filter((t) => /\[BUG/i.test(t.title));
    expect(bugs).toHaveLength(2);
    expect(bugs[1].title).toMatch(/\[RECURRING\]/); // same finding came back through the real toolkit
  });

  it('6. Analyze CRITICAL → recover: an uncovered requirement holds (policy-auditor/spec-validator ran via the real loop), then fix+delete-report re-analyzes clean', async () => {
    const h = setupFullStack({ uncovered: true, autopilot: false });
    await h.drive({ answerClarify: true, until: () => h.escalations.some((m) => /CRITICAL/i.test(m)) });
    expect(h.read('00001', 'analysis-report.md')).toMatch(/critical:\s*1/);
    expect(h.ms('analyze')).toBe('active');
    expect(h.toolLog.some((e) => e.agent === 'policy-auditor' && e.toolName === 'read_file')).toBe(true);

    h.write('00001', 'tasks.md', '- [ ] T001 {FR-001} do a\n- [ ] T002 {FR-002} do b\n'); // cover FR-002
    rmSync(h.abs('00001', 'analysis-report.md'));
    await h.pipeline.advanceFeature(h.repo, '00001');
    expect(h.read('00001', 'analysis-report.md')).toMatch(/critical:\s*0/);
    expect(h.ms('analyze')).toBe('done');
  });

  it('7. optional-skip: the optional authors emit no write via the real loop ⇒ those steps advance with no artifact', async () => {
    const h = setupFullStack({ skipOptional: true });
    expect(await h.drive()).toBe(true);
    for (const k of ['research', 'data-model', 'contracts', 'adrs']) expect(h.ms(k)).toBe('done');
    expect(existsSync(h.abs('00001', 'research.md'))).toBe(false);
    expect(existsSync(h.abs('00001', 'data-model.md'))).toBe(false);
    expect(existsSync(h.abs('00001', '.qc-passed'))).toBe(true);
  });

  it('8. Clarify autopilot OFF: requirements-scanner reads spec.md (real read) + asks the human, and the step HOLDS', async () => {
    const h = setupFullStack({ autopilot: false });
    await h.drive({ until: () => h.asks.length > 0 });
    expect(h.ms('clarify')).toBe('active');
    expect(h.asks.length).toBeGreaterThan(0);
    expect(h.toolLog.some((e) => e.agent === 'requirements-scanner' && e.toolName === 'read_file' && e.success)).toBe(true);
  });

  it('9. hive + web + memory tools round-trip through the real toolkit (composed, not isolated)', async () => {
    const h = setupFullStack();
    h.setTurns('context-gatherer', [
      { toolUses: [{ toolName: 'list_dir', toolInput: {}, toolCallId: 'c-1' }], usage: USAGE, endOfTurn: false },
      { toolUses: [{ toolName: 'hive_read_memory', toolInput: {}, toolCallId: 'c-2' }], usage: USAGE, endOfTurn: false },
      { toolUses: [{ toolName: 'hive_list_tasks', toolInput: {}, toolCallId: 'c-3' }], usage: USAGE, endOfTurn: false },
      { toolUses: [{ toolName: 'hive_feature_status', toolInput: { feature: '00001' }, toolCallId: 'c-4' }], usage: USAGE, endOfTurn: false },
      { toolUses: [{ toolName: 'write_memory', toolInput: { text: 'noted: feature 00001 not yet started' }, toolCallId: 'c-5' }], usage: USAGE, endOfTurn: false },
      { toolUses: [{ toolName: 'web_search', toolInput: { query: 'spec-driven development' }, toolCallId: 'c-6' }], usage: USAGE, endOfTurn: false },
      { text: 'context gathered', toolUses: [], usage: USAGE, endOfTurn: true }
    ]);

    const res = await h.spawn('owner', 'context-gatherer', 'gather');
    expect(res.success).toBe(true);
    const ran = (tool: string) => h.toolLog.some((e) => e.toolName === tool && e.success);
    for (const t of ['list_dir', 'hive_read_memory', 'hive_list_tasks', 'hive_feature_status', 'write_memory', 'web_search']) expect(ran(t)).toBe(true);
    expect(h.toolLog.find((e) => e.toolName === 'web_search')!.content).toMatch(/results for/);
    expect(h.toolLog.find((e) => e.toolName === 'hive_feature_status')!.content).toMatch(/phase/i);
  });
});
