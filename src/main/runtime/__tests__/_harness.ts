/** Shared test harness: build a ClaudeAdapter with controllable usage + capture. */
import { ClaudeAdapter, type UsageReader } from '../claudeAdapter';
import type { AgentEvent } from '../../../shared/agentEvent';
import type { UsageSnapshot } from '../../../shared/providerRuntime';
import { AGENT } from './fixtures/hookSignals';

export function usageSnapshot(p: Partial<UsageSnapshot>): UsageSnapshot {
  return {
    agentId: AGENT,
    sessionId: 'sess-1',
    ts: 1,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    model: 'claude-test',
    usd: 0,
    ...p
  };
}

export interface Built {
  adapter: ClaudeAdapter;
  events: AgentEvent[];
  setUsage: (u: UsageSnapshot | null) => void;
  written: string[];
  killed: () => boolean;
}

export function makeAdapter(initialUsage: UsageSnapshot | null = null): Built {
  let current = initialUsage;
  let didKill = false;
  const written: string[] = [];
  const usage: UsageReader = { getAgentUsage: () => current };
  const adapter = new ClaudeAdapter({
    agentId: AGENT,
    usage,
    getSessionId: () => 'sess-1',
    ptyWrite: (t) => written.push(t),
    ptyKill: () => { didKill = true; },
    now: () => 1
  });
  const events: AgentEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  return { adapter, events, setUsage: (u) => { current = u; }, written, killed: () => didKill };
}
