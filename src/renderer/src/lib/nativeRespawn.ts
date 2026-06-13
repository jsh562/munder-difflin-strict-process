import type { Agent } from '@/store/store';
import { buildSpawnCommand, type HarnessConfig } from '@/store/config';

const RESPAWN_COOLDOWN_MS = 15000;
// Module-level so every caller (the inbox-wake loop in useHive AND the message
// composer) shares ONE throttle per agent — a crash-looping or repeatedly-poked
// worker can't be respawned more than once per cooldown no matter who triggers it.
const lastRespawnAt = new Map<string, number>();

/**
 * Bring a DOWNED native (DeepSeek/Minimax) worker back so a message delegated to —
 * or typed at — it can actually land. The worker exited or was lost on a restart, but
 * its store record + hive inbox survive; re-spawn it from its own recipe (same
 * id/cwd/model/command as the "restore team" button) — the main spawn router sends a
 * native model to nativeRuntime.spawn. Idempotent: if the worker is already alive the
 * spawn returns "native worker exists" and this is a harmless no-op. Throttled per
 * agent so a crash loop can't thrash. Returns true if a spawn was attempted.
 *
 * Deliberately fire-and-forget: the caller does NOT mark the message delivered, so the
 * next wake tick / queue flush (worker now alive + idle) delivers it and the worker's
 * end-of-turn drain picks up the queued inbox mail.
 */
export function respawnNativeWorker(agent: Agent, config: HarnessConfig | null): boolean {
  const now = Date.now();
  if (now - (lastRespawnAt.get(agent.id) ?? 0) < RESPAWN_COOLDOWN_MS) return false;
  // A created agent always carries its spawn `command`; `config` is only the fallback
  // for old records that predate the persisted field, so callers without config (e.g.
  // the composer) can still revive a worker from its own recipe.
  const command = (agent.command ?? '').trim() || (config ? buildSpawnCommand(config, agent.model) : '');
  if (!command || !agent.cwd) return false;
  lastRespawnAt.set(agent.id, now);
  const [exe, ...args] = command.split(/\s+/);
  void window.cth.spawnPty({
    id: agent.ptyId ?? `pty-${agent.id}`,
    cwd: agent.cwd,
    command: exe,
    args,
    cols: 100,
    rows: 30,
    hive: { id: agent.id, name: agent.name, cwd: agent.cwd, role: agent.description }
  }).catch(() => { /* best-effort; the next trigger retries after the cooldown */ });
  return true;
}
