/**
 * One-shot sub-agent runner — the native equivalent of Claude's Task tool.
 *
 * When a native (DeepSeek/Minimax) phase-owner desk calls `spawn_subagent`, MAIN forks an
 * EPHEMERAL native worker whose system prompt is the named sub-agent's prompt, runs it for a
 * SINGLE turn on the caller's input, captures its final text, and tears the process down. This is
 * the faithful replica of sddp27's Task-tool delegation for desks that have no Task tool.
 *
 * It REUSES `NativeAgentWorker` (the same class persistent desks use) over an injected
 * `WorkerTransport` — so the real run forks a utilityProcess (host wires the electron transport),
 * and a unit test injects a fake transport that emits `text-delta` + `stop`. It deliberately does
 * NOT use `NativeRuntime`: that registry carries persistent-desk semantics (archive, roster,
 * revive-on-demand, concurrency tied to the floor) an ephemeral one-shot must not touch.
 *
 * Guards (cost is real — every spawn is a full LLM loop): a nesting refusal (a sub-agent can't
 * spawn a sub-agent), a concurrency cap, a wall-clock timeout that kills the worker, and — because
 * a finished loop leaves the utilityProcess idle (not exited) — an explicit `kill()` on completion.
 */
import type { AgentEvent } from '../../shared/agentEvent';
import type { AgentInput } from '../../shared/providerRuntime';
import { NativeAgentWorker, type WorkerTransportFactory } from './nativeAgentWorker';

/** Synthetic id prefix for an ephemeral sub-agent run (`sub:<callerId>:<name>:<seq>`). Lets the
 *  caller-scoped deps + the event bridge recognize a child run, and backs the nesting guard. */
export const SUBAGENT_ID_PREFIX = 'sub:';

/** Floor-wide cap on concurrent ephemeral sub-agents (each is a full extra LLM loop). */
export const MAX_CONCURRENT_SUBAGENTS = 4;

/** Default wall-clock budget for one sub-agent run, ms. */
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 180_000;

const active = new Set<string>();
let seq = 0;

/** Build a unique synthetic child id for a (caller, sub-agent name) spawn. */
export function subAgentChildId(callerId: string, name: string): string {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
  return `${SUBAGENT_ID_PREFIX}${slug(callerId)}:${slug(name)}:${++seq}`;
}

/** How many ephemeral sub-agents are running right now (for diagnostics/tests). */
export function activeSubAgentCount(): number {
  return active.size;
}

/**
 * Resolve the model an ephemeral sub-agent runs on. The operator's `sddpSubAgentModel` override
 * wins ONLY when it maps to the SAME provider as the caller (so the caller's injected credentials
 * still authenticate); a blank or cross-provider override falls back to the caller's own model.
 * Pure (the `deriveProviderId` resolver is injected) so it is unit-testable without config/host.
 */
export function resolveSubAgentModel(
  callerModel: string,
  override: string | undefined,
  providerId: string,
  deriveProviderId: (model: string) => string | null
): string {
  const o = (override ?? '').trim();
  return o && deriveProviderId(o) === providerId ? o : callerModel;
}

export interface OneShotSubAgentParams {
  /** The desk that called `spawn_subagent` (for the nesting guard + provenance). */
  callerId: string;
  /** The synthetic child id (from `subAgentChildId`). */
  childId: string;
  /** The task/context text the sub-agent runs on (becomes its single turn input). */
  input: string;
  /** Forks the worker process. Host passes the electron transport; tests pass a fake. */
  transportFactory: WorkerTransportFactory;
  /** Execute one tool the child requested — CALLER-SCOPED (cwd/repo/roles resolve to the caller)
   *  and deny-enforced by the host. */
  executeTool: (req: { toolCallId: string; toolName: string; toolInput: unknown }) => Promise<{ content: string; success: boolean }>;
  /** Forward the child's AgentEvent stream (to the renderer bridge); optional. */
  onEvent?: (event: AgentEvent) => void;
  /** Wall-clock budget; defaults to DEFAULT_SUBAGENT_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Operator abort (e.g. the SDDP pipeline `stopped` a step): when it fires, the ephemeral worker
   *  is killed mid-run and the call resolves `{ success:false, content:'(aborted by operator)' }`. */
  signal?: AbortSignal;
}

/**
 * Run one ephemeral sub-agent to completion and resolve with its final text. Never throws — a
 * guard refusal, a timeout, or an abnormal exit all resolve with `{ success:false }` so the caller
 * loop feeds it back as a tool result and self-corrects.
 */
export async function runOneShotSubAgent(params: OneShotSubAgentParams): Promise<{ content: string; success: boolean }> {
  // Nesting guard (belt-and-suspenders; the child's deny-list also drops spawn_subagent).
  if (params.callerId.startsWith(SUBAGENT_ID_PREFIX)) {
    return { content: 'a sub-agent cannot spawn another sub-agent', success: false };
  }
  if (active.size >= MAX_CONCURRENT_SUBAGENTS) {
    return { content: `too many sub-agents running (cap ${MAX_CONCURRENT_SUBAGENTS}) — wait for one to finish and retry`, success: false };
  }
  active.add(params.childId);
  try {
    return await drive(params);
  } finally {
    active.delete(params.childId);
  }
}

function drive(params: OneShotSubAgentParams): Promise<{ content: string; success: boolean }> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS;
  return new Promise((resolve) => {
    const textParts: string[] = [];
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let worker: NativeAgentWorker | null = null;
    const signal = params.signal;
    let onAbort: (() => void) | null = null;

    const collected = () => textParts.join('\n').trim();
    const finish = (content: string, success: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
      // A completed loop leaves the utilityProcess IDLE (it waits for more commands), so kill it
      // explicitly to free the process. Idempotent with the worker's own exit handling.
      try { worker?.kill(); } catch { /* already gone */ }
      resolve({ content, success });
    };

    // Operator abort → kill the worker mid-run + resolve as a clean failure.
    if (signal?.aborted) { resolve({ content: '(aborted by operator)', success: false }); return; }
    if (signal) {
      onAbort = () => finish('(aborted by operator)', false);
      signal.addEventListener('abort', onAbort, { once: true });
    }

    worker = new NativeAgentWorker({
      agentId: params.childId,
      transportFactory: params.transportFactory,
      onToolRequest: async (_id, req) => params.executeTool(req),
      // One-shot: never continue via an inbox drain — the first terminal `stop` ends the run.
      onDrainRequest: async () => ({ block: false }),
      // A process exit BEFORE a terminal stop is abnormal (crash) — settle as failure with any
      // partial text. The normal path settles on `stop` first, so this is then a no-op.
      onExit: () => finish(collected() || '(sub-agent exited before producing output)', false)
    });

    worker.subscribe((event) => {
      try { params.onEvent?.(event); } catch { /* forwarding is best-effort */ }
      if (event.kind === 'text-delta' && event.text) {
        textParts.push(event.text);
      } else if (event.kind === 'stop') {
        finish(collected() || '(sub-agent produced no output)', true);
      }
    });

    timer = setTimeout(() => {
      const partial = collected();
      finish((partial ? partial + '\n\n' : '') + `(sub-agent timed out after ${timeoutMs}ms)`, false);
    }, timeoutMs);

    const send: AgentInput = { kind: 'operator', text: params.input };
    void worker.start().then(() => { if (!settled) worker?.send(send); });
  });
}
