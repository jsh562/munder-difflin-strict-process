/** T012 / SC-004 — additive evolution: a new kind/field does not break consumers. */
import { describe, it, expect } from 'vitest';
import {
  AGENT_EVENT_VERSION,
  KNOWN_AGENT_EVENT_KINDS,
  isKnownAgentEventKind,
  isMonotonicTokenUsage,
  type TokenUsageEvent
} from '../../../shared/agentEvent';
import { IpcTranslator } from '../ipcTranslator';
import { AGENT } from './fixtures/hookSignals';

describe('AgentEvent versioning (additive-only)', () => {
  it('declares a stable version and closed v1 kind set', () => {
    expect(AGENT_EVENT_VERSION).toBe(1);
    expect(KNOWN_AGENT_EVENT_KINDS).toHaveLength(12);
  });

  it('an unknown (future) event kind is ignored, not broken, by existing consumers', () => {
    const translator = new IpcTranslator();
    // A hypothetical future kind a v2 emitter might add.
    const future = { v: 2, agentId: AGENT, sessionId: null, ts: 1, kind: 'image-block', url: 'x' } as never;
    expect(isKnownAgentEventKind('image-block')).toBe(false);
    // The translator returns null (no legacy mapping) instead of throwing.
    expect(translator.toHiveHookEvent(future)).toBeNull();
  });

  it('an added field on an existing kind does not break the monotonic check', () => {
    const base: TokenUsageEvent = {
      v: 2,
      agentId: AGENT,
      sessionId: null,
      ts: 1,
      kind: 'token-usage',
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheCreation: 0,
      model: null,
      usd: 0.01
    };
    const next = { ...base, input: 20, usd: 0.02, reasoningTokens: 7 } as TokenUsageEvent & { reasoningTokens: number };
    expect(isMonotonicTokenUsage(base, next)).toBe(true);
  });
});
