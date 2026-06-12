/**
 * Provider-agnostic agent-loop scaffold (E003 / ADR-0004). PURE — no electron,
 * no node-pty — so it runs under vitest in Node. Drives the agentic cycle
 * (request → tool_use → execute → tool_result → repeat until end-of-turn),
 * emits the normalized AgentEvent stream, and reproduces the Stop-hook autonomy:
 * end-of-turn drains the hive inbox (via the injected `requestDrain`) and
 * continues, guarded so it can never loop forever.
 *
 * The electron utilityProcess transport (agentWorker.ts) wires `emit` to the
 * parent port and `requestDrain` to an IPC round-trip; tests inject fakes.
 */
import { AGENT_EVENT_VERSION, type AgentEvent } from '../../../shared/agentEvent';
import type {
  ChatMessage,
  ProviderCall,
  ProviderTurn,
  ToolSpec,
  ToolUseRequest,
  UsageDelta
} from '../../../shared/providerCall';
import {
  ReliabilityError,
  withReliability,
  type ReliabilityOptions
} from './adapters/reliability';

export interface ToolResult {
  toolCallId: string;
  content: string;
  success: boolean;
}

export interface AgentLoopCaps {
  /** Hard bound on autonomy continuations (drain-created turns). */
  maxTurns: number;
  /** Hard bound on tool round-trips within one turn. */
  maxHops: number;
  /**
   * Per-turn wall-clock budget in ms (ADR-0009 / FR-012). When a single turn —
   * across its provider round-trips and tool hops — exceeds this, the turn is
   * stopped with a terminal `stop reason:'turn-budget-exhausted'`. Optional and
   * additive: omitted (or non-finite) means no wall-clock bound (prior behavior).
   */
  turnBudgetMs?: number;
  /**
   * Optional reliability tuning passed to `withReliability` around the provider
   * call (attempts/backoff and injectable clock/sleep/random for tests). Omitted
   * = ADR-0009 defaults. The loop fills `now` from `deps.now` when not set here.
   */
  reliability?: ReliabilityOptions;
}

export interface AgentLoopDeps {
  agentId: string;
  sessionId?: string | null;
  model?: string | null;
  providerCall: ProviderCall;
  executeTool: (use: ToolUseRequest) => Promise<ToolResult>;
  emit: (event: AgentEvent) => void;
  /** End-of-turn autonomy: returns fresh inbox continuation, or block:false = idle. */
  requestDrain: () => Promise<{ block: boolean; reason?: string }>;
  caps: AgentLoopCaps;
  tools?: ToolSpec[];
  /**
   * Optional system preamble prepended to the conversation as the first `system`
   * message (the hive protocol + toolkit briefing for a native desk). Absent ⇒ the
   * loop starts from the user input alone (prior behavior). Both native adapters
   * handle a `system` role — DeepSeek passes it through, Minimax hoists it into the
   * Anthropic `system` field — so this teaches a native desk how to use the toolkit
   * the way `--append-system-prompt` teaches a Claude desk.
   */
  systemPrompt?: string;
  now?: () => number;
}

const ZERO: UsageDelta = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

/**
 * Run one agent session starting from `initialInput`. Resolves when the agent
 * goes idle (empty drain) or a cap is hit. Never throws on provider/tool errors
 * (they become `api-error` events); never loops forever (guard + caps).
 */
export async function runAgentLoop(deps: AgentLoopDeps, initialInput: string): Promise<void> {
  const preamble = deps.systemPrompt?.trim();
  const messages: ChatMessage[] = [
    // The system preamble (when present) leads the conversation so it persists every
    // round — the adapters route a `system` message to the provider's system channel.
    ...(preamble ? [{ role: 'system' as const, content: preamble }] : []),
    { role: 'user', content: initialInput }
  ];
  const cumulative: UsageDelta = { ...ZERO };
  const now = deps.now ?? Date.now;

  // `stopActive` mirrors `stop_hook_active`: a turn created by a drain does NOT
  // itself re-drain, so autonomy converges (one continuation per stop cycle).
  let stopActive = false;
  let turns = 0;

  const env = (): { v: number; agentId: string; sessionId: string | null; ts: number } => ({
    v: AGENT_EVENT_VERSION,
    agentId: deps.agentId,
    sessionId: deps.sessionId ?? null,
    ts: now()
  });

  const emitUsage = (): void => {
    deps.emit({
      ...env(),
      kind: 'token-usage',
      input: cumulative.input,
      output: cumulative.output,
      cacheRead: cumulative.cacheRead,
      cacheCreation: cumulative.cacheCreation,
      model: deps.model ?? null,
      usd: 0 // passthrough; provider-accurate cost recompute is E007
    });
  };

  // Wall-clock budget knob (additive): non-finite/absent ⇒ no bound (prior behavior).
  const turnBudgetMs = deps.caps.turnBudgetMs;
  const hasBudget = typeof turnBudgetMs === 'number' && Number.isFinite(turnBudgetMs) && turnBudgetMs > 0;

  while (turns < deps.caps.maxTurns) {
    turns++;
    deps.emit({ ...env(), kind: 'turn-start' });
    const turnStartedAt = now();
    // True once this turn ended terminally on its own wall-clock budget — it then
    // emits a terminal `stop` and the session goes idle (never loops further).
    let budgetExhausted = false;

    let hops = 0;
    for (;;) {
      hops++;
      let turn: ProviderTurn;
      try {
        // Wrap the provider call with the ADR-0009 reliability policy (FR-012):
        // retryable transients (429/5xx/timeouts) are retried silently with
        // jittered backoff; only an exhausted-or-terminal failure surfaces here.
        // The scoped `emit` lets a streaming adapter push text/thinking/tool
        // deltas as the stream arrives (AD-001); the loop forwards them as-is.
        turn = await withReliability(
          () => deps.providerCall({ messages, tools: deps.tools ?? [] }, deps.emit),
          reliabilityOpts(deps, now)
        );
      } catch (e) {
        // Map exhausted/non-retryable to a single `api-error`. A terminal class
        // (400/401/403, context overflow) is `retryable:false` → feeds the breaker;
        // an exhausted-retryable transient stays `retryable:true` (it was transient,
        // it just ran out of room) so the breaker is not false-tripped.
        const retryable = e instanceof ReliabilityError ? e.retryable : true;
        deps.emit({ ...env(), kind: 'api-error', retryable, message: errMsg(e) });
        turn = { toolUses: [], usage: { ...ZERO }, endOfTurn: true }; // end the turn cleanly
      }

      cumulative.input += turn.usage.input;
      cumulative.output += turn.usage.output;
      cumulative.cacheRead += turn.usage.cacheRead;
      cumulative.cacheCreation += turn.usage.cacheCreation;
      emitUsage();

      if (turn.text) deps.emit({ ...env(), kind: 'text-delta', text: turn.text });
      messages.push({
        role: 'assistant',
        content: turn.text ?? '',
        // Preserve the tool calls this turn made so the next round's history is valid
        // (the following `tool` replies need a matching assistant tool-call to bind to).
        ...(turn.toolUses.length > 0 ? { toolCalls: turn.toolUses } : {})
      });

      if (turn.endOfTurn || turn.toolUses.length === 0) break;

      for (const use of turn.toolUses) {
        deps.emit({ ...env(), kind: 'tool-start', toolName: use.toolName, toolInput: use.toolInput, toolCallId: use.toolCallId });
        const start = now();
        let res: ToolResult;
        try {
          res = await deps.executeTool(use);
        } catch (e) {
          // A malformed/partial tool call (FR-011): the adapter never executed the
          // partial — surface a machine-readable `api-error` AND feed a failed tool
          // result back so the model can self-correct, rather than crashing the desk.
          deps.emit({ ...env(), kind: 'api-error', retryable: false, message: `tool '${use.toolName}' failed: ${errMsg(e)}` });
          res = { toolCallId: use.toolCallId, content: errMsg(e), success: false };
        }
        deps.emit({ ...env(), kind: 'tool-end', toolCallId: use.toolCallId, success: res.success, durationMs: now() - start, ...(res.success ? {} : { error: res.content }) });
        messages.push({ role: 'tool', content: res.content, toolCallId: use.toolCallId });
      }

      // Per-turn wall-clock budget (ADR-0009): stop this turn terminally if it has
      // run past its budget across provider round-trips + tool hops.
      if (hasBudget && now() - turnStartedAt >= (turnBudgetMs as number)) {
        budgetExhausted = true;
        break;
      }

      if (hops >= deps.caps.maxHops) break; // safety: bound tool round-trips
    }

    deps.emit({ ...env(), kind: 'turn-end' });
    if (budgetExhausted) {
      // Terminal — distinct reason from a clean end-of-turn or a non-retryable error.
      deps.emit({ ...env(), kind: 'stop', reason: 'turn-budget-exhausted', stopActive: true });
      return;
    }
    deps.emit({ ...env(), kind: 'stop', reason: 'end-of-turn', stopActive });

    // A drain-created turn does not re-drain — it goes idle (guard).
    if (stopActive) return;

    const drain = await deps.requestDrain();
    if (drain.block && drain.reason) {
      messages.push({ role: 'user', content: drain.reason });
      stopActive = true; // the next turn is a drain continuation
      continue;
    }
    return; // empty inbox → idle
  }

  // maxTurns cap reached → terminal stop (never loops forever).
  deps.emit({ ...env(), kind: 'stop', reason: 'max-turns', stopActive: true });
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Resolve the reliability options for a turn: caller-supplied `caps.reliability`
 * takes precedence, with the loop's injected clock (`deps.now`) filled in when the
 * caller did not pin one — so a test's fake clock drives backoff deterministically.
 */
function reliabilityOpts(deps: AgentLoopDeps, now: () => number): ReliabilityOptions {
  const supplied = deps.caps.reliability;
  return {
    ...supplied,
    now: supplied?.now ?? now,
    // Default the reliability per-turn budget to the loop's turn budget when set,
    // so the two bounds agree unless the caller overrides explicitly.
    turnBudgetMs: supplied?.turnBudgetMs ?? deps.caps.turnBudgetMs
  };
}
