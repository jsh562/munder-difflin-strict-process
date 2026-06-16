import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { normalizeRepoPath, samePath, normalizedPathSet, buildCacheKey } from '../paths';

const win = process.platform === 'win32';

describe('normalizeRepoPath', () => {
  it('returns "" for empty/nullish', () => {
    expect(normalizeRepoPath('')).toBe('');
    expect(normalizeRepoPath(null)).toBe('');
    expect(normalizeRepoPath(undefined)).toBe('');
  });

  it('strips a trailing separator', () => {
    const base = resolve('foo/bar');
    expect(normalizeRepoPath('foo/bar/')).toBe(win ? base.toLowerCase() : base);
    expect(normalizeRepoPath('foo/bar')).toBe(win ? base.toLowerCase() : base);
  });

  it('collapses . and .. and unifies separators (resolve)', () => {
    expect(normalizeRepoPath('foo/baz/../bar')).toBe(normalizeRepoPath('foo/bar'));
  });

  it('is case-insensitive only on win32', () => {
    if (win) expect(normalizeRepoPath('S:/Md/NumRS')).toBe(normalizeRepoPath('s:/md/numrs'));
    else expect(normalizeRepoPath('/Md/NumRS')).not.toBe(normalizeRepoPath('/md/numrs'));
  });
});

describe('samePath', () => {
  it('matches separator + trailing-slash variants of the same path', () => {
    expect(samePath('foo/bar', 'foo/bar/')).toBe(true);
    expect(samePath('foo/bar', 'foo/baz/../bar')).toBe(true);
  });

  it('does not match different paths, and empty never matches', () => {
    expect(samePath('foo/bar', 'foo/qux')).toBe(false);
    expect(samePath('', '')).toBe(false);
    expect(samePath(null, 'foo/bar')).toBe(false);
  });
});

describe('normalizedPathSet', () => {
  it('dedupes equivalent paths and drops empties', () => {
    const set = normalizedPathSet(['foo/bar', 'foo/bar/', '', null, 'foo/baz/../bar']);
    expect(set.size).toBe(1);
    expect(set.has(normalizeRepoPath('foo/bar'))).toBe(true);
  });
});

describe('buildCacheKey — per-working-tree build dir name', () => {
  it('is deterministic and begins with the basename', () => {
    const a = buildCacheKey('S:/munderdiff/worktrees/stanley-mqdrvp0p');
    expect(a).toBe(buildCacheKey('S:/munderdiff/worktrees/stanley-mqdrvp0p'));
    expect(a.startsWith('stanley-mqdrvp0p-')).toBe(true);
  });

  it('discriminates same-named dirs on different paths (no collision)', () => {
    // Two repos both named "numrs" under different parents must NOT share a build dir.
    expect(buildCacheKey('S:/a/numrs')).not.toBe(buildCacheKey('S:/b/numrs'));
    // …but both still carry the basename prefix.
    expect(buildCacheKey('S:/a/numrs').startsWith('numrs-')).toBe(true);
    expect(buildCacheKey('S:/b/numrs').startsWith('numrs-')).toBe(true);
  });

  it('is stable across trailing-slash / .. variants of one path', () => {
    expect(buildCacheKey('S:/md/numrs')).toBe(buildCacheKey('S:/md/numrs/'));
    expect(buildCacheKey('S:/md/numrs')).toBe(buildCacheKey('S:/md/sub/../numrs'));
  });

  it('is case-insensitive only on win32 (matches normalizeRepoPath)', () => {
    if (win) expect(buildCacheKey('S:/Md/NumRS')).toBe(buildCacheKey('s:/md/numrs'));
    else expect(buildCacheKey('/Md/NumRS')).not.toBe(buildCacheKey('/md/numrs'));
  });
});
