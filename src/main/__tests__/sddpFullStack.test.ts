/**
 * SDDP FULL-STACK composition — engine → REAL sub-agent runner → REAL toolkit → REAL fs/git, with
 * ONLY the model faked.
 *
 * The exhaustive E2E (`sddpPipelineE2e.test.ts`) mocks each sub-agent as a COARSE black box (name →
 * write a placeholder file): it proves the engine + real git/fs, but never runs the real sub-agent
 * RUNTIME. This suite closes that gap. It composes the SAME production glue the app wires:
 *   `makeSpawnSubAgent` (subAgentExecutor.ts) → `runOneShotSubAgent` (the one-shot runner) over a
 *   NativeAgentWorker → a SCRIPTED fake transport (the only fake — it stands in for the LLM token/
 *   tool stream) → the real `executeAgentTool` (write_file/edit_file/bash + cwd sandbox + the
 *   specs/ redirect) → a throwaway `git init` repo.
 * So each sub-agent's tool calls ACTUALLY execute: spec.md/plan.md/tasks.md are authored by a real
 * `write_file`, the checklist is flipped by a real `edit_file`, and the QC sub-agent's `bash` +
 * `write_file` run with the cwd OVERRIDDEN into the merged QC worktree — exactly the production path.
 *
 * What's faked: only the model's output (the scripted transport replays the tool-call + final-text
 * stream a real DeepSeek desk would emit). The runner, the worker plumbing, the toolkit, the deny-
 * list, the cwd-override, git, and the fs are all real. The live model + its prompts/outputs remain
 * un-automatable (sandbox only — docs/sddp-smoke.md). Requires `git` + `node` on PATH.
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
  executeAgentTool, defaultMilestones, advanceMilestones, analyzeCoverage, agentTaskBranch,
  buildBugTitles, bugSignature, type AgentToolDeps, type HiveTask, type HiveMessage
} from '@jsh562/won-agent-core';
import type { WorkerTransport } from '../runtime/nativeAgentWorker';
import type { WorkerCommand, WorkerMessage } from '../../shared/workerProtocol';
import type { AgentEvent } from '../../shared/agentEvent';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) { try { rmSync(r, { recursive: true, force: true }); } catch { /* best-effort */ } } });

/** One scripted sub-agent turn: a sequence of tool calls the worker will route through the REAL
 *  executor, then the final assistant text (where a verdict sub-agent puts "VERDICT: PASS"). */
interface SubAgentScript { tools: { tool: string; input: unknown }[]; final: string }

/** A record of one tool call that completed the round-trip (executor → toolkit → result). Its presence
 *  is proof the real toolkit (or the deny-list) actually ran for that call. */
interface ToolLogEntry { agent: string; toolName: string; input: unknown; content: string; success: boolean }

/**
 * A FAKE worker transport that replays a `SubAgentScript`: it stands in for the LLM. On the worker's
 * `send`, it emits the script's first tool request; the worker executes it (real `executeAgentTool`)
 * and posts a `toolResult`, which drives the next request; once the tools are exhausted it emits the
 * final text + `stop`. Mirrors the fake-transport pattern in subAgentRunner.test.ts, extended to a
 * multi-tool sequence keyed off the real `toolResult` round-trip.
 */
function scriptedTransport(name: string, script: SubAgentScript, toolLog: ToolLogEntry[]): WorkerTransport {
  let msgCb: ((m: WorkerMessage) => void) | null = null;
  let exitCb: ((c: number) => void) | null = null;
  let idx = 0;
  let callSeq = 0;
  const pending = new Map<string, { tool: string; input: unknown }>();
  const emit = (m: WorkerMessage) => msgCb?.(m);
  const ev = (kind: string, extra: Record<string, unknown> = {}): AgentEvent =>
    ({ v: 1, agentId: name, sessionId: null, ts: 1, kind, ...extra } as unknown as AgentEvent);
  const step = (): void => {
    if (idx < script.tools.length) {
      const t = script.tools[idx++];
      const toolCallId = `tc-${name}-${idx}`;
      pending.set(toolCallId, t);
      emit({ type: 'toolRequest', callId: ++callSeq, toolCallId, toolName: t.tool, toolInput: t.input });
    } else {
      if (script.final) emit({ type: 'event', event: ev('text-delta', { text: script.final }) });
      emit({ type: 'event', event: ev('stop', { reason: 'end-of-turn', stopActive: false }) });
    }
  };
  return {
    post: (c: WorkerCommand) => {
      if (c.type === 'send') step();
      else if (c.type === 'toolResult') {
        const req = pending.get(c.toolCallId);
        if (req) toolLog.push({ agent: name, toolName: req.tool, input: req.input, content: c.content, success: c.success });
        step();
      }
    },
    onMessage: (cb) => { msgCb = cb; },
    onExit: (cb) => { exitCb = cb; },
    kill: () => { exitCb?.(0); }
  };
}

/** A throwaway git repo + the engine wired to the REAL spawn composition (executor → runner → worker →
 *  scripted transport → real toolkit). The sub-agent SCRIPTS are mutable so a test can override one. */
function setupFullStack(opts: { qcPass?: boolean } = {}) {
  const state = { qcPass: opts.qcPass !== false };
  const root = mkdtempSync(join(tmpdir(), 'sddp-fs-'));
  roots.push(root);
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('-c', 'init.defaultBranch=main', 'init');
  git('config', 'user.email', 'fs@test'); git('config', 'user.name', 'FS');
  writeFileSync(join(repo, 'README.md'), '# scratch\n');
  git('add', '.'); git('commit', '-m', 'init');

  const abs = (feature: string, rel: string) => join(repo, 'specs', feature, rel);
  const read = (feature: string, rel: string) => { const p = abs(feature, rel); return existsSync(p) ? readFileSync(p, 'utf8') : null; };
  const write = (feature: string, rel: string, content: string) => { const p = abs(feature, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content); };
  const branchOf = (cid: string) => agentTaskBranch('worker', cid);

  // The model, faked: per-sub-agent tool-call + final-text scripts. Each authoring sub-agent issues a
  // REAL write_file/edit_file; the verdict sub-agents return text only; qc-auditor runs a REAL bash in
  // the merged tree + a real write_file (redirected to the shared specs/). Mutable via setScript.
  const scripts: Record<string, SubAgentScript> = {
    'spec-author': { tools: [{ tool: 'write_file', input: { path: 'specs/00001/spec.md', content: '# Spec\nFR-001: a\nFR-002: b\n' } }], final: 'spec drafted' },
    'technical-researcher': { tools: [{ tool: 'write_file', input: { path: 'specs/00001/research.md', content: '# Research\n' } }], final: 'researched' },
    'database-administrator': { tools: [{ tool: 'write_file', input: { path: 'specs/00001/data-model.md', content: '# Data\n' } }], final: 'modeled' },
    'api-designer': { tools: [{ tool: 'write_file', input: { path: 'specs/00001/contracts/api.yaml', content: 'openapi: 3\n' } }], final: 'contracts authored' },
    'adr-author': { tools: [{ tool: 'write_file', input: { path: 'specs/00001/adrs/0001-x.md', content: '# ADR-0001\n' } }], final: 'adr recorded' },
    'plan-author': { tools: [{ tool: 'write_file', input: { path: 'specs/00001/plan.md', content: '# Plan\n' } }], final: 'planned' },
    'test-planner': { tools: [{ tool: 'write_file', input: { path: 'specs/00001/checklists/q.md', content: '- [ ] CHK001 ok?\n' } }], final: 'checklist authored' },
    'test-evaluator': { tools: [{ tool: 'edit_file', input: { path: 'specs/00001/checklists/q.md', old_string: '- [ ]', new_string: '- [X]' } }], final: 'evaluated' },
    'wbs-generator': { tools: [{ tool: 'write_file', input: { path: 'specs/00001/tasks.md', content: '- [ ] T001 {FR-001} do a\n- [ ] T002 {FR-002} do b\n' } }], final: 'tasks decomposed' },
    'policy-auditor': { tools: [], final: 'VERDICT: PASS' },
    'spec-validator': { tools: [], final: 'VERDICT: PASS' },
    'story-verifier': { tools: [], final: 'VERDICT: PASS' }
  };
  // qc-auditor is built per-call (its report + verdict depend on state.qcPass at run time).
  const qcScript = (): SubAgentScript => ({
    tools: [
      { tool: 'bash', input: { command: 'node -e "process.stdout.write(process.cwd())"' } },
      { tool: 'write_file', input: { path: 'specs/00001/qc-report.md', content: state.qcPass ? '# QC\nall pass\n' : '# QC\n[BUG:ERROR] [test-failure] boom — a.ts:1\n' } }
    ],
    final: state.qcPass ? 'VERDICT: PASS' : 'VERDICT: FAIL'
  });
  const scriptFor = (name: string): SubAgentScript => (name === 'qc-auditor' ? qcScript() : (scripts[name] ?? { tools: [], final: 'ok' }));
  const setScript = (name: string, s: SubAgentScript) => { scripts[name] = s; };

  // The REAL toolkit deps over the temp repo. SDDP mode + repoFor anchor the specs/ redirect to the
  // base repo (so a sub-agent's `specs/...` write lands in the shared tree even from a QC worktree).
  // The caller-role gates are permissive (the owner desk holds authoring roles); the SUB-AGENT role
  // gate is the real deny-list applied in the executor wrapper, exercised below.
  const baseToolDeps: AgentToolDeps = {
    enabled: () => true,
    memory: () => '',
    send: (partial, from = 'system') => ({ id: 'm1', from, to: String(partial.to), act: 'inform' } as unknown as HiveMessage),
    tasks: () => ({ tasks: [] }),
    writeTasks: () => { /* no ledger in this test */ },
    roster: () => [],
    isGod: () => false,
    canIntegrate: () => false,
    canReview: () => false,
    appendMemory: () => { /* no memory in this test */ },
    resolveCwd: () => repo,
    readRoots: () => [repo],
    repoFor: () => repo,
    sddpMode: () => true,
    bashEnabled: () => true,
    canEditCode: () => true,
    canWriteFiles: () => true
  };
  const forwarded: string[] = [];        // tool names that REACHED the real toolkit (passed the deny-list)
  const toolLog: ToolLogEntry[] = [];     // every completed tool round-trip (incl. deny-list refusals)
  const executeTool = (callerId: string, req: { toolCallId: string; toolName: string; toolInput: unknown }, cwdOverride?: string) => {
    forwarded.push(req.toolName);
    const deps: AgentToolDeps = cwdOverride
      ? { ...baseToolDeps, resolveCwd: () => cwdOverride, readRoots: (id: string) => [cwdOverride, ...(baseToolDeps.readRoots?.(id) ?? [])] }
      : baseToolDeps;
    return executeAgentTool(deps, callerId, req);
  };

  // The production spawn composition, model-faked: a deepseek caller, the scripted transport, the real
  // executor (deny-list + caller-scoped real toolkit).
  const spawn = makeSpawnSubAgent({
    providerOf: () => 'deepseek',
    modelOf: () => 'deepseek-chat',
    credentialEnvFor: () => ({ NATIVE_PROVIDER_API_KEY: 'test-key', NATIVE_PROVIDER_ID: 'deepseek' }),
    subAgentModelOverride: () => undefined,
    envNote: () => '',
    transportFactory: (childId, _env, name) => scriptedTransport(name, scriptFor(name), toolLog),
    executeTool,
    onUsage: () => { /* cost rollup not under test */ }
  });

  let tasks: HiveTask[] = [{
    id: 'epic-1', title: 'Feature 00001', assignee: 'owner', status: 'doing', dependsOn: [],
    project: repo, feature: '00001', milestones: defaultMilestones(), priority: 0, createdAt: ''
  }];
  const escalations: string[] = [];
  const doAdvance = (key: string) => {
    const i = tasks.findIndex((t) => t.id === 'epic-1');
    if (i < 0 || !tasks[i].milestones) return;
    const adv = advanceMilestones(tasks[i].milestones!, key);
    if (adv) tasks = tasks.map((t, j) => (j === i ? { ...t, milestones: adv } : t));
  };

  const deps: SddpPipelineDeps = {
    enabled: () => true,
    autopilot: () => true,
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
        writeFileSync(join(repo, `${cid}.txt`), `work ${cid}\n`); git('add', `${cid}.txt`);
        git('commit', '-m', `work ${cid}`);
        git('checkout', 'main');
      }
      tasks = [...tasks, ...cids.map((cid) => ({ id: cid, title: `T-${cid}`, assignee: 'worker', status: 'todo' as const, dependsOn: [], project: repo, branch: branchOf(cid), feature: '00001', priority: 0, createdAt: '' }))];
      return cids.length;
    },
    escalate: (_f, m) => escalations.push(m),
    askHuman: () => { /* autopilot ON — never asked */ },
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
  const drive = async ({ until = () => ms('qc') === 'done', maxIters = 40 }: { until?: () => boolean; maxIters?: number } = {}) => {
    let last = '';
    for (let i = 0; i < maxIters; i++) {
      await pipeline.advanceFeature(repo, '00001');
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

  return { pipeline, root, repo, state, abs, read, ms, drive, closeBugCards, setScript, spawn, getTasks: () => tasks, escalations, forwarded, toolLog };
}

describe('SDDP engine — full-stack composition (real runner + real toolkit + real fs/git, model faked)', () => {
  it('1. happy path: every artifact is authored by a REAL toolkit tool call; QC bash + write run cwd-overridden into the merged tree; .qc-passed lands', async () => {
    const h = setupFullStack();
    expect(await h.drive()).toBe(true);

    // The pipeline completed — every milestone done, no escalations.
    expect(h.getTasks()[0].milestones!.every((m) => m.status === 'done')).toBe(true);
    expect(h.escalations).toHaveLength(0);

    // The artifacts exist BECAUSE the real toolkit wrote them (the engine never wrote spec/plan/tasks).
    expect(h.read('00001', 'spec.md')).toMatch(/FR-001/);
    expect(h.read('00001', 'plan.md')).toMatch(/# Plan/);
    expect(h.read('00001', 'tasks.md')).toMatch(/\{FR-002\}/);

    // Real write_file/edit_file actually reached the toolkit (deny-list let the authors through).
    const writes = h.toolLog.filter((e) => e.toolName === 'write_file' && e.success);
    expect(writes.some((e) => e.agent === 'spec-author')).toBe(true);
    expect(writes.some((e) => e.agent === 'wbs-generator')).toBe(true);
    expect(h.toolLog.some((e) => e.agent === 'test-evaluator' && e.toolName === 'edit_file' && e.success)).toBe(true);

    // The checklist was flipped by a REAL edit_file ([ ] → [X]) — so the checklist gate passed on real state.
    expect(h.read('00001', 'checklists/q.md')).toMatch(/- \[X\] CHK001/);

    // QC: the qc-auditor's bash ran with cwd OVERRIDDEN into the merged worktree (process.cwd() proves it)…
    const qcBash = h.toolLog.find((e) => e.agent === 'qc-auditor' && e.toolName === 'bash');
    expect(qcBash?.success).toBe(true);
    expect(qcBash?.content).toMatch(/qc-worktrees/);
    // …and its qc-report.md was REDIRECTED to the shared base specs/ (anchored to repoFor, not the tree).
    expect(h.read('00001', 'qc-report.md')).toMatch(/all pass/);
    // The engine wrote .qc-passed after both verdicts passed.
    expect(existsSync(h.abs('00001', '.qc-passed'))).toBe(true);
    expect(h.ms('qc')).toBe('done');
  });

  it('2. deny-list composes: a sub-agent\'s spawn_subagent + hive_integrate are refused by the executor BEFORE the toolkit; allowed tools still run', async () => {
    const h = setupFullStack();
    h.setScript('plan-author', { tools: [
      { tool: 'spawn_subagent', input: { name: 'spec-author', input: 'recurse' } },  // hard-denied (no nesting)
      { tool: 'hive_integrate', input: { branch: 'x', apply: true } },               // hard-denied (no merge)
      { tool: 'write_file', input: { path: 'specs/00001/plan.md', content: '# Plan\n' } }  // allowed (planner authors)
    ], final: 'done' });

    const res = await h.spawn('owner', 'plan-author', 'go');
    expect(res.success).toBe(true);

    // The two forbidden tools were refused IN THE EXECUTOR — never forwarded to the real toolkit.
    const refusals = h.toolLog.filter((e) => /a sub-agent may not call/.test(e.content) && !e.success);
    expect(refusals.map((e) => e.toolName).sort()).toEqual(['hive_integrate', 'spawn_subagent']);
    expect(h.forwarded).not.toContain('spawn_subagent');
    expect(h.forwarded).not.toContain('hive_integrate');
    // The allowed write_file DID reach the toolkit and really wrote the file.
    expect(h.forwarded).toContain('write_file');
    expect(h.read('00001', 'plan.md')).toMatch(/# Plan/);
  });

  it('3. QC FAIL via the real stack: a real bash + a real qc-report write, a FAIL verdict ⇒ no .qc-passed + a [BUG] card is filed', async () => {
    const h = setupFullStack({ qcPass: false });
    await h.drive({ until: () => h.getTasks().some((t) => /\[BUG/i.test(t.title)) });

    // QC ran the real sub-agent stack in the tree, FAILED, and the engine filed a bug card.
    expect(h.toolLog.some((e) => e.agent === 'qc-auditor' && e.toolName === 'bash' && e.success)).toBe(true);
    expect(h.read('00001', 'qc-report.md')).toMatch(/\[BUG:ERROR\]/);
    expect(existsSync(h.abs('00001', '.qc-passed'))).toBe(false);
    expect(h.ms('qc')).toBe('active');
    const bugs = h.getTasks().filter((t) => /\[BUG/i.test(t.title));
    expect(bugs).toHaveLength(1);

    // Close the bug + flip to PASS → the real QC stack re-runs and lands .qc-passed.
    h.closeBugCards(); h.state.qcPass = true;
    await h.pipeline.advanceFeature(h.repo, '00001');
    expect(existsSync(h.abs('00001', '.qc-passed'))).toBe(true);
    expect(h.ms('qc')).toBe('done');
  });
});
