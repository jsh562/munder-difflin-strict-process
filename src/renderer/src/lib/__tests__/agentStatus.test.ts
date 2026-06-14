import { describe, it, expect } from 'vitest';
import { reconcileTurnStatus } from '../agentStatus';

describe('reconcileTurnStatus — heal a status latched against main\'s authoritative live state', () => {
  it('clears a stuck "working" when the desk is dead (not running)', () => {
    expect(reconcileTurnStatus('working', false, true)).toBe('idle');
    expect(reconcileTurnStatus('working', false, false)).toBe('idle');
  });

  it('clears a stuck "working" when the desk is alive but NOT in a turn', () => {
    expect(reconcileTurnStatus('working', true, false)).toBe('idle');
  });

  it('promotes idle → working when the desk is genuinely mid-turn', () => {
    expect(reconcileTurnStatus('idle', true, true)).toBe('working');
  });

  it('returns null (no change) when already correct', () => {
    expect(reconcileTurnStatus('working', true, true)).toBeNull();
    expect(reconcileTurnStatus('idle', true, false)).toBeNull();
    expect(reconcileTurnStatus('idle', false, false)).toBeNull();
  });

  it('NEVER clobbers a non-working/idle status (blocked, compacting, looping, waiting)', () => {
    for (const s of ['blocked', 'compacting', 'looping', 'waiting', 'thinking', 'success'] as const) {
      expect(reconcileTurnStatus(s, false, false)).toBeNull();
      expect(reconcileTurnStatus(s, true, true)).toBeNull();
    }
  });
});
