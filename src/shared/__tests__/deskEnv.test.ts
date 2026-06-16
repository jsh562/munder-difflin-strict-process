/**
 * Shared desk-env model — pure token expansion (incl. the `${env:NAME}` form), the layering merge,
 * and the default table. No node/host deps (the renderer-safe half; the main-process `resolveDeskEnv`
 * is tested separately under src/main).
 */
import { describe, it, expect } from 'vitest';
import { expandTokens, mergeDeskEnv, DEFAULT_DESK_ENV, DESK_ENV_TOKENS } from '../deskEnv';

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

  it('resolves prefixed ${env:NAME}/${secret:NAME} via the (prefix,name) lookup', () => {
    const look = (prefix: string, name: string) =>
      prefix === 'env' && name === 'PATH' ? '/usr/bin'
      : prefix === 'secret' && name === 'GH_TOKEN' ? 'ghp_xyz'
      : undefined;
    expect(expandTokens('/extra:${env:PATH}', vars, look)).toBe('/extra:/usr/bin'); // safe PATH-append
    expect(expandTokens('Bearer ${secret:GH_TOKEN}', vars, look)).toBe('Bearer ghp_xyz');
    expect(expandTokens('${buildRoot}/x:${env:PATH}', vars, look)).toBe('S:/cache/x:/usr/bin'); // mixed
  });

  it('leaves a prefixed token intact when no lookup (renderer preview) or it resolves undefined', () => {
    expect(expandTokens('/extra:${env:PATH}', vars)).toBe('/extra:${env:PATH}'); // no lookup → literal
    expect(expandTokens('${secret:NOPE}', vars, () => undefined)).toBe('${secret:NOPE}'); // unknown → literal
  });

  it('returns plain strings unchanged', () => {
    expect(expandTokens('no-tokens-here', vars)).toBe('no-tokens-here');
  });
});

describe('mergeDeskEnv — layered overrides', () => {
  const base = [
    { name: 'CARGO_TARGET_DIR', value: '${buildRoot}/cargo/${worktreeKey}' },
    { name: 'RUST_BACKTRACE', value: '1' }
  ];

  it('returns the base unchanged for an empty/undefined override', () => {
    expect(mergeDeskEnv(base, undefined)).toBe(base);
    expect(mergeDeskEnv(base, [])).toBe(base);
  });

  it('replaces a same-name entry in place (override wins) and keeps base order', () => {
    const out = mergeDeskEnv(base, [{ name: 'CARGO_TARGET_DIR', value: 'D:/fast/${worktreeKey}' }]);
    expect(out).toEqual([
      { name: 'CARGO_TARGET_DIR', value: 'D:/fast/${worktreeKey}' },
      { name: 'RUST_BACKTRACE', value: '1' }
    ]);
  });

  it('appends override entries with new names after the base', () => {
    const out = mergeDeskEnv(base, [{ name: 'NODE_OPTIONS', value: '--max-old-space-size=4096' }]);
    expect(out.map((e) => e.name)).toEqual(['CARGO_TARGET_DIR', 'RUST_BACKTRACE', 'NODE_OPTIONS']);
  });

  it('ignores blank-name override rows', () => {
    expect(mergeDeskEnv(base, [{ name: '  ', value: 'x' }])).toEqual(base);
  });

  it('composes global → repo → agent (most specific wins)', () => {
    const repo = [{ name: 'RUST_BACKTRACE', value: 'full' }, { name: 'RUSTFLAGS', value: '-C debuginfo=0' }];
    const agent = [{ name: 'RUSTFLAGS', value: '-C opt-level=3' }, { name: 'CI', value: '1' }];
    const out = mergeDeskEnv(mergeDeskEnv(base, repo), agent);
    expect(out).toEqual([
      { name: 'CARGO_TARGET_DIR', value: '${buildRoot}/cargo/${worktreeKey}' }, // base
      { name: 'RUST_BACKTRACE', value: 'full' },                                 // repo over base
      { name: 'RUSTFLAGS', value: '-C opt-level=3' },                            // agent over repo
      { name: 'CI', value: '1' }                                                 // agent new
    ]);
  });
});

describe('DEFAULT_DESK_ENV', () => {
  it('redirects cargo under the root, grouped by tool then worktree', () => {
    expect(DEFAULT_DESK_ENV).toEqual([{ name: 'CARGO_TARGET_DIR', value: '${buildRoot}/cargo/${worktreeKey}' }]);
  });
  it('only uses named tokens the expander knows', () => {
    for (const { value } of DEFAULT_DESK_ENV) {
      for (const m of value.matchAll(/\$\{(\w+)\}/g)) {
        expect(DESK_ENV_TOKENS).toContain(m[1]);
      }
    }
  });
});
