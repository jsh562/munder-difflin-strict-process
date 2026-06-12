/**
 * NativeEventBridge (E008 / AD-002/AD-003) — the SINGLE-WRITER main→renderer bridge
 * for native (DeepSeek/Minimax) agent activity.
 *
 * Each native `NativeAgentWorker` emits the normalized `AgentEvent` stream on its
 * in-process `AgentEventBus`. The renderer has NO native-event subscription today,
 * so this bridge is the missing seam: per AgentEvent it APPENDS-AND-COMMITS the
 * line to the per-agent JSONL run log (`appendNativeEvent`) BEFORE forwarding it to
 * the renderer over the per-agent `agent:event` IPC channel. Main is the SOLE
 * writer of that log (FR-043) — no renderer/worker write — so the persisted stream
 * stays the single, ordered source of truth that replay rebuilds the views from.
 *
 * 🔒 SECRET-FREE (ADR-0007/FR-041): the bridge persists + forwards ONLY the
 * `AgentEvent` fields it is handed — it NEVER injects a key, auth header, or any
 * credential at any nesting depth. Credentials ride spawn `env`, never the bus.
 *
 * Ordering & non-blocking (FR-030/FR-037): events are processed in ARRIVAL ORDER
 * on a single serialized async chain. The worker's message loop is never blocked on
 * disk I/O — `ingest` only enqueues; the chain drains it. Within the chain, each
 * event is persisted, then (and only then) forwarded — append-and-commit precedes
 * forward, per event, so a panel that reopens after a crash replays exactly what the
 * renderer last saw (FR-037). A persist failure is isolated and never reorders or
 * drops a later event.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { AgentEvent } from '../../shared/agentEvent';

/** The persistence + forward seams the bridge drives. Both injected so the bridge
 *  is electron-free and unit-testable with fakes (the real wiring passes the hive's
 *  `appendNativeEvent` and a `webContents.send`-backed forward in `index.ts`). */
export interface NativeEventBridgeDeps {
  /** Append ONE AgentEvent line to the agent's run log, committing it to disk.
   *  Returns whether the line was committed (false ⇒ persistence off / disk error).
   *  Mirrors `HiveManager.appendNativeEvent`. */
  persist: (event: AgentEvent) => boolean;
  /** Forward ONE AgentEvent to the renderer over the per-agent `agent:event`
   *  channel (a `webContents.send`-backed call in main). Best-effort. */
  forward: (event: AgentEvent) => void;
}

/** The bridge handle. `ingest` is the sole entry point the runtime subscription
 *  feeds; `idle` resolves when the queue has fully drained (tests/teardown). */
export interface NativeEventBridge {
  /** Enqueue ONE AgentEvent for persist-then-forward, in arrival order. Returns
   *  immediately — never blocks the caller (the worker message loop) on disk. */
  ingest: (event: AgentEvent) => void;
  /** Resolves once every enqueued event has been persisted + forwarded. */
  idle: () => Promise<void>;
}

/**
 * Build a single-writer bridge over the injected persist/forward seams. ONE bridge
 * may serve many agents (each line carries its own `agentId`), or one per agent —
 * the serialized chain preserves global arrival order either way.
 */
export function createNativeEventBridge(deps: NativeEventBridgeDeps): NativeEventBridge {
  // The arrival-ordered work queue + the single in-flight drain promise. `ingest`
  // pushes and (re)starts the drain; only ONE drain runs at a time, so events are
  // persisted-then-forwarded strictly in the order they arrived (single-writer).
  const queue: AgentEvent[] = [];
  let draining: Promise<void> | null = null;

  async function drain(): Promise<void> {
    while (queue.length > 0) {
      const event = queue.shift()!;
      // Append-and-commit BEFORE forward (FR-037): the renderer never sees an event
      // that wasn't first committed, so a reopen after a crash replays what it saw.
      // A persist failure is isolated — we still forward the live event (best-effort
      // durability), never throwing out of the chain or dropping later events.
      try { deps.persist(event); } catch { /* best-effort persist — never break the chain */ }
      try { deps.forward(event); } catch { /* best-effort forward — window may be gone */ }
      // Yield between events so a burst can't monopolize the main thread; the
      // renderer is never blocked on this disk/serialize work (FR-030).
      await Promise.resolve();
    }
    draining = null;
  }

  return {
    ingest(event: AgentEvent): void {
      queue.push(event);
      if (!draining) draining = drain();
    },
    async idle(): Promise<void> {
      while (draining) await draining;
    }
  };
}

/**
 * Replay the persisted run log (E008 T003 {FR-016/042/043/045}).
 *
 * Read the per-agent JSONL ONCE, top-to-bottom, and return the ordered AgentEvent
 * array the renderer folds into its views. The persisted stream is the single
 * source of truth; this is a READ-ONLY pass over the append-only log (it never
 * mutates it), so replay is deterministic + idempotent (re-opening/restarting
 * rebuilds the same views, FR-039).
 *
 * GRACEFUL DEGRADATION (FR-016/042/043, data-model C5) — each mode is a DISTINCT
 * non-erroring outcome, never fatal:
 *   - missing file        → [] (empty state)
 *   - unreadable file     → [] (caught; never throws)
 *   - a corrupt/partial line (bad JSON, not an object) → SKIPPED
 *   - a truncated TRAILING line (a torn write — the append was cut mid-line on a
 *     crash) → SKIPPED like any other unparseable line
 * All 12 AgentEvent kinds round-trip as-is; a line whose `v` differs is kept and
 * folded best-effort downstream (no schema rejection here, C3/FR-045). Only the
 * AgentEvent ENVELOPE shape (`agentId` + a string `kind`) is required to retain a
 * line — payload validity is the fold's concern, not this reader's.
 */
export function loadNativeEvents(path: string | null): AgentEvent[] {
  if (!path) return [];
  let raw: string;
  try {
    if (!existsSync(path)) return []; // missing → empty state, not an error
    raw = readFileSync(path, 'utf8');
  } catch {
    return []; // unreadable → degrade to empty, never throw
  }
  const out: AgentEvent[] = [];
  // Splitting on '\n' makes a torn trailing append its own (unparseable) fragment,
  // which the per-line guard below simply skips — no special trailing-line casing.
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue; // blank/whitespace line — skip
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // corrupt / partial / truncated-tail line — skip, keep replaying
    }
    if (isAgentEventLike(parsed)) out.push(parsed as AgentEvent);
  }
  return out;
}

/** True when a parsed JSON value carries the AgentEvent envelope this reader needs
 *  to retain it: a non-null object with a string `agentId` and a string `kind`.
 *  Per-kind payload validity is intentionally NOT enforced here (the fold tolerates
 *  best-effort / `v`-mismatched lines, FR-045) — this only filters out lines that
 *  are not events at all (e.g. a stray non-object JSON literal). */
function isAgentEventLike(value: unknown): value is AgentEvent {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.agentId === 'string' && typeof v.kind === 'string';
}
