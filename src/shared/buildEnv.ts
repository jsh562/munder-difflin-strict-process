/**
 * Shared build-env model — lives in `shared` so the main process (which RESOLVES + injects the
 * vars per desk) and the renderer (the Settings table editor + its live preview) use the SAME
 * type, default, and token-expansion, with no drift.
 *
 * A desk's build/cache output (a Rust `target/`, etc.) is redirected OFF its worktree into one
 * configurable parent folder, subdivided per working tree. Each entry is an env var whose value is
 * a TEMPLATE carrying `${token}` placeholders the host expands per desk — so the user defines the
 * top-level folder once and the correct per-worktree structure is filled in automatically.
 *
 * Pure string logic only (no node deps) so it's safe to import in the sandboxed renderer.
 */

/** One injected env var: `name` (e.g. `CARGO_TARGET_DIR`) ← `value` (a template with tokens). */
export interface BuildEnvEntry {
  name: string;
  value: string;
}

/**
 * The tokens `expandTokens` understands in a `BuildEnvEntry.value`, resolved per desk:
 * - `buildRoot`   — the one parent folder (`config.buildCacheDir`, else `<harnessHome>/build-cache`)
 * - `worktreeKey` — the per-working-tree subfolder (`<basename>-<hash>`; see `buildCacheKey`)
 * - `cwd`         — the desk's working directory (its worktree, or the base repo)
 * - `agentId`     — the desk id
 * - `harnessHome` — the harness home folder
 */
export type BuildEnvVars = {
  buildRoot: string;
  worktreeKey: string;
  cwd: string;
  agentId: string;
  harnessHome: string;
};

/** The token names available in a value template (for the Settings hint + validation). */
export const BUILD_ENV_TOKENS = ['buildRoot', 'worktreeKey', 'cwd', 'agentId', 'harnessHome'] as const;

/**
 * Zero-config default: redirect cargo's `target/` under the root, grouped by tool then per worktree
 * (`<root>/cargo/<key>`) so additional tools (e.g. `SCCACHE_DIR = ${buildRoot}/sccache/${worktreeKey}`)
 * coexist under the SAME root — one folder to exclude from antivirus. Used when `config.buildEnv` is
 * unset (and seeded into the Settings editor so the user sees + can edit it).
 */
export const DEFAULT_BUILD_ENV: BuildEnvEntry[] = [
  { name: 'CARGO_TARGET_DIR', value: '${buildRoot}/cargo/${worktreeKey}' }
];

/**
 * Expand `${token}` placeholders in a template against `vars`. KNOWN tokens are substituted;
 * UNKNOWN `${x}` are left intact (so a literal a user wants passed through survives, and a typo is
 * visible rather than silently blanked). Deterministic + pure.
 */
export function expandTokens(template: string, vars: Partial<BuildEnvVars>): string {
  return template.replace(/\$\{(\w+)\}/g, (whole, token: string) => {
    const v = (vars as Record<string, string | undefined>)[token];
    return v === undefined ? whole : v;
  });
}
