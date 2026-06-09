/**
 * TelemetryCollector — the live, first-party observability tap for the hive.
 *
 * Every spawned `claude` is launched with `CLAUDE_CODE_ENABLE_TELEMETRY=1` and
 * `OTEL_EXPORTER_OTLP_ENDPOINT` pointed here (see hive.ts `ensureAgent`). Claude
 * Code then PUSHES OpenTelemetry over plain OTLP/HTTP JSON to this embedded
 * collector — no protobuf, no external process, loopback only. We decode it into
 * two products:
 *
 *   1. The usage PROVIDER (the locked cross-lane seam) — `getAgentUsage(agentId)`
 *      (pull, primary) + `onAgentUsage(cb)` (push). Returns `AgentUsageSample`,
 *      a PII-free cumulative cost/token snapshot. Lane A's circuit breaker (#6)
 *      consumes this; the swap between the OTel backend and the transcript
 *      fallback is hidden here so the breaker never changes.
 *   2. An EPHEMERAL ring buffer of rich tool spans (`tool_result` durations +
 *      success) per agent, for the per-agent span waterfall (#7B.2).
 *
 * 🔒 PII: raw OTel records carry `user.email`, `user.account_id/uuid`,
 * `organization.id` and a hashed `user.id`. We read ONLY an allowlist of keys
 * ({agent.id, session.id, model, token type, cost, tool fields}) and never
 * persist a raw record — so everything this module emits is PII-free BY
 * CONSTRUCTION. Downstream durable stores (Lane A's cost-ledger, Lane B's
 * SQLite) inherit that guarantee and must never persist a raw record either.
 *
 * Transport posture mirrors `slack.ts`: the local handler bound to 127.0.0.1 is
 * the security boundary. Runs in the Electron main process; deliberately free of
 * any `electron` import so it can be smoke-tested as a plain Node module.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readAgentUsage } from './transcript';
import { normalizeModel, resolvePrice } from './pricing';
import { listProviders } from '../shared/providerRegistry';

// ─── E007 T010 {FR-009} — pinned GenAI semantic-convention version ─────────────
//
// The OTel GenAI conventions are EXPERIMENTAL ("Development" status), so the
// emission + normalization stay locked to ONE pinned version. The native worker
// is spawned with `OTEL_SEMCONV_STABILITY_OPT_IN` set to this string (the main
// env `define` in electron.vite.config.ts threads it in), and this collector
// records the same pin so the gen_ai branch knows which instrument/attribute
// schema is in-version. An incoming gen_ai emission that does not match this pin
// (an unknown instrument name or a renamed attribute) is SEMCONV DRIFT and
// dropped on a distinct reason from a structurally-malformed input (AD-005 /
// research §1). This is recorded once, here, as the single parity invariant.
export const PINNED_SEMCONV = 'gen_ai_latest_experimental';

/** E007 T013/T016 {FR-015} — the set of KNOWN `gen_ai.provider.name` values (the
 *  registry's provider ids, lowercased). A gen_ai emission whose provider name is
 *  not in this set is off the pinned schema (SEMCONV DRIFT) and dropped — it is
 *  never attributed. Derived from the E002 registry so it stays in lockstep. */
const KNOWN_PROVIDER_NAMES = new Set(listProviders().map((p) => p.id.toLowerCase()));

// ─── The locked cross-lane contract (do not change without re-agreeing) ───────

/** A cumulative cost/token snapshot for one agent. The shared row consumed by
 *  Lane A's breaker (#6) and persisted by Lane A's cost-ledger / Lane B's SQLite
 *  (#4). PII-free by construction (see file header). `usd` is Claude's own
 *  per-model cost on the live path, the fallback estimate on the transcript
 *  path — never recomputed downstream. */
export interface AgentUsageSample {
  agentId: string;
  /** Dedup/accounting key — present on every OTel record; fixes the cwd
   *  double-count. Empty string on the transcript fallback when unknown. */
  sessionId: string;
  ts: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  /** Normalized model id (`claude-opus-4-8`, no `[1m]` suffix). */
  model: string;
  /** Registry-computed cost (the single seam source — NOT the provider's
   *  self-reported `cost.usage`, which is retained only as a diagnostic). `null`
   *  = unpriced (unknown model id): no price billed, parity warning is the flag.
   *  Consumers exclude `null` from billed totals, never read as 0 (FR-006/014). */
  usd: number | null;
}

/** Breaker state, emitted by Lane A's policy on `control:breakerState` and
 *  consumed by this lane's avatar adapter (#5C) + cost meter. Defined here as
 *  the shared type so both lanes import one shape. */
export interface BreakerState {
  agentId: string;
  level: 'healthy' | 'steering' | 'constrained' | 'stopped';
  reason: string;
  ts: number;
}

// ─── Internal, lane-owned shapes ──────────────────────────────────────────────

/** A single tool invocation, for the per-agent span waterfall. Ephemeral — kept
 *  only in the in-memory ring buffer, never persisted. */
export interface ToolSpan {
  agentId: string;
  sessionId: string;
  ts: number;
  tool: string;
  success: boolean;
  durationMs: number;
  decision?: 'accept' | 'reject';
  error?: string;
}

/**
 * E007 T012/T013 {FR-008/015} — native (gen_ai.*) usage fed into the collector's
 * normalization branch. This is the in-main forward seam (`nativeAgentWorker.ts`
 * single-writer, AD-002): a native `token-usage` AgentEvent maps onto this shape
 * and `ingestNativeUsage` accumulates it into the SAME `SessionAccum` /
 * `AgentUsageSample` path as `claude_code.*`.
 *
 * Models the GenAI `gen_ai.client.token.usage` histogram (split input/output) plus
 * the mandatory join attributes (FR-015): `agentId` ← `gen_ai.agent.id` (join key),
 * `providerName` ← `gen_ai.provider.name`, `requestModel` ← `gen_ai.request.model`.
 * `responseModel` ← `gen_ai.response.model` is OPTIONAL (preferred for pricing when
 * present). `tokens` are CUMULATIVE per session (the worker's loop accumulates),
 * not deltas. Least-attribute: NO prompt/response content, headers, or secret —
 * only token counts + the required ids (FR-013). */
export interface NativeUsageInput {
  /** `gen_ai.agent.id` — the join key (MANDATORY, FR-015). */
  agentId: string;
  /** Dedup/accounting key — present on every emission. */
  sessionId: string;
  /** `gen_ai.provider.name` (MANDATORY, FR-015). */
  providerName: string;
  /** `gen_ai.request.model` (MANDATORY, FR-015) — the priced model id. */
  requestModel: string;
  /** `gen_ai.response.model` (RECOMMENDED, FR-015) — preferred over requestModel
   *  for pricing when present; its absence is NOT a defect. */
  responseModel?: string | null;
  /** CUMULATIVE token counts for this session (`gen_ai.token.type` = input/output;
   *  cache split mirrors the seam). */
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number };
}

/**
 * E007 T014/T016 {FR-016} — a native `execute_tool` invocation fed into the
 * collector. Maps onto a `ToolSpan` by the FIXED rule (no new/renamed field,
 * FR-014): `tool` ← tool name; `durationMs` ← elapsed (end − start); `success` ←
 * false on an ERROR status (else true); `error` ← the error text when present;
 * `decision` ← the decision attr when present (else the ToolSpan default). */
export interface NativeToolInput {
  agentId: string;
  sessionId: string;
  /** `gen_ai.tool.name` (MANDATORY on a tool emission, FR-015). */
  toolName: string;
  /** Span elapsed time (end − start), ms. */
  durationMs: number;
  /** False when the span ended with an ERROR status / carries an error (FR-016). */
  success: boolean;
  /** The error text/status-description when the tool failed; absent on success. */
  error?: string;
  /** The tool-decision attr when the span carries one; absent ⇒ ToolSpan default. */
  decision?: 'accept' | 'reject';
}

/** E007 T016 {FR-009} — distinct internal drop reasons for the gen_ai branch, kept
 *  SEPARATE so semconv DRIFT (well-formed but off-version / unknown schema) is not
 *  conflated with a MALFORMED input (structurally invalid). Both drop (accumulate
 *  nothing); they are merely counted apart for attributability. */
export interface NativeDropCounts {
  /** Structurally invalid input (missing/non-numeric/NaN token, no ids). */
  malformed: number;
  /** Well-formed but off the pinned semconv (unknown provider / schema drift) or
   *  missing a MANDATORY join attribute (FR-015) — cannot be joined/attributed. */
  drift: number;
}

/** The normalized event pushed to the renderer over `telemetry:event`. */
export type TelemetryEvent =
  | { kind: 'usage'; sample: AgentUsageSample }
  | { kind: 'tool_result'; span: ToolSpan }
  | { kind: 'api_error'; agentId: string; sessionId: string; ts: number; error: string }
  /** E007 T020 {FR-006} — OPERATOR-VISIBLE telemetry-parity warning raised when a
   *  model id reaches the seam unknown/unpriced: the sample's `usd` is `null` (no
   *  price billed) and THIS is the loud flag the operator sees. Bounded to the
   *  unknown model id ALONE — NO prompt/response content, tokens, headers, or any
   *  secret (FR-006/FR-013). Deduped per model so it is not spammed every publish. */
  | { kind: 'parity_warning'; model: string; ts: number };

/** Cold-start backfill returned by `snapshot()`. */
export interface TelemetrySnapshot {
  usage: AgentUsageSample[];
  spans: Record<string, ToolSpan[]>;
}

/** Per-session running accumulation (token.usage / cost.usage are DELTA +
 *  monotonic, so we sum each export rather than treating it as a total).
 *
 *  Cost is NOT carried here: USD is computed ONCE at aggregate/publish from the
 *  registry (E007 AD-001/FR-005) using the summed token counts × the dated price
 *  row — never from the provider's self-reported figure. `diagUsd` retains the
 *  summed `claude_code.cost.usage` ONLY as a diagnostic cross-check; it is never
 *  the published `usd` (HINT-001). */
interface SessionAccum {
  agentId: string;
  model: string;
  ts: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  /** Diagnostic cross-check only — the provider's self-reported `cost.usage`
   *  sum. NEVER the published cost source (FR-005/HINT-001). */
  diagUsd: number;
  /** E007 T015 {FR-010/HINT-004} — native (gen_ai) CUMULATIVE token counts for
   *  this session, kept SEPARATE from the claude_code DELTA sums above.
   *
   *  Claude `claude_code.token.usage` arrives as deltas, summed into the fields
   *  above; native `gen_ai.client.token.usage` arrives ALREADY CUMULATIVE per
   *  session (the worker's `runAgentLoop` accumulates), so it is SET (latest),
   *  not summed — summing a cumulative stream would double-count (research §2).
   *  Both halves are added in `aggregateLive` to form one per-agent counter.
   *
   *  Cumulative-monotonic: a native sample that would LOWER any field is CLAMPED
   *  at the prior max (the decrease is not applied), so the counter never
   *  decreases or double-counts across the two sources (FR-010/SC-006). */
  nativeInput: number;
  nativeOutput: number;
  nativeCacheRead: number;
  nativeCacheCreation: number;
}

const MAX_BODY_BYTES = 8 * 1024 * 1024; // OTLP batches are small; cap unauth peers.
const SPAN_RING_CAP = 200; // rich spans retained per agent for the waterfall.

export interface TelemetryCollectorOptions {
  /** Loopback host to bind. Defaults to 127.0.0.1 (the trust boundary). */
  host?: string;
  /** TCP port. Defaults to 0 → OS-assigned ephemeral port (avoids clashing with
   *  a user's own collector on 4318); the chosen port is read back from the
   *  bound socket and exposed via `endpoint()`. */
  port?: number;
  /** Sink for renderer-facing events (set to `webContents.send`). No-op in tests. */
  emit?: (channel: string, payload: unknown) => void;
  /** Resolve an agent's cwd (from the hive registry) for the transcript fallback. */
  resolveCwd?: (agentId: string) => string | null;
}

export class TelemetryCollector {
  private server: Server | null = null;
  private boundPort: number | null = null;
  private readonly host: string;
  private readonly port: number;
  private readonly emit?: (channel: string, payload: unknown) => void;
  private readonly resolveCwd?: (agentId: string) => string | null;

  /** sessionId → running accumulation. */
  private readonly sessions = new Map<string, SessionAccum>();
  /** agentId → its sessionIds (lets getAgentUsage aggregate across --resume). */
  private readonly agentSessions = new Map<string, Set<string>>();
  /** agentId → ring buffer of recent tool spans. */
  private readonly spans = new Map<string, ToolSpan[]>();
  /** Push subscribers (Lane A breaker + dashboard). */
  private readonly usageSubs = new Set<(s: AgentUsageSample) => void>();
  /** api_error subscribers — feeds Lane A's breaker error-storm trip (#6), which
   *  has no input source of its own (hook payloads don't expose api errors). */
  private readonly apiErrorSubs = new Set<(agentId: string) => void>();
  /** E007 T016 {FR-009} — gen_ai-branch drop tally, split drift vs malformed so the
   *  two ignore paths stay distinguishable (semconv change vs corruption). */
  private readonly nativeDrops: NativeDropCounts = { malformed: 0, drift: 0 };
  /** E007 T020 {FR-006} — model ids that have already raised an operator-visible
   *  parity warning, so the loud-on-unknown signal fires ONCE per model and is not
   *  re-spammed on every publish (the registry's own console.warn is likewise
   *  deduped). Bounded set — only normalized model ids, never any secret. */
  private readonly warnedUnpricedModels = new Set<string>();

  constructor(opts: TelemetryCollectorOptions = {}) {
    this.host = opts.host ?? '127.0.0.1';
    this.port = opts.port ?? 0;
    this.emit = opts.emit;
    this.resolveCwd = opts.resolveCwd;
  }

  /** Bind the loopback OTLP listener. The handler is live the instant this
   *  resolves; `endpoint()` then returns the URL to inject into agent env. */
  async start(): Promise<{ ok: boolean; endpoint?: string; error?: string }> {
    if (this.server) return { ok: true, endpoint: this.endpoint() ?? undefined };
    try {
      await this.listen();
      return { ok: true, endpoint: this.endpoint() ?? undefined };
    } catch (e) {
      this.stop();
      return { ok: false, error: errMsg(e) };
    }
  }

  /** Close the listener. Idempotent and best-effort. Accumulated state is kept
   *  (it's ephemeral anyway) so a restart doesn't lose live agents' totals. */
  stop(): void {
    try { this.server?.close(); } catch { /* noop */ }
    this.server = null;
    this.boundPort = null;
  }

  /** The bound loopback URL agents export to, or null until started. */
  endpoint(): string | null {
    return this.boundPort ? `http://${this.host}:${this.boundPort}` : null;
  }

  // ─── The locked provider seam ──────────────────────────────────────────────

  /** Pull (contract primary). OTel-live aggregate preferred; transcript fallback
   *  when an agent has no live telemetry yet (e.g. spawned before the feature, or
   *  telemetry off). Returns null only when neither source has anything. */
  getAgentUsage(agentId: string): AgentUsageSample | null {
    const live = this.aggregateLive(agentId);
    if (live) return live;
    return this.transcriptFallback(agentId);
  }

  /** Push (additive, OTel-only). Fires the agent's fresh aggregate whenever new
   *  telemetry lands. Returns an unsubscribe fn. */
  onAgentUsage(cb: (s: AgentUsageSample) => void): () => void {
    this.usageSubs.add(cb);
    return () => this.usageSubs.delete(cb);
  }

  /** In-process api_error feed for Lane A's breaker (#6). At integration:
   *  `telemetry.onApiError((agentId) => breaker.recordError(agentId))`. Returns
   *  an unsubscribe fn. */
  onApiError(cb: (agentId: string) => void): () => void {
    this.apiErrorSubs.add(cb);
    return () => this.apiErrorSubs.delete(cb);
  }

  /** Recent tool spans for the per-agent waterfall (#7B.2), oldest→newest. */
  getSpans(agentId: string): ToolSpan[] {
    return this.spans.get(agentId)?.slice() ?? [];
  }

  /** Everything the renderer needs on cold start (it missed the live pushes). */
  snapshot(): TelemetrySnapshot {
    const usage: AgentUsageSample[] = [];
    for (const agentId of this.agentSessions.keys()) {
      const s = this.aggregateLive(agentId);
      if (s) usage.push(s);
    }
    const spans: Record<string, ToolSpan[]> = {};
    for (const [agentId, ring] of this.spans) spans[agentId] = ring.slice();
    return { usage, spans };
  }

  // ─── HTTP plumbing (mirrors slack.ts) ──────────────────────────────────────

  private listen(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => this.handleRequest(req, res));
      const onError = (e: Error): void => reject(e);
      server.once('error', onError);
      server.listen(this.port, this.host, () => {
        server.off('error', onError);
        const addr = server.address();
        this.boundPort = addr && typeof addr === 'object' ? addr.port : null;
        this.server = server;
        resolve();
      });
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c: Buffer) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        res.writeHead(413); res.end();
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      const url = req.url ?? '';
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (url.includes('/v1/metrics')) this.ingestMetrics(body);
        else if (url.includes('/v1/logs')) this.ingestLogs(body);
      } catch { /* malformed batch — drop it, never throw into the socket */ }
      // OTLP success response is an empty JSON ExportServiceResponse.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    req.on('error', () => {
      if (aborted) return;
      try { res.writeHead(400); res.end(); } catch { /* socket gone */ }
    });
  }

  // ─── OTLP decode → normalize → accumulate ──────────────────────────────────

  private ingestMetrics(body: unknown): void {
    const root = body as { resourceMetrics?: ResourceMetrics[] };
    if (!Array.isArray(root?.resourceMetrics)) return;
    const touched = new Set<string>(); // agentIds with new data this batch
    for (const rm of root.resourceMetrics) {
      const resAttrs = flattenAttrs(rm.resource?.attributes);
      for (const sm of rm.scopeMetrics ?? []) {
        for (const metric of sm.metrics ?? []) {
          const points = metric.sum?.dataPoints ?? metric.gauge?.dataPoints ?? [];
          for (const dp of points) {
            const attrs = flattenAttrs(dp.attributes);
            const agentId = str(attrs['agent.id']) || str(resAttrs['agent.id']);
            const sessionId = str(attrs['session.id']);
            if (!agentId || !sessionId) continue;
            const accum = this.session(agentId, sessionId);
            // Scrub before store: `model` is the one free-form id that reaches the
            // emitted sample (and the parity warning); a credential smuggled into
            // it is redacted so it can never ride the AgentUsageSample (T023/FR-013).
            const model = scrubSecret(normalizeModel(str(attrs['model'])));
            if (model) accum.model = model;
            accum.ts = Date.now();
            const value = pointValue(dp);
            if (metric.name === 'claude_code.token.usage') {
              switch (str(attrs['type'])) {
                case 'input': accum.input += value; break;
                case 'output': accum.output += value; break;
                case 'cacheRead': accum.cacheRead += value; break;
                case 'cacheCreation': accum.cacheCreation += value; break;
              }
              touched.add(agentId);
            } else if (metric.name === 'claude_code.cost.usage') {
              // Retained ONLY as a diagnostic cross-check — NEVER the published
              // `usd` source (the registry recompute is, see aggregateLive).
              // (FR-005/HINT-001).
              accum.diagUsd += value;
              touched.add(agentId);
            }
          }
        }
      }
    }
    for (const agentId of touched) this.publishUsage(agentId);
  }

  // ─── E007 gen_ai.* normalization branch (T012–T016) ─────────────────────────

  /**
   * E007 T012/T013/T015 {FR-008/010/015} — the gen_ai.* normalization branch.
   *
   * The SINGLE-WRITER (main) forward seam (`nativeAgentWorker.ts`, AD-002) feeds
   * each native `token-usage` AgentEvent in here. It maps native usage into the
   * SAME `SessionAccum` / `AgentUsageSample` path as `claude_code.*` — the produced
   * sample is byte-shape-identical, so every downstream consumer (ledger, breaker,
   * renderer, waterfall) reads it with NO provider-specific branching (FR-011).
   *
   * Mandatory-attr JOIN OR DROP (T013/FR-015): `agentId` (join key), `providerName`,
   * and `requestModel` MUST be present — a missing mandatory attribute is DROPPED
   * (accumulate nothing), never attributed to "unknown"/an arbitrary agent. The
   * provider name must be a KNOWN provider (else SEMCONV DRIFT, T016). Token counts
   * must be finite numbers (else MALFORMED, T016). Both drop paths are counted on
   * DISTINCT reasons (drift vs malformed) and accumulate nothing.
   *
   * Cumulative-monotonic (T015/HINT-004): native tokens are CUMULATIVE per session,
   * so each native field is SET to the new value but CLAMPED at its prior max — an
   * arriving sample that would lower the cumulative does NOT apply the decrease, so
   * the per-agent counter never decreases or double-counts (FR-010/SC-006).
   *
   * Returns `true` when the usage was accumulated (and the agent re-published),
   * `false` when it was dropped (with the distinct reason tallied).
   */
  ingestNativeUsage(usage: NativeUsageInput): boolean {
    // T013/FR-015 — mandatory join attributes. A missing one cannot be joined →
    // DROP (semconv-schema gap, counted as drift, never "unknown"/arbitrary agent).
    const agentId = str(usage?.agentId);
    const sessionId = str(usage?.sessionId);
    const providerName = str(usage?.providerName);
    const requestModel = str(usage?.requestModel);
    if (!agentId || !sessionId || !providerName || !requestModel) {
      this.nativeDrops.drift++;
      return false;
    }
    // T016/FR-009 — SEMCONV DRIFT: well-formed but off the pinned schema. An unknown
    // provider name is an off-version/renamed-attribute signal → drop on `drift`.
    if (!KNOWN_PROVIDER_NAMES.has(providerName.toLowerCase())) {
      this.nativeDrops.drift++;
      return false;
    }
    const t = usage.tokens;
    // T016/FR-009 — MALFORMED: a non-finite / missing token field is structurally
    // invalid OTLP-equivalent input → drop on the DISTINCT `malformed` reason.
    if (
      !t ||
      !Number.isFinite(t.input) || !Number.isFinite(t.output) ||
      !Number.isFinite(t.cacheRead) || !Number.isFinite(t.cacheCreation)
    ) {
      this.nativeDrops.malformed++;
      return false;
    }

    const accum = this.session(agentId, sessionId);
    // Price off the response model when present (RECOMMENDED), else the request
    // model (MANDATORY). normalizeModel strips any variant suffix; scrubSecret then
    // redacts any credential smuggled into the id so it never rides the emitted
    // sample or the parity warning (T023/FR-013).
    const model = scrubSecret(normalizeModel(str(usage.responseModel) || requestModel));
    if (model) accum.model = model;
    accum.ts = Date.now();
    // Native usage is CUMULATIVE — SET (not sum), CLAMPED so a would-be decrease is
    // not applied (cumulative-monotonic across both sources, T015/FR-010/HINT-004).
    accum.nativeInput = Math.max(accum.nativeInput, t.input);
    accum.nativeOutput = Math.max(accum.nativeOutput, t.output);
    accum.nativeCacheRead = Math.max(accum.nativeCacheRead, t.cacheRead);
    accum.nativeCacheCreation = Math.max(accum.nativeCacheCreation, t.cacheCreation);
    this.publishUsage(agentId);
    return true;
  }

  /**
   * E007 T014/T016 {FR-016} — map a native `execute_tool` invocation to a
   * `ToolSpan` by the FIXED rule (no new/renamed field, FR-014) and push it into
   * the same ring buffer + `telemetry:event` path the Claude `tool_result` log
   * uses. A FAILED native tool MUST surface `success = false` with a populated
   * `error` so the waterfall reflects failures, not only successes (SC-004).
   *
   * Mandatory-attr JOIN OR DROP (FR-015): `agentId` (join key) and `toolName`
   * MUST be present — a missing one is DROPPED (counted as drift, never an
   * arbitrary agent). Returns `true` when a span was pushed, `false` on drop.
   */
  ingestNativeToolSpan(tool: NativeToolInput): boolean {
    const agentId = str(tool?.agentId);
    const toolName = str(tool?.toolName);
    if (!agentId || !toolName) {
      this.nativeDrops.drift++;
      return false;
    }
    const success = tool.success === true;
    const span: ToolSpan = {
      agentId,
      sessionId: str(tool.sessionId),
      ts: Date.now(),
      tool: toolName,
      success,
      // duration ← elapsed (end − start); guard a non-finite value to 0.
      durationMs: Number.isFinite(tool.durationMs) ? tool.durationMs : 0,
      // decision ← the decision attr when present, else the ToolSpan default (undef).
      decision: tool.decision,
      // error ← the error text when the tool failed, else empty (omit on success).
      // T023/FR-013 — the native error string is the one free-form text that rides
      // the emitted `ToolSpan.error` attribute; scrub any credential-shaped token
      // out of it so a secret in a tool's failure text cannot leak onto the span.
      ...(success ? {} : { error: scrubSecret(str(tool.error)) })
    };
    this.pushSpan(span);
    this.emit?.('telemetry:event', { kind: 'tool_result', span } satisfies TelemetryEvent);
    return true;
  }

  /** E007 T016 {FR-009} — the gen_ai-branch drop tally (drift vs malformed kept
   *  distinct so semconv change is attributable apart from corruption). A copy, so
   *  callers/tests cannot mutate the live counters. */
  nativeDropCounts(): NativeDropCounts {
    return { ...this.nativeDrops };
  }

  private ingestLogs(body: unknown): void {
    const root = body as { resourceLogs?: ResourceLogs[] };
    if (!Array.isArray(root?.resourceLogs)) return;
    for (const rl of root.resourceLogs) {
      const resAttrs = flattenAttrs(rl.resource?.attributes);
      for (const sl of rl.scopeLogs ?? []) {
        for (const lr of sl.logRecords ?? []) {
          const attrs = flattenAttrs(lr.attributes);
          const name = str(attrs['event.name']) || str(lr.body?.stringValue);
          const agentId = str(attrs['agent.id']) || str(resAttrs['agent.id']);
          const sessionId = str(attrs['session.id']);
          if (!agentId) continue;
          if (name === 'tool_result') {
            const span: ToolSpan = {
              agentId,
              sessionId,
              ts: Date.now(),
              tool: str(attrs['tool_name']) || 'tool',
              success: truthy(attrs['success']),
              durationMs: numAttr(attrs['duration_ms']),
              decision: undefined
            };
            this.pushSpan(span);
            this.emit?.('telemetry:event', { kind: 'tool_result', span } satisfies TelemetryEvent);
          } else if (name === 'tool_decision') {
            // Attach the accept/reject decision to the most recent span, and emit.
            const decision = str(attrs['decision']) === 'reject' ? 'reject' : 'accept';
            const ring = this.spans.get(agentId);
            if (ring?.length) ring[ring.length - 1].decision = decision;
          } else if (name === 'api_error' || (name && name.includes('error'))) {
            // E007 T023 {FR-013} — the api_error event carries ONLY a FIXED,
            // non-leaking label + the join ids; the breaker needs just `agentId`
            // and the renderer shows a label. The upstream OTLP free-text body
            // (`error` / `message` / the log `body.stringValue`) is NEVER echoed,
            // so an error string cannot smuggle a secret or request payload onto
            // this channel — least-attribute, fail-closed (AD-005/HINT-005).
            for (const cb of this.apiErrorSubs) { try { cb(agentId); } catch { /* subscriber threw */ } }
            this.emit?.('telemetry:event', { kind: 'api_error', agentId, sessionId, ts: Date.now(), error: 'api_error' } satisfies TelemetryEvent);
          }
        }
      }
    }
  }

  // ─── Accumulation helpers ──────────────────────────────────────────────────

  private session(agentId: string, sessionId: string): SessionAccum {
    let accum = this.sessions.get(sessionId);
    if (!accum) {
      accum = {
        agentId, model: '', ts: Date.now(),
        input: 0, output: 0, cacheRead: 0, cacheCreation: 0, diagUsd: 0,
        nativeInput: 0, nativeOutput: 0, nativeCacheRead: 0, nativeCacheCreation: 0
      };
      this.sessions.set(sessionId, accum);
    }
    let set = this.agentSessions.get(agentId);
    if (!set) { set = new Set(); this.agentSessions.set(agentId, set); }
    set.add(sessionId);
    return accum;
  }

  private pushSpan(span: ToolSpan): void {
    let ring = this.spans.get(span.agentId);
    if (!ring) { ring = []; this.spans.set(span.agentId, ring); }
    ring.push(span);
    if (ring.length > SPAN_RING_CAP) ring.splice(0, ring.length - SPAN_RING_CAP);
  }

  /** Sum an agent's live sessions into one cumulative sample (sessionId/model =
   *  the most recently active session). Null if the agent has no live data.
   *
   *  USD is computed ONCE here from the price registry (E007 AD-001/FR-001/005):
   *  Σ(token counts) × the dated price row for the agent's model — NOT the summed
   *  `claude_code.cost.usage` (which is diagnostic-only). An unknown model id
   *  yields `usd = null` (unpriced, fail-loud via the registry warn) rather than
   *  a wrong-vendor default (FR-006). The Minimax context tier is selected from
   *  the call's input/prompt length (`contextSize`), then the whole call is
   *  repriced at that row (AD-004/HINT-003). */
  private aggregateLive(agentId: string): AgentUsageSample | null {
    return this.aggregateLiveWithFlag(agentId)?.sample ?? null;
  }

  /** As `aggregateLive`, but also reports whether the agent's model id was
   *  unknown/unpriced (`usd = null` because there is no registry row). The
   *  publish seam uses this to raise the operator-visible parity warning (T020);
   *  read paths (`getAgentUsage`/`snapshot`) call `aggregateLive` and never warn,
   *  so the loud signal fires on a real publish, not on every pull. */
  private aggregateLiveWithFlag(agentId: string): { sample: AgentUsageSample; unknownModel: boolean } | null {
    const set = this.agentSessions.get(agentId);
    if (!set || set.size === 0) return null;
    const out: AgentUsageSample = {
      agentId, sessionId: '', ts: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, model: '', usd: null
    };
    for (const sid of set) {
      const a = this.sessions.get(sid);
      if (!a) continue;
      // claude_code DELTA sums + native CUMULATIVE counters → one per-agent total.
      // Both halves are already clamped-monotonic at ingest, so the sum is too
      // (E007 T015 / FR-010 / HINT-004): claude deltas only ever add, and each
      // native field holds at its prior max, so this combined counter never
      // decreases or double-counts across the two sources.
      out.input += a.input + a.nativeInput;
      out.output += a.output + a.nativeOutput;
      out.cacheRead += a.cacheRead + a.nativeCacheRead;
      out.cacheCreation += a.cacheCreation + a.nativeCacheCreation;
      if (a.ts >= out.ts) { out.ts = a.ts; out.sessionId = sid; out.model = a.model; }
    }
    // USD computed ONCE here from the registry (FR-001/002). `unknownModel` is the
    // seam's fail-loud signal: an unknown/unpriced id yields `usd = null` (no
    // default billed) and drives the operator-visible parity warning on publish.
    const priced = resolvePrice(
      out.model,
      { inputTokens: out.input, outputTokens: out.output, cacheReadTokens: out.cacheRead, cacheWriteTokens: out.cacheCreation },
      { contextSize: out.input }
    );
    out.usd = priced.usd;
    return { sample: out, unknownModel: priced.unknownModel };
  }

  /**
   * E007 T020 {FR-006} — raise the OPERATOR-VISIBLE telemetry-parity warning for an
   * unknown/unpriced model id, ONCE per model (deduped — not spammed every publish).
   *
   * The payload is bounded to the unknown model id ALONE (FR-006/FR-013): it carries
   * NO prompt/response content, token counts, headers, or any secret — only the
   * model id + a timestamp. It rides the SAME `telemetry:event` channel the renderer
   * already consumes (not just a stderr log), so the warning actually reaches the
   * operator. NO default/substituted price is ever billed — the `usd = null` sample
   * is the no-bill flag; this warning is the loud signal beside it.
   */
  private warnUnpricedModel(model: string): void {
    // E007 T023 {FR-013} — the model id is the ONLY field the warning carries
    // (FR-006). It is operator/registry-controlled, but as a fail-closed defense
    // (a secret must never escape on ANY channel, even via an unexpected model
    // string) the id is scrubbed of any credential-shaped token before it rides
    // the wire — so a secret embedded in the id cannot leak into the warning.
    const key = scrubSecret(normalizeModel(model)) || '(empty)';
    if (this.warnedUnpricedModels.has(key)) return;
    this.warnedUnpricedModels.add(key);
    this.emit?.('telemetry:event', { kind: 'parity_warning', model: key, ts: Date.now() } satisfies TelemetryEvent);
  }

  private transcriptFallback(agentId: string): AgentUsageSample | null {
    const cwd = this.resolveCwd?.(agentId);
    if (!cwd) return null;
    const u = readAgentUsage(cwd);
    if (!u.inputTokens && !u.outputTokens && !u.cacheReadTokens && !u.cacheWriteTokens) return null;
    return {
      agentId,
      sessionId: '',
      ts: Date.now(),
      input: u.inputTokens,
      output: u.outputTokens,
      cacheRead: u.cacheReadTokens,
      cacheCreation: u.cacheWriteTokens,
      model: u.model ?? '',
      usd: u.estimatedCostUsd
    };
  }

  private publishUsage(agentId: string): void {
    const agg = this.aggregateLiveWithFlag(agentId);
    if (!agg) return;
    const { sample, unknownModel } = agg;
    // FR-006 — fail loud at the seam: an unknown/unpriced model bills no default
    // (sample.usd is already null) and raises the operator-visible parity warning,
    // deduped per model. Emitted BEFORE the usage sample so the operator sees the
    // flag alongside the unpriced sample. Bounded to the model id (FR-013).
    if (unknownModel && sample.model) this.warnUnpricedModel(sample.model);
    for (const cb of this.usageSubs) { try { cb(sample); } catch { /* subscriber threw */ } }
    this.emit?.('telemetry:event', { kind: 'usage', sample } satisfies TelemetryEvent);
  }
}

// ─── OTLP/JSON attribute decoding ─────────────────────────────────────────────

interface OtelKV { key?: string; value?: OtelAnyValue }
interface OtelAnyValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
}
interface OtelDataPoint { attributes?: OtelKV[]; asInt?: string | number; asDouble?: number; timeUnixNano?: string }
interface OtelMetric { name?: string; sum?: { dataPoints?: OtelDataPoint[] }; gauge?: { dataPoints?: OtelDataPoint[] } }
interface ResourceMetrics { resource?: { attributes?: OtelKV[] }; scopeMetrics?: { metrics?: OtelMetric[] }[] }
interface OtelLogRecord { attributes?: OtelKV[]; body?: { stringValue?: string } }
interface ResourceLogs { resource?: { attributes?: OtelKV[] }; scopeLogs?: { logRecords?: OtelLogRecord[] }[] }

/**
 * E007 T023 {FR-013/AD-005/HINT-005} — the FAIL-CLOSED known-attribute allowlist.
 *
 * This is the single gate the OTLP read path (`flattenAttrs`) consumes through:
 * ONLY a key in this set is ever copied off an incoming OTLP record; EVERY other
 * key (the raw attribute bag at large) is DROPPED before it can reach a
 * `SessionAccum`, `AgentUsageSample`, `ToolSpan`, `TelemetryEvent`, log, or any
 * diagnostic/warning/drop tally. Fail-closed: a NEW upstream attribute we have
 * not vetted is ignored by default, never copied — so prompt/response content, a
 * header value, an `Authorization` token, or an API key carried in an unexpected
 * attribute cannot leak onto any channel (the cost.usage diagnostic, the parity
 * warning, the missing-field/clamp/drift/malformed drop paths included).
 *
 * The set is the minimal LEAST-ATTRIBUTE key set the cost/token/span seam needs:
 *
 *   - `agent.id`, `session.id` — the join/accounting keys (FR-015 join key).
 *   - `model` (Claude OTLP) — the priced model id; the native `gen_ai.*` branch's
 *     `gen_ai.request.model` / `gen_ai.provider.name` arrive STRUCTURED via
 *     `ingestNativeUsage` (token counts + ids only), so they never transit this
 *     free-form attribute decode and need no entry here.
 *   - `type` — `token.type` (input/output/cacheRead/cacheCreation) for the split.
 *   - `tool_name`, `success`, `duration_ms`, `decision` — the closed `ToolSpan`
 *     field set (FR-016), all bounded/enumerated values, never free text.
 *   - `event.name` — the log-record DISCRIMINATOR (tool_result/tool_decision/
 *     api_error); routes the record, never copied into an emitted payload.
 *
 * DELIBERATELY EXCLUDED (free-text / identity surfaces that could echo a secret
 * or request payload, so fail-closed drops them): `agent.name`, and the OTLP log
 * `error` / `message` free-text bodies — the api_error event now carries only a
 * FIXED label + the join ids (see `ingestLogs`), never an upstream free-text
 * string. PII keys (`user.email`, `user.account_id`/`uuid`, `organization.id`,
 * `user.id`) are likewise absent and thus dropped. */
const ATTR_ALLOWLIST = new Set([
  'agent.id', 'session.id', 'model', 'type',
  'tool_name', 'success', 'duration_ms', 'decision', 'event.name'
]);

/**
 * Flatten an OTLP KeyValue[] to a plain object, keeping ONLY allowlisted keys.
 * This is the fail-closed seam (T023/FR-013): any key not in `ATTR_ALLOWLIST` —
 * the entire raw attribute bag we have not vetted — is dropped here, so no
 * unknown/free-text attribute (a header, an API key, prompt/response content)
 * can ever transit into an accumulator, a sample/span, a telemetry event, or a
 * diagnostic/drop tally downstream. */
function flattenAttrs(attrs: OtelKV[] | undefined): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!Array.isArray(attrs)) return out;
  for (const kv of attrs) {
    // Fail-closed: drop every non-allowlisted key BEFORE reading its value.
    if (!kv?.key || !ATTR_ALLOWLIST.has(kv.key)) continue;
    const v = kv.value;
    if (!v) continue;
    if (typeof v.stringValue === 'string') out[kv.key] = v.stringValue;
    else if (v.intValue !== undefined) out[kv.key] = Number(v.intValue);
    else if (typeof v.doubleValue === 'number') out[kv.key] = v.doubleValue;
    else if (typeof v.boolValue === 'boolean') out[kv.key] = v.boolValue;
  }
  return out;
}

/** A metric data point's numeric value (int counters arrive as strings in JSON). */
function pointValue(dp: OtelDataPoint): number {
  if (dp.asInt !== undefined) return Number(dp.asInt) || 0;
  if (typeof dp.asDouble === 'number') return dp.asDouble;
  return 0;
}

/**
 * E007 T023 {FR-013/AD-005} — fail-closed credential scrub for any free-form
 * string that could ride an emission channel (e.g. the parity-warning model id,
 * the one operator/registry-controlled string the seam emits).
 *
 * The least-attribute allowlist (`flattenAttrs`) is the PRIMARY guarantee — a raw
 * attribute bag never reaches a channel at all. This is the secondary, defense-in-
 * depth net: it REDACTS any credential-shaped token (an `sk-…` API key, a Bearer /
 * Authorization token) from a string before it is emitted, so even a secret
 * smuggled INTO an otherwise-allowed field (an unexpected model id) cannot leak.
 * Pure + bounded — only collapses recognized secret shapes to `[redacted]`. */
function scrubSecret(v: string): string {
  // The redaction marker is bracket-free on purpose: `normalizeModel` strips a
  // trailing `[…]` variant suffix, so a `[redacted]` marker could be re-stripped
  // downstream — `(redacted)` survives normalization intact.
  return v
    // API-key shapes: `sk-…`, `sk-ant-…`, and similar prefixed credential tokens.
    .replace(/\b(?:sk|pk|rk|api)[-_][A-Za-z0-9-_]{4,}/gi, '(redacted)')
    // Bearer / Authorization header values.
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, 'Bearer (redacted)');
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
}
function numAttr(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}
function truthy(v: unknown): boolean {
  return v === true || v === 'true' || v === 1 || v === '1';
}
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
