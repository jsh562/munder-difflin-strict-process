/**
 * planWorktree — the pure reattach-or-isolate decision for a worker desk's git worktree.
 * Driven without git/fs (the real `provisionWorktree` in index.ts wires `listWorktrees` +
 * `existsSync` around this). Covers the regression fix: a RESTART of an isolated desk must
 * REATTACH to its existing worktree (independent of the isolate flags) instead of silently
 * dropping into the shared tree; a workspace change to a different repo must not collide.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { planWorktree, shortHash } from '../git';

const ROOT = join('/harness', 'worktrees');
const REPO_A = join('/repos', 'alpha');
const REPO_B = join('/repos', 'beta');
const primary = (id: string) => join(ROOT, id);
const hashed = (id: string, repo: string) => join(ROOT, `${id}-${shortHash(repo)}`);
const none = () => false;

describe('planWorktree — first isolation', () => {
  it('creates a fresh worktree at the primary path when isolation is wanted and none exists', () => {
    const plan = planWorktree({ wtRoot: ROOT, agentId: 'jim', origCwd: REPO_A, forceNew: true, registered: [], exists: none });
    expect(plan).toEqual({ action: 'create', path: primary('jim') });
  });

  it('skips (runs in the shared cwd) when isolation is NOT wanted and none exists', () => {
    const plan = planWorktree({ wtRoot: ROOT, agentId: 'jim', origCwd: REPO_A, forceNew: false, registered: [], exists: none });
    expect(plan.action).toBe('skip');
  });
});

describe('planWorktree — restart of an isolated desk (the regression)', () => {
  it('REATTACHES to the existing worktree even when forceNew is false (maps were cleared on the kill)', () => {
    // On a role-toggle auto-restart the isolate flags are false, but the worktree is still
    // registered to the repo — we must reuse it, not drop into the shared tree.
    const plan = planWorktree({
      wtRoot: ROOT, agentId: 'jim', origCwd: REPO_A, forceNew: false,
      registered: [primary('jim')], exists: (p) => p === primary('jim')
    });
    expect(plan).toEqual({ action: 'reattach', path: primary('jim') });
  });
});

describe('planWorktree — workspace change to a different repo', () => {
  it('avoids colliding with the OLD repo worktree by isolating at a repo-hashed path', () => {
    // The primary path is taken on disk (old repo's worktree) but not registered to the NEW
    // repo → create at a hashed path discriminated by the new repo.
    const plan = planWorktree({
      wtRoot: ROOT, agentId: 'jim', origCwd: REPO_B, forceNew: true,
      registered: [], exists: (p) => p === primary('jim')
    });
    expect(plan).toEqual({ action: 'create', path: hashed('jim', REPO_B) });
    expect(hashed('jim', REPO_B)).not.toBe(primary('jim'));
  });

  it('reattaches to the hashed path on a later restart in the new repo', () => {
    const plan = planWorktree({
      wtRoot: ROOT, agentId: 'jim', origCwd: REPO_B, forceNew: false,
      registered: [hashed('jim', REPO_B)], exists: (p) => p === primary('jim') || p === hashed('jim', REPO_B)
    });
    expect(plan).toEqual({ action: 'reattach', path: hashed('jim', REPO_B) });
  });
});

describe('planWorktree — safety', () => {
  it('skips an agent id that would escape the worktrees root (a bare "..")', () => {
    const plan = planWorktree({ wtRoot: ROOT, agentId: '..', origCwd: REPO_A, forceNew: true, registered: [], exists: none });
    expect(plan.action).toBe('skip');
  });

  it('shortHash is deterministic and differs per repo', () => {
    expect(shortHash(REPO_A)).toBe(shortHash(REPO_A));
    expect(shortHash(REPO_A)).not.toBe(shortHash(REPO_B));
  });
});
