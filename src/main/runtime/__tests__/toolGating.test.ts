import { describe, it, expect } from 'vitest';
import { deniedNativeToolNames } from '../toolGating';

describe('deniedNativeToolNames — advertise only the tools a desk can actually use', () => {
  it('a pure-delegator god (no roles) is denied edit tools AND hive_integrate', () => {
    expect(deniedNativeToolNames([]).sort()).toEqual(['bash', 'edit_file', 'hive_integrate', 'write_file']);
  });

  it('a worker keeps edit tools but is denied hive_integrate', () => {
    expect(deniedNativeToolNames(['worker'])).toEqual(['hive_integrate']);
  });

  it('an integrator keeps everything (edits + integrate)', () => {
    expect(deniedNativeToolNames(['integrator'])).toEqual([]);
  });

  it('a reviewer is read-only and cannot integrate', () => {
    expect(deniedNativeToolNames(['reviewer']).sort()).toEqual(['bash', 'edit_file', 'hive_integrate', 'write_file']);
  });

  it('planner/qc can edit (artifacts/tests) but cannot integrate', () => {
    expect(deniedNativeToolNames(['planner'])).toEqual(['hive_integrate']);
    expect(deniedNativeToolNames(['qc'])).toEqual(['hive_integrate']);
  });

  it('a default god holding integrator+reviewer keeps everything', () => {
    expect(deniedNativeToolNames(['integrator', 'reviewer'])).toEqual([]);
  });
});
