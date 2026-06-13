/**
 * NativeRuntime (E003) — the main-process registry of native agent workers, peer
 * to `ClaudeRuntime`. It spawns one `NativeAgentWorker` per agent, routes each
 * worker's end-of-turn `drainRequest` to the hive `drainForStop` (the worker
 * never touches the hive git — single-committer preserved), runs the shared exit
 * teardown/archive on worker exit (mirrors the PTY path), and bounds floor-wide
 * concurrency.
 */
import { AGENT_EVENT_VERSION, type AgentEvent } from '../../shared/agentEvent';
import type { UsageSnapshot } from '../../shared/providerRuntime';
import { NativeAgentWorker, type NativeTelemetrySink } from './nativeAgentWorker';
import { makeElectronWorkerTransport } from './electronWorkerTransport';
import { NATIVE_PROVIDER_MODEL_ENV } from '../credentials';

export interface NativeRuntimeDeps {
  /** Runs in MAIN — the worker requests it over IPC at end-of-turn. */
  drainForStop: (agentId: string) => { block: boolean; reason?: string };
  /**
   * E006 {FR-009} — runs in MAIN: execute one tool the worker requested against the
   * hive tool handlers (single-committer preserved). Absent ⇒ the worker gets a
   * clean failed result and self-corrects (no crash). Wired to the hive tool
   * dispatcher in `index.ts`.
   */
  executeToolFor?: (
    agentId: string,
    req: { toolCallId: string; toolName: string; toolInput: unknown }
  ) => Promise<{ content: string; success: boolean }>;
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
  /** Extra non-secret env merged into a native worker's spawn env (e.g. the shell/OS
   *  note + the god orchestration prompt). Receives the agentId so it can vary per
   *  desk (e.g. inject the orchestrator role only for the god). Merged over
   *  `process.env` by the transport, so it never replaces the inherited env. */
  workerEnv?: (agentId: string) => Record<string, string>;
  /** E007 T011/T017 {FR-008/011} — the telemetry forward sink. Each spawned worker's
   *  native usage + tool spans are normalized into the loopback collector's gen_ai.*
   *  branch (single-writer in main, AD-002), so a native desk reaches telemetry
   *  parity. Wired to the live `TelemetryCollector` in `index.ts`. */
  telemetry?: NativeTelemetrySink;
  /**
   * E008 T004/T005 {FR-016/037/043} — the native-event bridge sink. When present,
   * EACH spawned worker's normalized `AgentEvent` stream is forwarded into the
   * bridge (single-writer main), which append-and-commits each line to the per-agent
   * JSONL run log BEFORE forwarding it to the renderer over `agent:event`. Absent ⇒
   * no persist/forward (the bus still emits for other consumers; the panel bridge
   * just isn't wired). Wired to `createNativeEventBridge(...).ingest` in `index.ts`.
   */
  onAgentEvent?: (event: AgentEvent) => void;
}

export class NativeRuntime {
  private readonly workers = new Map<string, NativeAgentWorker>();

  constructor(private readonly deps: NativeRuntimeDeps) {}

  /**
   * Spawn a native worker for an assigned desk. `providerId` selects the credential
   * env (E004); `model` is the desk's ASSIGNED model id, threaded to the worker via
   * `NATIVE_PROVIDER_MODEL` so `selectAdapter` builds the right adapter (FR-008).
   *
   * Returns `{ ok:false, error:'needs-credentials' }` when a providerId is given but
   * no key is stored (E004 presence false): the desk is NOT started on a broken loop
   * — the caller surfaces a clear "needs credentials" state (T021 / FR-008 edge case).
   */
  spawn(agentId: string, providerId?: string, model?: string): { ok: boolean; error?: string } {
    if (this.workers.has(agentId)) return { ok: false, error: `native worker exists: ${agentId}` };
    const cap = this.deps.maxConcurrent ?? 15;
    if (this.workers.size >= cap) return { ok: false, error: `native concurrency cap (${cap}) reached` };

    // E004 — inject the provider credential at spawn (none ⇒ no key env).
    const credEnv = providerId ? this.deps.credentialEnvFor?.(providerId) : undefined;
    // Missing-key guard (T021 / FR-008): a native provider with no stored key must
    // not start a broken loop — surface "needs credentials" rather than spawning.
    if (providerId && !credEnv) return { ok: false, error: 'needs-credentials' };
    // Thread the assigned model id alongside the key/id env (no secret) so the
    // worker's selectAdapter targets the right model + endpoint (FR-008). Plus any
    // host-supplied non-secret env (the shell/OS note). Merged over process.env by the
    // transport, so an undefined result still inherits the parent env.
    const extraEnv = this.deps.workerEnv?.(agentId) ?? {};
    const baseEnv =
      credEnv && model
        ? { ...credEnv, [NATIVE_PROVIDER_MODEL_ENV]: model }
        : (credEnv ?? undefined);
    const env =
      baseEnv || Object.keys(extraEnv).length > 0 ? { ...baseEnv, ...extraEnv } : undefined;
    const worker = new NativeAgentWorker({
      agentId,
      transportFactory: () => makeElectronWorkerTransport({ agentId, maxOldSpaceMb: this.deps.maxOldSpaceMb, env }),
      usageFallback: () => this.deps.usageFor?.(agentId) ?? null,
      onExit: (id) => { this.workers.delete(id); this.deps.onWorkerExit(id); },
      onDrainRequest: async (id) => this.deps.drainForStop(id),
      onToolRequest: this.deps.executeToolFor
        ? async (id, req) => this.deps.executeToolFor!(id, req)
        : undefined,
      // E007 T011 — forward this worker's usage/tool spans into the collector's
      // gen_ai branch so a native desk reaches telemetry parity (FR-008/011).
      telemetry: this.deps.telemetry
    });
    this.workers.set(agentId, worker);
    // E008 T004 {FR-016/037/043} — forward THIS worker's normalized AgentEvent
    // stream into the single-writer bridge (persist-then-forward to the renderer).
    // Subscribed BEFORE start() so the very first event is captured; the bus
    // isolates listener errors, so the bridge can never break the event stream.
    if (this.deps.onAgentEvent) {
      const sink = this.deps.onAgentEvent;
      worker.subscribe((event) => sink(event));
    }
    void worker.start();
    return { ok: true };
  }

  /**
   * The native worker fronting an agent, or undefined when none is running. The
   * worker IS a `ProviderRuntime`, so `runtimeFor(agentId)?.send(input)` routes an
   * operator prompt / steer / drain into the running native agent (E008 T004/T005
   * {FR-015/021}) — the reachable send seam the `native:send` IPC drives.
   */
  runtimeFor(agentId: string): NativeAgentWorker | undefined {
    return this.workers.get(agentId);
  }

  count(): number {
    return this.workers.size;
  }

  /**
   * Stop ONE native worker (the operator's per-agent kill seam, peer to `pty:kill`).
   * `worker.kill()` fires the worker's `onExit`, which removes it from the map and runs
   * the shared archive teardown (same path as a natural exit). Returns a structured ack
   * so the IPC layer can report whether a live worker was actually stopped.
   */
  kill(agentId: string): { ok: boolean; error?: string } {
    const worker = this.workers.get(agentId);
    if (!worker) return { ok: false, error: 'no native runtime for agent' };
    worker.kill();
    this.workers.delete(agentId); // idempotent with onExit — don't wait on the exit event
    // The worker dies mid-turn with NO final event (process.exit), so the folded
    // transcript's open turn would stay 'pending' and blink "working…" forever. Emit a
    // synthetic terminal `stop` through the SAME bridge sink the worker uses — the fold
    // treats `stop` as a global terminal signal (settles open turns) and it's persisted,
    // so the indicator clears immediately AND after a reload.
    this.deps.onAgentEvent?.({
      v: AGENT_EVENT_VERSION,
      agentId,
      sessionId: null,
      ts: Date.now(),
      kind: 'stop',
      reason: 'stopped by operator',
      stopActive: true
    });
    return { ok: true };
  }

  killAll(): void {
    for (const worker of this.workers.values()) worker.kill();
    this.workers.clear();
  }
}
