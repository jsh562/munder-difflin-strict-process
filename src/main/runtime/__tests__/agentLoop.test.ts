/** E003 — agent-loop scaffold: ordered events, monotonic usage, autonomy
 *  continue/idle, and guaranteed termination (SC-003/004/005/007). Pure Node. */
import { describe, it, expect } from 'vitest';
import { runAgentLoop, type AgentLoopDeps, type ToolResult } from '@jsh562/agent-core';
import { isMonotonicTokenUsage, type AgentEvent, type TokenUsageEvent } from '../../../shared/agentEvent';
import { makeStubProvider, stubExecuteTool } from '@jsh562/agent-core';
import type { ProviderCall, ProviderTurn, ToolUseRequest } from '../../../shared/providerCall';

function baseDeps(over: Partial<AgentLoopDeps>): AgentLoopDeps {
  const events: AgentEvent[] = [];
  return {
    agentId: 'agent.native',
    sessionId: 'sess-1',
    model: 'deepseek-v4-flash',
    providerCall: makeStubProvider(),
    executeTool: (u: ToolUseRequest): Promise<ToolResult> => stubExecuteTool(u),
    emit: (e: AgentEvent) => events.push(e),
    requestDrain: async () => ({ block: false }),
    caps: { maxTurns: 8, maxHops: 8 },
    now: () => 1,
    ...over,
    // expose the collected array via a side channel
    ...({ _events: events } as object)
  } as AgentLoopDeps & { _events: AgentEvent[] };
}

function collected(deps: AgentLoopDeps): AgentEvent[] {
  return (deps as unknown as { _events: AgentEvent[] })._events;
}

describe('SC-003 — ordered AgentEvents from a stub-driven loop', () => {
  it('emits turn-start → tool-start → tool-end → … → stop', async () => {
    const deps = baseDeps({});
    await runAgentLoop(deps, 'do the thing');
    const kinds = collected(deps).map((e) => e.kind);
    const idx = (k: string) => kinds.indexOf(k);
    expect(idx('turn-start')).toBeGreaterThanOrEqual(0);
    expect(idx('turn-start')).toBeLessThan(idx('tool-start'));
    expect(idx('tool-start')).toBeLessThan(idx('tool-end'));
    expect(idx('tool-end')).toBeLessThan(idx('stop'));
    expect(kinds).toContain('token-usage');
    expect(kinds).toContain('turn-end');
  });
});

describe('SC-007 — emitted stream conforms to the E001 AgentEvent contract', () => {
  it('token-usage is cumulative-monotonic and tool/stop carry required fields', async () => {
    const deps = baseDeps({});
    await runAgentLoop(deps, 'go');
    const events = collected(deps);
    const usage = events.filter((e): e is TokenUsageEvent => e.kind === 'token-usage');
    expect(usage.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < usage.length; i++) {
      expect(isMonotonicTokenUsage(usage[i - 1], usage[i])).toBe(true);
    }
    const toolStart = events.find((e) => e.kind === 'tool-start');
    expect(toolStart).toMatchObject({ toolName: 'echo', toolCallId: 'call-1' });
    const stop = events.find((e) => e.kind === 'stop');
    expect(stop).toMatchObject({ kind: 'stop' });
    if (stop?.kind === 'stop') expect(typeof stop.stopActive).toBe('boolean');
    for (const e of events) expect(e.v).toBe(1);
  });
});

describe('SC-004 — end-of-turn autonomy: continue on fresh inbox, idle on empty', () => {
  it('idles immediately when the inbox is empty', async () => {
    const deps = baseDeps({ requestDrain: async () => ({ block: false }) });
    await runAgentLoop(deps, 'go');
    const turnStarts = collected(deps).filter((e) => e.kind === 'turn-start').length;
    expect(turnStarts).toBe(1);
  });

  it('continues with the drained message, then idles (one continuation per stop cycle)', async () => {
    let drains = 0;
    const deps = baseDeps({
      requestDrain: async () => { drains++; return { block: true, reason: 'process your inbox' }; }
    });
    await runAgentLoop(deps, 'go');
    const turnStarts = collected(deps).filter((e) => e.kind === 'turn-start').length;
    expect(turnStarts).toBe(2);     // original + one drain continuation
    expect(drains).toBe(1);          // the drain-created turn does NOT re-drain
  });
});

describe('SC-005 — the autonomy loop always terminates', () => {
  it('halts via the stopActive guard even when drain always blocks', async () => {
    const deps = baseDeps({ requestDrain: async () => ({ block: true, reason: 'again' }) });
    // Resolves (does not hang); guard caps it at 2 turns.
    await runAgentLoop(deps, 'go');
    expect(collected(deps).filter((e) => e.kind === 'turn-start').length).toBe(2);
  });

  it('hits maxTurns → terminal max-turns stop', async () => {
    const deps = baseDeps({ caps: { maxTurns: 1, maxHops: 8 }, requestDrain: async () => ({ block: true, reason: 'again' }) });
    await runAgentLoop(deps, 'go');
    const stops = collected(deps).filter((e) => e.kind === 'stop');
    expect(stops.some((s) => s.kind === 'stop' && s.reason === 'max-turns')).toBe(true);
  });

  it('bounds tool round-trips by maxHops when the provider never ends the turn', async () => {
    const neverEnds: ProviderCall = async (): Promise<ProviderTurn> => ({
      toolUses: [{ toolName: 'loop', toolInput: {}, toolCallId: 'c' }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
      endOfTurn: false
    });
    const deps = baseDeps({ providerCall: neverEnds, caps: { maxTurns: 1, maxHops: 3 } });
    await runAgentLoop(deps, 'go'); // must resolve, not hang
    expect(collected(deps).some((e) => e.kind === 'turn-end')).toBe(true);
  });
});
