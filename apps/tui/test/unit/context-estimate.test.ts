import type { Item } from '@qwen-harness/protocol';
import { describe, expect, it } from 'vitest';

import { estimateContextTokens } from '../../src/context-estimate.ts';

/**
 * The status-line context estimate (CX-01, unit).
 *
 * The number the TUI surfaces as `<n> ctx`: null when there is nothing to report (so the indicator
 * stays hidden), a positive measured-serialized-size estimate otherwise, monotonic as the transcript
 * grows, and deterministic.
 */

const item = (id: string, text: string): Item =>
  ({
    id,
    turnId: 'trn_0001',
    threadId: 'thr_0001',
    seq: 1,
    createdAt: 0,
    type: 'user-message',
    text,
  }) as Item;

describe('estimateContextTokens (CX-01)', () => {
  it('is null for an empty transcript — the indicator stays hidden', () => {
    expect(estimateContextTokens([])).toBeNull();
  });

  it('is a positive token estimate once there is context, and deterministic', () => {
    const items = [item('a', 'hello world')];
    const est = estimateContextTokens(items);
    expect(est).not.toBeNull();
    expect(est!).toBeGreaterThan(0);
    expect(estimateContextTokens(items)).toBe(est); // deterministic
  });

  it('never shrinks as the transcript grows (utilization only rises)', () => {
    const one = estimateContextTokens([item('a', 'first message here')])!;
    const two = estimateContextTokens([
      item('a', 'first message here'),
      item('b', 'a second, longer message with more content'),
    ])!;
    expect(two).toBeGreaterThanOrEqual(one);
  });
});
