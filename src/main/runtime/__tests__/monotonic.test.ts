/** T010 / T016 — cumulative-monotonic token usage; regressive samples are dropped. */
import { describe, it, expect } from 'vitest';
import { isMonotonicTokenUsage, type TokenUsageEvent } from '../../../shared/agentEvent';
import { makeAdapter, usageSnapshot } from './_harness';
import { AGENT } from './fixtures/hookSignals';

function usageEvent(p: Partial<TokenUsageEvent>): TokenUsageEvent {
  return {
    v: 1, agentId: AGENT, sessionId: null, ts: 1, kind: 'token-usage',
    input: 0, output: 0, cacheRead: 0, cacheCreation: 0, model: null, usd: 0, ...p
  };
}

describe('isMonotonicTokenUsage', () => {
  it('null prev is trivially monotonic', () => {
    expect(isMonotonicTokenUsage(null, usageEvent({ input: 5 }))).toBe(true);
  });
  it('all fields non-decreasing is monotonic', () => {
    expect(isMonotonicTokenUsage(usageEvent({ input: 5, usd: 0.01 }), usageEvent({ input: 5, usd: 0.02 }))).toBe(true);
  });
  it('any field decreasing is not monotonic', () => {
    expect(isMonotonicTokenUsage(usageEvent({ output: 10 }), usageEvent({ output: 9 }))).toBe(false);
    expect(isMonotonicTokenUsage(usageEvent({ usd: 0.05 }), usageEvent({ usd: 0.04 }))).toBe(false);
  });
});

describe('adapter.emitUsage drops a regressive sample', () => {
  it('emits the first sample but not a lower one', () => {
    const h = makeAdapter(usageSnapshot({ input: 100, usd: 0.10 }));
    h.adapter.emitUsage();                                  // emitted
    h.setUsage(usageSnapshot({ input: 50, usd: 0.05 }));    // regressive
    h.adapter.emitUsage();                                  // dropped
    h.setUsage(usageSnapshot({ input: 120, usd: 0.12 }));   // resumes above the last EMITTED
    h.adapter.emitUsage();                                  // emitted
    const usage = h.events.filter((e) => e.kind === 'token-usage');
    expect(usage).toHaveLength(2);
  });
});
