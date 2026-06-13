import { useStore, type Agent } from '@/store/store';

/**
 * Operator Stop/Pause for a desk, shared by the god's Command Center and a worker's
 * detail panel. Routing by runtime kind keeps one call-site honest:
 *  - STOP a native desk → kill its worker (`native:kill`); a Claude desk → `pty:kill`.
 *    Stopping the god also records the intent (`godDesired='stopped'`) so the boot
 *    effect keeps him down across reloads until Start; a worker just goes cold and
 *    revives on the next delegation/message.
 *  - PAUSE → main's `control.pause` (tools denied) PLUS a renderer `paused` flag so the
 *    inbox-wake (#3) / queue-drain (#4) leave it alone; Resume clears both.
 */
export async function stopAgent(agent: Agent, isNative: boolean): Promise<void> {
  if (agent.isGod) useStore.getState().setGodDesired('stopped');
  try {
    if (isNative) await window.cth.nativeKill(agent.id);
    else if (agent.ptyId) await window.cth.killPty(agent.ptyId);
  } catch { /* best-effort — the worker may already be gone */ }
}

/** Bring the god back after a Stop: the boot effect (useHive #1) re-runs and respawns. */
export function startGod(): void {
  useStore.getState().setGodDesired('running');
}

export async function pauseAgent(id: string, on: boolean): Promise<void> {
  try {
    if (on) await window.cth.controlPause(id, true);
    else await window.cth.controlResume(id);
  } catch { /* best-effort */ }
  useStore.getState().setPaused(id, on);
}
