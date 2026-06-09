/**
 * Reliability wrapper (E006 / AD-006, FR-012 — implements ADR-0009).
 *
 * Wraps a single provider round-trip with the ADR-0009 retry policy:
 *  - classify every error as exactly one of `retryable` or `terminal`
 *    (the classification is exhaustive and disjoint, FR-012),
 *  - retry ONLY retryable errors with full-jitter exponential backoff,
 *  - honor a `Retry-After` hint when the provider sends one,
 *  - bound attempts (3–5) and per-attempt backoff (capped ~30–60s),
 *  - enforce a per-turn wall-clock budget across all attempts,
 *  - surface an exhausted-or-terminal failure as a `ReliabilityError` the caller
 *    maps to a single `api-error` event feeding the breaker (never false-trip on a
 *    transient 429 — that is retried silently, HINT-005).
 *
 * Pure and electron-free: the clock, sleep, and jitter source are injected so
 * vitest drives backoff deterministically without real timers (HINT-001).
 */

/** A provider error carrying enough signal to classify and to honor Retry-After. */
export interface ProviderErrorLike {
  /** HTTP status, when the failure carried one (absent = network/no-status). */
  status?: number;
  /** `Retry-After` header value (seconds or an HTTP-date), when present. */
  retryAfter?: string | number;
  /** A coarse, provider-agnostic code, e.g. `'timeout'`, `'network'`, `'context-overflow'`. */
  code?: string;
  message?: string;
}

/** The two — and only two — outcome classes for any error a turn encounters. */
export type ErrorClass = 'retryable' | 'terminal';

/** ADR-0009 retryable HTTP status allowlist (everything else with a status is terminal). */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 529]);

/** Statuses that are explicitly terminal even though they are client/auth errors. */
const TERMINAL_STATUSES = new Set([400, 401, 403]);

/** Coarse codes that always indicate a retryable transport failure. */
const RETRYABLE_CODES = new Set(['timeout', 'etimedout', 'econnreset', 'econnrefused', 'enotfound', 'network', 'eai_again', 'epipe', 'socket-hang-up']);

/** Coarse codes that are always terminal (no retry can help). */
const TERMINAL_CODES = new Set(['context-overflow', 'context_length_exceeded', 'invalid-request', 'unauthorized', 'forbidden']);

/**
 * Pull a `ProviderErrorLike` view out of an arbitrary thrown value. Recognizes a
 * `status`/`retryAfter`/`code` shape, a `Response`-like `{ status, headers }`, and
 * common Node network-error `code`s — so the classifier works on whatever the
 * fetch path threw without leaking a provider SDK type.
 */
function toProviderError(e: unknown): ProviderErrorLike {
  if (e && typeof e === 'object') {
    const obj = e as Record<string, unknown>;
    const status =
      typeof obj.status === 'number'
        ? obj.status
        : typeof obj.statusCode === 'number'
          ? obj.statusCode
          : undefined;
    let retryAfter: string | number | undefined;
    if (typeof obj.retryAfter === 'string' || typeof obj.retryAfter === 'number') {
      retryAfter = obj.retryAfter;
    } else if (obj.headers && typeof (obj.headers as { get?: unknown }).get === 'function') {
      const got = (obj.headers as { get(name: string): string | null }).get('retry-after');
      if (got != null) retryAfter = got;
    }
    const code = typeof obj.code === 'string' ? obj.code.toLowerCase() : undefined;
    const message = typeof obj.message === 'string' ? obj.message : undefined;
    return { status, retryAfter, code, message };
  }
  return { message: typeof e === 'string' ? e : String(e) };
}

/**
 * Classify an error as `retryable` or `terminal` (exhaustive + disjoint, FR-012).
 * Status takes precedence over a coarse code; an error with neither a known
 * status nor a known terminal signal (a bare network failure with no HTTP status)
 * is treated as RETRYABLE per ADR-0009 ("network failures with no HTTP status").
 */
export function classifyError(e: unknown): ErrorClass {
  const err = toProviderError(e);

  if (typeof err.status === 'number') {
    if (RETRYABLE_STATUSES.has(err.status)) return 'retryable';
    if (TERMINAL_STATUSES.has(err.status)) return 'terminal';
    // Any other 4xx is a terminal client error; any other 5xx we treat as terminal
    // unless it was in the allowlist above (conservative — only the allowlist retries).
    if (err.status >= 400 && err.status < 500) return 'terminal';
    return 'terminal';
  }

  if (err.code) {
    if (TERMINAL_CODES.has(err.code)) return 'terminal';
    if (RETRYABLE_CODES.has(err.code)) return 'retryable';
  }

  // Message-based terminal signal (context overflow surfaced without a status).
  if (err.message && /context (length|window)|too many tokens|maximum context/i.test(err.message)) {
    return 'terminal';
  }

  // No status + no terminal signal → a network/connection failure → retryable.
  return 'retryable';
}

/** Tuning for the retry policy. All bounds default to the ADR-0009 envelope. */
export interface ReliabilityOptions {
  /** Total attempts including the first try. ADR-0009: 3–5. Default 4. */
  maxAttempts?: number;
  /** Base backoff in ms for the exponential schedule (attempt 1 = base). Default 500. */
  baseDelayMs?: number;
  /** Hard cap on any single backoff delay, ms (~30–60s). Default 30_000. */
  maxDelayMs?: number;
  /** Per-turn wall-clock budget across all attempts, ms. Default 60_000. */
  turnBudgetMs?: number;
  /** Injected clock (ms epoch). Default `Date.now`. */
  now?: () => number;
  /** Injected sleep; tests pass a no-op or a fake-timer advance. Default real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected [0,1) jitter source. Default `Math.random`. */
  random?: () => number;
}

interface ResolvedOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  turnBudgetMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}

function resolve(opts?: ReliabilityOptions): ResolvedOptions {
  return {
    maxAttempts: clampAttempts(opts?.maxAttempts ?? 4),
    baseDelayMs: opts?.baseDelayMs ?? 500,
    maxDelayMs: opts?.maxDelayMs ?? 30_000,
    turnBudgetMs: opts?.turnBudgetMs ?? 60_000,
    now: opts?.now ?? Date.now,
    sleep: opts?.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))),
    random: opts?.random ?? Math.random
  };
}

/** ADR-0009 keeps attempts in [3,5]; clamp defensively rather than trust the caller. */
function clampAttempts(n: number): number {
  if (!Number.isFinite(n)) return 4;
  return Math.max(3, Math.min(5, Math.trunc(n)));
}

/**
 * Parse a `Retry-After` value (seconds, or an HTTP-date) into a delay in ms, or
 * null when absent/unparseable. Negative/over-cap values are left to the caller's cap.
 */
export function parseRetryAfterMs(value: string | number | undefined, now: () => number): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return value >= 0 ? value * 1000 : null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - now();
    return delta > 0 ? delta : 0;
  }
  return null;
}

/**
 * Full-jitter exponential backoff for `attempt` (1-based): a random value in
 * `[0, min(maxDelay, base * 2^(attempt-1))]`. Honors a `Retry-After` hint as a
 * floor (we wait at least that long), still capped by `maxDelayMs`.
 */
function backoffMs(attempt: number, retryAfterMs: number | null, o: ResolvedOptions): number {
  const exp = Math.min(o.maxDelayMs, o.baseDelayMs * 2 ** (attempt - 1));
  const jittered = Math.floor(o.random() * exp);
  if (retryAfterMs != null) return Math.min(o.maxDelayMs, Math.max(jittered, retryAfterMs));
  return jittered;
}

/**
 * The error surfaced when reliability gives up: either the error was terminal, or
 * the retry budget/attempts were exhausted. The caller maps this to one
 * `api-error` event whose `retryable` flag drives the breaker. `retryable:false`
 * is set for a terminal classification; an exhausted-retryable path keeps
 * `retryable:true` (it was transient — it just ran out of room).
 */
export class ReliabilityError extends Error {
  readonly classification: ErrorClass;
  readonly retryable: boolean;
  readonly attempts: number;
  readonly cause: unknown;
  constructor(message: string, classification: ErrorClass, attempts: number, cause: unknown) {
    super(message);
    this.name = 'ReliabilityError';
    this.classification = classification;
    this.retryable = classification === 'retryable';
    this.attempts = attempts;
    this.cause = cause;
  }
}

/**
 * Run `fn` under the ADR-0009 reliability policy. Resolves with `fn`'s value on
 * success; rejects with a `ReliabilityError` when the error is terminal or the
 * attempt/budget envelope is exhausted. Retryable errors are retried silently
 * with jittered backoff (Retry-After honored), so a transient 429 never reaches
 * the breaker (HINT-005). The per-turn wall-clock budget bounds total time even
 * when individual attempts keep failing retryably.
 */
export async function withReliability<T>(fn: () => Promise<T>, opts?: ReliabilityOptions): Promise<T> {
  const o = resolve(opts);
  const deadline = o.now() + o.turnBudgetMs;
  let attempt = 0;

  // The loop only ever exits by `return` (success) or `throw` (terminal/exhausted).
  for (;;) {
    attempt++;
    try {
      return await fn();
    } catch (e) {
      const cls = classifyError(e);
      if (cls === 'terminal') {
        throw new ReliabilityError(reason(e, 'terminal'), 'terminal', attempt, e);
      }
      // Retryable — decide whether there is room for another attempt.
      if (attempt >= o.maxAttempts) {
        throw new ReliabilityError(reason(e, 'retryable-exhausted'), 'retryable', attempt, e);
      }
      const retryAfterMs = parseRetryAfterMs(toProviderError(e).retryAfter, o.now);
      const delay = backoffMs(attempt, retryAfterMs, o);
      // Budget guard: if the backoff would blow the per-turn wall-clock budget,
      // stop now rather than sleep past it.
      if (o.now() + delay >= deadline) {
        throw new ReliabilityError(reason(e, 'budget-exhausted'), 'retryable', attempt, e);
      }
      await o.sleep(delay);
    }
  }
}

/** Build a budget-safe, key-free reason string (never echoes request content). */
function reason(e: unknown, phase: string): string {
  const err = toProviderError(e);
  const parts: string[] = [`provider call failed (${phase})`];
  if (typeof err.status === 'number') parts.push(`status=${err.status}`);
  if (err.code) parts.push(`code=${err.code}`);
  return parts.join(' ');
}
