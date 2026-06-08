/** T011 / SC-002 — every AgentEvent kind + required fields are emittable and typed. */
import { describe, it, expect } from 'vitest';
import {
  AGENT_EVENT_VERSION,
  KNOWN_AGENT_EVENT_KINDS,
  isKnownAgentEventKind,
  isMonotonicTokenUsage,
  type AgentEvent,
  type AgentEventKind
} from '../../../shared/agentEvent';
import { makeAdapter, usageSnapshot } from './_harness';
import {
  AGENT,
  notificationIdle,
  postToolUseEdit,
  preToolUseEdit,
  stopGenuine,
  userPromptSubmit
} from './fixtures/hookSignals';

describe('AgentEvent contract', () => {
  it('emits the adapter-produced kinds across a session with required fields', () => {
    const h = makeAdapter(usageSnapshot({ input: 10, output: 5, usd: 0.01 }));
    h.adapter.ingestHook(userPromptSubmit);
    h.adapter.ingestHook(preToolUseEdit);
    h.adapter.ingestHook(postToolUseEdit);
    h.adapter.ingestText('hello world');
    h.adapter.emitUsage();
    h.setUsage(usageSnapshot({ input: 20, output: 10, usd: 0.02 }));
    h.adapter.emitUsage();
    h.adapter.ingestHook(notificationIdle);
    h.adapter.ingestHook(stopGenuine);

    const kinds = h.events.map((e) => e.kind);
    for (const k of ['turn-start', 'tool-start', 'tool-end', 'text-delta', 'token-usage', 'needs-input', 'stop']) {
      expect(kinds, k).toContain(k);
    }

    const toolStart = h.events.find((e) => e.kind === 'tool-start');
    expect(toolStart).toMatchObject({ toolName: 'Edit' });
    if (toolStart?.kind === 'tool-start') expect(toolStart.toolCallId).toBeTruthy();

    const usage = h.events.filter((e) => e.kind === 'token-usage');
    expect(usage).toHaveLength(2);

    // every event carries the version envelope + agent id
    for (const e of h.events) {
      expect(e.v).toBe(AGENT_EVENT_VERSION);
      expect(e.agentId).toBe(AGENT);
      expect(isKnownAgentEventKind(e.kind)).toBe(true);
    }
  });

  it('the union types and accepts all 12 declared kinds', () => {
    const base = { v: AGENT_EVENT_VERSION, agentId: AGENT, sessionId: null, ts: 1 };
    const samples: AgentEvent[] = [
      { ...base, kind: 'turn-start' },
      { ...base, kind: 'turn-end' },
      { ...base, kind: 'thinking-start', text: 'h' },
      { ...base, kind: 'thinking-delta', text: 'i' },
      { ...base, kind: 'text-delta', text: 'x' },
      { ...base, kind: 'tool-start', toolName: 'Edit', toolInput: {}, toolCallId: 'c1' },
      { ...base, kind: 'tool-end', toolCallId: 'c1', success: true, durationMs: 0 },
      { ...base, kind: 'token-usage', input: 1, output: 1, cacheRead: 0, cacheCreation: 0, model: null, usd: 0 },
      { ...base, kind: 'api-error', retryable: true, message: 'rate' },
      { ...base, kind: 'stop', reason: 'done', stopActive: false },
      { ...base, kind: 'needs-input', message: 'q' },
      { ...base, kind: 'notification', message: 'n' }
    ];
    const kinds = samples.map((s) => s.kind);
    expect(new Set(kinds)).toEqual(new Set<AgentEventKind>(KNOWN_AGENT_EVENT_KINDS));
    expect(KNOWN_AGENT_EVENT_KINDS).toHaveLength(12);
  });

  it('token-usage is cumulative-monotonic across the session', () => {
    const h = makeAdapter(usageSnapshot({ input: 10, usd: 0.01 }));
    h.adapter.emitUsage();
    h.setUsage(usageSnapshot({ input: 20, usd: 0.02 }));
    h.adapter.emitUsage();
    const usage = h.events.filter((e) => e.kind === 'token-usage');
    expect(usage).toHaveLength(2);
    if (usage[0].kind === 'token-usage' && usage[1].kind === 'token-usage') {
      expect(isMonotonicTokenUsage(usage[0], usage[1])).toBe(true);
    }
  });
});
