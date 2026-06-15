import { describe, it, expect } from 'vitest';
import { deniedNativeToolNames } from '../toolGating';

describe('deniedNativeToolNames — advertise only the tools a desk can actually use', () => {
  it('a pure-delegator god (no roles) is denied edit tools AND hive_integrate', () => {
    expect(deniedNativeToolNames([]).sort()).toEqual(['bash', 'edit_file', 'hive_integrate', 'write_file']);
  });

  it('a worker keeps edit tools but is denied hive_integrate', () => {
    expect(deniedNativeToolNames(['worker'])).toEqual(['hive_integrate']);
  });

  it('an integrator is a gate+merger: keeps bash + hive_integrate, but is denied file edits', () => {
    expect(deniedNativeToolNames(['integrator']).sort()).toEqual(['edit_file', 'write_file']);
  });

  it('a reviewer is read-only and cannot integrate', () => {
    expect(deniedNativeToolNames(['reviewer']).sort()).toEqual(['bash', 'edit_file', 'hive_integrate', 'write_file']);
  });

  it('planner/qc can edit (artifacts/tests) but cannot integrate', () => {
    expect(deniedNativeToolNames(['planner'])).toEqual(['hive_integrate']);
    expect(deniedNativeToolNames(['qc'])).toEqual(['hive_integrate']);
  });

  it('a god holding integrator+reviewer keeps bash + hive_integrate, denied file edits', () => {
    expect(deniedNativeToolNames(['integrator', 'reviewer']).sort()).toEqual(['edit_file', 'write_file']);
  });
});
