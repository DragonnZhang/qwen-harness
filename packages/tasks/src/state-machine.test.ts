import { describe, expect, it } from 'vitest';

import {
  canTransition,
  isClaimable,
  isOwned,
  isTerminal,
  TASK_STATUSES,
  TASK_TRANSITIONS,
  type TaskStatus,
} from './state-machine.ts';

/**
 * The task state machine as evidence (WK-04). Every legal transition is asserted to work and — the
 * half that actually protects the log — every illegal transition is asserted to be rejected. Both
 * are derived mechanically from the table, so the machine is exhaustively covered, not spot-checked.
 */
describe('task state machine (WK-04)', () => {
  const all = TASK_STATUSES;

  const legal: [TaskStatus, TaskStatus][] = [];
  const illegal: [TaskStatus, TaskStatus][] = [];
  for (const from of all) {
    for (const to of all) {
      (TASK_TRANSITIONS[from].includes(to) ? legal : illegal).push([from, to]);
    }
  }

  it.each(legal)('allows the declared transition %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it.each(illegal)('rejects the undeclared transition %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  it('models the happy path pending -> claimed -> in-progress -> completed', () => {
    expect(canTransition('pending', 'claimed')).toBe(true);
    expect(canTransition('claimed', 'in-progress')).toBe(true);
    expect(canTransition('in-progress', 'completed')).toBe(true);
  });

  it('lets an owned task be released back toward the pool (owner-loss recovery)', () => {
    expect(canTransition('claimed', 'released')).toBe(true);
    expect(canTransition('in-progress', 'released')).toBe(true);
    expect(canTransition('released', 'claimed')).toBe(true);
  });

  it('never allows starting work straight from pending (must be claimed first)', () => {
    expect(canTransition('pending', 'in-progress')).toBe(false);
  });

  it('treats deleted as terminal — nothing transitions out of it', () => {
    expect(TASK_TRANSITIONS.deleted).toHaveLength(0);
    expect(isTerminal('deleted')).toBe(true);
    for (const to of all) expect(canTransition('deleted', to)).toBe(false);
  });

  it('classifies owned and claimable states consistently', () => {
    expect(isOwned('claimed')).toBe(true);
    expect(isOwned('in-progress')).toBe(true);
    expect(isOwned('pending')).toBe(false);
    expect(isClaimable('pending')).toBe(true);
    expect(isClaimable('released')).toBe(true);
    expect(isClaimable('blocked')).toBe(false);
    expect(isClaimable('claimed')).toBe(false);
  });
});
