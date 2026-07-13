import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RESERVE_FRACTION,
  computeBudget,
  defaultTokenEstimator,
  estimateItems,
  serializeInputItem,
} from './budget.ts';

const msg = (role, text) => ({ type: 'message', role, text });

describe('token estimation', () => {
  it('estimates ~4 chars per token deterministically', () => {
    expect(defaultTokenEstimator('12345678')).toBe(2); // 8 / 4
    expect(defaultTokenEstimator('123456789')).toBe(3); // ceil(9 / 4)
  });

  it('counts a function-call name and arguments, not just output', () => {
    const call = {
      type: 'function-call',
      callId: 'call_1',
      name: 'read',
      argumentsJson: '{"path":"/x"}',
    };
    expect(serializeInputItem(call)).toContain('read');
    expect(serializeInputItem(call)).toContain('/x');
    expect(estimateItems([call])).toBeGreaterThan(0);
  });
});

describe('computeBudget', () => {
  it('reserves 15% of the window for response + tool overhead', () => {
    const b = computeBudget({ contextWindow: 1000, items: [] });
    expect(b.reserveFraction).toBe(DEFAULT_RESERVE_FRACTION);
    expect(b.reservedTokens).toBe(150);
    expect(b.usableInputBudget).toBe(850);
  });

  it('computes utilization as used / usable', () => {
    // Serialized as "user: " + 400 chars = 406 chars -> ceil(406/4) = 102 tokens. Usable = 850.
    const items = [msg('user', 'x'.repeat(400))];
    const b = computeBudget({ contextWindow: 1000, items });
    expect(b.usedTokens).toBe(102);
    expect(b.availableTokens).toBe(748);
    expect(b.utilization).toBeCloseTo(102 / 850, 6);
    expect(b.overThreshold).toBe(false);
    expect(b.overCapacity).toBe(false);
  });

  it('adds fixed overhead (system prompt, tool schemas) to used tokens', () => {
    const b = computeBudget({ contextWindow: 1000, items: [], fixedOverheadTokens: 200 });
    expect(b.usedTokens).toBe(200);
    expect(b.availableTokens).toBe(650);
  });

  it('reports high utilization and crosses the proactive threshold as it fills', () => {
    // Usable = 850, proactive limit = floor(850 * 0.85) = 722. "user: " + 3000 = 3006 -> 752.
    const nearFull = computeBudget({ contextWindow: 1000, items: [msg('user', 'x'.repeat(3000))] });
    expect(nearFull.usedTokens).toBe(752);
    expect(nearFull.utilization).toBeGreaterThan(0.85);
    expect(nearFull.overThreshold).toBe(true);
    expect(nearFull.overCapacity).toBe(false);
  });

  it('flags over-capacity when input exceeds the usable budget', () => {
    const over = computeBudget({ contextWindow: 1000, items: [msg('user', 'x'.repeat(4000))] });
    expect(over.usedTokens).toBe(1002); // "user: " + 4000 = 4006 -> ceil(4006/4)
    expect(over.overCapacity).toBe(true);
    expect(over.availableTokens).toBe(0);
    expect(over.utilization).toBeGreaterThan(1);
  });
});
