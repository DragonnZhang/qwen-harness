import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ISOLATION,
  TERMINAL_TURN_STATES,
  TURN_TRANSITIONS,
  TurnStateSchema,
  canTransition,
  isTerminalTurnState,
  resolveProfile,
  type TurnState,
} from './domain.ts';

describe('permission profiles', () => {
  it('resolves the four canonical profiles', () => {
    expect(resolveProfile('plan')).toBe('plan');
    expect(resolveProfile('ask')).toBe('ask');
    expect(resolveProfile('auto-accept-edits')).toBe('auto-accept-edits');
    expect(resolveProfile('yolo')).toBe('yolo');
  });

  it('maps every compatibility alias from docs/product/defaults.md', () => {
    expect(resolveProfile('default')).toBe('ask');
    expect(resolveProfile('manual')).toBe('ask');
    expect(resolveProfile('acceptEdits')).toBe('auto-accept-edits');
    expect(resolveProfile('bypassPermissions')).toBe('yolo');
  });

  it('rejects an unknown profile rather than defaulting to something permissive', () => {
    expect(resolveProfile('superuser')).toBeUndefined();
    expect(resolveProfile('')).toBeUndefined();
    // The dangerous failure mode would be silently falling back to a broad profile.
    expect(resolveProfile('yolo ')).toBeUndefined();
  });

  it('maps default isolation exactly as frozen in defaults.md', () => {
    expect(DEFAULT_ISOLATION).toEqual({
      plan: 'read-only',
      ask: 'workspace-write',
      'auto-accept-edits': 'workspace-write',
      yolo: 'disabled',
    });
  });
});

describe('turn state machine (RT-03)', () => {
  const allStates = TurnStateSchema.options as readonly TurnState[];

  it('declares a transition list for every state, with no gaps', () => {
    for (const s of allStates) {
      expect(TURN_TRANSITIONS[s], `missing transitions for ${s}`).toBeDefined();
    }
  });

  it('makes terminal states genuinely terminal', () => {
    for (const s of TERMINAL_TURN_STATES) {
      expect(isTerminalTurnState(s)).toBe(true);
      expect(TURN_TRANSITIONS[s]).toEqual([]);
      for (const to of allStates) {
        expect(canTransition(s, to), `${s} must not transition to ${to}`).toBe(false);
      }
    }
  });

  it('resumes the SAME turn after approval — approval is not a new user message', () => {
    // This is the invariant in task.md: "Approval pauses and resumes the same turn."
    expect(canTransition('model-streaming', 'awaiting-approval')).toBe(true);
    expect(canTransition('awaiting-approval', 'executing')).toBe(true);
    // There is deliberately no path that ends the turn just because an approval happened.
    expect(canTransition('awaiting-approval', 'completed')).toBe(false);
  });

  it('never transitions to a state outside the declared enum', () => {
    for (const [from, tos] of Object.entries(TURN_TRANSITIONS)) {
      for (const to of tos) {
        expect(allStates, `${from} -> ${to} is not a declared state`).toContain(to);
      }
    }
  });

  it('lets every non-terminal state reach cancellation (RT-06: one abort tree)', () => {
    const nonTerminal = allStates.filter((s) => !isTerminalTurnState(s));
    for (const s of nonTerminal) {
      expect(
        canTransition(s, 'cancelled') || canTransition(s, 'failed'),
        `${s} has no escape to cancelled/failed — work could get stuck`,
      ).toBe(true);
    }
  });

  it('reaches every non-terminal state from somewhere (no orphan states)', () => {
    const reachable = new Set<string>(['preparing']);
    for (const tos of Object.values(TURN_TRANSITIONS)) for (const t of tos) reachable.add(t);
    for (const s of allStates) {
      expect(reachable.has(s), `${s} is unreachable`).toBe(true);
    }
  });
});
