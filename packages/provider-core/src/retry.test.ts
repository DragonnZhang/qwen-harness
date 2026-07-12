import { harnessError } from '@qwen-harness/protocol';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RETRY_POLICY,
  backoffBoundMs,
  decideRetry,
  fullJitterDelayMs,
  type Rng,
} from './retry.ts';

/** A deterministic RNG: replays a fixed sequence, then repeats the last value. */
function seq(values: number[]): Rng {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] ?? 0;
}

const transient = (over: Partial<Parameters<typeof harnessError>[0]> = {}) =>
  harnessError({
    origin: 'provider',
    category: 'provider.rate_limit.throttling',
    message: 'slow down',
    retryable: true,
    ...over,
  });

describe('frozen defaults', () => {
  it('matches docs/product/defaults.md exactly', () => {
    expect(DEFAULT_RETRY_POLICY).toEqual({
      maxAttempts: 10,
      maxElapsedMs: 300_000,
      baseDelayMs: 500,
      maxDelayMs: 30_000,
      honorServerHint: true,
    });
  });

  it('is frozen so a caller cannot widen the budget at runtime', () => {
    expect(Object.isFrozen(DEFAULT_RETRY_POLICY)).toBe(true);
  });
});

describe('backoffBoundMs', () => {
  it('doubles from the base and saturates at the cap', () => {
    const bounds = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) =>
      backoffBoundMs(DEFAULT_RETRY_POLICY, n),
    );
    expect(bounds).toEqual([500, 1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000, 30_000]);
  });
});

describe('fullJitterDelayMs', () => {
  it('stays within [0, min(cap, base * 2^n)] for every attempt and every rng value', () => {
    const samples = [0, 0.0001, 0.25, 0.5, 0.75, 0.999999];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const bound = backoffBoundMs(DEFAULT_RETRY_POLICY, attempt);
      for (const r of samples) {
        const delay = fullJitterDelayMs(DEFAULT_RETRY_POLICY, attempt, () => r);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(bound);
      }
    }
  });

  it('is FULL jitter: rng 0 yields 0, rng near 1 yields the whole bound', () => {
    expect(fullJitterDelayMs(DEFAULT_RETRY_POLICY, 3, () => 0)).toBe(0);
    expect(fullJitterDelayMs(DEFAULT_RETRY_POLICY, 3, () => 0.9999999)).toBe(4000);
  });

  it('rejects an rng outside [0, 1) rather than silently producing a negative delay', () => {
    expect(() => fullJitterDelayMs(DEFAULT_RETRY_POLICY, 0, () => 1)).toThrow(RangeError);
    expect(() => fullJitterDelayMs(DEFAULT_RETRY_POLICY, 0, () => -0.5)).toThrow(RangeError);
  });
});

describe('decideRetry', () => {
  it('retries a transient error with a jittered delay inside the bound', () => {
    const decision = decideRetry(transient(), { attempt: 1, elapsedMs: 0 }, seq([0.5]));
    expect(decision).toEqual({ retry: true, delayMs: 250 });
  });

  it('honors an explicit server hint over its own backoff', () => {
    const decision = decideRetry(
      transient({ retryAfterMs: 12_000 }),
      { attempt: 1, elapsedMs: 0 },
      seq([0.5]),
    );
    expect(decision).toEqual({ retry: true, delayMs: 12_000 });
  });

  it('stops at the 10th attempt', () => {
    expect(decideRetry(transient(), { attempt: 9, elapsedMs: 0 }, seq([0]))).toEqual({
      retry: true,
      delayMs: 0,
    });
    expect(decideRetry(transient(), { attempt: 10, elapsedMs: 0 }, seq([0]))).toEqual({
      retry: false,
      reason: 'attempts-exhausted',
    });
  });

  it('stops at the 5-minute wall even with attempts left', () => {
    expect(decideRetry(transient(), { attempt: 2, elapsedMs: 300_000 }, seq([0]))).toEqual({
      retry: false,
      reason: 'time-exhausted',
    });
  });

  it('refuses a server hint that would push past the 5-minute wall', () => {
    expect(
      decideRetry(
        transient({ retryAfterMs: 120_000 }),
        { attempt: 2, elapsedMs: 240_000 },
        seq([0]),
      ),
    ).toEqual({ retry: false, reason: 'time-exhausted' });
  });

  it('never retries after visible output was emitted (PV-11)', () => {
    expect(
      decideRetry(
        transient({ visibleOutputEmitted: true }),
        { attempt: 1, elapsedMs: 0 },
        seq([0.5]),
      ),
    ).toEqual({ retry: false, reason: 'visible-output-emitted' });
  });

  it('never retries a user-action-required error even when marked retryable', () => {
    expect(
      decideRetry(
        transient({ userActionRequired: true }),
        { attempt: 1, elapsedMs: 0 },
        seq([0.5]),
      ),
    ).toEqual({ retry: false, reason: 'user-action-required' });
  });

  it('never retries a non-retryable error', () => {
    expect(
      decideRetry(
        harnessError({ origin: 'provider', category: 'provider.auth.invalid_key', message: 'no' }),
        { attempt: 1, elapsedMs: 0 },
        seq([0.5]),
      ),
    ).toEqual({ retry: false, reason: 'not-retryable' });
  });

  it('never retries when a side effect may already have happened', () => {
    expect(
      decideRetry(
        transient({ sideEffectCertainty: 'indeterminate' }),
        { attempt: 1, elapsedMs: 0 },
        seq([0.5]),
      ),
    ).toEqual({ retry: false, reason: 'side-effect-uncertain' });
  });

  it('a full 10-attempt sequence stays bounded and terminates', () => {
    const rng = seq([0.99999999]); // always the top of the jitter window
    const delays: number[] = [];
    let elapsed = 0;
    let attempt = 1;
    for (;;) {
      const decision = decideRetry(transient(), { attempt, elapsedMs: elapsed }, rng);
      if (!decision.retry) {
        expect(decision.reason).toBe('attempts-exhausted');
        break;
      }
      delays.push(decision.delayMs);
      elapsed += decision.delayMs;
      attempt += 1;
    }
    // Nine retries after the first attempt, worst case, all inside the 5-minute budget.
    expect(delays).toHaveLength(9);
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000]);
    expect(elapsed).toBeLessThan(DEFAULT_RETRY_POLICY.maxElapsedMs);
    expect(attempt).toBe(10);
  });
});
