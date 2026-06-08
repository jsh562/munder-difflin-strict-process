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
  now?: () => number;
}

const ZERO: UsageDelta = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

/**
 * Run one agent session starting from `initialInput`. Resolves when the agent
 * goes idle (empty drain) or a cap is hit. Never throws on provider/tool errors
 * (they become `api-error` events); never loops forever (guard + caps).
 */
export async function runAgentLoop(deps: AgentLoopDeps, initialInput: string): Promise<void> {
  const messages: ChatMessage[] = [{ role: 'user', content: initialInput }];
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

  while (turns < deps.caps.maxTurns) {
    turns++;
    deps.emit({ ...env(), kind: 'turn-start' });

    let hops = 0;
    for (;;) {
      hops++;
      let turn: ProviderTurn;
      try {
        turn = await deps.providerCall({ messages, tools: deps.tools ?? [] });
      } catch (e) {
        deps.emit({ ...env(), kind: 'api-error', retryable: true, message: errMsg(e) });
        turn = { toolUses: [], usage: { ...ZERO }, endOfTurn: true }; // end turn; retry is E009
      }

      cumulative.input += turn.usage.input;
      cumulative.output += turn.usage.output;
      cumulative.cacheRead += turn.usage.cacheRead;
      cumulative.cacheCreation += turn.usage.cacheCreation;
      emitUsage();

      if (turn.text) deps.emit({ ...env(), kind: 'text-delta', text: turn.text });
      messages.push({ role: 'assistant', content: turn.text ?? '' });

      if (turn.endOfTurn || turn.toolUses.length === 0) break;

      for (const use of turn.toolUses) {
        deps.emit({ ...env(), kind: 'tool-start', toolName: use.toolName, toolInput: use.toolInput, toolCallId: use.toolCallId });
        const start = now();
        let res: ToolResult;
        try {
          res = await deps.executeTool(use);
        } catch (e) {
          res = { toolCallId: use.toolCallId, content: errMsg(e), success: false };
        }
        deps.emit({ ...env(), kind: 'tool-end', toolCallId: use.toolCallId, success: res.success, durationMs: now() - start });
        messages.push({ role: 'tool', content: res.content, toolCallId: use.toolCallId });
      }

      if (hops >= deps.caps.maxHops) break; // safety: bound tool round-trips
    }

    deps.emit({ ...env(), kind: 'turn-end' });
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
