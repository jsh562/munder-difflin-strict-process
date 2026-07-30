/**
 * E008 T035 {FR-029/SC-018} — display-only 8 KB truncation PARITY across both views,
 * and FULL-payload recoverability on replay with NO payload-level eviction.
 *
 * FR-029 / SC-018: a `toolInput` or tool-end `result` whose serialized size exceeds the
 * 8 KB display threshold MUST be truncated FOR DISPLAY ONLY in BOTH the transcript and
 * the structured tab, while the FULL payload stays in the retained event stream AND in
 * the persisted JSONL (no payload-level eviction) and is recoverable on replay.
 *
 * This suite proves all of that against the SOURCE paths (no mocks of the thing under
 * test):
 *   - the pure `foldEvents` core produces ONE `TruncatedPayload{truncated,display,full,
 *     fullBytes}` per tool input/result, and the transcript entry and the structured
 *     tool call carry the SAME payload object — so the two views are display-identical
 *     by construction (FR-029 parity, FR-034 one-fold-two-views);
 *   - the real `loadNativeEvents` replay reader is fed the persisted JSONL (the exact
 *     lines the single-writer bridge appends — `JSON.stringify(event)` per line) and the
 *     replayed events refold to a `.full` that is BYTE-IDENTICAL to the original payload:
 *     truncation never evicted the source from the persisted stream.
 *
 * Pure-node: `foldEvents` and `loadNativeEvents` are both DOM/electron-free (the reader
 * uses only `node:fs`), so this runs in the `node` Vitest env with no jsdom.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  foldEvents,
  DEFAULT_TRUNCATE_BYTES,
  TRUNCATION_INDICATOR,
  type TranscriptEntry,
  type StructuredToolCall
} from '../foldEvents';
import { loadNativeEvents } from '../../../../main/runtime/nativeEventBridge';
import type { AgentEvent } from '../../../../shared/agentEvent';

const BASE = { v: 1, agentId: 'desk-trunc', sessionId: 's-trunc' } as const;
let _ts = 5000;
const ts = () => ++_ts;

/** A payload comfortably over the 8 KB display threshold (so it MUST truncate). */
const BIG_INPUT = 'A'.repeat(DEFAULT_TRUNCATE_BYTES + 1234);
/** A failed tool-end carries its error as the result/output payload — make it big too. */
const BIG_ERROR = 'E'.repeat(DEFAULT_TRUNCATE_BYTES + 777);

/** A run whose single tool call has BOTH an oversized input and an oversized result. */
function bigPayloadRun(): AgentEvent[] {
  return [
    { ...BASE, kind: 'turn-start', ts: ts() },
    { ...BASE, kind: 'tool-start', toolCallId: 'tc-big', toolName: 'write', toolInput: BIG_INPUT, ts: ts() },
    { ...BASE, kind: 'tool-end', toolCallId: 'tc-big', success: false, durationMs: 9, error: BIG_ERROR, ts: ts() },
    { ...BASE, kind: 'turn-end', ts: ts() },
    { ...BASE, kind: 'stop', reason: 'end_turn', stopActive: false, ts: ts() }
  ];
}

/** The transcript tool-call entry + its mirror in the structured projection. */
function toolPair(events: AgentEvent[]): { entry: TranscriptEntry; struct: StructuredToolCall } {
  const { entries, structured } = foldEvents(events);
  const entry = entries.find((e) => e.type === 'tool-call')!;
  const struct = structured.turns[0].toolCalls[0];
  return { entry, struct };
}

// Track temp files so each test cleans up after itself.
const tempFiles: string[] = [];
afterEach(() => {
  for (const f of tempFiles.splice(0)) {
    try { rmSync(f, { force: true }); } catch { /* best-effort cleanup */ }
  }
});

/** Persist the events exactly as the single-writer bridge does — one `JSON.stringify`
 *  per line — to a temp JSONL, and return the path. */
function persistJsonl(events: AgentEvent[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'e008-trunc-'));
  const path = join(dir, 'native-events.jsonl');
  writeFileSync(path, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  tempFiles.push(path);
  return path;
}

describe('T035 {FR-029/SC-018} truncation — display-only, parity, recoverable on replay', () => {
  // ── a >8KB payload truncates for DISPLAY with a clear indicator, FULL retained ──

  it('a >8KB tool input yields truncated:true, a shorter display + indicator, full === original', () => {
    const { entry } = toolPair(bigPayloadRun());
    const input = entry.toolInput!;
    expect(input.truncated).toBe(true);
    // display is BOUNDED + carries a clear truncation indicator (FR-017 affordance).
    expect(String(input.display)).toContain(TRUNCATION_INDICATOR);
    expect(String(input.display).length).toBeLessThan(BIG_INPUT.length);
    // full is the COMPLETE original — no payload-level eviction.
    expect(input.full).toBe(BIG_INPUT);
    expect(input.fullBytes).toBe(BIG_INPUT.length);
  });

  it('a >8KB tool result (failed tool-end error) truncates for display, full retained', () => {
    const { entry } = toolPair(bigPayloadRun());
    const result = entry.result!;
    expect(result.truncated).toBe(true);
    expect(String(result.display)).toContain(TRUNCATION_INDICATOR);
    expect(result.full).toBe(BIG_ERROR);
    expect(result.fullBytes).toBe(BIG_ERROR.length);
  });

  // ── PARITY: the transcript view and the structured view truncate IDENTICALLY ──

  it('transcript + structured carry the SAME TruncatedPayload (display parity, FR-029)', () => {
    const { entry, struct } = toolPair(bigPayloadRun());
    // input parity — same object, so byte-for-byte identical display + full + flag.
    expect(struct.input).toBe(entry.toolInput);
    expect(struct.input.truncated).toBe(true);
    expect(struct.input.display).toBe(entry.toolInput!.display);
    expect(struct.input.full).toBe(entry.toolInput!.full);
    expect(struct.input.fullBytes).toBe(entry.toolInput!.fullBytes);
    // output parity — same object too.
    expect(struct.output).toBe(entry.result);
    expect(struct.output!.display).toBe(entry.result!.display);
    expect(struct.output!.full).toBe(entry.result!.full);
  });

  // ── REPLAY: persist → loadNativeEvents → refold recovers the FULL payload ─────

  it('after persist → loadNativeEvents → refold, the FULL payload is byte-identical (no eviction)', () => {
    const events = bigPayloadRun();
    // What the bridge persisted (the FULL events — truncation is display-only, never
    // applied to the persisted line).
    const path = persistJsonl(events);
    // The real replay reader rebuilds the AgentEvent array from the JSONL.
    const replayed = loadNativeEvents(path);

    // The persisted line carries the FULL untruncated payloads.
    const replayedStart = replayed.find((e) => e.kind === 'tool-start')!;
    const replayedEnd = replayed.find((e) => e.kind === 'tool-end')!;
    expect((replayedStart as Extract<AgentEvent, { kind: 'tool-start' }>).toolInput).toBe(BIG_INPUT);
    expect((replayedEnd as Extract<AgentEvent, { kind: 'tool-end' }>).error).toBe(BIG_ERROR);

    // Refolding the replayed stream recovers `.full` byte-identical to the original.
    const { entry } = toolPair(replayed);
    expect(entry.toolInput!.full).toBe(BIG_INPUT);
    expect(entry.result!.full).toBe(BIG_ERROR);
    // And it is still display-truncated on replay (parity with the live fold).
    expect(entry.toolInput!.truncated).toBe(true);
    expect(entry.result!.truncated).toBe(true);
  });

  it('live-fold and replay-fold produce IDENTICAL truncation (deterministic, FR-039)', () => {
    const events = bigPayloadRun();
    const live = toolPair(events);
    const replayed = loadNativeEvents(persistJsonl(events));
    const replay = toolPair(replayed);
    // Same truncation flag, same display preview, same full, same byte count.
    expect(replay.entry.toolInput).toEqual(live.entry.toolInput);
    expect(replay.entry.result).toEqual(live.entry.result);
  });

  // ── a payload UNDER threshold is NOT truncated (display === full original) ────

  it('a small payload is NOT truncated — display is the original value untouched', () => {
    const small = { path: '/tmp/x', mode: 'w' };
    const events: AgentEvent[] = [
      { ...BASE, kind: 'turn-start', ts: ts() },
      { ...BASE, kind: 'tool-start', toolCallId: 'tc-small', toolName: 'open', toolInput: small, ts: ts() },
      { ...BASE, kind: 'tool-end', toolCallId: 'tc-small', success: true, durationMs: 1, ts: ts() },
      { ...BASE, kind: 'turn-end', ts: ts() },
      { ...BASE, kind: 'stop', reason: 'end_turn', stopActive: false, ts: ts() }
    ];
    const { entry, struct } = toolPair(events);
    expect(entry.toolInput!.truncated).toBe(false);
    expect(entry.toolInput!.display).toBe(small); // the original value, not a preview
    expect(entry.toolInput!.full).toBe(small);
    // Parity holds for the non-truncated case too.
    expect(struct.input).toBe(entry.toolInput);
  });
});
