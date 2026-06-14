import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { normalizeRepoPath, samePath, normalizedPathSet } from '../paths';

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
