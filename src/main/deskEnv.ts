/**
 * Main-process resolution of a desk's env table — turns the token templates (shared model) into the
 * concrete env vars to inject + the build dirs to create. Kept pure (node:path + an injected env
 * lookup; no fs/config) so `index.ts` owns the impure parts (readConfig + mkdir + the two injection
 * seams) and this is unit-testable.
 */
import { resolve, isAbsolute, normalize, sep } from 'node:path';
import { expandTokens, type DeskEnvEntry, type DeskEnvVars } from '../shared/deskEnv';
import { normalizeRepoPath } from './paths';

/** Is `p` the same as, or nested under, `root` (resolved)? Gates which dirs we auto-create. */
function underRoot(p: string, root: string): boolean {
  const rp = resolve(p);
  const rr = resolve(root);
  return rp === rr || rp.startsWith(rr + sep);
}

/**
 * Expand a desk-env table for one desk. Returns the `env` record to merge over `process.env` and the
 * `dirs` the host should `mkdir -p`. A value that expands to an absolute path UNDER `root` is treated
 * as a managed build dir — normalized to platform separators and collected for creation; every OTHER
 * value (PATH lists, flags, external paths) is set RAW (never normalized — so a `${env:PATH}` list
 * isn't mangled). Rules: blank-`name` rows skipped; with `root` null, a row whose RAW value references
 * `${buildRoot}` is skipped (can't resolve). `envLookup` backs the `${env:NAME}` token.
 */
export function resolveDeskEnv(
  entries: DeskEnvEntry[],
  root: string | null,
  vars: DeskEnvVars,
  envLookup?: (name: string) => string | undefined
): { env: Record<string, string>; dirs: string[] } {
  const env: Record<string, string> = {};
  const dirs: string[] = [];
  for (const entry of entries) {
    const name = entry.name?.trim();
    if (!name) continue;
    if (!root && /\$\{buildRoot\}/.test(entry.value)) continue; // can't resolve without a root
    const expanded = expandTokens(entry.value, vars, envLookup);
    if (root && isAbsolute(expanded) && underRoot(expanded, root)) {
      const dir = normalize(expanded); // managed build dir → clean platform separators + auto-create
      env[name] = dir;
      dirs.push(dir);
    } else {
      env[name] = expanded; // plain value (flag / PATH list / external path) — set verbatim
    }
  }
  return { env, dirs };
}

/**
 * The per-repo override entries for a desk's project `repo` (else undefined). Keys in `deskEnvByRepo`
 * are repo paths as the user stored them (a `registeredRepos` string); matched case/separator-
 * insensitively against the desk's resolved repo via `normalizeRepoPath`, so a picker path and a
 * worktree-origin path that point at the same repo still match. Small linear scan (a few repos).
 */
export function perRepoDeskEnv(
  map: Record<string, DeskEnvEntry[]> | undefined,
  repo: string | null
): DeskEnvEntry[] | undefined {
  if (!map || !repo) return undefined;
  const want = normalizeRepoPath(repo);
  if (!want) return undefined;
  for (const [key, entries] of Object.entries(map)) {
    if (normalizeRepoPath(key) === want) return entries;
  }
  return undefined;
}

/** The per-agent override entries for a desk (else undefined). Keyed by EXACT agent id (ids are exact
 *  strings — no normalization). Layered on top of the global + per-repo tables (most specific wins). */
export function perAgentDeskEnv(
  map: Record<string, DeskEnvEntry[]> | undefined,
  agentId: string | null | undefined
): DeskEnvEntry[] | undefined {
  if (!map || !agentId) return undefined;
  return map[agentId];
}
