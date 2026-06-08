/** T008 / SC-001 — drive the Claude adapter through every ProviderRuntime method. */
import { describe, it, expect } from 'vitest';
import { ClaudeAdapter } from '../claudeAdapter';
import { EMPTY_CAPABILITY_DESCRIPTOR, type ProviderRuntime } from '../../../shared/providerRuntime';
import { usageSnapshot } from './_harness';

describe('ProviderRuntime conformance (Claude adapter)', () => {
  it('exercises start/send/stop/kill/getUsage/subscribe/capabilities', async () => {
    const written: string[] = [];
    let killed = false;
    const usage = usageSnapshot({ input: 5 });

    const port: ProviderRuntime = new ClaudeAdapter({
      agentId: 'agent.conform',
      usage: { getAgentUsage: () => usage },
      ptyWrite: (t) => written.push(t),
      ptyKill: () => { killed = true; },
      now: () => 1
    });

    await port.start();

    const seen: string[] = [];
    const unsub = port.subscribe((e) => seen.push(e.kind));
    expect(typeof unsub).toBe('function');

    port.send({ kind: 'operator', text: 'hello' });
    expect(written).toEqual(['hello']);

    const snap = port.getUsage();
    expect(snap?.input).toBe(5);

    await port.stop(true);
    expect(killed).toBe(false); // graceful stop does not kill
    port.kill();
    expect(killed).toBe(true);

    unsub();
    expect(port.capabilities()).toEqual(EMPTY_CAPABILITY_DESCRIPTOR);
  });

  it('getUsage returns null when the seam has no sample', () => {
    const port: ProviderRuntime = new ClaudeAdapter({ agentId: 'x', usage: { getAgentUsage: () => null } });
    expect(port.getUsage()).toBeNull();
  });
});
