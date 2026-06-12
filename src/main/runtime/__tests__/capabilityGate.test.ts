/** E006 T003 {FR-010} — capability gate: one notice per capability per session,
 *  strip the field, never throw, bounded payload (no request content). Electron-free,
 *  emit injected (HINT-001 / HINT-004 / AD-005). */
import { describe, it, expect } from 'vitest';
import { makeCapabilityGate } from '@jsh562/agent-core';
import { EMPTY_CAPABILITY_DESCRIPTOR, type CapabilityDescriptor } from '../../../shared/providerRuntime';
import type { AgentEvent, NotificationEvent } from '../../../shared/agentEvent';

function harness(descriptor: CapabilityDescriptor) {
  const events: AgentEvent[] = [];
  const gate = makeCapabilityGate(descriptor, (e) => events.push(e), {
    agentId: 'a.native',
    sessionId: 'sess-1',
    modelId: 'minimax-m3',
    now: () => 1
  });
  const notices = () => events.filter((e): e is NotificationEvent => e.kind === 'notification');
  return { gate, events, notices };
}

const ALL = { supportsImages: true, supportsMcpTools: true, supportsWebSearch: true, supportsCaching: true };

describe('T003 — makeCapabilityGate', () => {
  it('allows a supported capability with no notice', () => {
    const { gate, notices } = harness(ALL);
    expect(gate.allows('images')).toBe(true);
    expect(notices()).toHaveLength(0);
  });

  it('emits exactly ONE notice per capability per session and continues (never throws)', () => {
    const { gate, notices } = harness(EMPTY_CAPABILITY_DESCRIPTOR);
    expect(gate.gate('images').supported).toBe(false);
    expect(gate.gate('images').supported).toBe(false); // second invocation, same session
    expect(gate.gate('images').supported).toBe(false);
    expect(notices()).toHaveLength(1); // deduped across turns
    expect(gate.gate('webSearch').supported).toBe(false);
    expect(notices()).toHaveLength(2); // a different capability gets its own single notice
  });

  it('notice payload is bounded to capability label + model id, never the trigger content', () => {
    const { gate, notices } = harness(EMPTY_CAPABILITY_DESCRIPTOR);
    gate.gate('caching');
    const msg = notices()[0].message;
    expect(msg).toContain('prompt caching');
    expect(msg).toContain('minimax-m3');
    // It must not echo any request payload — only the bounded fields appear.
    expect(msg).not.toMatch(/base64|tool_input|image|bytes|content/i);
  });

  it('applyTo strips unsupported fields (e.g. caching) and notices once, leaving supported ones', () => {
    const capsCachingOff: CapabilityDescriptor = { ...ALL, supportsCaching: false };
    const { gate, notices } = harness(capsCachingOff);
    const out = gate.applyTo({ caching: { mode: 'ephemeral' }, images: [{ b64: 'x' }] });
    expect('caching' in out).toBe(false); // stripped
    expect('images' in out).toBe(true); // supported → kept
    expect(notices()).toHaveLength(1);
    // A second apply in the same session does not re-notice.
    gate.applyTo({ caching: { mode: 'ephemeral' } });
    expect(notices()).toHaveLength(1);
  });
});
