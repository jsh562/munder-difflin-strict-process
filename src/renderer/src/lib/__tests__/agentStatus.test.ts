import { describe, it, expect } from 'vitest';
import { reconcileTurnStatus, deskBucket, bucketCounts } from '../agentStatus';
import type { Agent } from '@/store/store';

/** Minimal Agent for the bucket helpers (only the fields they read). */
function mkAgent(over: Partial<Agent> & { id: string }): Agent {
  return { id: over.id, name: over.id, status: 'idle', ...over } as Agent;
}

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

describe('deskBucket — status + liveness → one matrix bucket', () => {
  it('maps active statuses straight through (thinking folds into working)', () => {
    expect(deskBucket(mkAgent({ id: 'a', status: 'working' }), false, 'running', true)).toBe('working');
    expect(deskBucket(mkAgent({ id: 'a', status: 'thinking' }), false, 'running', true)).toBe('working');
    expect(deskBucket(mkAgent({ id: 'a', status: 'waiting' }), false, 'running', true)).toBe('waiting');
    expect(deskBucket(mkAgent({ id: 'a', status: 'blocked' }), false, 'running', true)).toBe('blocked');
    expect(deskBucket(mkAgent({ id: 'a', status: 'looping' }), false, 'running', true)).toBe('looping');
    expect(deskBucket(mkAgent({ id: 'a', status: 'compacting' }), false, 'running', true)).toBe('compacting');
  });

  it('an idle desk is `cold` only when known-parked (warm===false), else `idle`', () => {
    expect(deskBucket(mkAgent({ id: 'a', status: 'idle' }), false, 'running', false)).toBe('cold');
    expect(deskBucket(mkAgent({ id: 'a', status: 'idle' }), false, 'running', true)).toBe('idle');
    expect(deskBucket(mkAgent({ id: 'a', status: 'idle' }), false, 'running', undefined)).toBe('idle');
  });

  it('a paused desk reads waiting; a stopped god reads idle/cold (via displayStatus)', () => {
    expect(deskBucket(mkAgent({ id: 'a', status: 'working' }), true, 'running', true)).toBe('waiting');
    expect(deskBucket(mkAgent({ id: 'g', isGod: true, status: 'working' }), false, 'stopped', false)).toBe('cold');
  });
});

describe('bucketCounts — tally a cell by bucket', () => {
  it('counts each desk under its bucket, using liveness for cold vs idle', () => {
    const agents = [
      mkAgent({ id: 'w', status: 'working' }),
      mkAgent({ id: 'i', status: 'idle' }),   // warm → idle
      mkAgent({ id: 'c', status: 'idle' })    // cold
    ];
    const counts = bucketCounts(agents, {}, 'running', { w: true, i: true, c: false });
    expect(counts).toEqual({ working: 1, idle: 1, cold: 1 });
  });

  it('an absent liveness entry is unknown → idle (not cold); paused overrides to waiting', () => {
    const agents = [mkAgent({ id: 'x', status: 'idle' }), mkAgent({ id: 'y', status: 'working' })];
    const counts = bucketCounts(agents, { y: true }, 'running', {});
    expect(counts).toEqual({ idle: 1, waiting: 1 });
  });
});
