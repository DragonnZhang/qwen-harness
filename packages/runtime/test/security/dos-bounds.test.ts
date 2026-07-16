import { ManualClock } from '@qwen-harness/protocol';
import { describe, expect, it } from 'vitest';

import { BudgetTracker, DEFAULT_BUDGET } from '../../src/budget.ts';

/**
 * A turn cannot be driven into unbounded cost or wall-clock (ER-06, S).
 *
 * The adversary is a model (or a compromised provider) that never stops asking for work. Every axis
 * that could otherwise be spent without limit — model calls, tool calls, wall-clock — has a hard cap
 * that fires with a NAMED reason, so a cost/time denial-of-service is stopped, not merely slowed. No
 * cap can be silently raised: the limits are the frozen defaults.
 */

describe('the budget bounds a cost/time denial-of-service (ER-06, S)', () => {
  it('caps runaway model calls with model-call-limit', () => {
    const clock = new ManualClock(0);
    const t = new BudgetTracker({ ...DEFAULT_BUDGET, maxModelCallsPerTurn: 5 }, () => clock.now());
    // Five calls are permitted; the sixth attempt is refused with the specific reason.
    for (let i = 0; i < 5; i += 1) expect(t.beforeModelCall().stop).toBe(false);
    const verdict = t.beforeModelCall();
    expect(verdict.stop && verdict.reason).toBe('model-call-limit');
  });

  it('caps runaway tool calls with tool-call-limit', () => {
    const clock = new ManualClock(0);
    const t = new BudgetTracker({ ...DEFAULT_BUDGET, maxToolCallsPerTurn: 3 }, () => clock.now());
    for (let i = 0; i < 3; i += 1) expect(t.beforeToolCall().stop).toBe(false);
    const verdict = t.beforeToolCall();
    expect(verdict.stop && verdict.reason).toBe('tool-call-limit');
  });

  it('caps wall-clock with time-limit, however many calls are attempted', () => {
    const clock = new ManualClock(0);
    const t = new BudgetTracker({ ...DEFAULT_BUDGET, maxWallMs: 1_000 }, () => clock.now());
    expect(t.beforeModelCall().stop).toBe(false);
    clock.advance(1_000);
    const verdict = t.beforeModelCall();
    expect(verdict.stop && verdict.reason).toBe('time-limit');
  });
});
