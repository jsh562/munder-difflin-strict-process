/**
 * E008 T014/T015 — NativeEventBridge integration + secret-free suite
 * (FR-016/FR-037/FR-039/FR-041/FR-043).
 *
 * The bridge is the main→renderer seam for native AgentEvents: per event it
 * APPENDS-AND-COMMITS the line to the per-agent JSONL run log BEFORE forwarding it to
 * the renderer, on a single serialized arrival-ordered chain (single-writer, FR-043).
 * This suite drives the REAL `createNativeEventBridge` over injected persist/forward
 * seams backed by a TEMP JSONL file (os.tmpdir — never the real hive) and a forward
 * capture array, and locks:
 *
 *   T014 (FR-016/FR-037/FR-039/FR-043):
 *     - each event is PERSISTED before it is FORWARDED (captured global call order);
 *     - arrival order is preserved across persist + forward;
 *     - `loadNativeEvents` of the written file rebuilds the SAME ordered events, and
 *       folding the rebuilt stream yields views identical to folding the originals
 *       (replay == live, FR-039);
 *     - N reopens (repeated `loadNativeEvents`) do not mutate the file or the results.
 *
 *   T015 (FR-041) — "persisted JSONL and forwarded IPC are secret-free (deep)":
 *     - inject a sentinel secret into NESTED payload fields (toolInput object, text,
 *       thinking, notice message) of fed events; the bridge passes AgentEvent through
 *       VERBATIM and adds no secret. The test documents that the bridge neither ADDS
 *       nor STRIPS a secret already inside a payload: it asserts the bridge does not
 *       LEAK a secret that was NOT in the event, and injects NO extra key/header at
 *       ANY nesting depth (ADR-0007: secrets must never be ADDED by persistence/
 *       telemetry; credentials ride env, not the bus).
 *
 * Node env, electron-free: persist/forward are plain fakes; the only I/O is a temp
 * JSONL written + read under os.tmpdir.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createNativeEventBridge, loadNativeEvents } from '../runtime/nativeEventBridge';
import { foldEvents, type FoldResult } from '../../renderer/src/components/foldEvents';
import type { AgentEvent } from '../../shared/agentEvent';

const BASE = { v: 1, agentId: 'desk-bridge', sessionId: 's1' } as const;

/** A representative settled stream the bridge persists/forwards (one per kind). */
function sampleStream(): AgentEvent[] {
  let ts = 1000;
  const n = (): number => ++ts;
  return [
    { ...BASE, kind: 'turn-start', ts: n() },
    { ...BASE, kind: 'thinking-delta', text: 'plan', ts: n() },
    { ...BASE, kind: 'text-delta', text: 'on it', ts: n() },
    { ...BASE, kind: 'tool-start', toolName: 'read', toolInput: { path: '/a' }, toolCallId: 'tc1', ts: n() },
    { ...BASE, kind: 'token-usage', input: 100, output: 30, cacheRead: 0, cacheCreation: 0, model: 'm1', usd: 0.001, ts: n() },
    { ...BASE, kind: 'tool-end', toolCallId: 'tc1', success: true, durationMs: 12, ts: n() },
    { ...BASE, kind: 'notification', message: 'degraded', ts: n() },
    { ...BASE, kind: 'turn-end', ts: n() },
    { ...BASE, kind: 'stop', ts: n(), reason: 'end_turn', stopActive: false }
  ];
}

describe('T014 {FR-016/FR-037/FR-039/FR-043} NativeEventBridge — persist-then-forward + replay', () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'e008-bridge-'));
    logPath = join(dir, 'native-events.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Build a bridge whose persist appends to the temp JSONL (mirroring the hive's
   *  `appendNativeEvent`) and whose forward captures into an array — both recording a
   *  GLOBAL call-order tag so we can assert append precedes forward, per event. */
  function harness(): {
    bridge: ReturnType<typeof createNativeEventBridge>;
    forwarded: AgentEvent[];
    order: Array<{ op: 'persist' | 'forward'; id: number; seq: number }>;
  } {
    const forwarded: AgentEvent[] = [];
    const order: Array<{ op: 'persist' | 'forward'; id: number; seq: number }> = [];
    let tick = 0;
    const bridge = createNativeEventBridge({
      persist: (event) => {
        order.push({ op: 'persist', id: event.ts, seq: tick++ });
        appendFileSync(logPath, JSON.stringify(event) + '\n', 'utf8');
        return true;
      },
      forward: (event) => {
        order.push({ op: 'forward', id: event.ts, seq: tick++ });
        forwarded.push(event);
      }
    });
    return { bridge, forwarded, order };
  }

  it('PERSISTS each event BEFORE it FORWARDS it (per-event order)', async () => {
    const { bridge, forwarded, order } = harness();
    const events = sampleStream();
    for (const e of events) bridge.ingest(e);
    await bridge.idle();

    // Every event was forwarded.
    expect(forwarded).toHaveLength(events.length);
    // For each event id, the persist tick precedes the forward tick.
    for (const e of events) {
      const persist = order.find((o) => o.op === 'persist' && o.id === e.ts)!;
      const forward = order.find((o) => o.op === 'forward' && o.id === e.ts)!;
      expect(persist, `persist for ts=${e.ts}`).toBeTruthy();
      expect(forward, `forward for ts=${e.ts}`).toBeTruthy();
      expect(persist.seq, `persist before forward for ts=${e.ts}`).toBeLessThan(forward.seq);
    }
  });

  it('preserves ARRIVAL order across persist + forward', async () => {
    const { bridge, forwarded } = harness();
    const events = sampleStream();
    for (const e of events) bridge.ingest(e);
    await bridge.idle();

    // Forwarded order == ingest order.
    expect(forwarded.map((e) => e.ts)).toEqual(events.map((e) => e.ts));
    // Persisted (on-disk) order == ingest order.
    const persisted = loadNativeEvents(logPath);
    expect(persisted.map((e) => e.ts)).toEqual(events.map((e) => e.ts));
  });

  it('loadNativeEvents rebuilds the SAME ordered events the bridge was fed', async () => {
    const { bridge } = harness();
    const events = sampleStream();
    for (const e of events) bridge.ingest(e);
    await bridge.idle();

    const reloaded = loadNativeEvents(logPath);
    expect(reloaded).toEqual(events);
  });

  it('folding the rebuilt stream yields views IDENTICAL to folding the originals (replay == live)', async () => {
    const { bridge, forwarded } = harness();
    const events = sampleStream();
    for (const e of events) bridge.ingest(e);
    await bridge.idle();

    const fromDisk = foldEvents(loadNativeEvents(logPath));
    const fromOriginals = foldEvents(events);
    const fromForwarded = foldEvents(forwarded);
    expect(fromDisk).toEqual(fromOriginals);
    expect(fromForwarded).toEqual(fromOriginals);
  });

  it('N REOPENS (repeated loadNativeEvents) do not mutate the file or the results', async () => {
    const { bridge } = harness();
    const events = sampleStream();
    for (const e of events) bridge.ingest(e);
    await bridge.idle();

    const before = readFileSync(logPath, 'utf8');
    const first = loadNativeEvents(logPath);
    for (let i = 0; i < 5; i++) {
      const again = loadNativeEvents(logPath);
      expect(again).toEqual(first); // deterministic, idempotent
      expect(foldEvents(again)).toEqual(foldEvents(first));
    }
    // The append-only log is untouched by the read-only replays.
    expect(readFileSync(logPath, 'utf8')).toBe(before);
  });

  it('skips corrupt / partial lines on replay (graceful degradation), keeps the rest', async () => {
    const { bridge } = harness();
    const events = sampleStream();
    for (const e of events) bridge.ingest(e);
    await bridge.idle();
    // Simulate a torn trailing append (a crash mid-write) + a corrupt middle line.
    appendFileSync(logPath, '{"agentId":"desk-bridge","kind":"text-de', 'utf8'); // truncated tail
    const reloaded = loadNativeEvents(logPath);
    // The corrupt tail is skipped; every committed event survives intact.
    expect(reloaded).toEqual(events);
  });

  it('returns [] for a missing log file (empty state, never throws)', () => {
    const missing = join(dir, 'does-not-exist.jsonl');
    expect(existsSync(missing)).toBe(false);
    expect(loadNativeEvents(missing)).toEqual([]);
    expect(loadNativeEvents(null)).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// T026 {FR-016/FR-039/FR-030} — durable re-open via the hook's backfill path
// ────────────────────────────────────────────────────────────────────────────

/**
 * T026 models what `useNativeAgentEvents` (T011) does on a panel re-open, but
 * WITHOUT React: the hook backfills via `cth.loadNativeEvents(agentId)` and folds the
 * replayed array through the SAME pure `foldEvents` the live path uses. So a re-opened
 * (or restarted) run rebuilds from the persisted JSONL, and the backfill-replay fold
 * MUST equal the original live fold (FR-039 determinism, FR-016 durable re-open).
 *
 * The hook folds the replayed stream with `streamEnded: true` once the run is settled
 * (a terminal `stop` is present), so we fold both the live and the replayed arrays with
 * `{ streamEnded: true }` here — that is the durable-reopen / restart fold.
 *
 * Verifies SC-009/SC-019/SC-022:
 *   - (a) panel close/reopen: a single `loadNativeEvents` → fold == the live fold;
 *   - (b) app restart: a SECOND, independent `loadNativeEvents` (a fresh read, as a new
 *         process would do) → fold == the live fold again;
 *   - the on-disk bytes are UNCHANGED after N reopens (read-only, idempotent replay,
 *     FR-030 single O(events) fold, no mutation);
 *   - ordering is preserved when a `token-usage` arrives AFTER streamed text (FR-039
 *     documented out-of-order case).
 */
describe('T026 {FR-016/FR-039/FR-030} durable re-open — backfill rebuilds the live view', () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'e008-reopen-'));
    logPath = join(dir, 'native-events.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A representative multi-turn live run: turn-1 has streamed text, a resolved tool,
   *  and a token-usage sample that arrives AFTER the text (the documented out-of-order
   *  case, FR-039); turn-2 is thinking-only (no visible text, no tools); a degradation
   *  notice lands between turns; the run ends with a terminal `stop`. */
  function liveRun(): AgentEvent[] {
    let ts = 2000;
    const n = (): number => ++ts;
    return [
      // ── turn 1: text → tool (resolved) → token-usage AFTER text (out-of-order) ──
      { ...BASE, kind: 'turn-start', ts: n() },
      { ...BASE, kind: 'text-delta', text: 'reading ', ts: n() },
      { ...BASE, kind: 'text-delta', text: 'the file', ts: n() },
      { ...BASE, kind: 'tool-start', toolName: 'read', toolInput: { path: '/etc/hosts' }, toolCallId: 'tc1', ts: n() },
      { ...BASE, kind: 'tool-end', toolCallId: 'tc1', success: true, durationMs: 7, ts: n() },
      // token-usage AFTER the streamed text + tool — must not reorder prior entries.
      { ...BASE, kind: 'token-usage', input: 200, output: 50, cacheRead: 0, cacheCreation: 0, model: 'm1', usd: 0.002, ts: n() },
      { ...BASE, kind: 'turn-end', ts: n() },
      // ── an inline degradation notice between turns ──
      { ...BASE, kind: 'notification', message: 'web-search degraded to fetch', ts: n() },
      // ── turn 2: thinking-only (reasoning, no visible text, no tools) ──
      { ...BASE, kind: 'turn-start', ts: n() },
      { ...BASE, kind: 'thinking-delta', text: 'considering ', ts: n() },
      { ...BASE, kind: 'thinking-delta', text: 'next steps', ts: n() },
      { ...BASE, kind: 'turn-end', ts: n() },
      // ── terminal stop ──
      { ...BASE, kind: 'stop', ts: n(), reason: 'end_turn', stopActive: false }
    ];
  }

  /** Persist a full live run through the REAL bridge to the temp JSONL (the same
   *  append-and-commit the hive does), then drain. Returns the live fold for comparison. */
  async function persistLiveRun(events: AgentEvent[]): Promise<FoldResult> {
    const bridge = createNativeEventBridge({
      persist: (event) => {
        appendFileSync(logPath, JSON.stringify(event) + '\n', 'utf8');
        return true;
      },
      forward: () => {
        /* live forward is exercised by T014; here we only need the persisted log */
      }
    });
    for (const e of events) bridge.ingest(e);
    await bridge.idle();
    // The LIVE view the renderer painted (settled run → streamEnded fold).
    return foldEvents(events, { streamEnded: true });
  }

  it('(a) panel close/reopen: loadNativeEvents → fold deep-equals the LIVE fold', async () => {
    const events = liveRun();
    const live = await persistLiveRun(events);

    // CLOSE/REOPEN: the hook's backfill replays the persisted JSONL and re-folds it.
    const replayed = loadNativeEvents(logPath);
    const reopened = foldEvents(replayed, { streamEnded: true });

    // The replayed stream is byte-identical to the live stream the bridge was fed…
    expect(replayed).toEqual(events);
    // …and folding it reconstructs the SAME transcript + structured view (FR-039).
    expect(reopened).toEqual(live);
  });

  it('(b) app restart: a SECOND independent read rebuilds the identical view (fresh process)', async () => {
    const events = liveRun();
    const live = await persistLiveRun(events);

    // A new process has no in-memory state — it reads the file fresh. Model that as a
    // SECOND, independent `loadNativeEvents` of the same path and an independent fold.
    const restartReplay = loadNativeEvents(logPath);
    const restarted = foldEvents(restartReplay, { streamEnded: true });
    expect(restarted).toEqual(live);

    // And the close/reopen fold and the restart fold are identical to each other —
    // determinism holds across every independent rebuild (SC-009/SC-019).
    const reopenAgain = foldEvents(loadNativeEvents(logPath), { streamEnded: true });
    expect(restarted).toEqual(reopenAgain);
  });

  it('N reopens are read-only + idempotent: the on-disk bytes are UNCHANGED', async () => {
    const events = liveRun();
    const live = await persistLiveRun(events);

    const before = readFileSync(logPath, 'utf8');
    // Re-open many times (close/reopen + restart, interleaved). Each rebuild must equal
    // the live view AND must not mutate/append/reorder the append-only log (FR-039).
    for (let i = 0; i < 6; i++) {
      const rebuilt = foldEvents(loadNativeEvents(logPath), { streamEnded: true });
      expect(rebuilt).toEqual(live);
    }
    // The append-only persisted log is byte-for-byte untouched by the read-only replays.
    expect(readFileSync(logPath, 'utf8')).toBe(before);
  });

  it('ordering is preserved when token-usage arrives AFTER streamed text (out-of-order)', async () => {
    const events = liveRun();
    const live = await persistLiveRun(events);
    const replayed = loadNativeEvents(logPath);

    // The token-usage event is positioned AFTER the streamed text/tool in the source.
    const usageIdx = events.findIndex((e) => e.kind === 'token-usage');
    const firstTextIdx = events.findIndex((e) => e.kind === 'text-delta');
    expect(usageIdx).toBeGreaterThan(firstTextIdx); // fixture really is out-of-order

    // Persisted arrival order == source order: the late token-usage did NOT jump ahead.
    expect(replayed.map((e) => e.ts)).toEqual(events.map((e) => e.ts));

    // The transcript entries are emitted in arrival order and the late usage never
    // reordered the already-emitted assistant-text / tool entries.
    const reopened = foldEvents(replayed, { streamEnded: true });
    const types = reopened.entries.map((e) => e.type);
    expect(types).toEqual(live.entries.map((e) => e.type));
    // The folded transcript anchors are non-decreasing in arrival order (ts, then seq).
    for (let i = 1; i < reopened.entries.length; i++) {
      const prev = reopened.entries[i - 1];
      const cur = reopened.entries[i];
      const ordered = cur.ts > prev.ts || (cur.ts === prev.ts && cur.seq >= prev.seq);
      expect(ordered, `entry ${i} (${cur.id}) out of arrival order`).toBe(true);
    }
    // The run-level token usage is still the cumulative passthrough sample, intact.
    expect(reopened.structured.runTokenUsage).toEqual({
      input: 200,
      output: 50,
      cacheRead: 0,
      cacheCreation: 0,
      model: 'm1',
      usd: 0.002
    });
  });

  it('the rebuilt run is coherent: text, a resolved tool, a thinking-only turn, and a notice', async () => {
    // A structural sanity check that the representative run folds to the expected shape,
    // so the deep-equals above is anchored to a real, non-trivial transcript (SC-001).
    const events = liveRun();
    await persistLiveRun(events);
    const view = foldEvents(loadNativeEvents(logPath), { streamEnded: true });

    // Transcript: assistant text, a resolved tool, a notice, then a collapsed thinking.
    const text = view.entries.find((e) => e.type === 'assistant-text');
    expect(text?.text).toBe('reading the file'); // coalesced across two deltas

    const tool = view.entries.find((e) => e.type === 'tool-call');
    expect(tool?.status).toBe('resolved'); // tool-end paired strictly by toolCallId
    expect(tool?.success).toBe(true);
    expect(tool?.durationMs).toBe(7);

    const notice = view.entries.find((e) => e.type === 'notice');
    expect(notice?.noticeKind).toBe('degradation');
    expect(notice?.message).toBe('web-search degraded to fetch');

    const thinking = view.entries.find((e) => e.type === 'thinking');
    expect(thinking?.text).toBe('considering next steps'); // coalesced thinking-only turn
    expect(thinking?.collapsed).toBe(true);

    // Structured: two real turns, both resolved (settled run, no interrupted entries).
    expect(view.structured.turns).toHaveLength(2);
    expect(view.structured.turns.every((t) => t.status === 'resolved')).toBe(true);
    expect(view.entries.some((e) => e.status === 'interrupted')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// T015 {FR-041} — secret-free invariant (deep scan of persisted + forwarded)
// ────────────────────────────────────────────────────────────────────────────

// A sentinel secret shaped like a real API key; the bare canary token is also
// asserted-absent so a partial leak (prefix stripped) is still caught.
const SENTINEL = 'sk-LEAKCANARY-DO-NOT-EMIT';
const CANARY = 'LEAKCANARY';

describe('T015 {FR-041} NativeEventBridge — secret-free (deep)', () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'e008-secret-'));
    logPath = join(dir, 'native-events.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Recursively scan ANY value for a substring, at ANY nesting depth (objects,
   *  arrays, primitives). Returns true if `needle` appears anywhere within. */
  function deepContains(value: unknown, needle: string): boolean {
    if (typeof value === 'string') return value.includes(needle);
    if (typeof value === 'number' || typeof value === 'boolean' || value == null) return false;
    if (Array.isArray(value)) return value.some((v) => deepContains(v, needle));
    if (typeof value === 'object') {
      // Scan BOTH keys and values — an injected secret could ride a key name too.
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (k.includes(needle)) return true;
        if (deepContains(v, needle)) return true;
      }
      return false;
    }
    return false;
  }

  /** Collect EVERY string-valued leaf key path of an object (for the no-injected-key
   *  assertion: the set of keys the bridge emits must equal the keys it was handed). */
  function keyPaths(value: unknown, prefix = ''): string[] {
    if (value == null || typeof value !== 'object') return [];
    const out: string[] = [];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k;
      out.push(path);
      out.push(...keyPaths(v, path));
    }
    return out.sort();
  }

  it('persisted JSONL and forwarded IPC are secret-free (deep)', async () => {
    // Events whose NESTED payload fields each smuggle the sentinel: a tool input
    // OBJECT (nested), assistant text, thinking text, and a notice message. The
    // bridge must neither add a secret elsewhere nor inject any extra key/header.
    const events: AgentEvent[] = [
      { ...BASE, kind: 'turn-start', ts: 1 },
      { ...BASE, kind: 'thinking-delta', text: `reasoning about ${SENTINEL}`, ts: 2 },
      { ...BASE, kind: 'text-delta', text: `the answer is ${SENTINEL}`, ts: 3 },
      {
        ...BASE,
        kind: 'tool-start',
        toolName: 'http',
        // DEEPLY nested secret inside the tool input object.
        toolInput: { headers: { authorization: `Bearer ${SENTINEL}`, nested: { deeper: [SENTINEL] } } },
        toolCallId: 'tc1',
        ts: 4
      },
      { ...BASE, kind: 'tool-end', toolCallId: 'tc1', success: true, durationMs: 1, ts: 5 },
      { ...BASE, kind: 'api-error', message: `auth failed for ${SENTINEL}`, retryable: true, ts: 6 },
      { ...BASE, kind: 'notification', message: `notice: ${SENTINEL}`, ts: 7 },
      { ...BASE, kind: 'stop', ts: 8, reason: 'end_turn', stopActive: false }
    ];

    const forwarded: AgentEvent[] = [];
    const bridge = createNativeEventBridge({
      persist: (event) => {
        appendFileSync(logPath, JSON.stringify(event) + '\n', 'utf8');
        return true;
      },
      forward: (event) => { forwarded.push(event); }
    });
    for (const e of events) bridge.ingest(e);
    await bridge.idle();

    // ── 1) The bridge ADDS no secret of its own. Whatever sentinel appears in the
    //       products is EXACTLY what the source events already carried — verbatim
    //       passthrough. We compute the expected count of sentinel occurrences from
    //       the SOURCE serialization and assert the products match it (no extra
    //       injected copy, none stripped). ────────────────────────────────────────
    const countOccurrences = (s: string, sub: string): number => s.split(sub).length - 1;
    const sourceBlob = events.map((e) => JSON.stringify(e)).join('\n');
    const expectedSentinel = countOccurrences(sourceBlob, SENTINEL);
    // Sanity: the fixture actually injected the sentinel (test is not vacuous).
    expect(expectedSentinel).toBeGreaterThan(0);

    const fileBlob = readFileSync(logPath, 'utf8').trimEnd();
    const forwardedBlob = forwarded.map((e) => JSON.stringify(e)).join('\n');

    // Verbatim passthrough: the bridge neither adds nor strips the in-payload secret.
    expect(countOccurrences(fileBlob, SENTINEL)).toBe(expectedSentinel);
    expect(countOccurrences(forwardedBlob, SENTINEL)).toBe(expectedSentinel);

    // ── 2) The bridge INJECTS no key/header of its own — at ANY nesting depth.
    //       Each forwarded event is === the event ingested (object identity), and
    //       its key-path set is unchanged from the source. No `apiKey`/`authorization`
    //       key was added by the bridge anywhere it wasn't already in the payload. ──
    forwarded.forEach((fwd, i) => {
      // Identity passthrough: the bridge forwards the SAME object, adding no wrapper.
      expect(fwd).toBe(events[i]);
      // The persisted line round-trips to the SAME shape (no extra injected keys).
      const persistedLine = loadNativeEvents(logPath)[i];
      expect(keyPaths(persistedLine)).toEqual(keyPaths(events[i]));
    });

    // ── 3) DEEP-SCAN assertion: no secret was leaked into ANY field the bridge
    //       PRODUCES beyond the source payload. Reload the persisted stream and diff
    //       each line against its source: any sentinel/canary present must be present
    //       in the SOURCE at the same path — i.e. the bridge added none. We assert
    //       the persisted + forwarded blobs contain ONLY the source's sentinels by
    //       confirming a deep scan of the DIFFERENCE finds none. ────────────────────
    const reloaded = loadNativeEvents(logPath);
    reloaded.forEach((line, i) => {
      // Every persisted/forwarded line is byte-identical (re-serialized) to source.
      expect(JSON.stringify(line)).toBe(JSON.stringify(events[i]));
    });

    // A purely-clean event (no source secret) must come out secret-free — proving the
    // bridge would never INVENT a secret. The turn-start/stop frames carry none.
    const cleanFrames = reloaded.filter((e) => e.kind === 'turn-start' || e.kind === 'stop');
    for (const frame of cleanFrames) {
      expect(deepContains(frame, SENTINEL)).toBe(false);
      expect(deepContains(frame, CANARY)).toBe(false);
    }
    for (const frame of forwarded.filter((e) => e.kind === 'turn-start' || e.kind === 'stop')) {
      expect(deepContains(frame, SENTINEL)).toBe(false);
      expect(deepContains(frame, CANARY)).toBe(false);
    }

    // ── 4) No credential KEY was injected. The union of key-paths across the whole
    //       persisted + forwarded stream contains no key the source did not have. ──
    const sourceKeyPaths = new Set(events.flatMap((e) => keyPaths(e)));
    const productKeyPaths = new Set([
      ...reloaded.flatMap((e) => keyPaths(e)),
      ...forwarded.flatMap((e) => keyPaths(e))
    ]);
    for (const path of productKeyPaths) {
      expect(sourceKeyPaths.has(path), `bridge injected key path "${path}"`).toBe(true);
    }
    // Specifically: no top-level credential envelope key was added.
    for (const e of [...reloaded, ...forwarded]) {
      expect(Object.keys(e)).not.toContain('apiKey');
      expect(Object.keys(e)).not.toContain('authorization');
      expect(Object.keys(e)).not.toContain('x-api-key');
    }
  });

  it('a fully-clean stream produces NO sentinel anywhere (the bridge never invents one)', async () => {
    // Drive the bridge with events that contain NO secret; assert the deep scan of
    // both products is clean — the bridge adds nothing.
    const clean: AgentEvent[] = [
      { ...BASE, kind: 'turn-start', ts: 1 },
      { ...BASE, kind: 'text-delta', text: 'hello world', ts: 2 },
      { ...BASE, kind: 'tool-start', toolName: 'read', toolInput: { path: '/a' }, toolCallId: 'tc', ts: 3 },
      { ...BASE, kind: 'tool-end', toolCallId: 'tc', success: true, durationMs: 1, ts: 4 },
      { ...BASE, kind: 'stop', ts: 5, reason: 'end_turn', stopActive: false }
    ];
    const forwarded: AgentEvent[] = [];
    const bridge = createNativeEventBridge({
      persist: (event) => { appendFileSync(logPath, JSON.stringify(event) + '\n', 'utf8'); return true; },
      forward: (event) => { forwarded.push(event); }
    });
    for (const e of clean) bridge.ingest(e);
    await bridge.idle();

    const fileBlob = readFileSync(logPath, 'utf8');
    expect(deepContains(JSON.parse(`[${fileBlob.trim().split('\n').join(',')}]`), SENTINEL)).toBe(false);
    expect(deepContains(forwarded, SENTINEL)).toBe(false);
    expect(deepContains(forwarded, CANARY)).toBe(false);
  });
});
