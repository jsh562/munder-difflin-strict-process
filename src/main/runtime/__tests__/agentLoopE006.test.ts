/** E006 T005 {FR-007,FR-011,FR-012} — loop seam extension: scoped emit passed to
 *  providerCall (adapter streaming), reliability-mapped api-error, malformed tool
 *  result path, and the per-turn wall-clock budget terminal stop. Pure Node. */
import { describe, it, expect } from 'vitest';
import { runAgentLoop, type AgentLoopDeps, type ToolResult } from '@jsh562/agent-core';
import type { AgentEvent } from '../../../shared/agentEvent';
import type { ProviderCall, ProviderTurn, ToolUseRequest } from '../../../shared/providerCall';

function deps(over: Partial<AgentLoopDeps>): { deps: AgentLoopDeps; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  const d: AgentLoopDeps = {
    agentId: 'a.native',
    sessionId: 'sess-1',
    model: 'deepseek-v4-flash',
    providerCall: async (): Promise<ProviderTurn> => ({ toolUses: [], usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, endOfTurn: true }),
    executeTool: async (u: ToolUseRequest): Promise<ToolResult> => ({ toolCallId: u.toolCallId, content: 'ok', success: true }),
    emit: (e) => events.push(e),
    requestDrain: async () => ({ block: false }),
    caps: { maxTurns: 4, maxHops: 4 },
    now: () => 0,
    ...over
  };
  return { deps: d, events };
}

describe('FR-007 — the loop passes a scoped emit into providerCall (adapter streaming)', () => {
  it('forwards the loop emit so an adapter can stream deltas', async () => {
    let received: ((e: AgentEvent) => void) | undefined;
    const streaming: ProviderCall = async (_req, emit): Promise<ProviderTurn> => {
      received = emit;
      emit?.({ v: 1, agentId: 'a.native', sessionId: 'sess-1', ts: 0, kind: 'thinking-delta', text: 'mulling' });
      return { toolUses: [], usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, endOfTurn: true };
    };
    const { deps: d, events } = deps({ providerCall: streaming });
    await runAgentLoop(d, 'go');
    expect(received).toBeTypeOf('function');
    expect(events.some((e) => e.kind === 'thinking-delta')).toBe(true);
  });
});

describe('FR-012 — reliability maps provider failures to api-error with the right flag', () => {
  it('a terminal provider error surfaces api-error retryable:false and ends the turn', async () => {
    const terminal: ProviderCall = async (): Promise<ProviderTurn> => { throw { status: 401 }; };
    const { deps: d, events } = deps({
      providerCall: terminal,
      caps: { maxTurns: 1, maxHops: 2, reliability: { sleep: async () => {}, random: () => 0 } }
    });
    await runAgentLoop(d, 'go');
    const apiErr = events.find((e) => e.kind === 'api-error');
    expect(apiErr).toBeDefined();
    if (apiErr?.kind === 'api-error') expect(apiErr.retryable).toBe(false);
    expect(events.some((e) => e.kind === 'turn-end')).toBe(true);
  });

  it('an exhausted retryable transient surfaces api-error retryable:true (no false breaker trip)', async () => {
    const transient: ProviderCall = async (): Promise<ProviderTurn> => { throw { status: 503 }; };
    const { deps: d, events } = deps({
      providerCall: transient,
      caps: { maxTurns: 1, maxHops: 2, reliability: { sleep: async () => {}, random: () => 0, maxAttempts: 3 } }
    });
    await runAgentLoop(d, 'go');
    const apiErr = events.find((e) => e.kind === 'api-error');
    if (apiErr?.kind === 'api-error') expect(apiErr.retryable).toBe(true);
  });
});

describe('FR-011 — a failed tool execution surfaces api-error + a failed tool result', () => {
  it('never executes a partial call as success; feeds back an error tool result', async () => {
    let toolCalls = 0;
    const oneTool: ProviderCall = (() => {
      let n = 0;
      return async (): Promise<ProviderTurn> => {
        n++;
        if (n === 1) return { toolUses: [{ toolName: 'bad', toolInput: {}, toolCallId: 'c1' }], usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, endOfTurn: false };
        return { toolUses: [], usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, endOfTurn: true };
      };
    })();
    const { deps: d, events } = deps({
      providerCall: oneTool,
      executeTool: async () => { toolCalls++; throw new Error('malformed tool-call JSON'); },
      caps: { maxTurns: 1, maxHops: 4 }
    });
    await runAgentLoop(d, 'go');
    expect(toolCalls).toBe(1);
    expect(events.some((e) => e.kind === 'api-error' && /malformed tool-call JSON/.test(e.message))).toBe(true);
    const toolEnd = events.find((e) => e.kind === 'tool-end');
    expect(toolEnd?.kind === 'tool-end' && toolEnd.success).toBe(false);
  });
});

describe('FR-012 — per-turn wall-clock budget stops a runaway turn terminally', () => {
  it('emits stop reason:turn-budget-exhausted distinct from end-of-turn', async () => {
    // Clock advances each call so the turn quickly exceeds the budget.
    let t = 0;
    const clock = () => (t += 100);
    const neverEnds: ProviderCall = async (): Promise<ProviderTurn> => ({
      toolUses: [{ toolName: 'loop', toolInput: {}, toolCallId: 'c' }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
      endOfTurn: false
    });
    const { deps: d, events } = deps({
      providerCall: neverEnds,
      now: clock,
      caps: { maxTurns: 1, maxHops: 100, turnBudgetMs: 150 }
    });
    await runAgentLoop(d, 'go');
    const stops = events.filter((e) => e.kind === 'stop');
    expect(stops.some((s) => s.kind === 'stop' && s.reason === 'turn-budget-exhausted')).toBe(true);
  });
});
