import { describe, expect, it } from 'vitest';

import { UNKNOWN_USAGE, addUsage, type NormalizedUsage } from './usage.ts';

const usage = (over: Partial<NormalizedUsage>): NormalizedUsage => ({ ...UNKNOWN_USAGE, ...over });

describe('NormalizedUsage', () => {
  it('starts entirely unknown rather than zero', () => {
    expect(UNKNOWN_USAGE).toEqual({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      reasoningTokens: null,
      cachedInputTokens: null,
    });
  });

  it('keeps unknown + unknown as unknown, never 0', () => {
    expect(addUsage(UNKNOWN_USAGE, UNKNOWN_USAGE)).toEqual(UNKNOWN_USAGE);
  });

  it('treats a known value plus an unknown one as the known value', () => {
    const sum = addUsage(usage({ inputTokens: 10 }), usage({ outputTokens: 3 }));
    expect(sum.inputTokens).toBe(10);
    expect(sum.outputTokens).toBe(3);
    expect(sum.totalTokens).toBeNull();
  });

  it('adds two known values', () => {
    const sum = addUsage(
      usage({ inputTokens: 10, reasoningTokens: 5 }),
      usage({ inputTokens: 7, reasoningTokens: 2 }),
    );
    expect(sum.inputTokens).toBe(17);
    expect(sum.reasoningTokens).toBe(7);
  });
});
