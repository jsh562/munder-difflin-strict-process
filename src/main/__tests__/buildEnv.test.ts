/**
 * resolveBuildEnv — expand a desk's build-env table into the env to inject + the dirs to create.
 * Pure (no fs/config); the index.ts wrapper owns readConfig + mkdir + the two injection seams.
 */
import { describe, it, expect } from 'vitest';
import { join, resolve } from 'node:path';
import { resolveBuildEnv } from '../buildEnv';
import { DEFAULT_BUILD_ENV, type BuildEnvVars } from '../../shared/buildEnv';

const ROOT = join('/harness', 'build-cache');
const vars = (root: string): BuildEnvVars => ({
  buildRoot: root, worktreeKey: 'jim-abc', cwd: join('/repos', 'numrs'), agentId: 'jim', harnessHome: '/harness'
});

describe('resolveBuildEnv', () => {
  it('expands the default cargo entry under the root and marks it for creation', () => {
    const { env, dirs } = resolveBuildEnv(DEFAULT_BUILD_ENV, ROOT, vars(ROOT));
    const expected = join(ROOT, 'cargo', 'jim-abc');
    expect(env.CARGO_TARGET_DIR).toBe(expected);
    expect(dirs.map((d) => resolve(d))).toContain(resolve(expected)); // under the root ⇒ auto-created
  });

  it('sets a value OUTSIDE the root but does NOT auto-create it', () => {
    const external = join('/elsewhere', '${worktreeKey}'); // not under ROOT
    const { env, dirs } = resolveBuildEnv([{ name: 'X', value: external }], ROOT, vars(ROOT));
    expect(env.X).toBe(join('/elsewhere', 'jim-abc'));
    expect(dirs).toHaveLength(0);
  });

  it('skips rows with a blank name', () => {
    const { env } = resolveBuildEnv(
      [{ name: '   ', value: '${buildRoot}/x' }, { name: 'KEEP', value: '${buildRoot}/y' }],
      ROOT, vars(ROOT)
    );
    expect(Object.keys(env)).toEqual(['KEEP']);
  });

  it('when root is null: skips ${buildRoot} rows, keeps absolute non-root rows (no dirs created)', () => {
    const { env, dirs } = resolveBuildEnv(
      [
        { name: 'NEEDS_ROOT', value: '${buildRoot}/cargo/${worktreeKey}' }, // unresolvable ⇒ skipped
        { name: 'EXT', value: join('/ext', '${worktreeKey}') }
      ],
      null, vars('')
    );
    expect(env.NEEDS_ROOT).toBeUndefined();
    expect(env.EXT).toBe(join('/ext', 'jim-abc'));
    expect(dirs).toHaveLength(0); // nothing auto-created without a root
  });

  it('handles a multi-tool table: two vars, two under-root dirs', () => {
    const { env, dirs } = resolveBuildEnv(
      [
        { name: 'CARGO_TARGET_DIR', value: '${buildRoot}/cargo/${worktreeKey}' },
        { name: 'SCCACHE_DIR', value: '${buildRoot}/sccache/${worktreeKey}' }
      ],
      ROOT, vars(ROOT)
    );
    expect(env.CARGO_TARGET_DIR).toBe(join(ROOT, 'cargo', 'jim-abc'));
    expect(env.SCCACHE_DIR).toBe(join(ROOT, 'sccache', 'jim-abc'));
    expect(dirs).toHaveLength(2);
  });
});
