/** E006 T024 {FR-007,FR-009} — full hive-peer integration: runAgentLoop driven by a
 *  MOCK ProviderCall through a multi-round tool loop, asserting the normalized
 *  AgentEvent stream (turn/thinking/text/tool/usage/stop) AND that tools execute via
 *  the executeTool seam — and that the seam can route to the core hive tools
 *  (executeHiveTool) exactly as the native worker wires it. Pure Node, no electron. */
import { describe, it, expect } from 'vitest';
import { runAgentLoop, type AgentLoopDeps, type ToolResult } from '@jsh562/agent-core';
import { executeHiveTool, CORE_HIVE_TOOL_NAMES, HIVE_TOOL_CATALOG, type HiveToolDeps } from '@jsh562/agent-core';
import type { AgentEvent } from '../../../shared/agentEvent';
import type { ProviderCall, ProviderRequest, ProviderTurn, ToolSpec, ToolUseRequest } from '../../../shared/providerCall';

/** A mock adapter: round 1 thinks + calls a tool, round 2 reads the result and ends.
 *  It also emits streaming thinking/text deltas via the scoped `emit` (AD-001). */
function multiRoundAdapter(): { call: ProviderCall; seenToolResults: string[]; rounds: () => number } {
  let n = 0;
  const seenToolResults: string[] = [];
  const call: ProviderCall = async (req: ProviderRequest, emit): Promise<ProviderTurn> => {
    n++;
    if (n === 1) {
      emit?.({ v: 1, agentId: 'a', sessionId: 's', ts: 0, kind: 'thinking-start' });
      emit?.({ v: 1, agentId: 'a', sessionId: 's', ts: 0, kind: 'thinking-delta', text: 'planning' });
      emit?.({ v: 1, agentId: 'a', sessionId: 's', ts: 0, kind: 'text-delta', text: 'looking it up' });
      return {
        text: 'looking it up',
        thinking: 'planning',
        toolUses: [{ toolName: 'hive_list_tasks', toolInput: {}, toolCallId: 'call-1' }],
        usage: { input: 100, output: 20, cacheRead: 0, cacheCreation: 0 },
        endOfTurn: false,
        stopReason: 'tool-use'
      };
    }
    // Round 2: the loop appended the tool result as a `tool` message — confirm it.
    const toolMsg = req.messages.find((m) => m.role === 'tool');
    if (toolMsg) seenToolResults.push(toolMsg.content);
    return {
      text: 'done',
      toolUses: [],
      usage: { input: 50, output: 10, cacheRead: 0, cacheCreation: 0 },
      endOfTurn: true,
      stopReason: 'end-of-turn'
    };
  };
  return { call, seenToolResults, rounds: () => n };
}

/** An in-memory hive that satisfies HiveToolDeps (no electron, no git). */
function fakeHive(): HiveToolDeps & { sent: { to: string; from: string }[]; tasks_: unknown } {
  let ledger: { tasks: unknown[] } = { tasks: [] };
  const sent: { to: string; from: string }[] = [];
  return {
    sent,
    get tasks_() { return ledger; },
    enabled: () => true,
    memory: (id: string) => `memory of ${id}`,
    send: (partial, from = 'system') => {
      sent.push({ to: String(partial.to), from });
      return {
        id: 'm1', conversation: 'c', in_reply_to: null, from, to: String(partial.to),
        act: 'inform', subject: '', body: '', hops: 0, requires_reply: false,
        needs_human: false, created_at: ''
      } as ReturnType<HiveToolDeps['send']>;
    },
    tasks: () => ledger,
    writeTasks: (t) => { ledger = { tasks: t }; },
    roster: () => [],
    isGod: () => false,
    canIntegrate: () => false,
    canReview: () => false
  };
}

function collect(): { deps: (over: Partial<AgentLoopDeps>) => AgentLoopDeps; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  const deps = (over: Partial<AgentLoopDeps>): AgentLoopDeps => ({
    agentId: 'a.native',
    sessionId: 's',
    model: 'deepseek-v4-flash',
    providerCall: async (): Promise<ProviderTurn> => ({ toolUses: [], usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, endOfTurn: true }),
    executeTool: async (u: ToolUseRequest): Promise<ToolResult> => ({ toolCallId: u.toolCallId, content: 'ok', success: true }),
    emit: (e) => events.push(e),
    requestDrain: async () => ({ block: false }),
    caps: { maxTurns: 4, maxHops: 4 },
    now: () => 0,
    ...over
  });
  return { deps, events };
}

describe('T024 {FR-007} — multi-round tool loop emits the full normalized stream', () => {
  it('emits turn/thinking/text/tool/usage/stop in order across two rounds', async () => {
    const adapter = multiRoundAdapter();
    const { deps, events } = collect();
    await runAgentLoop(deps({ providerCall: adapter.call }), 'go');

    const kinds = events.map((e) => e.kind);
    // Each normalized kind the spec names is present (US3 acceptance #2).
    for (const k of ['turn-start', 'thinking-start', 'thinking-delta', 'text-delta', 'tool-start', 'tool-end', 'token-usage', 'turn-end', 'stop']) {
      expect(kinds).toContain(k);
    }
    // Ordering: turn-start < tool-start < tool-end < stop.
    expect(kinds.indexOf('turn-start')).toBeLessThan(kinds.indexOf('tool-start'));
    expect(kinds.indexOf('tool-start')).toBeLessThan(kinds.indexOf('tool-end'));
    expect(kinds.indexOf('tool-end')).toBeLessThan(kinds.lastIndexOf('stop'));
    // Two provider rounds ran (tool round + a final no-tool round).
    expect(adapter.rounds()).toBe(2);
    // The final stop is a clean end-of-turn (not max-turns / not an error).
    const stop = events.filter((e) => e.kind === 'stop').at(-1);
    expect(stop?.kind === 'stop' && stop.reason).toBe('end-of-turn');
  });
});

describe('T024 {FR-009} — tools execute via the executeTool seam', () => {
  it('routes the tool call through executeTool and feeds its result back to the next round', async () => {
    const adapter = multiRoundAdapter();
    const executed: ToolUseRequest[] = [];
    const { deps } = collect();
    await runAgentLoop(
      deps({
        providerCall: adapter.call,
        executeTool: async (u): Promise<ToolResult> => {
          executed.push(u);
          return { toolCallId: u.toolCallId, content: '{"tasks":[]}', success: true };
        }
      }),
      'go'
    );
    expect(executed.map((u) => u.toolName)).toEqual(['hive_list_tasks']);
    // The tool result was appended as a tool message the adapter saw in round 2.
    expect(adapter.seenToolResults).toContain('{"tasks":[]}');
  });

  it('the seam can be backed by the core hive tools (executeHiveTool) as the worker wires it', async () => {
    const adapter = multiRoundAdapter();
    const hive = fakeHive();
    const { deps } = collect();
    // Mirror the worker→main wiring: executeTool delegates to executeHiveTool.
    await runAgentLoop(
      deps({
        providerCall: adapter.call,
        executeTool: async (u): Promise<ToolResult> => {
          const r = executeHiveTool(hive, 'a.native', { toolName: u.toolName, toolInput: u.toolInput });
          return { toolCallId: u.toolCallId, content: r.content, success: r.success };
        }
      }),
      'go'
    );
    // hive_list_tasks ran against the fake hive and returned the ledger JSON.
    expect(adapter.seenToolResults.some((c) => c.includes('"tasks"'))).toBe(true);
  });
});

describe('T024 {FR-009} — executeHiveTool covers the core hive tools', () => {
  it('reads own memory, sends a message, lists + adds tasks; fails closed on bad input', () => {
    const hive = fakeHive();
    const id = 'a.native';

    expect(executeHiveTool(hive, id, { toolName: 'hive_read_memory', toolInput: {} }))
      .toEqual({ content: 'memory of a.native', success: true });

    const send = executeHiveTool(hive, id, { toolName: 'hive_send_message', toolInput: { to: 'god', body: 'hi' } });
    expect(send.success).toBe(true);
    expect(hive.sent.at(-1)).toEqual({ to: 'god', from: id });

    // A send with no recipient fails closed (the loop self-corrects).
    expect(executeHiveTool(hive, id, { toolName: 'hive_send_message', toolInput: {} }).success).toBe(false);

    const add = executeHiveTool(hive, id, { toolName: 'hive_add_task', toolInput: { title: 'do X' } });
    expect(add.success).toBe(true);
    const list = executeHiveTool(hive, id, { toolName: 'hive_list_tasks', toolInput: {} });
    expect(list.success).toBe(true);
    expect(list.content).toContain('do X');

    // Unknown tool + disabled hive both fail closed (never throw).
    expect(executeHiveTool(hive, id, { toolName: 'nope', toolInput: {} }).success).toBe(false);
    const off: HiveToolDeps = { ...hive, enabled: () => false };
    expect(executeHiveTool(off, id, { toolName: 'hive_read_memory', toolInput: {} }).success).toBe(false);
  });
});

describe('T022 {FR-009} — the hive-tool catalog is advertised to the native model', () => {
  it('the catalog tool names EXACTLY match the executeHiveTool dispatch names (no drift)', () => {
    const catalogNames = HIVE_TOOL_CATALOG.map((t) => t.name).sort();
    const dispatchNames = [...CORE_HIVE_TOOL_NAMES].sort();
    // The advertised catalog and the executor's dispatch table cannot drift: every
    // advertised tool is dispatchable, and every dispatchable core tool is advertised.
    expect(catalogNames).toEqual(dispatchNames);

    // Every catalog entry carries a description + JSON-schema object inputSchema so the
    // model is actually told how to call it (FR-009).
    for (const spec of HIVE_TOOL_CATALOG) {
      expect(typeof spec.description).toBe('string');
      expect((spec.description ?? '').length).toBeGreaterThan(0);
      const schema = spec.inputSchema as { type?: string } | undefined;
      expect(schema?.type).toBe('object');
    }
  });

  it('runAgentLoop forwards deps.tools into the ProviderCall request (model is advertised the tools)', async () => {
    const seenTools: (ToolSpec[] | undefined)[] = [];
    const capturing: ProviderCall = async (req: ProviderRequest): Promise<ProviderTurn> => {
      seenTools.push(req.tools);
      return { toolUses: [], usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, endOfTurn: true };
    };
    const { deps } = collect();
    // Drive the loop with the same catalog the native worker passes into the deps.
    await runAgentLoop(deps({ providerCall: capturing, tools: [...HIVE_TOOL_CATALOG] }), 'go');

    expect(seenTools.length).toBeGreaterThan(0);
    expect(seenTools[0]?.map((t) => t.name)).toEqual(HIVE_TOOL_CATALOG.map((t) => t.name));
  });
});
