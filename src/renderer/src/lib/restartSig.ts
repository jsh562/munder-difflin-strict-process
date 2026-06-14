/**
 * "Restart required" detection for settings that are BAKED INTO A DESK AT SPAWN.
 *
 * A desk's prompt + spawn flags are fixed when its worker process forks (the host reads the
 * config once in `workerEnv`/`ensureAgent`). Changing one of these while a desk is running
 * therefore has NO effect until that desk is RESPAWNED — and a "resume from the floor" is only
 * an un-pause, not a respawn. So we stamp each desk, at spawn, with a snapshot of just these
 * values (`Agent.spawnSig`) and compare it to the live config: any difference means the desk is
 * running with outdated settings and owes a restart. Toggling a value back to its original
 * auto-clears the flag; a desk spawned AFTER the change is never falsely flagged.
 *
 * This is the SINGLE source of truth for which settings need a restart — add a field here to
 * have it tracked end-to-end (stamp + staleness + every indicator).
 */

/** The restart-required config subset (baked at spawn). Deliberately excludes `defaultModel`
 *  (non-retroactive by design — existing desks keep their snapshot) and the read-live settings
 *  (`nativeBashEnabled`/`webSearchEnabled`/breaker/caps), which take effect with no restart. */
export interface RestartSig {
  /** spec-driven (SDDP) mode — selects the desk's whole role-prompt set at spawn. */
  sddpMode: boolean;
  /** auto mode — bakes `--permission-mode bypassPermissions` into the spawn command. */
  autoMode: boolean;
  /** terminal theme — mirrored into the desk's per-session Claude settings at spawn. */
  terminalTheme: 'light' | 'dark';
}

/** Human labels for each restart-required key (shown in the "needs restart" banner/tooltips). */
export const RESTART_SIG_LABELS: Record<keyof RestartSig, string> = {
  sddpMode: 'spec-driven mode',
  autoMode: 'auto mode',
  terminalTheme: 'terminal theme'
};

/** Normalize any config-ish source (a HarnessConfig or the store's mirrored fields) into a
 *  RestartSig, so the boot mirror and the live signature are built the same way. */
export function restartSigOf(src: { sddpMode?: boolean; autoMode?: boolean; terminalTheme?: 'light' | 'dark' }): RestartSig {
  return {
    sddpMode: src.sddpMode === true,
    autoMode: src.autoMode === true,
    terminalTheme: src.terminalTheme === 'dark' ? 'dark' : 'light'
  };
}

/** Which restart-required keys differ between a desk's spawn snapshot and the live config.
 *  Empty ⇒ the desk is fresh. A desk with no snapshot (spawned before this feature) is treated
 *  as fresh — we never nag about a desk we can't reason about; it stamps on its next restart. */
export function deskStaleKeys(spawnSig: RestartSig | undefined, live: RestartSig): (keyof RestartSig)[] {
  if (!spawnSig) return [];
  return (Object.keys(live) as (keyof RestartSig)[]).filter((k) => spawnSig[k] !== live[k]);
}
