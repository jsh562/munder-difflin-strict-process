import { resolve } from 'node:path';

/**
 * Canonicalize a repo/workspace path for set-membership comparison. The integrate allow-list
 * and the read-roots compare paths that arrive from different sources — a folder picker
 * (`S:\md\numrs`), a model-supplied `hive_integrate` argument (`S:/md/numrs` or a trailing
 * slash), the registry, `git worktree list` — so a raw `===` / `Set.has` misses obvious
 * equivalents and blocks a legitimate target. Normalization: resolve to an absolute path
 * (collapses `.`/`..` and unifies separators via the platform), drop a trailing separator, and
 * lowercase on Windows (its filesystem is case-insensitive; POSIX stays case-sensitive).
 */
export function normalizeRepoPath(p: string | null | undefined): string {
  if (!p) return '';
  let out = resolve(p.trim());
  out = out.replace(/[\\/]+$/, ''); // strip trailing separator(s)
  if (process.platform === 'win32') out = out.toLowerCase();
  return out;
}

/** Do two paths point at the same repo/workspace once normalized? */
export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeRepoPath(a);
  return na !== '' && na === normalizeRepoPath(b);
}

/** Build a Set of normalized paths for fast membership tests (drops empties). */
export function normalizedPathSet(paths: Iterable<string | null | undefined>): Set<string> {
  const set = new Set<string>();
  for (const p of paths) {
    const n = normalizeRepoPath(p);
    if (n) set.add(n);
  }
  return set;
}
