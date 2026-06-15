import { describe, it, expect } from 'vitest';
import { assigneesForStatus } from '../phaseScope';

describe('assigneesForStatus — the desks a per-phase pause/stop targets', () => {
  const tasks = [
    { status: 'doing', assignee: 'kevin' },
    { status: 'doing', assignee: 'kevin' },   // same desk, two cards → deduped
    { status: 'doing', assignee: 'oscar' },
    { status: 'review', assignee: 'angela' },
    { status: 'doing' },                        // unassigned → skipped
    { status: 'integrate', assignee: 'phyllis' }
  ];

  it('returns the distinct assignees of cards in the lane', () => {
    expect(assigneesForStatus(tasks, 'doing').sort()).toEqual(['kevin', 'oscar']);
    expect(assigneesForStatus(tasks, 'review')).toEqual(['angela']);
    expect(assigneesForStatus(tasks, 'integrate')).toEqual(['phyllis']);
  });

  it('is empty for a lane with no (assigned) cards', () => {
    expect(assigneesForStatus(tasks, 'todo')).toEqual([]);
    expect(assigneesForStatus(tasks, 'done')).toEqual([]);
  });
});
