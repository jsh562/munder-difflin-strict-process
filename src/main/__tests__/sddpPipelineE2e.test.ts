/**
 * SDDP host-driven engine — EXHAUSTIVE end-to-end against REAL git + REAL fs (no electron, no LLM).
 *
 * Every other engine test FAKES git.ts + fs; this suite wires the REAL `prepareQcTree`/`mergeBranch`
 * (actual `git worktree add` + merges) + real file gating + real `analyzeCoverage` + the real bug-task
 * grammar helpers, against a throwaway `git init` repo in `os.tmpdir`, driven by a SCRIPTED (no-API)
 * provider. It exercises EVERY engine path: the happy path through integrate-to-trunk, a real merge
 * conflict, the full bug loop (fail→fix→re-QC→pass, with [RECURRING]), analyze CRITICAL + recover,
 * optional-step skip, autopilot-OFF clarify, and the per-step control / no-owner / idempotent /
 * in-flight-lock branches — each in its own temp repo, deleted after. Requires `git` on PATH.
 *
 * NOT covered (inherently un-automatable — see docs/sddp-smoke.md): the live model, the native worker,
 * the sub-agent cwd-override, IPC/UI, the god-creates-epic + integrate-desk flows. The integrate step
 * here is a SIMULATED `mergeBranch`, not the notifier/integrator path.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { SddpPipeline, type SddpPipelineDeps } from '../sddpPipeline';
import { prepareQcTree as gitPrepareQcTree, repoTrunk, mergeBranch } from '../git';
import { defaultMilestones, advanceMilestones, analyzeCoverage, agentTaskBranch, buildBugTitles, bugSignature, type HiveTask, type FeatureMilestone } from '@jsh562/won-agent-core';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) { try { rmSync(r, { recursive: true, force: true }); } catch { /* best-effort */ } } });

function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }

interface E2EOpts { qcPass?: boolean; autopilot?: boolean; uncovered?: boolean; skipOptional?: boolean; conflict?: boolean; ownerUsable?: boolean; plannerDesk?: string | null; }

/** A throwaway git repo + a fully-real-deps engine driven by a scripted provider. Flags on `state` are
 *  mutable so a test can change behavior mid-run (e.g. flip qcPass for the bug loop, release the gate). */
function setupE2E(opts: E2EOpts = {}) {
  const state = {
    qcPass: opts.qcPass !== false,
    autopilot: opts.autopilot !== false,
    uncovered: !!opts.uncovered,
    skipOptional: !!opts.skipOptional,
    conflict: !!opts.conflict,
    ownerUsable: opts.ownerUsable !== false,
    plannerDesk: opts.plannerDesk ?? null,
    gate: null as Promise<void> | null
  };
  const root = mkdtempSync(join(tmpdir(), 'sddp-e2e-'));
  roots.push(root);
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('-c', 'init.defaultBranch=main', 'init');
  git('config', 'user.email', 'e2e@test'); git('config', 'user.name', 'E2E');
  writeFileSync(join(repo, 'README.md'), '# scratch\n');
  git('add', '.'); git('commit', '-m', 'init');
  if (state.conflict) { writeFileSync(join(repo, 'shared.txt'), 'base\n'); git('add', 'shared.txt'); git('commit', '-m', 'base'); }

  const abs = (feature: string, rel: string) => join(repo, 'specs', feature, rel);
  const write = (feature: string, rel: string, content: string) => { const p = abs(feature, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content); };
  const read = (feature: string, rel: string) => { const p = abs(feature, rel); return existsSync(p) ? readFileSync(p, 'utf8') : null; };
  const branchOf = (cid: string) => agentTaskBranch('worker', cid);

  let tasks: HiveTask[] = [{
    id: 'epic-1', title: 'Feature 00001', assignee: 'owner', status: 'doing', dependsOn: [],
    project: repo, feature: '00001', milestones: defaultMilestones(), priority: 0, createdAt: ''
  }];
  const spawns: string[] = [];
  const treeSpawns: string[] = [];
  const escalations: string[] = [];
  const asks: string[] = [];
  const assigns: { cardId: string; deskId: string }[] = [];
  const removedTrees: string[] = [];
  let qcResult: { ok: boolean; merged: string[]; conflicts: string[] } | null = null;

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
    ownerUsable: () => state.ownerUsable,
    findDeskForRole: (role) => (role === 'planner' ? state.plannerDesk : null),
    assignCard: (cardId, deskId) => { assigns.push({ cardId, deskId }); tasks = tasks.map((t) => (t.id === cardId ? { ...t, assignee: deskId } : t)); },
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
    spawnSubAgent: async (_caller, name, _input, signal) => {
      spawns.push(name);
      if (state.gate) await new Promise<void>((res) => { signal?.addEventListener('abort', () => res(), { once: true }); state.gate!.then(res, res); });
      if (signal?.aborted) return { content: '(aborted)', success: false };
      switch (name) {
        case 'spec-author': write('00001', 'spec.md', '# Spec\nFR-001: a\nFR-002: b\n'); break;
        case 'technical-researcher': if (!state.skipOptional) write('00001', 'research.md', '# Research\n'); break;
        case 'database-administrator': if (!state.skipOptional) write('00001', 'data-model.md', '# Data\n'); break;
        case 'api-designer': if (!state.skipOptional) write('00001', 'contracts/api.yaml', 'openapi: 3\n'); break;
        case 'adr-author': if (!state.skipOptional) write('00001', 'adrs/0001-x.md', '# ADR-0001\n'); break;
        case 'plan-author': write('00001', 'plan.md', '# Plan\n'); break;
        case 'test-planner': write('00001', 'checklists/q.md', '- [ ] CHK001 ok?\n'); break;
        case 'wbs-generator': write('00001', 'tasks.md', state.uncovered ? '- [ ] T001 {FR-001} do a\n' : '- [ ] T001 {FR-001} do a\n- [ ] T002 {FR-002} do b\n'); break;
        case 'test-evaluator': { const p = abs('00001', 'checklists/q.md'); if (existsSync(p)) writeFileSync(p, readFileSync(p, 'utf8').replace(/- \[ \]/g, '- [X]')); break; }
        case 'policy-auditor': return { content: 'VERDICT: PASS', success: true };
        case 'spec-validator': return { content: 'VERDICT: PASS', success: true };
      }
      return { content: 'ok', success: true };
    },
    prepareQcTree: async () => {
      const branches = [...new Set(tasks.filter((t) => t.feature === '00001' && t.id !== 'epic-1' && t.branch && !/\[BUG/i.test(t.title)).map((t) => t.branch!))];
      const base = await repoTrunk(repo);
      const path = join(root, 'qc-worktrees', '00001');
      const res = await gitPrepareQcTree(repo, path, base, branches);
      qcResult = { ok: res.ok, merged: res.merged, conflicts: res.conflicts };
      return { ok: res.ok, path: res.ok ? path : null, conflicts: res.conflicts };
    },
    removeQcTree: (p) => { try { git('worktree', 'remove', '--force', p); } catch { /* */ } try { rmSync(p, { recursive: true, force: true }); } catch { /* */ } removedTrees.push(p); },
    spawnSubAgentInTree: async (_caller, name) => {
      treeSpawns.push(name);
      if (name === 'qc-auditor') { write('00001', 'qc-report.md', state.qcPass ? '# QC\nall pass\n' : '# QC\n[BUG:ERROR] [test-failure] boom — a.ts:1\n'); return { content: state.qcPass ? 'VERDICT: PASS' : 'VERDICT: FAIL', success: true }; }
      if (name === 'story-verifier') return { content: 'VERDICT: PASS', success: true };
      return { content: 'ok', success: true };
    },
    sddpPolicy: () => ({ qcStrictness: 'standard', maxQcIterations: 10 }),
    // Real bug-task grammar: recurrence via prior [BUG signatures + attempt-driven tags (buildBugTitles).
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
  const setControl = (key: string, control: NonNullable<FeatureMilestone['control']>) => {
    tasks = tasks.map((t) => (t.id === 'epic-1' && t.milestones ? { ...t, milestones: t.milestones.map((m) => (m.key === key ? { ...m, control } : m)) } : t));
  };
  const closeBugCards = () => { tasks = tasks.map((t) => (/\[BUG/i.test(t.title) && t.status !== 'done' ? { ...t, status: 'done' as const } : t)); };
  const trace = !!process.env.SDDP_E2E_TRACE;       // set SDDP_E2E_TRACE=1 for a per-milestone step trace
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
  return { pipeline, root, repo, state, git, abs, read, write, ms, setControl, closeBugCards, drive, operatorAdvance: doAdvance, getTasks: () => tasks, spawns, treeSpawns, escalations, asks, assigns, removedTrees, qc: () => qcResult };
}

describe('SDDP engine — exhaustive real-git/fs end-to-end', () => {
  it('1. happy path → integrate-to-trunk: full run to .qc-passed, then merges the branches into main', async () => {
    const h = setupE2E();
    expect(await h.drive()).toBe(true);
    expect(h.getTasks()[0].milestones!.every((m) => m.status === 'done')).toBe(true);
    expect(h.read('00001', 'analysis-report.md')).toMatch(/critical:\s*0/);
    expect(existsSync(h.abs('00001', '.qc-passed'))).toBe(true);
    expect(h.treeSpawns.sort()).toEqual(['qc-auditor', 'story-verifier']);
    expect(h.qc()?.merged).toHaveLength(2);
    expect(existsSync(join(h.root, 'qc-worktrees', '00001'))).toBe(false);
    expect(h.escalations).toHaveLength(0);
    // simulate the integrator: merge each implement branch into trunk
    for (const t of h.getTasks().filter((t) => t.branch && t.id !== 'epic-1' && !/\[BUG/i.test(t.title))) {
      const m = await mergeBranch(h.repo, t.branch!);
      expect(m.ok).toBe(true);
    }
    expect(existsSync(join(h.repo, 'c1.txt'))).toBe(true);
    expect(existsSync(join(h.repo, 'c2.txt'))).toBe(true);
  });

  it('2. merge CONFLICT: QC escalates, no .qc-passed, never runs the QC sub-agents, tree torn down', async () => {
    const h = setupE2E({ conflict: true });
    await h.drive({ until: () => h.escalations.some((m) => /conflict/i.test(m)) });
    expect(h.escalations.some((m) => /conflict/i.test(m))).toBe(true);
    expect(existsSync(h.abs('00001', '.qc-passed'))).toBe(false);
    expect(h.ms('qc')).toBe('active');
    expect(h.qc()?.conflicts.length).toBeGreaterThan(0);
    expect(h.treeSpawns).toHaveLength(0);
    expect(existsSync(join(h.root, 'qc-worktrees', '00001'))).toBe(false);
  });

  it('3. full bug loop: FAIL→wait→close→re-QC FAIL ([RECURRING])→close→re-QC PASS→.qc-passed', async () => {
    const h = setupE2E({ qcPass: false });
    await h.drive({ until: () => h.getTasks().some((t) => /\[BUG/i.test(t.title)) });
    expect(h.getTasks().filter((t) => /\[BUG/i.test(t.title))).toHaveLength(1);
    expect(h.getTasks().find((t) => /\[BUG/i.test(t.title))!.title).not.toMatch(/\[RECURRING\]/);

    const treeRunsBefore = h.treeSpawns.length;
    await h.pipeline.advanceFeature(h.repo, '00001');                 // bug open → engine WAITS
    expect(h.treeSpawns.length).toBe(treeRunsBefore);

    h.closeBugCards();
    await h.pipeline.advanceFeature(h.repo, '00001');                 // re-QC (attempt 2) → FAIL again
    const bugs = h.getTasks().filter((t) => /\[BUG/i.test(t.title));
    expect(bugs).toHaveLength(2);
    expect(bugs[1].title).toMatch(/\[RECURRING\]/);                   // same finding came back

    h.closeBugCards(); h.state.qcPass = true;
    await h.pipeline.advanceFeature(h.repo, '00001');                 // re-QC → PASS
    expect(existsSync(h.abs('00001', '.qc-passed'))).toBe(true);
    expect(h.ms('qc')).toBe('done');
  });

  it('4. Analyze CRITICAL → recover: uncovered req holds, then fix+delete-report re-analyzes clean', async () => {
    const h = setupE2E({ uncovered: true, autopilot: false });
    await h.drive({ answerClarify: true, until: () => h.escalations.some((m) => /CRITICAL/i.test(m)) });
    expect(h.read('00001', 'analysis-report.md')).toMatch(/critical:\s*1/);
    expect(h.ms('analyze')).toBe('active');

    h.write('00001', 'tasks.md', '- [ ] T001 {FR-001} do a\n- [ ] T002 {FR-002} do b\n'); // cover FR-002
    rmSync(h.abs('00001', 'analysis-report.md'));                     // allow re-analysis
    await h.pipeline.advanceFeature(h.repo, '00001');
    expect(h.read('00001', 'analysis-report.md')).toMatch(/critical:\s*0/);
    expect(h.ms('analyze')).toBe('done');
  });

  it('5. optional-step skip: research/data-model/contracts/adrs advance with NO artifact', async () => {
    const h = setupE2E({ skipOptional: true });
    expect(await h.drive()).toBe(true);
    for (const k of ['research', 'data-model', 'contracts', 'adrs']) expect(h.ms(k)).toBe('done');
    expect(existsSync(h.abs('00001', 'research.md'))).toBe(false);
    expect(existsSync(h.abs('00001', 'data-model.md'))).toBe(false);
    expect(existsSync(h.abs('00001', '.qc-passed'))).toBe(true);
  });

  it('6. Clarify autopilot OFF: requirements-scanner asks the human + HOLDS; operator-advance continues', async () => {
    const h = setupE2E({ autopilot: false });
    await h.drive({ until: () => h.asks.length > 0 });
    expect(h.ms('clarify')).toBe('active');                           // held, awaiting answers
    expect(h.spawns).toContain('requirements-scanner');
    h.operatorAdvance('clarify');                                     // operator answers + advances
    expect(await h.drive({ answerClarify: true })).toBe(true);
    expect(h.ms('qc')).toBe('done');
  });

  it('7. control=paused: the engine neither runs nor advances', async () => {
    const h = setupE2E();
    h.setControl('spec', 'paused');
    await h.pipeline.advanceFeature(h.repo, '00001');
    expect(h.spawns).toHaveLength(0);
    expect(h.ms('spec')).toBe('active');
  });

  it('8. control=manual: engine skips the run; advances when a desk writes the artifact', async () => {
    const h = setupE2E();
    h.setControl('spec', 'manual');
    await h.pipeline.advanceFeature(h.repo, '00001');
    expect(h.spawns).toHaveLength(0);
    expect(h.ms('spec')).toBe('active');
    h.write('00001', 'spec.md', '# Spec\nFR-001: a\n');               // a desk/human authored it
    await h.pipeline.advanceFeature(h.repo, '00001');
    expect(h.ms('spec')).toBe('done');
  });

  it('9. control=stopped: aborts the in-flight sub-agent run + holds (no artifact, no advance)', async () => {
    const h = setupE2E();
    const g = deferred(); h.state.gate = g.promise;
    const p = h.pipeline.advanceFeature(h.repo, '00001');             // spec spawn hangs on the gate
    await Promise.resolve();
    h.setControl('spec', 'stopped');
    await h.pipeline.advanceFeature(h.repo, '00001');                 // sees stopped → aborts the in-flight run
    g.resolve();
    await p;
    expect(existsSync(h.abs('00001', 'spec.md'))).toBe(false);        // aborted before writing
    expect(h.ms('spec')).toBe('active');                              // not advanced
  });

  it('10. no usable owner: escalates with no planner; auto-assigns the epic when a planner exists', async () => {
    const h = setupE2E({ ownerUsable: false, plannerDesk: null });
    await h.pipeline.advanceFeature(h.repo, '00001');
    expect(h.spawns).toHaveLength(0);
    expect(h.escalations.length).toBeGreaterThan(0);

    const h2 = setupE2E({ ownerUsable: false, plannerDesk: 'pam' });
    await h2.pipeline.advanceFeature(h2.repo, '00001');
    expect(h2.assigns.some((a) => a.deskId === 'pam')).toBe(true);
  });

  it('11. idempotent: an existing .qc-passed advances qc without building a tree', async () => {
    const h = setupE2E();
    await h.drive({ until: () => h.ms('qc') === 'active' });
    h.write('00001', '.qc-passed', '');                              // marker already present
    await h.pipeline.advanceFeature(h.repo, '00001');
    expect(h.ms('qc')).toBe('done');
    expect(h.qc()).toBeNull();                                       // prepareQcTree never ran
  });

  it('12. in-flight lock: two concurrent advances on the same step ⇒ exactly one spawn', async () => {
    const h = setupE2E();
    const g = deferred(); h.state.gate = g.promise;
    const p1 = h.pipeline.advanceFeature(h.repo, '00001');
    await Promise.resolve();
    const p2 = h.pipeline.advanceFeature(h.repo, '00001');           // locked out
    g.resolve();
    await Promise.all([p1, p2]);
    expect(h.spawns.filter((n) => n === 'spec-author')).toHaveLength(1);
  });
});
