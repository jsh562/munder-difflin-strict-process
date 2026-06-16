/**
 * Host-driven SDDP engine — drives a feature epic's active HOST milestone via a fake sub-agent
 * runtime + fake artifact scan + fake ledger (no electron, no real LLM). Verifies: it runs the
 * active step's specialist, advances ONLY after the gate artifact lands, skips an optional step
 * that produces nothing, leaves desk steps alone, escalates (no run) for an unusable owner, and
 * the in-flight lock prevents a double-run.
 */
import { describe, it, expect } from 'vitest';
import { SddpPipeline, buildStepInput, type SddpPipelineDeps } from '../sddpPipeline';
import { defaultMilestones, advanceMilestones, type HiveTask, type FeatureMilestone } from '@jsh562/won-agent-core';

function epicWith(activeKey: string, assignee = 'dwight'): HiveTask {
  const milestones: FeatureMilestone[] = defaultMilestones().map((m) => ({
    ...m,
    status: m.key === activeKey ? 'active' : 'pending'
  }));
  return { id: 'epic-1', title: 'Feature 00001', assignee, status: 'doing', dependsOn: [], project: 'S:/repo', feature: '00001', milestones, priority: 0, createdAt: '' };
}

function mkPipeline(opts: { hostQc?: boolean } = {}) {
  let tasks: HiveTask[] = [];
  const artifacts = new Set<string>();           // `${feature}/${relPath}` present on "disk"
  const spawns: { caller: string; name: string; input: string; signal?: AbortSignal }[] = [];
  const escalations: { feature: string; message: string }[] = [];
  const asks: { feature: string; questions: string }[] = [];
  const seeds: string[] = [];                     // epic ids the engine asked to seed cards for
  const assigns: { cardId: string; deskId: string }[] = [];
  const removedTrees: string[] = [];              // qc trees torn down
  const bugSeeds: string[] = [];                  // qc-fail reports passed to seedBugCards
  const artifactText = new Map<string, string>(); // `${feature}/${rel}` → text (analyze read/write)
  const state = { enabled: true, ownerUsable: true, autopilot: false, seedCount: 2, plannerDesk: null as string | null, uncovered: [] as string[], policyVerdict: 'PASS' as 'PASS' | 'FAIL', checklist: { total: 0, checked: 0 }, qcConflicts: [] as string[], qcAuditorPass: true, storyPass: true, bugCount: 0 };
  let onSpawn: (name: string) => void = () => {}; // simulate what a sub-agent writes
  let gate: Promise<void> | null = null;          // optional latch to hold a spawn open (lock test)

  const deps: SddpPipelineDeps = {
    enabled: () => state.enabled,
    autopilot: () => state.autopilot,
    listTasks: () => tasks,
    repoForEpic: () => 'S:/repo',
    ownerUsable: () => state.ownerUsable,
    featureArtifactExists: (_r, feature, rel) => artifacts.has(`${feature}/${rel}`),
    spawnSubAgent: async (caller, name, input, signal) => {
      spawns.push({ caller, name, input, signal });
      if (gate) await gate;
      onSpawn(name);
      const content = name === 'policy-auditor' ? `VERDICT: ${state.policyVerdict}` : 'ok';
      return { content, success: true };
    },
    analyzeFeature: () => ({ uncovered: state.uncovered }),
    featureArtifactText: (_r, feature, rel) => artifactText.get(`${feature}/${rel}`) ?? null,
    writeFeatureArtifact: (_r, feature, rel, content) => { artifactText.set(`${feature}/${rel}`, content); artifacts.add(`${feature}/${rel}`); },
    checklistStatus: () => state.checklist,
    findDeskForRole: (role) => (role === 'planner' ? state.plannerDesk : null),
    assignCard: (cardId, deskId) => { assigns.push({ cardId, deskId }); },
    advanceMilestone: (epicId, key) => {
      const i = tasks.findIndex((t) => t.id === epicId);
      if (i < 0 || !tasks[i].milestones) return;
      const adv = advanceMilestones(tasks[i].milestones!, key);
      if (adv) tasks = tasks.map((t, j) => (j === i ? { ...t, milestones: adv } : t));
    },
    escalate: (feature, message) => escalations.push({ feature, message }),
    askHuman: (feature, questions) => asks.push({ feature, questions }),
    seedImplementCards: (epic) => {
      seeds.push(epic.id);
      for (let i = 0; i < state.seedCount; i++) {
        tasks = [...tasks, { id: `t-impl-${i}`, title: `task ${i}`, status: 'todo', dependsOn: [], feature: epic.feature, priority: 0, createdAt: '' } as HiveTask];
      }
      return state.seedCount;
    },
    debounceMs: 0
  };
  // Host-driven QC deps are OPT-IN: present ⇒ qc routes to runQc; absent ⇒ qc feed-tracks (default).
  if (opts.hostQc) {
    deps.prepareQcTree = async () => ({ ok: state.qcConflicts.length === 0 ? true : true, path: 'S:/qc/00001', conflicts: state.qcConflicts });
    deps.removeQcTree = (p) => { removedTrees.push(p); };
    deps.spawnSubAgentInTree = async (caller, name, input, _tree, signal) => {
      spawns.push({ caller, name, input, signal });
      onSpawn(name);
      const pass = name === 'qc-auditor' ? state.qcAuditorPass : name === 'story-verifier' ? state.storyPass : true;
      return { content: `VERDICT: ${pass ? 'PASS' : 'FAIL'}`, success: true };
    };
    deps.sddpPolicy = () => ({ qcStrictness: 'standard', maxQcIterations: 10 });
    deps.seedBugCards = (_epic, report) => { bugSeeds.push(report); return state.bugCount; };
  }

  const pipeline = new SddpPipeline(deps);
  return {
    pipeline, artifacts, spawns, escalations, asks, seeds, assigns, state, artifactText, removedTrees, bugSeeds,
    setTasks: (t: HiveTask[]) => { tasks = t; },
    getTasks: () => tasks,
    setOnSpawn: (fn: (name: string) => void) => { onSpawn = fn; },
    setGate: (g: Promise<void> | null) => { gate = g; }
  };
}

const milestone = (t: HiveTask, key: string) => t.milestones!.find((m) => m.key === key)!;
const withControl = (epic: HiveTask, key: string, control: NonNullable<FeatureMilestone['control']>): HiveTask =>
  ({ ...epic, milestones: epic.milestones!.map((m) => (m.key === key ? { ...m, control } : m)) });

describe('SddpPipeline.advanceFeature', () => {
  it('runs the active host step\'s sub-agent, then advances after the gate artifact lands + activates the next', async () => {
    const h = mkPipeline();
    h.setTasks([epicWith('data-model')]);
    h.setOnSpawn((name) => { if (name === 'database-administrator') h.artifacts.add('00001/data-model.md'); });

    await h.pipeline.advanceFeature('S:/repo', '00001');

    expect(h.spawns.map((s) => s.name)).toEqual(['database-administrator']);
    expect(h.spawns[0].caller).toBe('dwight');           // ran AS the epic owner
    expect(milestone(h.getTasks()[0], 'data-model').status).toBe('done');
    expect(milestone(h.getTasks()[0], 'contracts').status).toBe('active'); // next in order
    expect(h.escalations).toHaveLength(0);
  });

  it('does NOT advance a REQUIRED step + escalates when the artifact never lands', async () => {
    const h = mkPipeline();
    h.setTasks([epicWith('tasks')]);                     // tasks is required, gate tasks.md
    h.setOnSpawn(() => { /* produces nothing */ });

    await h.pipeline.advanceFeature('S:/repo', '00001');

    expect(h.spawns.map((s) => s.name)).toEqual(['wbs-generator']);
    expect(milestone(h.getTasks()[0], 'tasks').status).toBe('active'); // unchanged
    expect(h.escalations).toHaveLength(1);
    expect(h.escalations[0].message).toMatch(/tasks\.md did not appear/);
  });

  it('SKIPS an optional step that produces nothing (advances without the artifact)', async () => {
    const h = mkPipeline();
    h.setTasks([epicWith('contracts')]);                 // contracts is optional
    h.setOnSpawn(() => { /* no contracts/ produced — feature has no API */ });

    await h.pipeline.advanceFeature('S:/repo', '00001');

    expect(h.spawns.map((s) => s.name)).toEqual(['api-designer']);
    expect(milestone(h.getTasks()[0], 'contracts').status).toBe('done'); // skipped on
    expect(milestone(h.getTasks()[0], 'adrs').status).toBe('active');
    expect(h.escalations).toHaveLength(0);
  });

  it('leaves a DESK step alone (no spawn) — the notifier pings the desk', async () => {
    const h = mkPipeline();
    h.setTasks([epicWith('implement')]);                 // implement is desk/worker-driven
    await h.pipeline.advanceFeature('S:/repo', '00001');
    expect(h.spawns).toHaveLength(0);
    expect(milestone(h.getTasks()[0], 'implement').status).toBe('active');
    expect(h.escalations).toHaveLength(0);
  });

  it('drives the spec step via spec-author (request + template in the input) and advances to clarify', async () => {
    const h = mkPipeline();
    const epic = epicWith('spec');
    epic.description = 'Build a notes API';
    h.setTasks([epic]);
    h.setOnSpawn((name) => { if (name === 'spec-author') h.artifacts.add('00001/spec.md'); });

    await h.pipeline.advanceFeature('S:/repo', '00001');

    expect(h.spawns.map((s) => s.name)).toEqual(['spec-author']);
    expect(h.spawns[0].input).toMatch(/Build a notes API/);          // the feature request rode in
    expect(h.spawns[0].input).toMatch(/Success Criteria/);            // the spec template rode in
    expect(milestone(h.getTasks()[0], 'spec').status).toBe('done');
    expect(milestone(h.getTasks()[0], 'clarify').status).toBe('active');
  });

  it('Clarify (autopilot OFF): runs requirements-scanner once, asks the human, does NOT advance + does not re-run', async () => {
    const h = mkPipeline();
    h.setTasks([epicWith('clarify')]);
    await h.pipeline.advanceFeature('S:/repo', '00001');
    await h.pipeline.advanceFeature('S:/repo', '00001'); // second trigger while waiting

    expect(h.spawns.map((s) => s.name)).toEqual(['requirements-scanner']); // only once (asked dedup)
    expect(h.asks).toHaveLength(1);
    expect(milestone(h.getTasks()[0], 'clarify').status).toBe('active');   // paused, not advanced
    expect(h.escalations).toHaveLength(0);
  });

  it('Clarify (autopilot ON): spec-author resolves + the engine advances, no human ask', async () => {
    const h = mkPipeline();
    h.state.autopilot = true;
    h.setTasks([epicWith('clarify')]);

    await h.pipeline.advanceFeature('S:/repo', '00001');

    expect(h.spawns.map((s) => s.name)).toEqual(['spec-author']);          // auto-resolved
    expect(h.spawns[0].input).toMatch(/RESOLVE each \[NEEDS CLARIFICATION\]/);
    expect(h.asks).toHaveLength(0);                                        // no human asked
    expect(milestone(h.getTasks()[0], 'clarify').status).toBe('done');
    expect(milestone(h.getTasks()[0], 'research').status).toBe('active');
  });

  it('Implement (feed): seeds the cards from tasks.md when none exist + does NOT advance yet', async () => {
    const h = mkPipeline();
    h.setTasks([epicWith('implement')]);
    await h.pipeline.advanceFeature('S:/repo', '00001');
    expect(h.seeds).toEqual(['epic-1']);                                   // engine seeded the cards
    expect(h.spawns).toHaveLength(0);                                      // no sub-agent — distributed work
    expect(milestone(h.getTasks()[0], 'implement').status).toBe('active'); // waiting for workers
    expect(h.escalations).toHaveLength(0);
  });

  it('Implement (feed): escalates when tasks.md has no tasks to import', async () => {
    const h = mkPipeline();
    h.state.seedCount = 0;
    h.setTasks([epicWith('implement')]);
    await h.pipeline.advanceFeature('S:/repo', '00001');
    expect(h.seeds).toEqual(['epic-1']);
    expect(h.escalations).toHaveLength(1);
    expect(h.escalations[0].message).toMatch(/no tasks to import/);
  });

  it('Implement (track): advances to qc when .completed lands; does not re-seed', async () => {
    const h = mkPipeline();
    h.setTasks([epicWith('implement')]);
    h.artifacts.add('00001/.completed');                                   // distributed flow finished implement
    await h.pipeline.advanceFeature('S:/repo', '00001');
    expect(h.seeds).toHaveLength(0);                                       // marker present → no seed
    expect(milestone(h.getTasks()[0], 'implement').status).toBe('done');
    expect(milestone(h.getTasks()[0], 'qc').status).toBe('active');
  });

  it('QC (track): advances when .qc-passed lands (qc desk produced it)', async () => {
    const h = mkPipeline();
    h.setTasks([epicWith('qc')]);
    h.artifacts.add('00001/.qc-passed');
    await h.pipeline.advanceFeature('S:/repo', '00001');
    expect(h.spawns).toHaveLength(0);                                      // engine tracks, doesn't run QC
    expect(milestone(h.getTasks()[0], 'qc').status).toBe('done');
  });

  it('QC (track): waits (no advance) while .qc-passed is absent', async () => {
    const h = mkPipeline();
    h.setTasks([epicWith('qc')]);
    await h.pipeline.advanceFeature('S:/repo', '00001');
    expect(milestone(h.getTasks()[0], 'qc').status).toBe('active');
    expect(h.escalations).toHaveLength(0);
  });

  it('drives the plan step via plan-author (now host) and advances on plan.md', async () => {
    const h = mkPipeline();
    h.setTasks([epicWith('plan')]);
    h.setOnSpawn((name) => { if (name === 'plan-author') h.artifacts.add('00001/plan.md'); });

    await h.pipeline.advanceFeature('S:/repo', '00001');

    expect(h.spawns.map((s) => s.name)).toEqual(['plan-author']);
    expect(h.spawns[0].input).toMatch(/Requirement Coverage Map/); // the plan template rode in the input
    expect(milestone(h.getTasks()[0], 'plan').status).toBe('done');
    expect(milestone(h.getTasks()[0], 'checklist').status).toBe('active');
  });

  it('escalates (and does NOT spawn) when the epic has no usable native owner desk', async () => {
    const h = mkPipeline();
    h.state.ownerUsable = false;
    h.setTasks([epicWith('data-model')]);
    await h.pipeline.advanceFeature('S:/repo', '00001');
    expect(h.spawns).toHaveLength(0);
    expect(h.escalations).toHaveLength(1);
    expect(h.escalations[0].message).toMatch(/no usable native owner desk/);
  });

  it('is inert when SDDP mode is off', async () => {
    const h = mkPipeline();
    h.state.enabled = false;
    h.setTasks([epicWith('data-model')]);
    await h.pipeline.advanceFeature('S:/repo', '00001');
    expect(h.spawns).toHaveLength(0);
  });

  it('the in-flight lock prevents a double-run of the same step', async () => {
    const h = mkPipeline();
    h.setTasks([epicWith('data-model')]);
    let release!: () => void;
    h.setGate(new Promise<void>((r) => { release = r; }));

    const p1 = h.pipeline.advanceFeature('S:/repo', '00001'); // locks + awaits the held spawn
    const p2 = h.pipeline.advanceFeature('S:/repo', '00001'); // sees the lock → returns, no spawn
    release();
    await Promise.all([p1, p2]);

    expect(h.spawns).toHaveLength(1);
  });
});

describe('SddpPipeline per-step control + auto-assign (P5)', () => {
  it('paused: the engine neither runs nor advances the step', async () => {
    const h = mkPipeline();
    h.setTasks([withControl(epicWith('data-model'), 'data-model', 'paused')]);
    await h.pipeline.advanceFeature('S:/repo', '00001');
    expect(h.spawns).toHaveLength(0);
    expect(milestone(h.getTasks()[0], 'data-model').status).toBe('active');
    expect(h.pipeline.statusFor('00001')?.state).toBe('paused');
  });

  it('manual: the engine skips the run + advances when the artifact appears (a desk authored it)', async () => {
    const h = mkPipeline();
    h.setTasks([withControl(epicWith('data-model'), 'data-model', 'manual')]);
    await h.pipeline.advanceFeature('S:/repo', '00001');
    expect(h.spawns).toHaveLength(0);                                  // engine did not run it
    expect(milestone(h.getTasks()[0], 'data-model').status).toBe('active'); // no artifact yet → wait
    h.artifacts.add('00001/data-model.md');                            // a desk/human wrote it
    await h.pipeline.advanceFeature('S:/repo', '00001');
    expect(h.spawns).toHaveLength(0);
    expect(milestone(h.getTasks()[0], 'data-model').status).toBe('done'); // engine advanced on the artifact
  });

  it('stopped: aborts the in-flight sub-agent run', async () => {
    const h = mkPipeline();
    const epic = epicWith('data-model');
    h.setTasks([epic]);
    let release!: () => void;
    h.setGate(new Promise<void>((r) => { release = r; }));
    const p1 = h.pipeline.advanceFeature('S:/repo', '00001');         // auto → spawns, held by the gate
    const sig = h.spawns[0].signal!;
    expect(sig.aborted).toBe(false);
    h.setTasks([withControl(epic, 'data-model', 'stopped')]);          // operator stops the step
    await h.pipeline.advanceFeature('S:/repo', '00001');              // stopped branch → abort the in-flight run
    expect(sig.aborted).toBe(true);
    release();
    await p1;
  });

  it('auto-assign: an epic with no usable owner is assigned to an available planner desk', async () => {
    const h = mkPipeline();
    h.state.ownerUsable = false;
    h.state.plannerDesk = 'planner-x';
    h.setTasks([epicWith('data-model')]);
    await h.pipeline.advanceFeature('S:/repo', '00001');
    expect(h.assigns).toEqual([{ cardId: 'epic-1', deskId: 'planner-x' }]);
    expect(h.spawns).toHaveLength(0);                                  // waits for the next pass (now owned)
    expect(h.escalations).toHaveLength(0);                             // assigned, not escalated
  });

  it('auto-assign: escalates only when there is no planner desk to assign', async () => {
    const h = mkPipeline();
    h.state.ownerUsable = false;
    h.state.plannerDesk = null;
    h.setTasks([epicWith('data-model')]);
    await h.pipeline.advanceFeature('S:/repo', '00001');
    expect(h.assigns).toHaveLength(0);
    expect(h.escalations).toHaveLength(1);
    expect(h.escalations[0].message).toMatch(/no usable native owner desk/);
  });
});

describe('buildStepInput', () => {
  it('points each host step at the right specs/<feature>/ paths', () => {
    expect(buildStepInput('data-model', '00001')).toMatch(/specs\/00001\/data-model\.md/);
    expect(buildStepInput('tasks', '00001')).toMatch(/specs\/00001\/tasks\.md/);
    expect(buildStepInput('contracts', '00001')).toMatch(/specs\/00001\/contracts\//);
  });

  it('prepends the step template for plan + tasks, but not for single-artifact steps', () => {
    expect(buildStepInput('plan', '00001')).toMatch(/Author into THIS structure/);
    expect(buildStepInput('plan', '00001')).toMatch(/Requirement Coverage Map/);
    expect(buildStepInput('tasks', '00001')).toMatch(/Author into THIS structure/);
    // data-model carries its format inline in the sub-agent prompt → no template appended
    expect(buildStepInput('data-model', '00001')).not.toMatch(/Author into THIS structure/);
  });
});

describe('SddpPipeline — Analyze (host-driven, multi-agent + CRITICAL gate)', () => {
  it('runs policy-auditor + spec-validator, writes a clean report, and advances when nothing is CRITICAL', async () => {
    const h = mkPipeline();
    h.state.uncovered = []; h.state.policyVerdict = 'PASS';
    h.setTasks([epicWith('analyze')]);

    await h.pipeline.advanceFeature('S:/repo', '00001');

    expect(h.spawns.map((s) => s.name).sort()).toEqual(['policy-auditor', 'spec-validator']);
    expect(h.artifactText.get('00001/analysis-report.md')).toMatch(/critical:\s*0/);
    expect(milestone(h.getTasks()[0], 'analyze').status).toBe('done');
    expect(milestone(h.getTasks()[0], 'implement').status).toBe('active');
    expect(h.escalations).toHaveLength(0);
  });

  it('HOLDS + escalates on an uncovered requirement (mechanical CRITICAL), does not advance', async () => {
    const h = mkPipeline();
    h.state.uncovered = ['FR-003']; h.state.policyVerdict = 'PASS';
    h.setTasks([epicWith('analyze')]);

    await h.pipeline.advanceFeature('S:/repo', '00001');

    expect(h.artifactText.get('00001/analysis-report.md')).toMatch(/critical:\s*1/);
    expect(milestone(h.getTasks()[0], 'analyze').status).toBe('active'); // held
    expect(h.escalations).toHaveLength(1);
  });

  it('HOLDS on a policy-auditor FAIL verdict', async () => {
    const h = mkPipeline();
    h.state.uncovered = []; h.state.policyVerdict = 'FAIL';
    h.setTasks([epicWith('analyze')]);

    await h.pipeline.advanceFeature('S:/repo', '00001');

    expect(h.artifactText.get('00001/analysis-report.md')).toMatch(/critical:\s*1/);
    expect(milestone(h.getTasks()[0], 'analyze').status).toBe('active');
    expect(h.escalations).toHaveLength(1);
  });

  it('autopilot advances despite CRITICAL findings', async () => {
    const h = mkPipeline();
    h.state.autopilot = true; h.state.uncovered = ['FR-003']; h.state.policyVerdict = 'FAIL';
    h.setTasks([epicWith('analyze')]);

    await h.pipeline.advanceFeature('S:/repo', '00001');

    expect(milestone(h.getTasks()[0], 'analyze').status).toBe('done');
    expect(milestone(h.getTasks()[0], 'implement').status).toBe('active');
  });

  it('a pre-existing report gates WITHOUT re-running the validators', async () => {
    const h = mkPipeline();
    h.artifactText.set('00001/analysis-report.md', '---\ncritical: 2\n---\n# stale');
    h.setTasks([epicWith('analyze')]);

    await h.pipeline.advanceFeature('S:/repo', '00001');

    expect(h.spawns).toHaveLength(0);                                   // no re-spawn
    expect(milestone(h.getTasks()[0], 'analyze').status).toBe('active'); // held on its critical:2
    expect(h.escalations).toHaveLength(1);
  });
});

describe('SddpPipeline — Checklist-completion gate (before Implement)', () => {
  it('no checklists ⇒ N/A: seeds implement cards, never runs test-evaluator', async () => {
    const h = mkPipeline();
    h.state.checklist = { total: 0, checked: 0 };
    h.setTasks([epicWith('implement')]);

    await h.pipeline.advanceFeature('S:/repo', '00001');

    expect(h.spawns).toHaveLength(0);
    expect(h.seeds).toContain('epic-1');
  });

  it('an incomplete checklist HOLDS Implement (auto-resolves once, then escalates — no seed)', async () => {
    const h = mkPipeline();
    h.state.checklist = { total: 3, checked: 1 };                       // test-evaluator won't fix it here
    h.setTasks([epicWith('implement')]);

    await h.pipeline.advanceFeature('S:/repo', '00001');

    expect(h.spawns.map((s) => s.name)).toContain('test-evaluator');    // one auto-resolve attempt
    expect(h.seeds).toHaveLength(0);                                    // did NOT seed
    expect(h.escalations).toHaveLength(1);
  });

  it('proceeds when test-evaluator completes the checklist', async () => {
    const h = mkPipeline();
    h.state.checklist = { total: 3, checked: 1 };
    h.setOnSpawn((name) => { if (name === 'test-evaluator') h.state.checklist.checked = 3; });
    h.setTasks([epicWith('implement')]);

    await h.pipeline.advanceFeature('S:/repo', '00001');

    expect(h.seeds).toContain('epic-1');
    expect(h.escalations).toHaveLength(0);
  });

  it('autopilot proceeds despite an incomplete checklist', async () => {
    const h = mkPipeline();
    h.state.autopilot = true; h.state.checklist = { total: 3, checked: 1 };
    h.setTasks([epicWith('implement')]);

    await h.pipeline.advanceFeature('S:/repo', '00001');

    expect(h.seeds).toContain('epic-1');
    expect(h.escalations).toHaveLength(0);
  });

  it('a complete checklist proceeds without running test-evaluator', async () => {
    const h = mkPipeline();
    h.state.checklist = { total: 2, checked: 2 };
    h.setTasks([epicWith('implement')]);

    await h.pipeline.advanceFeature('S:/repo', '00001');

    expect(h.spawns.map((s) => s.name)).not.toContain('test-evaluator');
    expect(h.seeds).toContain('epic-1');
  });
});

describe('SddpPipeline — host-driven QC (worktree + qc-auditor/story-verifier)', () => {
  it('PASS: runs both QC sub-agents in the tree, writes .qc-passed, advances, tears the tree down', async () => {
    const h = mkPipeline({ hostQc: true });
    h.state.qcAuditorPass = true; h.state.storyPass = true;
    h.setTasks([epicWith('qc')]);

    await h.pipeline.advanceFeature('S:/repo', '00001');

    expect(h.spawns.map((s) => s.name).sort()).toEqual(['qc-auditor', 'story-verifier']);
    expect(h.artifacts.has('00001/.qc-passed')).toBe(true);            // engine wrote the marker
    expect(milestone(h.getTasks()[0], 'qc').status).toBe('done');
    expect(h.removedTrees).toEqual(['S:/qc/00001']);                  // tree torn down
    expect(h.escalations).toHaveLength(0);
  });

  it('FAIL: no .qc-passed, holds + escalates + files bug cards, still tears the tree down', async () => {
    const h = mkPipeline({ hostQc: true });
    h.state.qcAuditorPass = false; h.state.bugCount = 2;
    h.setTasks([epicWith('qc')]);

    await h.pipeline.advanceFeature('S:/repo', '00001');

    expect(h.artifacts.has('00001/.qc-passed')).toBe(false);
    expect(milestone(h.getTasks()[0], 'qc').status).toBe('active');    // held
    expect(h.bugSeeds).toHaveLength(1);
    expect(h.escalations).toHaveLength(1);
    expect(h.removedTrees).toEqual(['S:/qc/00001']);
  });

  it('merge CONFLICT: escalates without running the QC sub-agents', async () => {
    const h = mkPipeline({ hostQc: true });
    h.state.qcConflicts = ['agent/kevin-t1'];
    h.setTasks([epicWith('qc')]);

    await h.pipeline.advanceFeature('S:/repo', '00001');

    expect(h.spawns).toHaveLength(0);                                  // never ran qc-auditor
    expect(milestone(h.getTasks()[0], 'qc').status).toBe('active');
    expect(h.escalations[0].message).toMatch(/conflict/i);
    expect(h.removedTrees).toEqual(['S:/qc/00001']);
  });

  it('idempotent: an existing .qc-passed advances without building a tree', async () => {
    const h = mkPipeline({ hostQc: true });
    h.setTasks([epicWith('qc')]);
    h.artifacts.add('00001/.qc-passed');

    await h.pipeline.advanceFeature('S:/repo', '00001');

    expect(h.spawns).toHaveLength(0);
    expect(milestone(h.getTasks()[0], 'qc').status).toBe('done');
  });

  it('without the host-QC deps, qc still feed-tracks (.qc-passed advances)', async () => {
    const h = mkPipeline();                                            // no hostQc
    h.setTasks([epicWith('qc')]);
    h.artifacts.add('00001/.qc-passed');
    await h.pipeline.advanceFeature('S:/repo', '00001');
    expect(milestone(h.getTasks()[0], 'qc').status).toBe('done');      // tracked, not host-run
    expect(h.spawns).toHaveLength(0);
  });
});
