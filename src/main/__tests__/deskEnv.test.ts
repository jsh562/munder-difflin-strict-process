/**
 * resolveDeskEnv + per-repo/per-agent lookups — expand a desk's env table into the env to inject +
 * the build dirs to create. Pure (no fs/config); the index.ts wrapper owns readConfig + mkdir + the
 * two injection seams.
 */
import { describe, it, expect } from 'vitest';
import { join, resolve } from 'node:path';
import { resolveDeskEnv, perRepoDeskEnv, perAgentDeskEnv } from '../deskEnv';
import { DEFAULT_DESK_ENV, mergeDeskEnv, type DeskEnvVars, type DeskEnvEntry } from '../../shared/deskEnv';

const win = process.platform === 'win32';
const ROOT = join('/harness', 'build-cache');
const vars = (root: string): DeskEnvVars => ({
  buildRoot: root, worktreeKey: 'jim-abc', cwd: join('/repos', 'numrs'), agentId: 'jim', harnessHome: '/harness'
});

describe('resolveDeskEnv', () => {
  it('expands the default cargo entry under the root and marks it for creation', () => {
    const { env, dirs } = resolveDeskEnv(DEFAULT_DESK_ENV, ROOT, vars(ROOT));
    const expected = join(ROOT, 'cargo', 'jim-abc');
    expect(env.CARGO_TARGET_DIR).toBe(expected);
    expect(dirs.map((d) => resolve(d))).toContain(resolve(expected)); // under the root ⇒ auto-created
  });

  it('sets a value OUTSIDE the root but does NOT auto-create it', () => {
    const external = join('/elsewhere', '${worktreeKey}'); // not under ROOT
    const { env, dirs } = resolveDeskEnv([{ name: 'X', value: external }], ROOT, vars(ROOT));
    expect(env.X).toBe(join('/elsewhere', 'jim-abc'));
    expect(dirs).toHaveLength(0);
  });

  it('sets a plain (non-path) value verbatim, never as a dir', () => {
    const { env, dirs } = resolveDeskEnv([{ name: 'RUST_BACKTRACE', value: '1' }, { name: 'CI', value: 'true' }], ROOT, vars(ROOT));
    expect(env).toEqual({ RUST_BACKTRACE: '1', CI: 'true' });
    expect(dirs).toHaveLength(0);
  });

  it('expands ${env:NAME} via the lookup and sets a PATH list RAW (not normalized, not a dir)', () => {
    const look = (n: string) => (n === 'PATH' ? '/usr/bin:/bin' : '');
    const { env, dirs } = resolveDeskEnv([{ name: 'PATH', value: '/extra:${env:PATH}' }], ROOT, vars(ROOT), look);
    expect(env.PATH).toBe('/extra:/usr/bin:/bin'); // verbatim — separators untouched
    expect(dirs).toHaveLength(0);
  });

  it('skips rows with a blank name', () => {
    const { env } = resolveDeskEnv(
      [{ name: '   ', value: '${buildRoot}/x' }, { name: 'KEEP', value: '${buildRoot}/y' }],
      ROOT, vars(ROOT)
    );
    expect(Object.keys(env)).toEqual(['KEEP']);
  });

  it('when root is null: skips ${buildRoot} rows, keeps absolute non-root rows (no dirs created)', () => {
    const { env, dirs } = resolveDeskEnv(
      [
        { name: 'NEEDS_ROOT', value: '${buildRoot}/cargo/${worktreeKey}' }, // unresolvable ⇒ skipped
        { name: 'EXT', value: join('/ext', '${worktreeKey}') }
      ],
      null, vars('')
    );
    expect(env.NEEDS_ROOT).toBeUndefined();
    expect(env.EXT).toBe(join('/ext', 'jim-abc'));
    expect(dirs).toHaveLength(0);
  });

  it('handles a multi-tool table: two vars, two under-root dirs', () => {
    const { env, dirs } = resolveDeskEnv(
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

describe('perRepoDeskEnv — normalized per-repo lookup', () => {
  const ovr: DeskEnvEntry[] = [{ name: 'RUSTFLAGS', value: '-C debuginfo=0' }];
  const map = { [join('/repos', 'numrs')]: ovr, [join('/repos', 'other')]: [{ name: 'X', value: 'y' }] };

  it('returns undefined for an absent map, repo, or no match', () => {
    expect(perRepoDeskEnv(undefined, join('/repos', 'numrs'))).toBeUndefined();
    expect(perRepoDeskEnv(map, null)).toBeUndefined();
    expect(perRepoDeskEnv(map, join('/repos', 'missing'))).toBeUndefined();
  });

  it('matches the same repo across trailing-slash / .. variants', () => {
    expect(perRepoDeskEnv(map, join('/repos', 'numrs'))).toBe(ovr);
    expect(perRepoDeskEnv(map, join('/repos', 'numrs') + '/')).toBe(ovr);
    expect(perRepoDeskEnv(map, join('/repos', 'sub', '..', 'numrs'))).toBe(ovr);
  });

  it('is case-insensitive only on win32 (matches normalizeRepoPath)', () => {
    const upper = join('/repos', 'numrs').toUpperCase();
    if (win) expect(perRepoDeskEnv(map, upper)).toBe(ovr);
    else expect(perRepoDeskEnv(map, upper)).toBeUndefined();
  });

  it('the override value wins when merged + resolved (layered on the global base)', () => {
    const override = perRepoDeskEnv({ [join('/repos', 'numrs')]: [{ name: 'CARGO_TARGET_DIR', value: '${buildRoot}/special/${worktreeKey}' }] }, join('/repos', 'numrs'));
    const { env } = resolveDeskEnv(mergeDeskEnv(DEFAULT_DESK_ENV, override), ROOT, vars(ROOT));
    expect(env.CARGO_TARGET_DIR).toBe(join(ROOT, 'special', 'jim-abc')); // repo override, not the default cargo/
  });
});

describe('perAgentDeskEnv — exact agent-id lookup', () => {
  const ovr: DeskEnvEntry[] = [{ name: 'RUST_LOG', value: 'debug' }];
  const map = { 'jim-1': ovr };

  it('matches the exact id, misses otherwise', () => {
    expect(perAgentDeskEnv(map, 'jim-1')).toBe(ovr);
    expect(perAgentDeskEnv(map, 'jim-2')).toBeUndefined();
    expect(perAgentDeskEnv(map, null)).toBeUndefined();
    expect(perAgentDeskEnv(undefined, 'jim-1')).toBeUndefined();
  });
});
