/**
 * One-shot sub-agent runner — drives a NativeAgentWorker over a FAKE transport (no electron):
 * captures the child's final text on terminal `stop`, kills the idle process, enforces the
 * nesting guard, and times out a hung child. Mirrors the fake-transport pattern in
 * nativeAgentWorker.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { runOneShotSubAgent, subAgentChildId, SUBAGENT_ID_PREFIX, resolveSubAgentModel } from '../subAgentRunner';
import type { WorkerTransport } from '../nativeAgentWorker';
import type { WorkerCommand, WorkerMessage } from '../../../shared/workerProtocol';
import type { AgentEvent } from '../../../shared/agentEvent';

const ev = (kind: string, extra: Record<string, unknown> = {}): AgentEvent =>
  ({ v: 1, agentId: 'child', sessionId: null, ts: 1, kind, ...extra } as unknown as AgentEvent);

/** A fake transport whose `onSend` hook drives the worker's reply (emit events / tool requests). */
function fakeTransport(onSend: (emit: (m: WorkerMessage) => void, post: (c: WorkerCommand) => void) => void) {
  const posted: WorkerCommand[] = [];
  let msgCb: ((m: WorkerMessage) => void) | null = null;
  let exitCb: ((c: number) => void) | null = null;
  let killed = false;
  const emit = (m: WorkerMessage) => msgCb?.(m);
  const post = (c: WorkerCommand) => {
    posted.push(c);
    if (c.type === 'send') onSend(emit, post);
  };
  const transport: WorkerTransport = {
    post,
    onMessage: (cb) => { msgCb = cb; },
    onExit: (cb) => { exitCb = cb; },
    kill: () => { killed = true; exitCb?.(0); }
  };
  return { transport, posted, emit, killed: () => killed };
}

describe('runOneShotSubAgent', () => {
  it('captures the accumulated final text and succeeds on a terminal stop, then kills the worker', async () => {
    const f = fakeTransport((emit) => {
      emit({ type: 'event', event: ev('text-delta', { text: 'data-model written.' }) });
      emit({ type: 'event', event: ev('text-delta', { text: '3 entities.' }) });
      emit({ type: 'event', event: ev('stop', { reason: 'end-of-turn', stopActive: false }) });
    });
    const events: string[] = [];
    const res = await runOneShotSubAgent({
      callerId: 'planner-1',
      childId: subAgentChildId('planner-1', 'database-administrator'),
      input: 'spec at specs/00001/spec.md',
      transportFactory: () => f.transport,
      executeTool: async () => ({ content: '', success: true }),
      onEvent: (e) => events.push(e.kind)
    });
    expect(res.success).toBe(true);
    expect(res.content).toBe('data-model written.\n3 entities.');
    expect(f.killed()).toBe(true); // completed loop leaves the process idle → runner kills it
    expect(events).toContain('text-delta');
    expect(events).toContain('stop');
  });

  it('refuses to nest: a caller that is itself a sub-agent is rejected without spawning', async () => {
    let spawned = false;
    const res = await runOneShotSubAgent({
      callerId: `${SUBAGENT_ID_PREFIX}planner-1:database-administrator:1`,
      childId: 'whatever',
      input: 'x',
      transportFactory: () => { spawned = true; return fakeTransport(() => {}).transport; },
      executeTool: async () => ({ content: '', success: true })
    });
    expect(res.success).toBe(false);
    expect(res.content).toMatch(/cannot spawn another sub-agent/);
    expect(spawned).toBe(false);
  });

  it('routes the child tool calls through executeTool and replies with a toolResult', async () => {
    const toolCalls: string[] = [];
    const f = fakeTransport((emit) => {
      // The child requests a tool; the worker calls executeTool and posts a toolResult; then stop.
      emit({ type: 'toolRequest', callId: 1, toolCallId: 'tc1', toolName: 'read_file', toolInput: { path: 'spec.md' } });
      // Give the async tool handler a tick, then end the turn.
      setTimeout(() => emit({ type: 'event', event: ev('stop', { reason: 'end-of-turn', stopActive: false }) }), 0);
    });
    const res = await runOneShotSubAgent({
      callerId: 'planner-1',
      childId: 'sub:planner-1:x:9',
      input: 'go',
      transportFactory: () => f.transport,
      executeTool: async (req) => { toolCalls.push(req.toolName); return { content: 'file body', success: true }; }
    });
    expect(toolCalls).toEqual(['read_file']);
    expect(f.posted.some((c) => c.type === 'toolResult' && c.content === 'file body' && c.success)).toBe(true);
    expect(res.success).toBe(true);
  });

  it('times out a hung child (no stop) — kills it and reports the timeout', async () => {
    const f = fakeTransport(() => { /* child never replies */ });
    const res = await runOneShotSubAgent({
      callerId: 'planner-1',
      childId: 'sub:planner-1:hang:1',
      input: 'go',
      transportFactory: () => f.transport,
      executeTool: async () => ({ content: '', success: true }),
      timeoutMs: 30
    });
    expect(res.success).toBe(false);
    expect(res.content).toMatch(/timed out after 30ms/);
    expect(f.killed()).toBe(true);
  });

  it('forwards the child token-usage events to onEvent (caller cost rollup)', async () => {
    const usage: number[] = [];
    const f = fakeTransport((emit) => {
      emit({ type: 'event', event: { v: 1, agentId: 'child', sessionId: null, ts: 1, kind: 'token-usage', input: 100, output: 40, cacheRead: 0, cacheCreation: 0, model: 'deepseek-chat', usd: 0 } as unknown as AgentEvent });
      emit({ type: 'event', event: ev('text-delta', { text: 'done' }) });
      emit({ type: 'event', event: ev('stop', { reason: 'end-of-turn', stopActive: false }) });
    });
    await runOneShotSubAgent({
      callerId: 'planner-1',
      childId: 'sub:planner-1:x:1',
      input: 'go',
      transportFactory: () => f.transport,
      executeTool: async () => ({ content: '', success: true }),
      onEvent: (e) => { if (e.kind === 'token-usage') usage.push((e as { input: number }).input); }
    });
    expect(usage).toEqual([100]);
  });

  it('aborts an in-flight run when the signal fires — kills the worker + resolves false', async () => {
    const f = fakeTransport(() => { /* child never replies */ });
    const ac = new AbortController();
    const p = runOneShotSubAgent({
      callerId: 'planner-1',
      childId: 'sub:planner-1:abort:1',
      input: 'go',
      transportFactory: () => f.transport,
      executeTool: async () => ({ content: '', success: true }),
      signal: ac.signal,
      timeoutMs: 5000
    });
    ac.abort();
    const res = await p;
    expect(res.success).toBe(false);
    expect(res.content).toMatch(/aborted by operator/);
    expect(f.killed()).toBe(true);
  });

  it('a pre-aborted signal resolves immediately without forking a worker', async () => {
    const ac = new AbortController();
    ac.abort();
    let forked = false;
    const res = await runOneShotSubAgent({
      callerId: 'planner-1',
      childId: 'sub:planner-1:abort:2',
      input: 'go',
      transportFactory: () => { forked = true; return fakeTransport(() => {}).transport; },
      executeTool: async () => ({ content: '', success: true }),
      signal: ac.signal
    });
    expect(res.success).toBe(false);
    expect(res.content).toMatch(/aborted by operator/);
    expect(forked).toBe(false);
  });

  it('childIds are unique per spawn (no collision under the same caller+name)', () => {
    const a = subAgentChildId('planner-1', 'database-administrator');
    const b = subAgentChildId('planner-1', 'database-administrator');
    expect(a).not.toBe(b);
    expect(a.startsWith(SUBAGENT_ID_PREFIX)).toBe(true);
  });
});

describe('resolveSubAgentModel — override only when same-provider', () => {
  // A toy provider deriver: a model maps to the provider before the first '-'.
  const derive = (m: string): string | null => (m.includes('-') ? m.split('-')[0] : null);

  it('uses the override when it maps to the caller provider', () => {
    expect(resolveSubAgentModel('deepseek-reasoner', 'deepseek-chat', 'deepseek', derive)).toBe('deepseek-chat');
  });
  it('falls back to the caller model when the override is a DIFFERENT provider', () => {
    expect(resolveSubAgentModel('deepseek-reasoner', 'minimax-text', 'deepseek', derive)).toBe('deepseek-reasoner');
  });
  it('falls back to the caller model when the override is blank/absent', () => {
    expect(resolveSubAgentModel('deepseek-reasoner', '', 'deepseek', derive)).toBe('deepseek-reasoner');
    expect(resolveSubAgentModel('deepseek-reasoner', undefined, 'deepseek', derive)).toBe('deepseek-reasoner');
  });
});
