import { resolve, basename } from 'node:path';
import { shortHash } from './git';

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

/**
 * A stable per-working-tree key for the shared build-cache root: `<basename>-<hash>`. Each distinct
 * working tree (an isolated desk's worktree OR a base repo) gets its OWN subdir, so a build tool that
 * locks its output dir (cargo's `target`) never contends across desks; the hash (over the NORMALIZED
 * path) discriminates same-named repos on different paths and is case-insensitive on Windows. Pure +
 * deterministic — the host joins it under the cache root and creates the dir.
 */
export function buildCacheKey(cwd: string): string {
  const norm = normalizeRepoPath(cwd); // resolved + trailing-sep stripped + lowercased on win32
  return `${basename(norm)}-${shortHash(norm)}`;
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
