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
