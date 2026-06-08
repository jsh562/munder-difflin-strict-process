/** E003 — NativeAgentWorker drives the full E001 ProviderRuntime port over a
 *  FAKED transport (no electron), SC-002. */
import { describe, it, expect } from 'vitest';
import { NativeAgentWorker, type WorkerTransport } from '../nativeAgentWorker';
import { EMPTY_CAPABILITY_DESCRIPTOR, type ProviderRuntime } from '../../../shared/providerRuntime';
import type { WorkerCommand, WorkerMessage } from '../../../shared/workerProtocol';

function fakeTransport() {
  const posted: WorkerCommand[] = [];
  let msgCb: ((m: WorkerMessage) => void) | null = null;
  let exitCb: ((c: number) => void) | null = null;
  let killed = false;
  const transport: WorkerTransport = {
    post: (c) => posted.push(c),
    onMessage: (cb) => { msgCb = cb; },
    onExit: (cb) => { exitCb = cb; },
    kill: () => { killed = true; exitCb?.(0); }
  };
  return { transport, posted, emit: (m: WorkerMessage) => msgCb?.(m), killed: () => killed };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('SC-002 — ProviderRuntime conformance (native worker, faked transport)', () => {
  it('exercises start/subscribe/send/getUsage/drain/capabilities/stop/kill', async () => {
    const f = fakeTransport();
    let exited = false;
    const drains: number[] = [];
    const port: ProviderRuntime = new NativeAgentWorker({
      agentId: 'a.native',
      transportFactory: () => f.transport,
      usageFallback: () => null,
      onExit: () => { exited = true; },
      onDrainRequest: async (_id, turnId) => { drains.push(turnId); return { block: false }; }
    });

    await port.start();
    expect(f.posted[0]).toMatchObject({ type: 'start', agentId: 'a.native' });

    const seen: string[] = [];
    const unsub = port.subscribe((e) => seen.push(e.kind));
    f.emit({ type: 'event', event: { v: 1, agentId: 'a.native', sessionId: null, ts: 1, kind: 'turn-start' } });
    expect(seen).toEqual(['turn-start']);
    unsub();

    f.emit({ type: 'usage', usage: { agentId: 'a.native', sessionId: null, ts: 1, input: 10, output: 5, cacheRead: 0, cacheCreation: 0, model: null, usd: 0 } });
    expect(port.getUsage()?.input).toBe(10);

    port.send({ kind: 'operator', text: 'hello' });
    expect(f.posted.some((c) => c.type === 'send')).toBe(true);

    f.emit({ type: 'drainRequest', turnId: 7 });
    await flush();
    expect(drains).toContain(7);
    expect(f.posted.some((c) => c.type === 'drainResult' && c.turnId === 7 && c.block === false)).toBe(true);

    expect(port.capabilities()).toEqual(EMPTY_CAPABILITY_DESCRIPTOR);

    await port.stop(true);
    expect(f.killed()).toBe(false); // graceful stop does not kill
    port.kill();
    expect(f.killed()).toBe(true);
    expect(exited).toBe(true); // kill → exit → onExit teardown
  });

  it('getUsage falls back to the provided seam when the worker has not reported', () => {
    const f = fakeTransport();
    const port = new NativeAgentWorker({
      agentId: 'a.native',
      transportFactory: () => f.transport,
      usageFallback: () => ({ agentId: 'a.native', sessionId: null, ts: 1, input: 1, output: 1, cacheRead: 0, cacheCreation: 0, model: null, usd: 0 })
    });
    expect(port.getUsage()?.input).toBe(1);
  });
});
