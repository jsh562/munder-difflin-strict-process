/**
 * Main-process resolution of a desk's build-env table — turns the token templates (shared model)
 * into the concrete env vars to inject + the dirs the host must create. Kept pure (node:path only,
 * no fs/config) so `index.ts` owns the impure parts (readConfig + mkdir + the two injection seams)
 * and this is unit-testable.
 */
import { resolve, isAbsolute, normalize, sep } from 'node:path';
import { expandTokens, type BuildEnvEntry, type BuildEnvVars } from '../shared/buildEnv';
import { normalizeRepoPath } from './paths';

/**
 * The per-repo override entries for a desk's project `repo` (else undefined). Keys in
 * `buildEnvByRepo` are repo paths as the user stored them (a `registeredRepos` string); matched
 * case/separator-insensitively against the desk's resolved repo via `normalizeRepoPath`, so a
 * picker path and a worktree-origin path that point at the same repo still match. Small linear scan
 * (a handful of repos). The caller layers these over the global base with `mergeBuildEnv`.
 */
export function perRepoEntriesFor(
  map: Record<string, BuildEnvEntry[]> | undefined,
  repo: string | null
): BuildEnvEntry[] | undefined {
  if (!map || !repo) return undefined;
  const want = normalizeRepoPath(repo);
  if (!want) return undefined;
  for (const [key, entries] of Object.entries(map)) {
    if (normalizeRepoPath(key) === want) return entries;
  }
  return undefined;
}

/** Is `p` the same as, or nested under, `root` (resolved)? Gates which dirs we auto-create. */
function underRoot(p: string, root: string): boolean {
  const rp = resolve(p);
  const rr = resolve(root);
  return rp === rr || rp.startsWith(rr + sep);
}

/**
 * Expand a build-env table for one desk. Returns the `env` record to merge over `process.env` and
 * the `dirs` the host should `mkdir -p` (only resolved values that are absolute AND under `root`, so
 * we never create arbitrary folders). Rules:
 *  - rows with a blank `name` are skipped;
 *  - when `root` is null (pre-onboarding / no home) a row whose RAW value references `${buildRoot}`
 *    is skipped (it can't resolve to a real path) — other rows still apply;
 *  - a value is set whether or not it's under the root (a user may point at an external drive); only
 *    under-root values are auto-created.
 */
export function resolveBuildEnv(
  entries: BuildEnvEntry[],
  root: string | null,
  vars: BuildEnvVars
): { env: Record<string, string>; dirs: string[] } {
  const env: Record<string, string> = {};
  const dirs: string[] = [];
  for (const entry of entries) {
    const name = entry.name?.trim();
    if (!name) continue;
    if (!root && /\$\{buildRoot\}/.test(entry.value)) continue; // can't resolve without a root
    const expanded = expandTokens(entry.value, vars);
    // Normalize an absolute path value to platform separators (the template uses `/`, the root may
    // use `\` on Windows → avoid a mixed `S:\…/cargo/…`). Non-path values pass through untouched.
    const value = isAbsolute(expanded) ? normalize(expanded) : expanded;
    env[name] = value;
    if (root && isAbsolute(value) && underRoot(value, root)) dirs.push(value);
  }
  return { env, dirs };
}
