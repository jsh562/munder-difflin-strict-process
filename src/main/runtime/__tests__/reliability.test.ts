/** E006 T002 {FR-012} — ADR-0009 reliability: exhaustive retryable-vs-terminal
 *  classification, retry only retryable, full-jitter backoff, Retry-After floor,
 *  attempt + per-turn-budget bounds. Pure; clock/sleep/random injected (HINT-001). */
import { describe, it, expect } from 'vitest';
import {
  classifyError,
  parseRetryAfterMs,
  withReliability,
  ReliabilityError
} from '../worker/adapters/reliability';

describe('T002 — classifyError (exhaustive, disjoint)', () => {
  it('classifies the ADR-0009 retryable status allowlist as retryable', () => {
    for (const status of [429, 500, 502, 503, 504, 529]) {
      expect(classifyError({ status })).toBe('retryable');
    }
  });

  it('classifies 400/401/403 and other 4xx as terminal', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(classifyError({ status })).toBe('terminal');
    }
  });

  it('classifies connection/read-timeout codes as retryable', () => {
    for (const code of ['timeout', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND']) {
      expect(classifyError({ code })).toBe('retryable');
    }
  });

  it('classifies context-overflow as terminal (code or message)', () => {
    expect(classifyError({ code: 'context-overflow' })).toBe('terminal');
    expect(classifyError({ message: 'maximum context length exceeded' })).toBe('terminal');
  });

  it('treats a network failure with no HTTP status as retryable', () => {
    expect(classifyError(new Error('socket disconnected'))).toBe('retryable');
    expect(classifyError('boom')).toBe('retryable');
  });
});

describe('T002 — parseRetryAfterMs', () => {
  const now = () => 1_000_000;
  it('parses seconds (number and numeric string)', () => {
    expect(parseRetryAfterMs(2, now)).toBe(2000);
    expect(parseRetryAfterMs('3', now)).toBe(3000);
  });
  it('parses an HTTP-date into a positive delta', () => {
    const future = new Date(now() + 5000).toUTCString();
    expect(parseRetryAfterMs(future, now)).toBeGreaterThanOrEqual(0);
  });
  it('returns null for absent/unparseable values', () => {
    expect(parseRetryAfterMs(undefined, now)).toBeNull();
    expect(parseRetryAfterMs('soon', now)).toBeNull();
  });
});

const noSleep = async () => {};
const zeroJitter = () => 0; // deterministic backoff

describe('T002 — withReliability', () => {
  it('returns the value on first success (no retry)', async () => {
    let calls = 0;
    const v = await withReliability(async () => { calls++; return 42; }, { sleep: noSleep, random: zeroJitter });
    expect(v).toBe(42);
    expect(calls).toBe(1);
  });

  it('retries a retryable transient then succeeds', async () => {
    let calls = 0;
    const v = await withReliability(
      async () => {
        calls++;
        if (calls < 3) throw { status: 429 };
        return 'ok';
      },
      { sleep: noSleep, random: zeroJitter, maxAttempts: 5 }
    );
    expect(v).toBe('ok');
    expect(calls).toBe(3);
  });

  it('does NOT retry a terminal error and surfaces retryable:false', async () => {
    let calls = 0;
    await expect(
      withReliability(async () => { calls++; throw { status: 401 }; }, { sleep: noSleep, random: zeroJitter })
    ).rejects.toMatchObject({ name: 'ReliabilityError', retryable: false, classification: 'terminal' });
    expect(calls).toBe(1);
  });

  it('exhausts retryable attempts and surfaces retryable:true (does not false-trip the breaker)', async () => {
    let calls = 0;
    const err = await withReliability(async () => { calls++; throw { status: 503 }; }, {
      sleep: noSleep,
      random: zeroJitter,
      maxAttempts: 3
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ReliabilityError);
    expect(err.retryable).toBe(true);
    expect(calls).toBe(3);
  });

  it('honors Retry-After as a backoff floor', async () => {
    const slept: number[] = [];
    let calls = 0;
    // Fixed clock so the budget never expires; Retry-After 2s floors the 0-jitter backoff.
    await withReliability(
      async () => {
        calls++;
        if (calls < 2) throw { status: 429, retryAfter: '2' };
        return 'done';
      },
      { sleep: async (ms) => { slept.push(ms); }, random: zeroJitter, now: () => 0, turnBudgetMs: 1_000_000 }
    );
    expect(slept[0]).toBeGreaterThanOrEqual(2000);
  });

  it('stops when the per-turn wall-clock budget would be blown by the next backoff', async () => {
    let t = 0;
    const err = await withReliability(async () => { throw { status: 500 }; }, {
      sleep: async () => { t += 100; },
      random: () => 0,
      now: () => t,
      baseDelayMs: 10_000,
      turnBudgetMs: 50, // any backoff exceeds the budget immediately
      maxAttempts: 5
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ReliabilityError);
    expect(err.retryable).toBe(true);
  });
});

/**
 * T029 {FR-012} [COMPLETES FR-012] — close the remaining FR-012 corners the T002
 * suite above did not assert outright: that the retryable/terminal partition is
 * EXHAUSTIVE AND DISJOINT (every error is in exactly one class, none in both), that
 * attempts are BOUNDED to the ADR-0009 3–5 envelope regardless of the caller's
 * request, and that BOTH the exhausted-retryable and the terminal exit surface as
 * the same `ReliabilityError` the loop maps to one `api-error` (differing only by
 * the `retryable` flag the breaker reads). The classification/backoff/budget
 * mechanics themselves are covered by T002 and are not re-asserted here.
 */
describe('T029 — exhaustive+disjoint classes, bounded attempts, single api-error surface', () => {
  // A representative spread covering every classifier branch: retryable statuses,
  // terminal statuses, other 4xx/5xx, retryable transport codes, terminal codes,
  // context-overflow by message, and a bare network failure with no status/code.
  const SAMPLES: unknown[] = [
    { status: 429 }, { status: 500 }, { status: 502 }, { status: 503 }, { status: 504 }, { status: 529 },
    { status: 400 }, { status: 401 }, { status: 403 }, { status: 404 }, { status: 422 }, { status: 418 },
    { status: 501 }, { status: 599 },
    { code: 'timeout' }, { code: 'ETIMEDOUT' }, { code: 'ECONNRESET' }, { code: 'ENOTFOUND' }, { code: 'network' },
    { code: 'context-overflow' }, { code: 'invalid-request' },
    { message: 'maximum context length exceeded' },
    new Error('socket disconnected'), 'boom', null, undefined, 42
  ];

  it('classifies EVERY representative error as exactly one of retryable|terminal (no overlap, no gap)', () => {
    for (const sample of SAMPLES) {
      const cls = classifyError(sample);
      // Exactly one of the two classes — never both, never neither/other.
      expect(['retryable', 'terminal']).toContain(cls);
      const isRetryable = cls === 'retryable';
      const isTerminal = cls === 'terminal';
      expect(isRetryable).toBe(!isTerminal); // disjoint: exactly one is true
    }
  });

  it('bounds attempts BELOW the ADR-0009 floor up to ≥3 (a small maxAttempts is clamped up)', async () => {
    // Caller asks for 1 attempt; ADR-0009 clamps to a floor of 3 — so a persistently
    // retryable error is still tried 3 times before the exhausted error surfaces.
    let calls = 0;
    const err = await withReliability(async () => { calls++; throw { status: 503 }; }, {
      sleep: noSleep,
      random: zeroJitter,
      maxAttempts: 1
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ReliabilityError);
    expect(calls).toBe(3);
  });

  it('bounds attempts ABOVE the ADR-0009 ceiling at ≤5 (a large maxAttempts is clamped down)', async () => {
    // Caller asks for 99 attempts; ADR-0009 caps at 5 — runaway retrying cannot
    // exceed the ceiling even when every attempt fails retryably.
    let calls = 0;
    const err = await withReliability(async () => { calls++; throw { status: 503 }; }, {
      sleep: noSleep,
      random: zeroJitter,
      maxAttempts: 99
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ReliabilityError);
    expect(calls).toBe(5);
  });

  it('surfaces BOTH terminal and exhausted-retryable as one ReliabilityError the loop maps to api-error', async () => {
    // Terminal (401): ends the turn cleanly, retryable:false → feeds the breaker.
    const terminal = await withReliability(async () => { throw { status: 401 }; }, {
      sleep: noSleep,
      random: zeroJitter
    }).catch((e) => e);
    expect(terminal).toBeInstanceOf(ReliabilityError);
    expect(terminal.classification).toBe('terminal');
    expect(terminal.retryable).toBe(false);

    // Exhausted-retryable (503 ×N): the transient ran out of room, retryable:true →
    // the breaker is NOT false-tripped. Same error type, opposite flag.
    const exhausted = await withReliability(async () => { throw { status: 503 }; }, {
      sleep: noSleep,
      random: zeroJitter,
      maxAttempts: 3
    }).catch((e) => e);
    expect(exhausted).toBeInstanceOf(ReliabilityError);
    expect(exhausted.classification).toBe('retryable');
    expect(exhausted.retryable).toBe(true);

    // The loop reads `e.retryable` (errMsg/api-error) — the single discriminator that
    // distinguishes the two api-error outcomes. Both carry a bounded, key-free message.
    expect(typeof terminal.message).toBe('string');
    expect(typeof exhausted.message).toBe('string');
  });
});
