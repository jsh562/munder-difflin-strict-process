/**
 * NativeRuntime (E003) — the main-process registry of native agent workers, peer
 * to `ClaudeRuntime`. It spawns one `NativeAgentWorker` per agent, routes each
 * worker's end-of-turn `drainRequest` to the hive `drainForStop` (the worker
 * never touches the hive git — single-committer preserved), runs the shared exit
 * teardown/archive on worker exit (mirrors the PTY path), and bounds floor-wide
 * concurrency.
 */
import type { UsageSnapshot } from '../../shared/providerRuntime';
import { NativeAgentWorker } from './nativeAgentWorker';
import { makeElectronWorkerTransport } from './electronWorkerTransport';

export interface NativeRuntimeDeps {
  /** Runs in MAIN — the worker requests it over IPC at end-of-turn. */
  drainForStop: (agentId: string) => { block: boolean; reason?: string };
  /** Shared teardown/archive (same path a PTY exit runs). */
  onWorkerExit: (agentId: string) => void;
  /** Usage seam fallback. */
  usageFor?: (agentId: string) => UsageSnapshot | null;
  /** Floor-wide concurrency cap (default 15). */
  maxConcurrent?: number;
  /** Per-worker heap cap, MB (execArgv --max-old-space-size). */
  maxOldSpaceMb?: number;
  /** E004 — the credential injection seam: provider id → spawn env, or null when
   *  no key is set. Wired to `injectionEnvForProvider(readConfig(), providerId)`. */
  credentialEnvFor?: (providerId: string) => Record<string, string> | null;
}

export class NativeRuntime {
  private readonly workers = new Map<string, NativeAgentWorker>();

  constructor(private readonly deps: NativeRuntimeDeps) {}

  spawn(agentId: string, providerId?: string): { ok: boolean; error?: string } {
    if (this.workers.has(agentId)) return { ok: false, error: `native worker exists: ${agentId}` };
    const cap = this.deps.maxConcurrent ?? 15;
    if (this.workers.size >= cap) return { ok: false, error: `native concurrency cap (${cap}) reached` };

    // E004 — inject the provider credential at spawn (none ⇒ no key env).
    const env = providerId ? (this.deps.credentialEnvFor?.(providerId) ?? undefined) : undefined;
    const worker = new NativeAgentWorker({
      agentId,
      transportFactory: () => makeElectronWorkerTransport({ agentId, maxOldSpaceMb: this.deps.maxOldSpaceMb, env }),
      usageFallback: () => this.deps.usageFor?.(agentId) ?? null,
      onExit: (id) => { this.workers.delete(id); this.deps.onWorkerExit(id); },
      onDrainRequest: async (id) => this.deps.drainForStop(id)
    });
    this.workers.set(agentId, worker);
    void worker.start();
    return { ok: true };
  }

  runtimeFor(agentId: string): NativeAgentWorker | undefined {
    return this.workers.get(agentId);
  }

  count(): number {
    return this.workers.size;
  }

  killAll(): void {
    for (const worker of this.workers.values()) worker.kill();
    this.workers.clear();
  }
}
