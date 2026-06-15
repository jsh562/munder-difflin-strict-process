import { describe, it, expect } from 'vitest';
import { deniedNativeToolNames } from '../toolGating';

describe('deniedNativeToolNames — advertise only the tools a desk can actually use', () => {
  it('a pure-delegator god (no roles) is denied edit tools, hive_integrate, AND spawn_subagent', () => {
    expect(deniedNativeToolNames([]).sort()).toEqual(['bash', 'edit_file', 'hive_integrate', 'spawn_subagent', 'write_file']);
  });

  it('a worker keeps edit tools + spawn_subagent but is denied hive_integrate', () => {
    expect(deniedNativeToolNames(['worker'])).toEqual(['hive_integrate']);
  });

  it('an integrator is a gate+merger: keeps bash + hive_integrate, but is denied file edits + spawn_subagent', () => {
    expect(deniedNativeToolNames(['integrator']).sort()).toEqual(['edit_file', 'spawn_subagent', 'write_file']);
  });

  it('a reviewer is read-only, cannot integrate, and cannot spawn sub-agents', () => {
    expect(deniedNativeToolNames(['reviewer']).sort()).toEqual(['bash', 'edit_file', 'hive_integrate', 'spawn_subagent', 'write_file']);
  });

  it('planner/qc can edit (artifacts/tests) AND spawn sub-agents but cannot integrate', () => {
    expect(deniedNativeToolNames(['planner'])).toEqual(['hive_integrate']);
    expect(deniedNativeToolNames(['qc'])).toEqual(['hive_integrate']);
  });

  it('a god holding integrator+reviewer keeps bash + hive_integrate, denied file edits + spawn_subagent', () => {
    expect(deniedNativeToolNames(['integrator', 'reviewer']).sort()).toEqual(['edit_file', 'spawn_subagent', 'write_file']);
  });

  it('only the orchestrating roles (planner/qc/worker) are advertised spawn_subagent', () => {
    for (const role of ['planner', 'qc', 'worker'] as const) {
      expect(deniedNativeToolNames([role])).not.toContain('spawn_subagent');
    }
    for (const role of ['reviewer', 'integrator'] as const) {
      expect(deniedNativeToolNames([role])).toContain('spawn_subagent');
    }
    expect(deniedNativeToolNames([])).toContain('spawn_subagent');
  });
});
