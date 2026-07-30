/**
 * E007 US2 — collector normalization parity (T018/T019, FR-008/010/015/016, SC-004/005/006).
 *
 * Feeds the loopback collector BOTH Claude `claude_code.*` DELTA metric bodies (over
 * real OTLP/HTTP JSON, the production ingest path) AND native `gen_ai.*` cumulative
 * usage (the in-main forward seam `ingestNativeUsage`) and asserts:
 *
 *  - ONE cumulative-monotonic `AgentUsageSample` per agent (no double-count, no
 *    decrease — including a would-be DECREASE that CLAMPS at the prior max), with the
 *    registry-computed `usd` set once at the seam (T018 / FR-010 / SC-006);
 *  - the native `execute_tool` → `ToolSpan` mapping: all fields mapped; a FAILED
 *    native tool yields `success=false` with a populated `error` (T019 / FR-016);
 *  - mandatory-attr JOIN-OR-DROP and the distinct drift-vs-malformed drop reasons
 *    (FR-015 / FR-009);
 *  - the consumed sample/span shapes are unchanged, so no consumer needs a
 *    provider-specific branch (FR-011).
 *
 * Network-free except for loopback (127.0.0.1, OS-assigned port) — no live keys.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  TelemetryCollector,
  PINNED_SEMCONV,
  type AgentUsageSample,
  type ToolSpan,
  type TelemetryEvent
} from '../telemetry';
import { NativeAgentWorker, type WorkerTransport } from '../runtime/nativeAgentWorker';
import type { AgentEvent } from '../../shared/agentEvent';
import type { WorkerCommand, WorkerMessage } from '../../shared/workerProtocol';
import { lookupPrice, type PriceRow } from '../../shared/providerRegistry';

// ── OTLP/JSON metric-body builders (mirrors what Claude Code PUSHes) ────────────

interface KV { key: string; value: { stringValue?: string; intValue?: string } }
function attr(key: string, value: string): KV {
  return { key, value: { stringValue: value } };
}

/** Build a `claude_code.token.usage` OTLP body with one DELTA per token class. */
function claudeTokenBody(
  agentId: string,
  sessionId: string,
  model: string,
  delta: { input?: number; output?: number; cacheRead?: number; cacheCreation?: number }
): unknown {
  const point = (type: string, v: number): unknown => ({
    attributes: [
      attr('agent.id', agentId),
      attr('session.id', sessionId),
      attr('model', model),
      attr('type', type)
    ],
    asInt: String(v)
  });
  const dataPoints: unknown[] = [];
  if (delta.input != null) dataPoints.push(point('input', delta.input));
  if (delta.output != null) dataPoints.push(point('output', delta.output));
  if (delta.cacheRead != null) dataPoints.push(point('cacheRead', delta.cacheRead));
  if (delta.cacheCreation != null) dataPoints.push(point('cacheCreation', delta.cacheCreation));
  return {
    resourceMetrics: [
      {
        resource: { attributes: [attr('agent.id', agentId)] },
        scopeMetrics: [{ metrics: [{ name: 'claude_code.token.usage', sum: { dataPoints } }] }]
      }
    ]
  };
}

/** POST an OTLP metric body to the collector's loopback `/v1/metrics` endpoint. */
async function postMetrics(endpoint: string, body: unknown): Promise<void> {
  const res = await fetch(`${endpoint}/v1/metrics`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  // Drain the body so the socket closes and ingest has run before we read state.
  await res.text();
}

function row(model: string): PriceRow {
  const r = lookupPrice(model, { contextSize: 0 });
  if ('unknown' in r) throw new Error(`registry row missing for ${model}`);
  return r;
}

function expectUsd(sample: AgentUsageSample): void {
  const r = row(sample.model);
  const expected =
    (sample.input / 1_000_000) * r.inputPerM +
    (sample.output / 1_000_000) * r.outputPerM +
    (sample.cacheRead / 1_000_000) * r.cacheReadPerM +
    (sample.cacheCreation / 1_000_000) * r.cacheWritePerM;
  expect(sample.usd).not.toBeNull();
  expect(sample.usd as number).toBeCloseTo(expected, 10);
}

describe('E007 US2 — gen_ai.* normalization branch (T018/T019)', () => {
  let collector: TelemetryCollector;
  let endpoint: string;

  beforeEach(async () => {
    collector = new TelemetryCollector({ host: '127.0.0.1', port: 0 });
    const r = await collector.start();
    expect(r.ok).toBe(true);
    endpoint = r.endpoint as string;
  });

  afterEach(() => {
    collector.stop();
  });

  it('pins the GenAI semconv version (FR-009 / T010)', () => {
    expect(PINNED_SEMCONV).toBe('gen_ai_latest_experimental');
  });

  // ── T018 {FR-010} — one cumulative-monotonic sample across both sources ──────

  it('native gen_ai usage normalizes into an AgentUsageSample with registry usd (FR-008/011)', () => {
    const ok = collector.ingestNativeUsage({
      agentId: 'desk-ds',
      sessionId: 's1',
      providerName: 'deepseek',
      requestModel: 'deepseek-v4-flash',
      tokens: { input: 1_200_000, output: 300_000, cacheRead: 800_000, cacheCreation: 50_000 }
    });
    expect(ok).toBe(true);

    const sample = collector.getAgentUsage('desk-ds');
    expect(sample).not.toBeNull();
    expect(sample!.model).toBe('deepseek-v4-flash');
    expect(sample!.input).toBe(1_200_000);
    expect(sample!.output).toBe(300_000);
    expect(sample!.cacheRead).toBe(800_000);
    expect(sample!.cacheCreation).toBe(50_000);
    // usd computed ONCE at the seam from the registry (FR-001/002).
    expectUsd(sample!);
  });

  it('claude_code DELTA + native cumulative reconcile to ONE counter, no double-count (FR-010/SC-006)', async () => {
    const agentId = 'desk-mix';
    // Claude on the SAME agent but a DIFFERENT session (a claude_code sub-stream).
    await postMetrics(
      endpoint,
      claudeTokenBody(agentId, 'claude-sess', 'claude-opus-4', {
        input: 100_000,
        output: 40_000,
        cacheRead: 0,
        cacheCreation: 0
      })
    );
    // Native cumulative usage on a different session of the same agent.
    collector.ingestNativeUsage({
      agentId,
      sessionId: 'native-sess',
      providerName: 'minimax',
      requestModel: 'minimax-m3',
      tokens: { input: 200_000, output: 80_000, cacheRead: 0, cacheCreation: 0 }
    });

    const sample = collector.getAgentUsage(agentId);
    expect(sample).not.toBeNull();
    // Both sources SUMMED once — claude delta (100k/40k) + native cumulative (200k/80k).
    expect(sample!.input).toBe(300_000);
    expect(sample!.output).toBe(120_000);
  });

  it('native cumulative is SET-not-SUMMED — re-reporting the same cumulative does NOT double-count (FR-010)', () => {
    const agentId = 'desk-cum';
    const cum = { input: 500_000, output: 100_000, cacheRead: 0, cacheCreation: 0 };
    collector.ingestNativeUsage({ agentId, sessionId: 's', providerName: 'deepseek', requestModel: 'deepseek-v4-flash', tokens: cum });
    // The worker re-emits the SAME cumulative snapshot (e.g. an idle re-publish).
    collector.ingestNativeUsage({ agentId, sessionId: 's', providerName: 'deepseek', requestModel: 'deepseek-v4-flash', tokens: cum });

    const sample = collector.getAgentUsage(agentId);
    expect(sample!.input).toBe(500_000); // NOT 1,000,000 — cumulative set, not summed
    expect(sample!.output).toBe(100_000);
  });

  it('native cumulative GROWS monotonically across calls (FR-010)', () => {
    const agentId = 'desk-grow';
    collector.ingestNativeUsage({ agentId, sessionId: 's', providerName: 'deepseek', requestModel: 'deepseek-v4-flash', tokens: { input: 100_000, output: 20_000, cacheRead: 0, cacheCreation: 0 } });
    collector.ingestNativeUsage({ agentId, sessionId: 's', providerName: 'deepseek', requestModel: 'deepseek-v4-flash', tokens: { input: 250_000, output: 60_000, cacheRead: 0, cacheCreation: 0 } });

    const sample = collector.getAgentUsage(agentId);
    expect(sample!.input).toBe(250_000); // the latest cumulative, not the sum (350k)
    expect(sample!.output).toBe(60_000);
  });

  it('a would-be DECREASE CLAMPS at the prior cumulative max (never decreases — HINT-004/SC-006)', () => {
    const agentId = 'desk-clamp';
    collector.ingestNativeUsage({ agentId, sessionId: 's', providerName: 'minimax', requestModel: 'minimax-m3', tokens: { input: 400_000, output: 90_000, cacheRead: 10_000, cacheCreation: 5_000 } });
    // A LOWER cumulative arrives (out-of-order / reset glitch): MUST NOT be applied.
    collector.ingestNativeUsage({ agentId, sessionId: 's', providerName: 'minimax', requestModel: 'minimax-m3', tokens: { input: 100_000, output: 10_000, cacheRead: 0, cacheCreation: 0 } });

    const sample = collector.getAgentUsage(agentId);
    expect(sample!.input).toBe(400_000); // clamped at the prior max
    expect(sample!.output).toBe(90_000);
    expect(sample!.cacheRead).toBe(10_000);
    expect(sample!.cacheCreation).toBe(5_000);
  });

  it('a partial decrease clamps PER-FIELD (one field rises, another would fall)', () => {
    const agentId = 'desk-clamp2';
    collector.ingestNativeUsage({ agentId, sessionId: 's', providerName: 'deepseek', requestModel: 'deepseek-v4-flash', tokens: { input: 300_000, output: 100_000, cacheRead: 0, cacheCreation: 0 } });
    // input grows, output would shrink — each field clamps independently.
    collector.ingestNativeUsage({ agentId, sessionId: 's', providerName: 'deepseek', requestModel: 'deepseek-v4-flash', tokens: { input: 350_000, output: 40_000, cacheRead: 0, cacheCreation: 0 } });

    const sample = collector.getAgentUsage(agentId);
    expect(sample!.input).toBe(350_000); // rose
    expect(sample!.output).toBe(100_000); // held at the prior max (decrease not applied)
  });

  // ── T013/T016 {FR-015/009} — mandatory-attr join-or-drop + distinct reasons ──

  it('drops an emission missing a MANDATORY attribute, never attributing it (FR-015)', () => {
    const before = collector.nativeDropCounts();
    // Missing provider.name (mandatory) — cannot be joined → DROP (drift).
    const ok = collector.ingestNativeUsage({
      agentId: 'desk-x',
      sessionId: 's',
      providerName: '',
      requestModel: 'deepseek-v4-flash',
      tokens: { input: 100, output: 100, cacheRead: 0, cacheCreation: 0 }
    });
    expect(ok).toBe(false);
    expect(collector.getAgentUsage('desk-x')).toBeNull(); // accumulated nothing
    expect(collector.nativeDropCounts().drift).toBe(before.drift + 1);
  });

  it('distinguishes SEMCONV DRIFT (unknown provider) from MALFORMED (bad token) on distinct reasons (FR-009)', () => {
    const before = collector.nativeDropCounts();
    // DRIFT: well-formed but an unknown/off-version provider name.
    expect(collector.ingestNativeUsage({
      agentId: 'd1', sessionId: 's', providerName: 'acme-unknown', requestModel: 'deepseek-v4-flash',
      tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }
    })).toBe(false);
    // MALFORMED: a structurally invalid (NaN) token value.
    expect(collector.ingestNativeUsage({
      agentId: 'd2', sessionId: 's', providerName: 'deepseek', requestModel: 'deepseek-v4-flash',
      tokens: { input: Number.NaN, output: 1, cacheRead: 0, cacheCreation: 0 }
    })).toBe(false);

    const after = collector.nativeDropCounts();
    expect(after.drift).toBe(before.drift + 1);     // counted apart
    expect(after.malformed).toBe(before.malformed + 1);
    expect(collector.getAgentUsage('d1')).toBeNull();
    expect(collector.getAgentUsage('d2')).toBeNull();
  });

  it('an unknown REQUEST model accumulates but prices usd = null (parity warning, FR-006)', () => {
    // Provider is known (deepseek) so it joins; the model id is unpriced.
    const ok = collector.ingestNativeUsage({
      agentId: 'desk-unk',
      sessionId: 's',
      providerName: 'deepseek',
      requestModel: 'deepseek-totally-unknown-zzz',
      tokens: { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheCreation: 0 }
    });
    expect(ok).toBe(true);
    const sample = collector.getAgentUsage('desk-unk');
    expect(sample).not.toBeNull();
    expect(sample!.usd).toBeNull(); // unpriced — NOT 0, no wrong-vendor default
  });

  // ── T019 [P] {FR-016} — execute_tool → ToolSpan mapping ──────────────────────

  it('maps a native execute_tool to a ToolSpan with all fields (FR-016)', () => {
    const ok = collector.ingestNativeToolSpan({
      agentId: 'desk-tool',
      sessionId: 's7',
      toolName: 'hive_send',
      durationMs: 1234,
      success: true,
      decision: 'accept'
    });
    expect(ok).toBe(true);

    const spans: ToolSpan[] = collector.getSpans('desk-tool');
    expect(spans).toHaveLength(1);
    const span = spans[0];
    expect(span.agentId).toBe('desk-tool');
    expect(span.sessionId).toBe('s7');
    expect(span.tool).toBe('hive_send'); // tool ← tool name
    expect(span.durationMs).toBe(1234);  // duration ← elapsed
    expect(span.success).toBe(true);
    expect(span.decision).toBe('accept'); // decision ← the decision attr
    expect(span.error).toBeUndefined();   // empty/omitted on success
  });

  it('a FAILED native tool yields success=false with a populated error (FR-016/SC-004)', () => {
    collector.ingestNativeToolSpan({
      agentId: 'desk-fail',
      sessionId: 's8',
      toolName: 'hive_task',
      durationMs: 42,
      success: false,
      error: 'permission denied: read-only hive'
    });

    const span = collector.getSpans('desk-fail')[0];
    expect(span.success).toBe(false);
    expect(span.error).toBe('permission denied: read-only hive');
    expect(span.tool).toBe('hive_task');
    expect(span.durationMs).toBe(42);
  });

  it('uses the default decision (none) when the tool span carries no decision attr', () => {
    collector.ingestNativeToolSpan({ agentId: 'desk-nd', sessionId: 's', toolName: 'hive_read', durationMs: 5, success: true });
    const span = collector.getSpans('desk-nd')[0];
    expect(span.decision).toBeUndefined(); // ToolSpan default — no decision recorded
  });

  it('drops a tool span missing the tool name (mandatory) — never an arbitrary agent (FR-015)', () => {
    const before = collector.nativeDropCounts();
    const ok = collector.ingestNativeToolSpan({ agentId: 'desk-nt', sessionId: 's', toolName: '', durationMs: 5, success: true });
    expect(ok).toBe(false);
    expect(collector.getSpans('desk-nt')).toHaveLength(0);
    expect(collector.nativeDropCounts().drift).toBe(before.drift + 1);
  });

  // ── FR-011 — the native sample is consumed unchanged via the push seam ───────

  it('publishes the native sample on the SAME onAgentUsage push seam consumers use (FR-011)', () => {
    const received: AgentUsageSample[] = [];
    const unsub = collector.onAgentUsage((s) => received.push(s));
    collector.ingestNativeUsage({
      agentId: 'desk-push',
      sessionId: 's',
      providerName: 'minimax',
      requestModel: 'minimax-m3',
      tokens: { input: 10_000, output: 5_000, cacheRead: 0, cacheCreation: 0 }
    });
    unsub();
    expect(received.length).toBeGreaterThanOrEqual(1);
    const last = received[received.length - 1];
    expect(last.agentId).toBe('desk-push');
    // Same locked shape — every field the consumers read is present.
    expect(last).toHaveProperty('input');
    expect(last).toHaveProperty('output');
    expect(last).toHaveProperty('cacheRead');
    expect(last).toHaveProperty('cacheCreation');
    expect(last).toHaveProperty('model');
    expect(last).toHaveProperty('usd');
  });

  // ── T011/T017 {FR-008/011/016} — the worker forward seam end-to-end ──────────

  it('NativeAgentWorker forwards token-usage + tool spans into the collector (FR-008/011/016)', async () => {
    const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
    // A fake worker transport whose `emit` injects worker→main messages.
    let msgCb: ((m: WorkerMessage) => void) | null = null;
    const posted: WorkerCommand[] = [];
    const transport: WorkerTransport = {
      post: (c) => posted.push(c),
      onMessage: (cb) => { msgCb = cb; },
      onExit: () => { /* unused */ },
      kill: () => { /* unused */ }
    };
    const worker = new NativeAgentWorker({
      agentId: 'desk-w',
      transportFactory: () => transport,
      telemetry: collector // the REAL collector as the forward sink (single-writer)
    });
    await worker.start();
    const emit = (event: AgentEvent): void =>
      msgCb?.({ type: 'event', event });
    const base = { v: 1, agentId: 'desk-w', sessionId: 'ws', ts: 1 } as const;

    // 1) cumulative token-usage on a deepseek model → AgentUsageSample with usd.
    emit({ ...base, kind: 'token-usage', input: 600_000, output: 150_000, cacheRead: 0, cacheCreation: 0, model: 'deepseek-v4-flash', usd: 0 });
    await flush();
    const sample = collector.getAgentUsage('desk-w');
    expect(sample).not.toBeNull();
    expect(sample!.input).toBe(600_000);
    expect(sample!.model).toBe('deepseek-v4-flash');
    expectUsd(sample!); // provider DERIVED from the model, priced once at the seam

    // 2) a tool-start/tool-end pair → one ToolSpan (name recovered from start).
    emit({ ...base, kind: 'tool-start', toolName: 'hive_send', toolInput: {}, toolCallId: 'tc1' });
    emit({ ...base, kind: 'tool-end', toolCallId: 'tc1', success: true, durationMs: 88 });
    await flush();
    const okSpan = collector.getSpans('desk-w').find((s) => s.tool === 'hive_send');
    expect(okSpan).toBeTruthy();
    expect(okSpan!.success).toBe(true);
    expect(okSpan!.durationMs).toBe(88);

    // 3) a FAILED tool-end → success=false with the error text (FR-016).
    emit({ ...base, kind: 'tool-start', toolName: 'hive_task', toolInput: {}, toolCallId: 'tc2' });
    emit({ ...base, kind: 'tool-end', toolCallId: 'tc2', success: false, durationMs: 12, error: 'denied' });
    await flush();
    const failSpan = collector.getSpans('desk-w').find((s) => s.tool === 'hive_task');
    expect(failSpan!.success).toBe(false);
    expect(failSpan!.error).toBe('denied');
  });
});

// ─── E007 T024 {FR-013 / SC-008} — secret-non-leak across EVERY channel ─────────
//
// Injects a SENTINEL secret into the collector via EVERY input path the seam has,
// then asserts the sentinel — and the bare `LEAKCANARY` substring — appears in
// NONE of the products the seam emits/holds:
//   - the published `AgentUsageSample` (push + pull + snapshot),
//   - any `ToolSpan` (pull + snapshot),
//   - EVERY emitted `telemetry:event` (usage, tool_result, api_error, AND the
//     unknown-model parity_warning),
//   - the collector's drop tally + diagnostic state.
//
// Paths exercised (the task's full matrix):
//   (a) an OTLP METRIC body carrying the secret in an UNKNOWN/unexpected attribute
//       (the fail-closed allowlist must drop it — never copy it onto a sample),
//   (b) an OTLP LOG body carrying the secret in unknown attrs + the free-text
//       error/message/body (the api_error channel must emit only a fixed label),
//   (c) a NATIVE usage input whose model id embeds the secret (the unknown-model
//       parity-warning trigger — the warning must scrub it),
//   (d) a NATIVE tool input,
//   (e) the malformed + drift DROP paths (a secret in a dropped input must not
//       surface in any state, event, or tally).
//
// The single sentinel is shaped like a real API key (`sk-…`) so the allowlist +
// credential scrub are both exercised; the bare `LEAKCANARY` token is also asserted
// absent so a partial/unscrubbed leak is caught even if the `sk-` prefix is stripped.

const SENTINEL = 'sk-LEAKCANARY-DO-NOT-EMIT';
const CANARY = 'LEAKCANARY';

/** Build an OTLP metric body that ALSO carries the secret in UNKNOWN attributes
 *  (an API-key header, an authorization attr) plus a valid token point — so the
 *  fail-closed allowlist is the only thing standing between the secret and a
 *  sample. The known keys (agent.id/session.id/model/type) are present so the
 *  point would otherwise accumulate. */
function leakyClaudeMetricBody(agentId: string, sessionId: string, model: string): unknown {
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            attr('agent.id', agentId),
            // UNKNOWN resource attrs carrying the secret — must be dropped.
            attr('api.key', SENTINEL),
            attr('authorization', `Bearer ${SENTINEL}`),
            attr('x-api-key', SENTINEL)
          ]
        },
        scopeMetrics: [
          {
            metrics: [
              {
                name: 'claude_code.token.usage',
                sum: {
                  dataPoints: [
                    {
                      attributes: [
                        attr('agent.id', agentId),
                        attr('session.id', sessionId),
                        attr('model', model),
                        attr('type', 'input'),
                        // UNKNOWN data-point attrs carrying the secret + a payload.
                        attr('prompt', `secret in the prompt: ${SENTINEL}`),
                        attr('http.request.header.authorization', SENTINEL),
                        attr('user.email', `${CANARY}@example.com`)
                      ],
                      asInt: '100000'
                    }
                  ]
                }
              }
            ]
          }
        ]
      }
    ]
  };
}

/** Build an OTLP LOG body for the api_error channel that smuggles the secret into
 *  the free-text error/message/body fields AND unknown attrs. */
function leakyApiErrorLogBody(agentId: string, sessionId: string): unknown {
  return {
    resourceLogs: [
      {
        resource: { attributes: [attr('agent.id', agentId)] },
        scopeLogs: [
          {
            logRecords: [
              {
                attributes: [
                  attr('agent.id', agentId),
                  attr('session.id', sessionId),
                  attr('event.name', 'api_error'),
                  // Free-text fields an upstream record could carry — must NOT echo.
                  attr('error', `auth failed for key ${SENTINEL}`),
                  attr('message', `request body: ${SENTINEL}`),
                  attr('api_key', SENTINEL)
                ],
                body: { stringValue: `api_error: leaked ${SENTINEL}` }
              }
            ]
          }
        ]
      }
    ]
  };
}

describe('E007 T024 {FR-013/SC-008} — no secret leaks on ANY channel', () => {
  let collector: TelemetryCollector;
  let endpoint: string;
  let events: TelemetryEvent[];

  beforeEach(async () => {
    events = [];
    collector = new TelemetryCollector({
      host: '127.0.0.1',
      port: 0,
      // Capture EVERY emitted renderer event so we can scan them all for the secret.
      emit: (channel, payload) => {
        if (channel === 'telemetry:event') events.push(payload as TelemetryEvent);
      }
    });
    const r = await collector.start();
    expect(r.ok).toBe(true);
    endpoint = r.endpoint as string;
  });

  afterEach(() => collector.stop());

  /** Assert neither the sentinel nor the bare canary substring appears in a blob. */
  function expectClean(label: string, value: unknown): void {
    const blob = typeof value === 'string' ? value : JSON.stringify(value);
    expect(blob, `${label} must not contain the sentinel secret`).not.toContain(SENTINEL);
    expect(blob, `${label} must not contain the canary substring`).not.toContain(CANARY);
  }

  it('the sentinel appears in NONE of the samples, spans, events, drops, or diagnostics', async () => {
    const pushed: AgentUsageSample[] = [];
    const unsub = collector.onAgentUsage((s) => pushed.push(s));

    // (a) OTLP METRIC with the secret in UNKNOWN attrs — the allowlist must drop it,
    //     the token point still accumulates onto a clean sample.
    await postMetrics(endpoint, leakyClaudeMetricBody('desk-leak', 'sess-a', 'claude-opus-4'));

    // (b) OTLP LOG (api_error) smuggling the secret into free-text + unknown attrs.
    await fetch(`${endpoint}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(leakyApiErrorLogBody('desk-leak', 'sess-a'))
    }).then((r) => r.text());

    // (c) NATIVE usage whose MODEL ID embeds the secret → unknown-model → priced
    //     usd=null + a parity_warning (the warning must scrub the embedded secret).
    collector.ingestNativeUsage({
      agentId: 'desk-leak',
      sessionId: 'sess-native',
      providerName: 'deepseek', // known provider → joins, then the model is unpriced
      requestModel: `deepseek-${SENTINEL}-zzz`,
      tokens: { input: 50_000, output: 10_000, cacheRead: 0, cacheCreation: 0 }
    });

    // (d) NATIVE tool input (a clean span path on the same agent).
    collector.ingestNativeToolSpan({
      agentId: 'desk-leak',
      sessionId: 'sess-native',
      toolName: 'hive_send',
      durationMs: 5,
      success: true
    });

    // (e) DROP paths — a secret in a MALFORMED (NaN token) and a DRIFT (unknown
    //     provider) input must surface nowhere, not even in the drop tally.
    collector.ingestNativeUsage({
      agentId: 'desk-leak',
      sessionId: 'sess-drop',
      providerName: 'deepseek',
      requestModel: `deepseek-${SENTINEL}`,
      tokens: { input: Number.NaN, output: 1, cacheRead: 0, cacheCreation: 0 } // malformed
    });
    collector.ingestNativeUsage({
      agentId: 'desk-leak',
      sessionId: 'sess-drop2',
      providerName: `acme-${SENTINEL}`, // unknown provider → drift
      requestModel: 'deepseek-v4-flash',
      tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }
    });

    unsub();

    // ── 1) The published AgentUsageSample (pull) is clean. ──────────────────────
    const sample = collector.getAgentUsage('desk-leak');
    expect(sample).not.toBeNull();
    expectClean('getAgentUsage sample', sample);
    // The model id smuggled a secret; the resolved/normalized model must be scrubbed.
    expectClean('sample.model', sample!.model);

    // ── 2) Every PUSHED sample is clean. ────────────────────────────────────────
    expect(pushed.length).toBeGreaterThanOrEqual(1);
    for (const s of pushed) expectClean('pushed AgentUsageSample', s);

    // ── 3) Every ToolSpan (pull) is clean. ──────────────────────────────────────
    for (const span of collector.getSpans('desk-leak')) expectClean('ToolSpan', span);

    // ── 4) The cold-start snapshot (samples + spans) is clean. ──────────────────
    const snap = collector.snapshot();
    expectClean('snapshot', snap);

    // ── 5) EVERY emitted telemetry:event is clean — incl. usage, tool_result,
    //       api_error, AND the unknown-model parity_warning. ─────────────────────
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expectClean(`telemetry:event(${e.kind})`, e);

    // Assert the channels we EXPECT actually fired (so the test isn't vacuous):
    expect(events.some((e) => e.kind === 'usage')).toBe(true);
    expect(events.some((e) => e.kind === 'api_error')).toBe(true);
    expect(events.some((e) => e.kind === 'parity_warning')).toBe(true);

    // The api_error event carries ONLY the fixed label — no upstream free text.
    const apiErr = events.find((e) => e.kind === 'api_error') as
      | { kind: 'api_error'; error: string }
      | undefined;
    expect(apiErr?.error).toBe('api_error');

    // The parity_warning carries the SCRUBBED model id (secret redacted), never raw.
    const warn = events.find((e) => e.kind === 'parity_warning') as
      | { kind: 'parity_warning'; model: string }
      | undefined;
    expect(warn).toBeTruthy();
    expectClean('parity_warning.model', warn!.model);
    expect(warn!.model).toContain('(redacted)'); // the embedded secret was scrubbed

    // ── 6) The drop tally + diagnostic state hold no secret. ────────────────────
    const drops = collector.nativeDropCounts();
    expectClean('nativeDropCounts', drops);
    expect(drops.malformed).toBeGreaterThanOrEqual(1); // the NaN-token drop counted
    expect(drops.drift).toBeGreaterThanOrEqual(1);     // the unknown-provider drift counted
  });

  it('a secret in an UNKNOWN OTLP metric attribute is DROPPED, never copied onto the sample (allowlist)', async () => {
    await postMetrics(endpoint, leakyClaudeMetricBody('desk-mx', 'sess', 'claude-opus-4'));
    const sample = collector.getAgentUsage('desk-mx');
    expect(sample).not.toBeNull();
    // The token point still accumulated (proving the body parsed), but the secret
    // attrs were dropped by the fail-closed allowlist — the sample is clean.
    expect(sample!.input).toBe(100_000);
    expectClean('sample after leaky metric ingest', sample);
    for (const e of events) expectClean(`event(${e.kind}) after leaky metric`, e);
  });

  it('the api_error channel emits a FIXED label, never the upstream free-text error/body (FR-013)', async () => {
    await fetch(`${endpoint}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(leakyApiErrorLogBody('desk-ae', 'sess'))
    }).then((r) => r.text());
    const apiErr = events.find((e) => e.kind === 'api_error') as
      | { kind: 'api_error'; error: string }
      | undefined;
    expect(apiErr).toBeTruthy();
    expect(apiErr!.error).toBe('api_error'); // the fixed, non-leaking label
    for (const e of events) expectClean(`event(${e.kind})`, e);
  });
});
