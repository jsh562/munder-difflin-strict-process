/**
 * E008 T012/T013 — pure fold core suite (FR-013/FR-036/FR-039/FR-042/FR-044).
 *
 * `foldEvents` is the ONE deterministic projection of a native agent's normalized
 * `AgentEvent[]` into the two renderer view-models (ordered transcript + structured
 * run view). This suite locks the invariants the live transcript and the persisted-
 * replay transcript MUST share — so they are machine-verified here, not deferred to QC:
 *
 *   T012 (FR-013/FR-036/FR-044):
 *     - contiguous `text-delta` coalesce into ONE `assistant-text` entry; a non-text
 *       boundary splits a later delta into a fresh entry;
 *     - tool calls pair STRICTLY by `toolCallId` (pending→resolved), and an ORPHAN
 *       `tool-end` (no matching `tool-start`) is DROPPED — never mutating a peer;
 *     - interrupted resolution: still-open entries stay `pending` mid-stream
 *       (`streamEnded:false`) but flip to `interrupted` at end-of-stream / a trailing
 *       `stop`;
 *     - cumulative-monotonic SET-not-SUM token projection (latest cumulative replaces
 *       prior, never summed; a decrease clamps per field) with `usd:null` preserved
 *       as null (never coerced to 0);
 *     - an empty / no-op turn emits NO transcript entry; a thinking-only turn emits a
 *       collapsed `thinking` entry DISTINCT from assistant text.
 *
 *   T013 (FR-039/FR-042):
 *     - replay determinism: `foldEvents(events)` deep-equals `foldEvents([...events])`
 *       and the input array is NOT mutated (no reorder, no field write-back);
 *     - live-fold (`streamEnded:false`, no trailing `stop`) == replay-fold once the
 *       same settled stream is folded — pending entries are the only difference, and
 *       a settled live stream matches replay exactly;
 *     - malformed / forward-version kinds fold best-effort with NO throw.
 *
 * Pure-node: imports ONLY the fold + the shared `AgentEvent` contract — no DOM/React/
 * electron, so it runs in the `node` Vitest environment with no jsdom/IPC.
 */
import { describe, it, expect } from 'vitest';
import {
  foldEvents,
  DEFAULT_TRUNCATE_BYTES,
  TRUNCATION_INDICATOR,
  type TranscriptEntry
} from '../foldEvents';
import type { AgentEvent } from '../../../../shared/agentEvent';

// ── Event builders (deterministic ts/seq from the call order) ───────────────────

let _ts = 1000;
/** Monotonic timestamp helper so fixtures don't repeat a literal everywhere. */
function nextTs(): number {
  return ++_ts;
}

const BASE = { v: 1, agentId: 'desk-a', sessionId: 's1' } as const;

function turnStart(ts = nextTs()): AgentEvent {
  return { ...BASE, kind: 'turn-start', ts };
}
function turnEnd(ts = nextTs()): AgentEvent {
  return { ...BASE, kind: 'turn-end', ts };
}
function textDelta(text: string, ts = nextTs()): AgentEvent {
  return { ...BASE, kind: 'text-delta', text, ts };
}
function thinkingDelta(text: string, ts = nextTs()): AgentEvent {
  return { ...BASE, kind: 'thinking-delta', text, ts };
}
function thinkingStart(text: string | undefined, ts = nextTs()): AgentEvent {
  return { ...BASE, kind: 'thinking-start', text, ts };
}
function toolStart(toolCallId: string, toolName: string, toolInput: unknown, ts = nextTs()): AgentEvent {
  return { ...BASE, kind: 'tool-start', toolCallId, toolName, toolInput, ts };
}
function toolEnd(
  toolCallId: string,
  opts: { success?: boolean; durationMs?: number; error?: string } = {},
  ts = nextTs()
): AgentEvent {
  return {
    ...BASE,
    kind: 'tool-end',
    toolCallId,
    success: opts.success ?? true,
    durationMs: opts.durationMs ?? 0,
    ...(opts.error !== undefined ? { error: opts.error } : {}),
    ts
  };
}
function tokenUsage(
  u: { input: number; output: number; cacheRead?: number; cacheCreation?: number; usd?: number | null; model?: string | null },
  ts = nextTs()
): AgentEvent {
  return {
    ...BASE,
    kind: 'token-usage',
    input: u.input,
    output: u.output,
    cacheRead: u.cacheRead ?? 0,
    cacheCreation: u.cacheCreation ?? 0,
    usd: u.usd === undefined ? null : u.usd,
    model: u.model === undefined ? null : u.model,
    ts
  };
}
function stop(ts = nextTs()): AgentEvent {
  return { ...BASE, kind: 'stop', ts, reason: 'end_turn', stopActive: false };
}
function apiError(message: string, retryable: boolean, ts = nextTs()): AgentEvent {
  return { ...BASE, kind: 'api-error', message, retryable, ts };
}
function notification(message: string, ts = nextTs()): AgentEvent {
  return { ...BASE, kind: 'notification', message, ts };
}

/** Filter helpers for asserting against a single entry category. */
function ofType(entries: TranscriptEntry[], type: TranscriptEntry['type']): TranscriptEntry[] {
  return entries.filter((e) => e.type === type);
}

// ────────────────────────────────────────────────────────────────────────────
// T012 — coalescing, strict pairing (+ orphan), interrupted, token projection
// ────────────────────────────────────────────────────────────────────────────

describe('T012 {FR-013/FR-036/FR-044} foldEvents — coalescing / pairing / interrupted / tokens', () => {
  // ── text-delta coalescing (FR-002/FR-026) ──────────────────────────────────

  it('coalesces CONTIGUOUS text-deltas into ONE assistant-text entry', () => {
    const events = [turnStart(), textDelta('Hel'), textDelta('lo, '), textDelta('world'), turnEnd(), stop()];
    const { entries } = foldEvents(events);
    const texts = ofType(entries, 'assistant-text');
    expect(texts).toHaveLength(1);
    expect(texts[0].text).toBe('Hello, world');
    expect(texts[0].status).toBe('resolved');
  });

  it('splits text-deltas separated by a non-text boundary into DISTINCT entries', () => {
    // A tool call between two text runs breaks contiguity — two assistant-text entries.
    const events = [
      turnStart(),
      textDelta('before '),
      toolStart('tc1', 'read', { path: '/x' }),
      toolEnd('tc1'),
      textDelta('after'),
      turnEnd(),
      stop()
    ];
    const { entries } = foldEvents(events);
    const texts = ofType(entries, 'assistant-text');
    expect(texts).toHaveLength(2);
    expect(texts[0].text).toBe('before ');
    expect(texts[1].text).toBe('after');
    // Order: text, tool, text — preserved in arrival order.
    expect(entries.map((e) => e.type)).toEqual(['assistant-text', 'tool-call', 'assistant-text']);
  });

  // ── strict toolCallId pairing + orphan drop (FR-044) ────────────────────────

  it('pairs a tool call STRICTLY by toolCallId (pending → resolved)', () => {
    const events = [
      turnStart(),
      toolStart('tc-1', 'grep', { q: 'foo' }),
      toolEnd('tc-1', { success: true, durationMs: 42 }),
      turnEnd(),
      stop()
    ];
    const { entries, structured } = foldEvents(events);
    const tool = ofType(entries, 'tool-call')[0];
    expect(tool.toolCallId).toBe('tc-1');
    expect(tool.toolName).toBe('grep');
    expect(tool.status).toBe('resolved');
    expect(tool.success).toBe(true);
    expect(tool.durationMs).toBe(42);
    // Mirrored in the structured projection.
    const sTool = structured.turns[0].toolCalls[0];
    expect(sTool.toolCallId).toBe('tc-1');
    expect(sTool.status).toBe('resolved');
    expect(sTool.durationMs).toBe(42);
  });

  it('DROPS an ORPHAN tool-end (no matching tool-start) — never mutates a peer entry', () => {
    const events = [
      turnStart(),
      toolStart('tc-real', 'read', { path: '/a' }),
      toolEnd('tc-real', { success: true, durationMs: 5 }),
      // Orphan: a tool-end whose toolCallId never had a tool-start.
      toolEnd('tc-ghost', { success: false, durationMs: 999, error: 'boom' }),
      turnEnd(),
      stop()
    ];
    const { entries, structured } = foldEvents(events);
    const tools = ofType(entries, 'tool-call');
    // Only the real tool exists; the orphan created NO entry and mutated nothing.
    expect(tools).toHaveLength(1);
    expect(tools[0].toolCallId).toBe('tc-real');
    expect(tools[0].success).toBe(true); // NOT overwritten by the orphan's false/error
    expect(tools[0].error).toBeUndefined();
    expect(tools[0].durationMs).toBe(5); // NOT the orphan's 999
    expect(structured.turns[0].toolCalls).toHaveLength(1);
  });

  it('maps a FAILED tool-end to success=false with the error surfaced as result', () => {
    const events = [
      turnStart(),
      toolStart('tc-f', 'write', { path: '/ro' }),
      toolEnd('tc-f', { success: false, durationMs: 7, error: 'permission denied' }),
      turnEnd(),
      stop()
    ];
    const tool = ofType(foldEvents(events).entries, 'tool-call')[0];
    expect(tool.success).toBe(false);
    expect(tool.error).toBe('permission denied');
    expect(tool.result?.full).toBe('permission denied');
  });

  // ── interrupted resolution: pending vs interrupted (FR-011/FR-033) ──────────

  it('leaves an open tool call PENDING mid-stream (streamEnded:false, no stop)', () => {
    const events = [turnStart(), toolStart('tc-open', 'sleep', {})];
    const { entries, structured } = foldEvents(events, { streamEnded: false });
    expect(ofType(entries, 'tool-call')[0].status).toBe('pending');
    // The open turn is still pending too.
    expect(structured.turns[0].status).toBe('pending');
    expect(structured.turns[0].toolCalls[0].status).toBe('pending');
  });

  it('flips an open tool call + unfinished turn to INTERRUPTED at end-of-stream (streamEnded default true)', () => {
    const events = [turnStart(), toolStart('tc-open', 'sleep', {})];
    const { entries, structured } = foldEvents(events); // default streamEnded:true
    expect(ofType(entries, 'tool-call')[0].status).toBe('interrupted');
    expect(structured.turns[0].status).toBe('interrupted');
    expect(structured.turns[0].toolCalls[0].status).toBe('interrupted');
  });

  it('flips an open entry to INTERRUPTED on a TRAILING stop even when streamEnded:false', () => {
    // A terminal `stop` in the stream itself forces end-of-stream resolution
    // regardless of the option (the run genuinely ended).
    const events = [turnStart(), toolStart('tc-open', 'sleep', {}), stop()];
    const { entries } = foldEvents(events, { streamEnded: false });
    expect(ofType(entries, 'tool-call')[0].status).toBe('interrupted');
  });

  it('a turn that closed with turn-end is RESOLVED, not interrupted', () => {
    const events = [turnStart(), textDelta('done'), turnEnd(), stop()];
    const { structured } = foldEvents(events);
    expect(structured.turns[0].status).toBe('resolved');
  });

  // ── token projection: SET-not-SUM, decrease clamp, usd:null preserved ───────

  it('projects token usage cumulative SET-not-SUM (latest replaces prior, never summed)', () => {
    const events = [
      turnStart(),
      tokenUsage({ input: 100, output: 20, model: 'deepseek-v4-flash', usd: 0.001 }),
      // A LATER cumulative snapshot — the run total is SET to this, not 100+250.
      tokenUsage({ input: 250, output: 60, model: 'deepseek-v4-flash', usd: 0.003 }),
      turnEnd(),
      stop()
    ];
    const { structured } = foldEvents(events);
    expect(structured.runTokenUsage).not.toBeNull();
    expect(structured.runTokenUsage!.input).toBe(250); // SET to latest, NOT 350
    expect(structured.runTokenUsage!.output).toBe(60);
    expect(structured.runTokenUsage!.usd).toBe(0.003);
    expect(structured.runTokenUsage!.model).toBe('deepseek-v4-flash');
    // The turn carries the latest in-turn cumulative at close.
    expect(structured.turns[0].tokenUsage!.input).toBe(250);
  });

  it('clamps a DECREASING cumulative sample PER FIELD (never regresses a total)', () => {
    const events = [
      turnStart(),
      tokenUsage({ input: 400, output: 100, cacheRead: 10, cacheCreation: 5, usd: 0.05 }),
      // A lower cumulative arrives (reset glitch / out-of-order): each field clamps.
      tokenUsage({ input: 350, output: 120, cacheRead: 0, cacheCreation: 0, usd: 0.02 }),
      turnEnd(),
      stop()
    ];
    const { structured } = foldEvents(events);
    const run = structured.runTokenUsage!;
    expect(run.input).toBe(400); // held at prior max (decrease clamped)
    expect(run.output).toBe(120); // rose — applied
    expect(run.cacheRead).toBe(10); // held
    expect(run.cacheCreation).toBe(5); // held
    expect(run.usd).toBe(0.05); // priced decrease clamps to prior max
  });

  it('preserves usd:null as null — NEVER coerced to 0 (FR-036)', () => {
    const events = [
      turnStart(),
      tokenUsage({ input: 100, output: 20, usd: null, model: null }),
      turnEnd(),
      stop()
    ];
    const { structured } = foldEvents(events);
    expect(structured.runTokenUsage!.usd).toBeNull();
    expect(structured.runTokenUsage!.usd).not.toBe(0);
    expect(structured.turns[0].tokenUsage!.usd).toBeNull();
  });

  it('usd:null is monotonicity-neutral — a later unpriced sample keeps the prior known price', () => {
    const events = [
      turnStart(),
      tokenUsage({ input: 100, output: 20, usd: 0.01, model: 'm1' }),
      tokenUsage({ input: 200, output: 40, usd: null, model: null }), // unpriced
      turnEnd(),
      stop()
    ];
    const run = foldEvents(events).structured.runTokenUsage!;
    expect(run.input).toBe(200); // token fields still advance
    expect(run.usd).toBe(0.01); // prior known price carried (null is neutral, not 0)
    expect(run.model).toBe('m1'); // model carried too
  });

  it('a turn with NO usage sample reports tokenUsage:null (never a fabricated 0)', () => {
    const events = [turnStart(), textDelta('hi'), turnEnd(), stop()];
    const { structured } = foldEvents(events);
    expect(structured.turns[0].tokenUsage).toBeNull();
    expect(structured.runTokenUsage).toBeNull();
  });

  // ── empty/no-op turn → no entry; thinking-only → collapsed thinking ─────────

  it('emits NO transcript entry for an empty / no-op turn', () => {
    const events = [turnStart(), turnEnd(), stop()];
    const { entries, structured } = foldEvents(events);
    expect(entries).toHaveLength(0);
    // The turn still exists in the structured projection (resolved, no tools/usage).
    expect(structured.turns).toHaveLength(1);
    expect(structured.turns[0].toolCalls).toHaveLength(0);
    expect(structured.turns[0].status).toBe('resolved');
  });

  it('emits a COLLAPSED thinking entry DISTINCT from assistant text for a thinking-only turn', () => {
    const events = [
      turnStart(),
      thinkingStart('let me '),
      thinkingDelta('think...'),
      turnEnd(),
      stop()
    ];
    const { entries } = foldEvents(events);
    const thinking = ofType(entries, 'thinking');
    expect(thinking).toHaveLength(1);
    expect(thinking[0].text).toBe('let me think...'); // contiguous thinking coalesced
    expect(thinking[0].collapsed).toBe(true); // default-collapsed (FR-017)
    expect(thinking[0].type).toBe('thinking');
    // NO assistant-text entry — thinking is never merged into text.
    expect(ofType(entries, 'assistant-text')).toHaveLength(0);
  });

  it('keeps thinking and assistant text as SEPARATE entries when both appear', () => {
    const events = [
      turnStart(),
      thinkingDelta('reasoning'),
      textDelta('answer'),
      turnEnd(),
      stop()
    ];
    const { entries } = foldEvents(events);
    expect(ofType(entries, 'thinking')).toHaveLength(1);
    expect(ofType(entries, 'assistant-text')).toHaveLength(1);
    expect(ofType(entries, 'thinking')[0].text).toBe('reasoning');
    expect(ofType(entries, 'assistant-text')[0].text).toBe('answer');
  });

  // ── notices (FR-007/FR-008) surface inline without aborting ─────────────────

  it('surfaces api-error and notification as distinct inline notices, transcript continues', () => {
    const events = [
      turnStart(),
      textDelta('working'),
      apiError('rate limited', true),
      notification('degraded to fallback model'),
      textDelta(' resumed'),
      turnEnd(),
      stop()
    ];
    const { entries } = foldEvents(events);
    const notices = ofType(entries, 'notice');
    expect(notices).toHaveLength(2);
    expect(notices[0].noticeKind).toBe('api-error');
    expect(notices[0].retryable).toBe(true);
    expect(notices[1].noticeKind).toBe('degradation');
    // Transcript did not abort — two distinct text runs flank the notices.
    expect(ofType(entries, 'assistant-text')).toHaveLength(2);
  });

  // ── display-only truncation (FR-029) ────────────────────────────────────────

  it('truncates a large tool input FOR DISPLAY ONLY — full payload retained', () => {
    const big = 'x'.repeat(DEFAULT_TRUNCATE_BYTES + 500);
    const events = [
      turnStart(),
      toolStart('tc-big', 'write', big),
      toolEnd('tc-big', { success: true }),
      turnEnd(),
      stop()
    ];
    const tool = ofType(foldEvents(events).entries, 'tool-call')[0];
    expect(tool.toolInput!.truncated).toBe(true);
    expect(String(tool.toolInput!.display)).toContain(TRUNCATION_INDICATOR);
    expect(tool.toolInput!.full).toBe(big); // full payload kept — no eviction
    expect(tool.toolInput!.fullBytes).toBe(big.length);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// T013 — replay determinism, live==replay, malformed best-effort
// ────────────────────────────────────────────────────────────────────────────

describe('T013 {FR-039/FR-042} foldEvents — replay determinism / best-effort', () => {
  /** A representative settled stream covering every kind the fold acts on. */
  function richStream(): AgentEvent[] {
    return [
      turnStart(),
      thinkingDelta('plan'),
      textDelta('hi '),
      textDelta('there'),
      toolStart('tc-a', 'read', { path: '/a' }),
      tokenUsage({ input: 100, output: 30, usd: 0.002, model: 'm1' }),
      toolEnd('tc-a', { success: true, durationMs: 11 }),
      apiError('transient', true),
      notification('degraded'),
      tokenUsage({ input: 180, output: 60, usd: 0.004, model: 'm1' }),
      turnEnd(),
      // A second turn left UNFINISHED with an open tool — exercises interrupted.
      turnStart(),
      toolStart('tc-b', 'grep', { q: 'x' }),
      stop()
    ];
  }

  it('foldEvents(events) deep-equals foldEvents([...events]) — deterministic', () => {
    const events = richStream();
    const a = foldEvents(events);
    const b = foldEvents([...events]);
    expect(a).toEqual(b);
  });

  it('does NOT mutate or reorder the input array (no field write-back)', () => {
    const events = richStream();
    const snapshot = JSON.parse(JSON.stringify(events));
    const beforeRefs = [...events];
    foldEvents(events);
    // Same elements, same order, same identities, same field values.
    expect(events).toEqual(snapshot);
    expect(events).toHaveLength(snapshot.length);
    events.forEach((e, i) => expect(e).toBe(beforeRefs[i]));
  });

  it('folding the SAME stream twice yields identical results (idempotent replay)', () => {
    const events = richStream();
    expect(foldEvents(events)).toEqual(foldEvents(events));
  });

  it('live-fold of a SETTLED stream == replay-fold (FR-039)', () => {
    // A stream that ended with a `stop` is settled: a live fold (streamEnded:false,
    // relying on the trailing stop) must equal the replay fold (streamEnded:true).
    const events = [
      turnStart(),
      textDelta('answer'),
      toolStart('tc-1', 'read', {}),
      toolEnd('tc-1', { success: true, durationMs: 3 }),
      turnEnd(),
      stop()
    ];
    const live = foldEvents(events, { streamEnded: false });
    const replay = foldEvents(events, { streamEnded: true });
    expect(live).toEqual(replay);
  });

  it('the ONLY difference between mid-stream live and settled replay is pending→interrupted', () => {
    // No trailing stop: mid-stream the open tool is `pending`; the settled replay
    // flips it to `interrupted`. Everything else is identical.
    const events = [turnStart(), textDelta('x'), toolStart('tc-open', 'sleep', {})];
    const live = foldEvents(events, { streamEnded: false });
    const replay = foldEvents(events, { streamEnded: true });
    expect(ofType(live.entries, 'tool-call')[0].status).toBe('pending');
    expect(ofType(replay.entries, 'tool-call')[0].status).toBe('interrupted');
    // The non-status content is identical (same ids, text, ordering).
    expect(live.entries.map((e) => e.id)).toEqual(replay.entries.map((e) => e.id));
    expect(ofType(live.entries, 'assistant-text')[0].text).toBe(
      ofType(replay.entries, 'assistant-text')[0].text
    );
  });

  it('folds a MALFORMED / forward-version kind best-effort with NO throw', () => {
    // A forward-version additive kind the consumer does not know (FR-045/C3) plus a
    // structurally odd line — neither breaks the fold; both contribute no entry.
    const forwardKind = { v: 99, agentId: 'desk-a', sessionId: 's1', ts: nextTs(), kind: 'future-kind', blob: { x: 1 } } as unknown as AgentEvent;
    const events = [
      turnStart(),
      forwardKind,
      textDelta('still works'),
      turnEnd(),
      stop()
    ];
    let result!: ReturnType<typeof foldEvents>;
    expect(() => { result = foldEvents(events); }).not.toThrow();
    // The known events still folded; the unknown kind was simply ignored.
    expect(ofType(result.entries, 'assistant-text')[0].text).toBe('still works');
  });

  it('does not throw on an entirely empty stream', () => {
    expect(() => foldEvents([])).not.toThrow();
    const { entries, structured } = foldEvents([]);
    expect(entries).toHaveLength(0);
    expect(structured.turns).toHaveLength(0);
    expect(structured.runTokenUsage).toBeNull();
  });

  it('tolerates a tool firing OUTSIDE any turn (missing turn boundaries) without throwing', () => {
    // No turn-start/turn-end around the tool — a synthetic bucket is created and
    // stays resolved (only REAL turns interrupt).
    const events = [toolStart('tc-x', 'read', {}), toolEnd('tc-x', { success: true }), stop()];
    let result!: ReturnType<typeof foldEvents>;
    expect(() => { result = foldEvents(events); }).not.toThrow();
    expect(result.structured.turns).toHaveLength(1);
    expect(result.structured.turns[0].status).toBe('resolved');
    expect(result.structured.turns[0].toolCalls[0].status).toBe('resolved');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// T033 — notice dedup/collapse + structured-view notice threading
// ────────────────────────────────────────────────────────────────────────────

describe('T033 {FR-019/FR-020} foldEvents — notice dedup / collapse / threading', () => {
  // ── consecutive identical notices collapse into ONE entry with a count ──────

  it('collapses CONSECUTIVE identical notices into ONE entry carrying count N', () => {
    const events = [
      turnStart(),
      apiError('rate limited', true),
      apiError('rate limited', true),
      apiError('rate limited', true),
      turnEnd(),
      stop()
    ];
    const notices = ofType(foldEvents(events).entries, 'notice');
    // 3 identical notices → 1 entry, count 3 — they do NOT flood the transcript.
    expect(notices).toHaveLength(1);
    expect(notices[0].count).toBe(3);
    expect(notices[0].noticeKind).toBe('api-error');
    expect(notices[0].message).toBe('rate limited');
    expect(notices[0].retryable).toBe(true);
  });

  it('collapses repeated capability-degradation notifications too', () => {
    const events = [
      turnStart(),
      notification('vision unsupported — degraded to text'),
      notification('vision unsupported — degraded to text'),
      turnEnd(),
      stop()
    ];
    const notices = ofType(foldEvents(events).entries, 'notice');
    expect(notices).toHaveLength(1);
    expect(notices[0].noticeKind).toBe('degradation');
    expect(notices[0].count).toBe(2);
  });

  it('a lone notice carries count 1', () => {
    const events = [turnStart(), notification('degraded'), turnEnd(), stop()];
    const notices = ofType(foldEvents(events).entries, 'notice');
    expect(notices).toHaveLength(1);
    expect(notices[0].count).toBe(1);
  });

  // ── a DIFFERENT notice in between breaks the run ────────────────────────────

  it('a DIFFERENT notice between identical notices BREAKS the run (two entries, not collapsed)', () => {
    const events = [
      turnStart(),
      apiError('rate limited', true),
      notification('degraded to fallback'), // different notice breaks the run
      apiError('rate limited', true), // identical to the first but NOT consecutive
      turnEnd(),
      stop()
    ];
    const notices = ofType(foldEvents(events).entries, 'notice');
    // 3 distinct entries: the trailing api-error is a FRESH entry (count 1), not folded
    // back into the first because the notification broke the consecutive run.
    expect(notices).toHaveLength(3);
    expect(notices.map((n) => n.noticeKind)).toEqual(['api-error', 'degradation', 'api-error']);
    expect(notices.every((n) => n.count === 1)).toBe(true);
  });

  it('a non-notice entry (assistant text) between identical notices BREAKS the run', () => {
    const events = [
      turnStart(),
      apiError('boom', false),
      textDelta('still working'), // a real transcript entry breaks contiguity
      apiError('boom', false),
      turnEnd(),
      stop()
    ];
    const notices = ofType(foldEvents(events).entries, 'notice');
    expect(notices).toHaveLength(2);
    expect(notices.every((n) => n.count === 1)).toBe(true);
    // The transcript continued — the text run sits between the two notices (no abort).
    expect(foldEvents(events).entries.map((e) => e.type)).toEqual([
      'notice',
      'assistant-text',
      'notice'
    ]);
  });

  it('same message but DIFFERENT retryable does NOT collapse (treated as distinct)', () => {
    const events = [
      turnStart(),
      apiError('overloaded', true),
      apiError('overloaded', false), // same message, terminal this time
      turnEnd(),
      stop()
    ];
    const notices = ofType(foldEvents(events).entries, 'notice');
    expect(notices).toHaveLength(2);
    expect(notices[0].retryable).toBe(true);
    expect(notices[1].retryable).toBe(false);
    expect(notices.every((n) => n.count === 1)).toBe(true);
  });

  // ── dedup keeps the fold deterministic + order-preserving (replay==live) ─────

  it('collapsing notices is order-preserving + deterministic (id/ts anchored to FIRST)', () => {
    const events = [
      turnStart(),
      textDelta('before'),
      apiError('flaky', true),
      apiError('flaky', true),
      textDelta('after'),
      turnEnd(),
      stop()
    ];
    const a = foldEvents(events);
    const b = foldEvents([...events]);
    // Deterministic: same input ⇒ same output (replay == live).
    expect(a).toEqual(b);
    // Order preserved: text, the single collapsed notice, text.
    expect(a.entries.map((e) => e.type)).toEqual(['assistant-text', 'notice', 'assistant-text']);
    // The collapsed notice's identity anchors to the FIRST occurrence's index/ts.
    const notice = ofType(a.entries, 'notice')[0];
    expect(notice.count).toBe(2);
    expect(notice.id).toMatch(/^notice-/);
  });

  it('does not mutate the input array when collapsing notices', () => {
    const events = [turnStart(), apiError('x', true), apiError('x', true), turnEnd(), stop()];
    const snapshot = JSON.parse(JSON.stringify(events));
    foldEvents(events);
    expect(events).toEqual(snapshot);
  });

  // ── structured view carries the SAME notices (threaded, not re-folded) ───────

  it('threads the SAME deduped notice entries onto structured.notices (one fold, two views)', () => {
    const events = [
      turnStart(),
      apiError('rate limited', true),
      apiError('rate limited', true),
      notification('degraded'),
      turnEnd(),
      stop()
    ];
    const { entries, structured } = foldEvents(events);
    const transcriptNotices = ofType(entries, 'notice');
    // structured.notices === the transcript notice entries (same objects, same order).
    expect(structured.notices).toHaveLength(transcriptNotices.length);
    expect(structured.notices).toBe(structured.notices); // present
    structured.notices.forEach((n, i) => expect(n).toBe(transcriptNotices[i]));
    expect(structured.notices[0].count).toBe(2);
    expect(structured.notices[1].noticeKind).toBe('degradation');
  });

  it('structured.notices is an empty array when the run has no notices', () => {
    const events = [turnStart(), textDelta('hi'), turnEnd(), stop()];
    const { structured } = foldEvents(events);
    expect(structured.notices).toEqual([]);
  });
});
