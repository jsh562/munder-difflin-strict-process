/**
 * SDDP host-driven engine — END-TO-END against REAL git + REAL fs (no electron, no LLM, no API).
 *
 * Every other engine test FAKES git.ts + fs; this one wires the REAL `prepareQcTree` (an actual
 * `git worktree add` + merges) + real file gating + real `analyzeCoverage`, against a throwaway
 * `git init` repo in `os.tmpdir`, driven by a SCRIPTED provider that writes the artifacts a sub-agent
 * would. It runs the whole lifecycle spec→clarify→…→analyze→implement→host-QC and asserts the
 * milestones chain, `.qc-passed` lands, and the QC integration worktree really merges the implement
 * branches — then deletes the temp dir. Nothing permanent is created. Requires `git` on PATH.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { SddpPipeline, type SddpPipelineDeps } from '../sddpPipeline';
import { prepareQcTree as gitPrepareQcTree, repoTrunk } from '../git';
import { defaultMilestones, advanceMilestones, analyzeCoverage, agentTaskBranch, type HiveTask } from '@jsh562/won-agent-core';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) { try { rmSync(r, { recursive: true, force: true }); } catch { /* best-effort */ } } });

/** A throwaway git repo + a fully-real-deps engine driven by a scripted (no-API) provider. */
function setupE2E(opts: { qcPass?: boolean } = {}) {
  const qcPass = opts.qcPass !== false;
  const root = mkdtempSync(join(tmpdir(), 'sddp-e2e-'));
  roots.push(root);
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('-c', 'init.defaultBranch=main', 'init');
  git('config', 'user.email', 'e2e@test'); git('config', 'user.name', 'E2E');
  writeFileSync(join(repo, 'README.md'), '# scratch\n');
  git('add', '.'); git('commit', '-m', 'init');

  const abs = (feature: string, rel: string) => join(repo, 'specs', feature, rel);
  const write = (feature: string, rel: string, content: string) => { const p = abs(feature, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content); };
  const read = (feature: string, rel: string) => { const p = abs(feature, rel); return existsSync(p) ? readFileSync(p, 'utf8') : null; };

  let tasks: HiveTask[] = [{
    id: 'epic-1', title: 'Feature 00001', assignee: 'owner', status: 'doing', dependsOn: [],
    project: repo, feature: '00001', milestones: defaultMilestones(), priority: 0, createdAt: ''
  }];
  const spawns: string[] = [];
  const treeSpawns: string[] = [];
  const escalations: string[] = [];
  const asks: string[] = [];
  let qcResult: { ok: boolean; merged: string[]; conflicts: string[] } | null = null;
  const removedTrees: string[] = [];
  const branchOf = (cid: string) => agentTaskBranch('worker', cid);

  const deps: SddpPipelineDeps = {
    enabled: () => true,
    autopilot: () => true, // run unattended past the Clarify human-gate
    listTasks: () => tasks,
    repoForEpic: () => repo,
    ownerUsable: () => true,
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
    advanceMilestone: (epicId, key) => {
      const i = tasks.findIndex((t) => t.id === epicId);
      if (i < 0 || !tasks[i].milestones) return;
      const adv = advanceMilestones(tasks[i].milestones!, key);
      if (adv) tasks = tasks.map((t, j) => (j === i ? { ...t, milestones: adv } : t));
    },
    seedImplementCards: () => {
      // Create real branches off main with a commit each (so the QC tree has something to merge).
      const cids = ['c1', 'c2'];
      for (const cid of cids) {
        const br = branchOf(cid);
        git('checkout', '-b', br, 'main');
        writeFileSync(join(repo, `${cid}.txt`), `work ${cid}\n`);
        git('add', `${cid}.txt`); git('commit', '-m', `work ${cid}`); // ONLY the work file — leave specs/ untracked so `checkout main` doesn't delete them
        git('checkout', 'main');
      }
      tasks = [...tasks, ...cids.map((cid) => ({ id: cid, title: `T-${cid}`, assignee: 'worker', status: 'todo' as const, dependsOn: [], project: repo, branch: branchOf(cid), feature: '00001', priority: 0, createdAt: '' }))];
      return cids.length;
    },
    escalate: (_f, m) => escalations.push(m),
    askHuman: (_f, q) => asks.push(q),
    // Scripted provider: write the artifact each specialist would produce.
    spawnSubAgent: async (_caller, name) => {
      spawns.push(name);
      switch (name) {
        case 'spec-author': write('00001', 'spec.md', '# Spec\nFR-001: a\nFR-002: b\n'); break;
        case 'technical-researcher': write('00001', 'research.md', '# Research\n'); break;
        case 'database-administrator': write('00001', 'data-model.md', '# Data\n'); break;
        case 'api-designer': write('00001', 'contracts/api.yaml', 'openapi: 3\n'); break;
        case 'adr-author': write('00001', 'adrs/0001-x.md', '# ADR-0001\n'); break;
        case 'plan-author': write('00001', 'plan.md', '# Plan\n'); break;
        case 'test-planner': write('00001', 'checklists/q.md', '- [ ] CHK001 ok?\n- [ ] CHK002 ok?\n'); break;
        case 'wbs-generator': write('00001', 'tasks.md', '- [ ] T001 {FR-001} do a\n- [ ] T002 {FR-002} do b\n'); break;
        case 'test-evaluator': { const p = abs('00001', 'checklists/q.md'); if (existsSync(p)) writeFileSync(p, readFileSync(p, 'utf8').replace(/- \[ \]/g, '- [X]')); break; }
        case 'policy-auditor': return { content: 'VERDICT: PASS', success: true };
        case 'spec-validator': return { content: 'VERDICT: PASS', success: true };
      }
      return { content: 'ok', success: true };
    },
    prepareQcTree: async () => {
      const branches = [...new Set(tasks.filter((t) => t.feature === '00001' && t.id !== 'epic-1' && t.branch).map((t) => t.branch!))];
      const base = await repoTrunk(repo);
      const path = join(root, 'qc-worktrees', '00001');
      const res = await gitPrepareQcTree(repo, path, base, branches);
      qcResult = { ok: res.ok, merged: res.merged, conflicts: res.conflicts };
      return { ok: res.ok, path: res.ok ? path : null, conflicts: res.conflicts };
    },
    removeQcTree: (p) => { try { git('worktree', 'remove', '--force', p); } catch { /* */ } try { rmSync(p, { recursive: true, force: true }); } catch { /* */ } removedTrees.push(p); },
    spawnSubAgentInTree: async (_caller, name) => {
      treeSpawns.push(name);
      if (name === 'qc-auditor') { write('00001', 'qc-report.md', qcPass ? '# QC\nall pass\n' : '# QC\n[BUG:ERROR] [test-failure] boom — a.ts:1\n'); return { content: qcPass ? 'VERDICT: PASS' : 'VERDICT: FAIL', success: true }; }
      if (name === 'story-verifier') return { content: 'VERDICT: PASS', success: true };
      return { content: 'ok', success: true };
    },
    sddpPolicy: () => ({ qcStrictness: 'standard', maxQcIterations: 10 }),
    seedBugCards: (_epic, _report, _attempt) => { tasks = [...tasks, { id: `bug-${tasks.length}`, title: '[BUG:ERROR] [test-failure] boom — a.ts:1', assignee: 'worker', status: 'todo', dependsOn: [], project: repo, feature: '00001', priority: 1, createdAt: '' }]; return 1; },
    openBugCards: () => tasks.filter((t) => t.feature === '00001' && t.status !== 'done' && /\[BUG/i.test(t.title)).length,
    debounceMs: 0
  };

  const pipeline = new SddpPipeline(deps);
  const ms = (key: string) => tasks[0].milestones!.find((m) => m.key === key)!.status;
  return { pipeline, root, repo, abs, read, ms, getTasks: () => tasks, spawns, treeSpawns, escalations, asks, removedTrees, qc: () => qcResult };
}

describe('SDDP engine — real-git/fs end-to-end (temp repo, scripted provider)', () => {
  it('drives spec→…→analyze→implement→host-QC to .qc-passed, merging real branches, leaving nothing', async () => {
    const h = setupE2E({ qcPass: true });
    for (let i = 0; i < 30; i++) {
      await h.pipeline.advanceFeature(h.repo, '00001');
      // simulate workers finishing: once implement cards exist, drop the .completed marker.
      const hasImpl = h.getTasks().some((t) => t.feature === '00001' && t.id !== 'epic-1' && !(t.milestones?.length) && !/\[BUG/i.test(t.title));
      if (hasImpl && !existsSync(h.abs('00001', '.completed'))) writeFileSync(h.abs('00001', '.completed'), '');
      if (h.ms('qc') === 'done') break;
    }

    // every milestone advanced
    expect(h.getTasks()[0].milestones!.every((m) => m.status === 'done')).toBe(true);
    // analyze ran the real coverage + validators → clean report
    expect(h.read('00001', 'analysis-report.md')).toMatch(/critical:\s*0/);
    expect(h.spawns).toEqual(expect.arrayContaining(['policy-auditor', 'spec-validator', 'wbs-generator', 'test-evaluator']));
    // host-driven QC produced the marker, ran both QC sub-agents in the tree, merged the real branches
    expect(existsSync(h.abs('00001', '.qc-passed'))).toBe(true);
    expect(h.treeSpawns.sort()).toEqual(['qc-auditor', 'story-verifier']);
    expect(h.qc()?.conflicts).toEqual([]);
    expect(h.qc()?.merged).toHaveLength(2);
    // the QC integration worktree was created then torn down (nothing left behind)
    expect(existsSync(join(h.root, 'qc-worktrees', '00001'))).toBe(false);
    expect(h.escalations).toHaveLength(0);
    expect(h.asks).toHaveLength(0);
  });

  it('a QC FAIL holds at qc, writes no .qc-passed, and files a [BUG] card (the bug loop)', async () => {
    const h = setupE2E({ qcPass: false });
    for (let i = 0; i < 30; i++) {
      await h.pipeline.advanceFeature(h.repo, '00001');
      const hasImpl = h.getTasks().some((t) => t.feature === '00001' && t.id !== 'epic-1' && !(t.milestones?.length) && !/\[BUG/i.test(t.title));
      if (hasImpl && !existsSync(h.abs('00001', '.completed'))) writeFileSync(h.abs('00001', '.completed'), '');
      if (h.ms('implement') === 'done') break; // reach qc, let it fail once
    }
    await h.pipeline.advanceFeature(h.repo, '00001'); // qc runs → FAIL

    expect(existsSync(h.abs('00001', '.qc-passed'))).toBe(false);
    expect(h.ms('qc')).toBe('active'); // held, not advanced
    expect(h.getTasks().some((t) => /\[BUG/i.test(t.title))).toBe(true); // bug card filed
    expect(existsSync(join(h.root, 'qc-worktrees', '00001'))).toBe(false); // tree still torn down
  });
});
