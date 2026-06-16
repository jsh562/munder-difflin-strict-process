/**
 * Shared build-env model — pure token expansion + the default table. No node/host deps (this is the
 * renderer-safe half; the main-process `resolveBuildEnv` is tested separately under src/main).
 */
import { describe, it, expect } from 'vitest';
import { expandTokens, mergeBuildEnv, DEFAULT_BUILD_ENV, BUILD_ENV_TOKENS } from '../buildEnv';

describe('expandTokens', () => {
  const vars = { buildRoot: 'S:/cache', worktreeKey: 'jim-abc', cwd: 'S:/md/numrs', agentId: 'jim', harnessHome: 'S:/munderdiff' };

  it('substitutes every known token', () => {
    expect(expandTokens('${buildRoot}/cargo/${worktreeKey}', vars)).toBe('S:/cache/cargo/jim-abc');
    expect(expandTokens('${cwd}|${agentId}|${harnessHome}', vars)).toBe('S:/md/numrs|jim|S:/munderdiff');
  });

  it('leaves an UNKNOWN ${token} intact (typo is visible, not silently blanked)', () => {
    expect(expandTokens('${buildRoot}/${worktreekey}', vars)).toBe('S:/cache/${worktreekey}'); // wrong case
    expect(expandTokens('${nope}', vars)).toBe('${nope}');
  });

  it('expands repeated tokens and tolerates missing vars', () => {
    expect(expandTokens('${worktreeKey}-${worktreeKey}', vars)).toBe('jim-abc-jim-abc');
    expect(expandTokens('${buildRoot}/x', { worktreeKey: 'k' })).toBe('${buildRoot}/x'); // buildRoot absent ⇒ left intact
  });

  it('returns plain strings unchanged', () => {
    expect(expandTokens('no-tokens-here', vars)).toBe('no-tokens-here');
  });
});

describe('mergeBuildEnv — per-repo override layered on the global base', () => {
  const base = [
    { name: 'CARGO_TARGET_DIR', value: '${buildRoot}/cargo/${worktreeKey}' },
    { name: 'RUST_BACKTRACE', value: '1' }
  ];

  it('returns the base unchanged for an empty/undefined override', () => {
    expect(mergeBuildEnv(base, undefined)).toBe(base);
    expect(mergeBuildEnv(base, [])).toBe(base);
  });

  it('replaces a same-name entry in place (override wins) and keeps base order', () => {
    const out = mergeBuildEnv(base, [{ name: 'CARGO_TARGET_DIR', value: 'D:/fast/${worktreeKey}' }]);
    expect(out).toEqual([
      { name: 'CARGO_TARGET_DIR', value: 'D:/fast/${worktreeKey}' },
      { name: 'RUST_BACKTRACE', value: '1' }
    ]);
  });

  it('appends override entries with new names after the base', () => {
    const out = mergeBuildEnv(base, [{ name: 'NODE_OPTIONS', value: '--max-old-space-size=4096' }]);
    expect(out.map((e) => e.name)).toEqual(['CARGO_TARGET_DIR', 'RUST_BACKTRACE', 'NODE_OPTIONS']);
  });

  it('handles a mix of replace + append in one override', () => {
    const out = mergeBuildEnv(base, [
      { name: 'RUST_BACKTRACE', value: 'full' },
      { name: 'RUSTFLAGS', value: '-C debuginfo=0' }
    ]);
    expect(out).toEqual([
      { name: 'CARGO_TARGET_DIR', value: '${buildRoot}/cargo/${worktreeKey}' },
      { name: 'RUST_BACKTRACE', value: 'full' },
      { name: 'RUSTFLAGS', value: '-C debuginfo=0' }
    ]);
  });

  it('ignores blank-name override rows', () => {
    expect(mergeBuildEnv(base, [{ name: '  ', value: 'x' }])).toEqual(base);
  });
});

describe('DEFAULT_BUILD_ENV', () => {
  it('redirects cargo under the root, grouped by tool then worktree', () => {
    expect(DEFAULT_BUILD_ENV).toEqual([{ name: 'CARGO_TARGET_DIR', value: '${buildRoot}/cargo/${worktreeKey}' }]);
  });
  it('only uses tokens the expander knows', () => {
    for (const { value } of DEFAULT_BUILD_ENV) {
      for (const m of value.matchAll(/\$\{(\w+)\}/g)) {
        expect(BUILD_ENV_TOKENS).toContain(m[1]);
      }
    }
  });
});
