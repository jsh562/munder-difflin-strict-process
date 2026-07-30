import { describe, it, expect } from 'vitest';
import { classifyWorktree } from '../git';

describe('classifyWorktree — worktree health flags for the operator diagnostics', () => {
  it('a clean isolated agent worktree has no problem flags', () => {
    expect(classifyWorktree({ isMain: false, branch: 'agent/kevin', dirty: 0, ahead: 0, locked: false })).toEqual([]);
  });

  it('a clean base tree on the trunk is just `main`', () => {
    expect(classifyWorktree({ isMain: true, branch: 'master', dirty: 0, ahead: 0, locked: false })).toEqual(['main']);
  });

  it('a base tree on an agent branch is `not-isolated` (the legacy bug)', () => {
    const flags = classifyWorktree({ isMain: true, branch: 'agent/phyllis', dirty: 0, ahead: 0, locked: false });
    expect(flags).toContain('main');
    expect(flags).toContain('not-isolated');
  });

  it('surfaces dirty + unmerged + locked, and detached when no branch', () => {
    expect(classifyWorktree({ isMain: false, branch: 'agent/x', dirty: 3, ahead: 2, locked: true }).sort())
      .toEqual(['dirty', 'locked', 'unmerged']);
    expect(classifyWorktree({ isMain: false, branch: null, dirty: 0, ahead: 0, locked: false })).toEqual(['detached']);
  });

  it('non-main agent branch is never flagged not-isolated', () => {
    expect(classifyWorktree({ isMain: false, branch: 'agent/kevin', dirty: 0, ahead: 0, locked: false }))
      .not.toContain('not-isolated');
  });
});
