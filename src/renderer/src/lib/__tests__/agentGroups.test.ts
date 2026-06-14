import { describe, it, expect } from 'vitest';
import { effectiveRoles, groupAgents, roleCounts, FLOOR_GROUP } from '../agentGroups';
import type { Agent } from '@/store/store';

/** Minimal Agent for the pure grouping logic (only the fields the helpers read matter). */
function mk(p: Partial<Agent>): Agent {
  return {
    id: 'a', name: 'A', character: 'michael', accent: 'sky', description: '',
    project: 'proj', tmuxTarget: '', cwd: '/p', status: 'idle', action: '', progress: 0,
    ...p
  } as unknown as Agent;
}

describe('effectiveRoles — defaults applied when roles unset', () => {
  it('god → integrator+reviewer; worker → worker; assistant → none; explicit preserved', () => {
    expect(effectiveRoles(mk({ isGod: true })).sort()).toEqual(['integrator', 'reviewer']);
    expect(effectiveRoles(mk({}))).toEqual(['worker']);
    expect(effectiveRoles(mk({ isAssistant: true }))).toEqual([]);
    expect(effectiveRoles(mk({ roles: ['worker', 'reviewer'] }))).toEqual(['worker', 'reviewer']);
    // an explicit empty roles (a pure-delegator god) holds NONE, overriding the default
    expect(effectiveRoles(mk({ isGod: true, roles: [] }))).toEqual([]);
  });
});

describe('groupAgents — FLOOR first, then projects alphabetically', () => {
  it('puts god/assistant in FLOOR and clusters the rest by project', () => {
    const god = mk({ id: 'god', isGod: true });
    const asst = mk({ id: 'asst', isAssistant: true });
    const w1 = mk({ id: 'w1', project: 'numrs' });
    const w2 = mk({ id: 'w2', project: 'numrs' });
    const r1 = mk({ id: 'r1', project: 'alpha', roles: ['reviewer'] });
    const groups = groupAgents([god, w1, asst, r1, w2]);
    expect(groups.map((g) => g.key)).toEqual([FLOOR_GROUP, 'alpha', 'numrs']);
    expect(groups[0].label).toBe('FLOOR');
    expect(groups[0].agents.map((a) => a.id)).toEqual(['god', 'asst']);
    expect(groups[1].agents.map((a) => a.id)).toEqual(['r1']);
    expect(groups[2].agents.map((a) => a.id)).toEqual(['w1', 'w2']);
  });

  it('omits FLOOR when there are no god/assistant desks', () => {
    expect(groupAgents([mk({ id: 'w', project: 'p' })]).map((g) => g.key)).toEqual(['p']);
  });
});

describe('roleCounts — a multi-role desk counts under each role it holds', () => {
  it('tallies per role with defaults applied', () => {
    const counts = roleCounts([
      mk({ id: 'w1' }),                              // worker
      mk({ id: 'w2' }),                              // worker
      mk({ id: 'wr', roles: ['worker', 'reviewer'] }) // worker + reviewer
    ]);
    expect(counts).toEqual({ worker: 3, reviewer: 1 });
  });

  it('the assistant contributes no role counts', () => {
    expect(roleCounts([mk({ id: 'asst', isAssistant: true })])).toEqual({});
  });
});
