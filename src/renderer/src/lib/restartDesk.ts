import { useStore, type Agent } from '@/store/store';
import { buildSpawnCommand } from '@/store/config';
import { isNativeRuntimeDesk } from './runtimeKind';
import { disposeTerminal } from '@/components/terminalPool';

/**
 * Respawn a desk with an optional new model and/or working directory — the one path that
 * works for BOTH a native desk (no PTY → `nativeKill` + `spawnPty` routed to the native
 * runtime) and a Claude desk (`killPty` + `spawnPty`). The old `restartWithModel` only
 * handled Claude (it early-returned on `!a.ptyId`), so native model/cwd changes were
 * impossible — this fixes that and powers the "change workspace" control.
 *
 * The new `cwd`/`model` are passed through `spawnPty` → `ensureAgent`, which rewrites the
 * registry; the renderer record is updated by the caller (reassignAgentModel / setAgentCwd).
 * Roles + identity ride along so the respawn re-injects the right prompt.
 */
export async function restartDesk(
  agent: Agent,
  opts: { model?: string; cwd?: string } = {}
): Promise<{ ok: boolean; error?: string }> {
  const cfg = await window.cth.getConfig();
  const fleetDefault = useStore.getState().fleetDefaultModel;
  const model = 'model' in opts ? opts.model : agent.model;
  const cwd = opts.cwd ?? agent.cwd;
  const command = buildSpawnCommand(cfg, model);
  const [exe, ...args] = command.trim().split(/\s+/);
  const native = isNativeRuntimeDesk(agent, fleetDefault);

  try {
    if (native) {
      await window.cth.nativeKill(agent.id).catch(() => { /* may already be down */ });
    } else if (agent.ptyId) {
      await window.cth.killPty(agent.ptyId);
      disposeTerminal(agent.ptyId);
    }
  } catch { /* best-effort teardown */ }

  const id = agent.ptyId ?? `pty-${agent.id}`;
  return window.cth.spawnPty({
    id,
    cwd,
    command: exe,
    args,
    cols: 100,
    rows: 30,
    hive: {
      id: agent.id,
      name: agent.name,
      cwd,
      role: agent.description,
      roles: agent.roles,
      isGod: agent.isGod,
      isAssistant: agent.isAssistant
    }
  });
}

// Debounce timers, one per desk, so a flurry of role toggles coalesces into a SINGLE
// respawn instead of thrashing the desk on every click.
const restartTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Schedule a debounced desk restart for `agentId` (default ~1.2s). A role change applies
 * its CAPABILITY gate live (the registry is the source of truth), but the role's PROMPT only
 * re-injects on (re)spawn — so after toggling roles we auto-restart the desk to pick the
 * prompt up, with no manual step. Reads the LATEST agent record at fire time (after the store
 * write has settled), so rapid toggles all fold into one respawn carrying the final role set.
 */
export function scheduleDeskRestart(agentId: string, delayMs = 1200): void {
  const existing = restartTimers.get(agentId);
  if (existing) clearTimeout(existing);
  restartTimers.set(agentId, setTimeout(() => {
    restartTimers.delete(agentId);
    const agent = useStore.getState().agents.find((a) => a.id === agentId);
    if (agent) void restartDesk(agent).catch(() => { /* best-effort — desk may be down */ });
  }, delayMs));
}
