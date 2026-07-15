import type { ModelInputItem } from '@qwen-harness/provider-core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { computeBudget, defaultTokenEstimator, estimateItems } from './budget.ts';

/**
 * The context budget as a PROPERTY (CX-01).
 *
 * `compaction.test.ts` pins specific transcripts; this proves the budget arithmetic holds across the
 * whole space of windows, reserve fractions, overheads, and transcripts. The load-bearing invariants:
 * response/tool headroom is ALWAYS withheld (reserve + usable = window exactly), `available` is never
 * negative, utilization is the measured used/usable, overflow implies over-threshold, and adding
 * content never lowers utilization — so an honest "how full is the context" reading can never drift
 * below the truth.
 */

const message = (): fc.Arbitrary<ModelInputItem> =>
  fc.record({
    type: fc.constant('message' as const),
    role: fc.constantFrom('user' as const, 'assistant' as const),
    text: fc.string({ maxLength: 200 }),
  });

describe('computeBudget invariants (CX-01, P)', () => {
  const anyInput = fc.record({
    contextWindow: fc.integer({ min: 0, max: 2_000_000 }),
    reserveFraction: fc.double({ min: 0, max: 1, noNaN: true }),
    items: fc.array(message(), { maxLength: 40 }),
    fixedOverheadTokens: fc.integer({ min: 0, max: 200_000 }),
  });

  it('holds every structural invariant for any window/reserve/overhead/transcript', () => {
    fc.assert(
      fc.property(anyInput, (input) => {
        const b = computeBudget(input);

        // Headroom is real: the reserve + usable split is EXACT against the window, and neither part
        // is negative — response/tool space is never silently spent.
        expect(b.reservedTokens).toBeGreaterThanOrEqual(0);
        expect(b.usableInputBudget).toBeGreaterThanOrEqual(0);
        expect(b.reservedTokens + b.usableInputBudget).toBe(b.contextWindow);
        expect(b.usableInputBudget).toBeLessThanOrEqual(b.contextWindow);

        // Availability is measured and never negative.
        expect(b.availableTokens).toBe(Math.max(0, b.usableInputBudget - b.usedTokens));
        expect(b.availableTokens).toBeGreaterThanOrEqual(0);

        // Utilization is exactly used/usable (Infinity only when there is no usable budget at all).
        if (b.usableInputBudget > 0) {
          expect(b.utilization).toBeCloseTo(b.usedTokens / b.usableInputBudget, 10);
        } else {
          expect(b.utilization).toBe(b.usedTokens === 0 ? Number.POSITIVE_INFINITY : Infinity);
        }

        // The proactive limit sits within the usable budget, and the flags mean what they say.
        expect(b.proactiveLimitTokens).toBeLessThanOrEqual(b.usableInputBudget);
        expect(b.overThreshold).toBe(b.usedTokens >= b.proactiveLimitTokens);
        expect(b.overCapacity).toBe(b.usedTokens > b.usableInputBudget);
        // Overflow always implies over-threshold — you cannot exceed capacity while looking "fine".
        if (b.overCapacity) expect(b.overThreshold).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it('is deterministic: the same input yields an identical breakdown', () => {
    fc.assert(
      fc.property(anyInput, (input) => {
        expect(computeBudget(input)).toEqual(computeBudget(input));
      }),
      { numRuns: 200 },
    );
  });

  it('adding content never lowers used tokens or utilization (monotonic)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2_000_000 }),
        fc.array(message(), { maxLength: 20 }),
        message(),
        (contextWindow, items, extra) => {
          const before = computeBudget({ contextWindow, items });
          const after = computeBudget({ contextWindow, items: [...items, extra] });
          expect(after.usedTokens).toBeGreaterThanOrEqual(before.usedTokens);
          expect(after.utilization).toBeGreaterThanOrEqual(before.utilization);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('estimateItems measures serialized size (CX-01, P)', () => {
  it('an empty transcript is zero; a non-empty one is strictly positive and deterministic', () => {
    expect(estimateItems([])).toBe(0);
    fc.assert(
      fc.property(fc.array(message(), { minLength: 1, maxLength: 30 }), (items) => {
        const est = estimateItems(items);
        expect(est).toBe(estimateItems(items)); // deterministic
        // Serializing includes the role/wrapper, so even all-empty texts weigh something.
        expect(est).toBeGreaterThan(0);
        // The default estimator is the injected default — no hidden second code path.
        expect(estimateItems(items, defaultTokenEstimator)).toBe(est);
      }),
      { numRuns: 200 },
    );
  });
});
