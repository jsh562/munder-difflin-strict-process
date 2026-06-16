/**
 * Shared desk-env model — lives in `shared` so the main process (which RESOLVES + injects the vars
 * per desk) and the renderer (the Settings table editor + its live preview) use the SAME type,
 * default, and token-expansion, with no drift.
 *
 * A desk's environment is set by a token-templated table: each entry is ANY env var whose value may
 * carry `${token}` placeholders the host expands per desk. The common use is redirecting heavy build
 * output (a Rust `target/`, …) OFF the worktree into one configurable parent folder, subdivided per
 * working tree — but the table is general (RUSTFLAGS, NODE_OPTIONS, etc.). Layers: a global base, a
 * per-repo override, and a per-agent override (most specific wins).
 *
 * Pure string logic only (no node deps) so it's safe to import in the sandboxed renderer.
 */

/** One injected env var: `name` (e.g. `CARGO_TARGET_DIR`) ← `value` (a template with tokens). */
export interface DeskEnvEntry {
  name: string;
  value: string;
}

/**
 * The tokens `expandTokens` understands in a `DeskEnvEntry.value`, resolved per desk:
 * - `buildRoot`   — the one build-output parent folder (`config.buildCacheDir`, else `<harnessHome>/build-cache`)
 * - `worktreeKey` — the per-working-tree subfolder (`<basename>-<hash>`; see `buildCacheKey`)
 * - `cwd`         — the desk's working directory (its worktree, or the base repo)
 * - `agentId`     — the desk id
 * - `harnessHome` — the harness home folder
 * Plus the parametric form `${env:NAME}` — the value of an existing process env var (for safe
 * append, e.g. `PATH=/extra:${env:PATH}`); resolved via the `envLookup` passed by the host.
 */
export type DeskEnvVars = {
  buildRoot: string;
  worktreeKey: string;
  cwd: string;
  agentId: string;
  harnessHome: string;
};

/** The named token forms available in a value template (for the Settings hint + chips). The
 *  parametric `${env:NAME}` is offered separately (it takes an arbitrary var name). */
export const DESK_ENV_TOKENS = ['buildRoot', 'worktreeKey', 'cwd', 'agentId', 'harnessHome'] as const;

/**
 * Zero-config default: redirect cargo's `target/` under the root, grouped by tool then per worktree
 * (`<root>/cargo/<key>`) so additional tools (e.g. `SCCACHE_DIR = ${buildRoot}/sccache/${worktreeKey}`)
 * coexist under the SAME root — one folder to exclude from antivirus. Used when `config.deskEnv` is
 * unset (and seeded into the Settings editor so the user sees + can edit it).
 */
export const DEFAULT_DESK_ENV: DeskEnvEntry[] = [
  { name: 'CARGO_TARGET_DIR', value: '${buildRoot}/cargo/${worktreeKey}' }
];

/**
 * Expand `${token}` placeholders in a template. A PREFIXED token `${prefix:name}` (e.g. `${env:PATH}`,
 * `${secret:GH_TOKEN}`) resolves via `lookup(prefix, name)` — the host wires this to `process.env` +
 * the secret vault (main only). The named tokens (`buildRoot`, …) resolve via `vars`. UNKNOWN tokens
 * (no `vars` entry / no `lookup` / lookup returns undefined) are left intact, so a literal survives and
 * a typo stays visible. Deterministic + pure (the only outside reads are via the injected `lookup`).
 * The renderer omits `lookup`, so a preview shows `${env:…}`/`${secret:…}` literally — values never
 * cross IPC.
 */
export function expandTokens(
  template: string,
  vars: Partial<DeskEnvVars>,
  lookup?: (prefix: string, name: string) => string | undefined
): string {
  return template.replace(/\$\{([^}]+)\}/g, (whole, raw: string) => {
    const token = raw.trim();
    const colon = token.indexOf(':');
    if (colon > 0) {
      const v = lookup?.(token.slice(0, colon), token.slice(colon + 1));
      return v === undefined ? whole : v;
    }
    const v = (vars as Record<string, string | undefined>)[token];
    return v === undefined ? whole : v;
  });
}

/**
 * Layer an `override` table ON TOP of `base`: a `base` entry is replaced by an `override` entry of the
 * same `name` (override wins), and `override` entries with new names are appended. Order: base order
 * preserved (with replacements in place), then the new override names. An empty/undefined override
 * returns the base unchanged. Pure. Used both by the main-process resolver and the renderer preview,
 * and composed for the global→repo→agent layering (`mergeDeskEnv(mergeDeskEnv(base, repo), agent)`).
 */
export function mergeDeskEnv(base: DeskEnvEntry[], override?: DeskEnvEntry[]): DeskEnvEntry[] {
  if (!override || override.length === 0) return base;
  const byName = new Map<string, DeskEnvEntry>();
  for (const e of override) if (e.name?.trim()) byName.set(e.name, e);
  const out: DeskEnvEntry[] = base.map((e) => byName.get(e.name) ?? e);
  const baseNames = new Set(base.map((e) => e.name));
  for (const e of override) if (e.name?.trim() && !baseNames.has(e.name)) out.push(e);
  return out;
}
