import { ManualClock } from '@qwen-harness/protocol';
import { describe, expect, it } from 'vitest';

import { BudgetTracker, DEFAULT_BUDGET, type BudgetLimits } from './budget.ts';

function tracker(overrides: Partial<BudgetLimits> = {}) {
  const clock = new ManualClock(0);
  const t = new BudgetTracker({ ...DEFAULT_BUDGET, ...overrides }, () => clock.now());
  return { t, clock };
}

describe('BudgetTracker', () => {
  it('stops at the model-call limit with a named reason', () => {
    const { t } = tracker({ maxModelCallsPerTurn: 2 });
    expect(t.beforeModelCall().stop).toBe(false);
    expect(t.beforeModelCall().stop).toBe(false);
    const v = t.beforeModelCall();
    expect(v).toEqual({ stop: true, reason: 'model-call-limit' });
  });

  it('stops at the wall-clock limit (deterministic via injected clock)', () => {
    const { t, clock } = tracker({ maxWallMs: 1000 });
    expect(t.beforeModelCall().stop).toBe(false);
    clock.advance(1000);
    expect(t.beforeModelCall()).toEqual({ stop: true, reason: 'time-limit' });
  });

  it('stops at the tool-call limit', () => {
    const { t } = tracker({ maxToolCallsPerTurn: 1 });
    expect(t.beforeToolCall().stop).toBe(false);
    expect(t.beforeToolCall()).toEqual({ stop: true, reason: 'tool-call-limit' });
  });

  it('stops after too many retries', () => {
    const { t } = tracker({ maxRetries: 2 });
    expect(t.recordRetry().stop).toBe(false);
    expect(t.recordRetry().stop).toBe(false);
    expect(t.recordRetry()).toEqual({ stop: true, reason: 'retry-limit' });
  });

  it('detects a no-progress loop distinctly from a call limit', () => {
    const { t } = tracker({ maxNoProgressRounds: 2 });
    expect(t.afterModelRound({ madeProgress: false }).stop).toBe(false);
    expect(t.afterModelRound({ madeProgress: false })).toEqual({
      stop: true,
      reason: 'no-progress',
    });
  });

  it('resets the no-progress counter when progress is made', () => {
    const { t } = tracker({ maxNoProgressRounds: 2 });
    t.afterModelRound({ madeProgress: false });
    t.afterModelRound({ madeProgress: true }); // progress! counter resets
    expect(t.afterModelRound({ madeProgress: false }).stop).toBe(false);
  });

  it('detects identical repeated tool calls', () => {
    const { t } = tracker({ maxRepeatedIdenticalCalls: 3 });
    const call = () => t.observeToolCall('write_file', '{"path":"a.ts"}');
    expect(call().stop).toBe(false);
    expect(call().stop).toBe(false);
    expect(call()).toEqual({ stop: true, reason: 'repeated-identical-calls' });
  });

  it('does not flag DIFFERENT calls as repeats', () => {
    const { t } = tracker({ maxRepeatedIdenticalCalls: 2 });
    expect(t.observeToolCall('write', '{"path":"a"}').stop).toBe(false);
    expect(t.observeToolCall('write', '{"path":"b"}').stop).toBe(false);
    expect(t.observeToolCall('write', '{"path":"c"}').stop).toBe(false);
  });

  it('reports a running snapshot', () => {
    const { t, clock } = tracker();
    t.beforeModelCall();
    t.beforeToolCall();
    clock.advance(500);
    expect(t.snapshot()).toMatchObject({ modelCalls: 1, toolCalls: 1, elapsedMs: 500 });
  });
});
