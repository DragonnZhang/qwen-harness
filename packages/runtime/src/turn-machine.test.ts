import { describe, expect, it } from 'vitest';

import { TurnMachine } from './turn-machine.ts';

describe('TurnMachine', () => {
  it('starts preparing and walks a normal completed turn', () => {
    const m = new TurnMachine();
    expect(m.state).toBe('preparing');

    m.transition('model-streaming');
    m.transition('executing');
    m.transition('model-streaming');
    m.terminate('completed', 'natural-completion');

    expect(m.state).toBe('completed');
    expect(m.isTerminal).toBe(true);
    expect(m.terminationReason).toBe('natural-completion');
    expect(m.history).toEqual([
      'preparing',
      'model-streaming',
      'executing',
      'model-streaming',
      'completed',
    ]);
  });

  it('resumes the same turn after approval (approval is not a new turn)', () => {
    const m = new TurnMachine();
    m.transition('model-streaming');
    m.transition('awaiting-approval');
    m.transition('executing'); // the approval RESUMED the turn
    expect(m.state).toBe('executing');
  });

  it('throws on an illegal transition rather than corrupting the turn', () => {
    const m = new TurnMachine();
    expect(() => m.transition('completed')).toThrow(/illegal turn transition/);
  });

  it('refuses any transition out of a terminal state', () => {
    const m = new TurnMachine();
    m.terminate('failed', 'provider-error');
    expect(() => m.transition('model-streaming')).toThrow(/already terminal/);
    expect(() => m.terminate('completed', 'natural-completion')).toThrow(/already terminal/);
  });

  it('always records a reason when terminating', () => {
    const m = new TurnMachine();
    m.transition('model-streaming');
    m.terminate('budget-exhausted', 'token-limit');
    expect(m.terminationReason).toBe('token-limit');
  });
});
