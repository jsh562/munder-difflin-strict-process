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

function mkPipeline() {
  let tasks: HiveTask[] = [];
  const artifacts = new Set<string>();           // `${feature}/${relPath}` present on "disk"
  const spawns: { caller: string; name: string; input: string }[] = [];
  const escalations: { feature: string; message: string }[] = [];
  const asks: { feature: string; questions: string }[] = [];
  const seeds: string[] = [];                     // epic ids the engine asked to seed cards for
  const state = { enabled: true, ownerUsable: true, autopilot: false, seedCount: 2 };
  let onSpawn: (name: string) => void = () => {}; // simulate what a sub-agent writes
  let gate: Promise<void> | null = null;          // optional latch to hold a spawn open (lock test)

  const deps: SddpPipelineDeps = {
    enabled: () => state.enabled,
    autopilot: () => state.autopilot,
    listTasks: () => tasks,
    repoForEpic: () => 'S:/repo',
    ownerUsable: () => state.ownerUsable,
    featureArtifactExists: (_r, feature, rel) => artifacts.has(`${feature}/${rel}`),
    spawnSubAgent: async (caller, name, input) => {
      spawns.push({ caller, name, input });
      if (gate) await gate;
      onSpawn(name);
      return { content: 'ok', success: true };
    },
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
  const pipeline = new SddpPipeline(deps);
  return {
    pipeline, artifacts, spawns, escalations, asks, seeds, state,
    setTasks: (t: HiveTask[]) => { tasks = t; },
    getTasks: () => tasks,
    setOnSpawn: (fn: (name: string) => void) => { onSpawn = fn; },
    setGate: (g: Promise<void> | null) => { gate = g; }
  };
}

const milestone = (t: HiveTask, key: string) => t.milestones!.find((m) => m.key === key)!;

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
