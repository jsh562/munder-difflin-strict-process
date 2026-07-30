/**
 * Regression guard for the SDDP orchestration: the role prompts MUST keep instructing desks to
 * actually USE the sub-agent runtime (spawn_subagent the specialists per phase + advanceMilestone)
 * and the god to seed the feature epic card. Without these the P1–P4 machinery is advertised but
 * inert — this test fails loudly if the wiring rots back out.
 */
import { describe, it, expect } from 'vitest';
import {
  nativeSddpGodPrompt,
  nativeSddpRolePrompt,
  NATIVE_SDDP_PLANNER_PROMPT,
  NATIVE_SDDP_QC_PROMPT,
  NATIVE_SDDP_WORKER_PROMPT,
  SDDP_SUBAGENTS
} from '../sddpPrompts';

describe('SDDP prompts drive the sub-agent runtime', () => {
  it('the planner is told to spawn its planning specialists + advance milestones', () => {
    const p = NATIVE_SDDP_PLANNER_PROMPT;
    expect(p).toMatch(/spawn_subagent/);
    expect(p).toMatch(/database-administrator/);
    expect(p).toMatch(/api-designer/);
    expect(p).toMatch(/wbs-generator/);
    expect(p).toMatch(/spec-validator/);
    expect(p).toMatch(/advanceMilestone/);
  });

  it('the qc role spawns qc-auditor + story-verifier and advances the qc milestone', () => {
    const q = NATIVE_SDDP_QC_PROMPT;
    expect(q).toMatch(/spawn_subagent/);
    expect(q).toMatch(/qc-auditor/);
    expect(q).toMatch(/story-verifier/);
    expect(q).toMatch(/milestone/i);
  });

  it('the worker may delegate to the developer sub-agent', () => {
    expect(NATIVE_SDDP_WORKER_PROMPT).toMatch(/spawn_subagent\('developer'/);
  });

  it('the god seeds the feature epic card + runs hive_import_tasks', () => {
    const g = nativeSddpGodPrompt(['integrator', 'reviewer']);
    expect(g).toMatch(/epic/i);
    expect(g).toMatch(/epic:\s*true/);
    expect(g).toMatch(/hive_import_tasks/);
    expect(g).toMatch(/advanceMilestone/);
  });

  it('the shared sub-agent guidance is included ONLY for spawn-capable roles (planner/qc/worker)', () => {
    expect(nativeSddpRolePrompt(['planner'])).toContain(SDDP_SUBAGENTS);
    expect(nativeSddpRolePrompt(['qc'])).toContain(SDDP_SUBAGENTS);
    expect(nativeSddpRolePrompt(['worker'])).toContain(SDDP_SUBAGENTS);
    // a pure reviewer / integrator can't spawn → no sub-agent guidance (avoids advertising a tool it lacks)
    expect(nativeSddpRolePrompt(['reviewer'])).not.toContain(SDDP_SUBAGENTS);
    expect(nativeSddpRolePrompt(['integrator'])).not.toContain(SDDP_SUBAGENTS);
  });
});
