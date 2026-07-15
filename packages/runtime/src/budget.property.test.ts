import { TerminationReasonSchema } from '@qwen-harness/protocol';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { BudgetTracker, DEFAULT_BUDGET, type BudgetLimits, type BudgetVerdict } from './budget.ts';

/**
 * RT-04 as a PROPERTY: every stop is a TYPED, enumerable reason, and each distinct pathology maps to
 * its own reason.
 *
 * `budget.test.ts` pins the specific limits with fixed numbers. This proves the invariant across the
 * whole input space: whatever sequence of model calls, tool calls, retries, idle rounds, repeated
 * calls, and elapsed time a run produces, a `stop` verdict NEVER carries an untyped or off-enum
 * reason string — the thing that would let an untyped reason leak into a durable `turn-ended` event
 * (exactly the `hook-stopped` vs `hook-stop` class of bug). It also pins the pathology→reason map:
 * a stuck loop is reported as stuck, not merely as "too long".
 */

// A clock we advance explicitly; time is injected so "8 hours" is a microsecond test.
function trackerWith(limits: BudgetLimits): { t: BudgetTracker; advance: (ms: number) => void } {
  let now = 0;
  const t = new BudgetTracker(limits, () => now);
  return { t, advance: (ms) => (now += ms) };
}

const isTyped = (v: BudgetVerdict): boolean =>
  !v.stop || TerminationReasonSchema.safeParse(v.reason).success;

describe('BudgetTracker — every stop is a typed TerminationReason (RT-04, P)', () => {
  type Op =
    | { readonly t: 'model' }
    | { readonly t: 'tool' }
    | { readonly t: 'retry' }
    | { readonly t: 'round'; readonly progress: boolean }
    | { readonly t: 'observe'; readonly sig: string }
    | { readonly t: 'advance'; readonly ms: number };

  const op: fc.Arbitrary<Op> = fc.oneof(
    fc.constant({ t: 'model' as const }),
    fc.constant({ t: 'tool' as const }),
    fc.constant({ t: 'retry' as const }),
    fc.record({ t: fc.constant('round' as const), progress: fc.boolean() }),
    // A tiny signature alphabet so identical repeats actually occur.
    fc.record({ t: fc.constant('observe' as const), sig: fc.constantFrom('a', 'b', 'c') }),
    fc.record({ t: fc.constant('advance' as const), ms: fc.integer({ min: 0, max: 60_000 }) }),
  );

  function apply(t: BudgetTracker, advance: (ms: number) => void, o: Op): BudgetVerdict {
    switch (o.t) {
      case 'model':
        return t.beforeModelCall();
      case 'tool':
        return t.beforeToolCall();
      case 'retry':
        return t.recordRetry();
      case 'round':
        return t.afterModelRound({ madeProgress: o.progress });
      case 'observe':
        return t.observeToolCall(o.sig, '{}');
      case 'advance':
        advance(o.ms);
        return { stop: false };
    }
  }

  it('no operation sequence ever yields an untyped or off-enum stop reason', () => {
    fc.assert(
      fc.property(
        fc.record({
          maxTurns: fc.integer({ min: 1, max: 50 }),
          maxModelCallsPerTurn: fc.integer({ min: 1, max: 20 }),
          maxToolCallsPerTurn: fc.integer({ min: 1, max: 20 }),
          maxWallMs: fc.integer({ min: 1, max: 100_000 }),
          maxRetries: fc.integer({ min: 1, max: 20 }),
          maxNoProgressRounds: fc.integer({ min: 1, max: 10 }),
          maxRepeatedIdenticalCalls: fc.integer({ min: 1, max: 10 }),
        }),
        fc.array(op, { maxLength: 200 }),
        (limits, ops) => {
          const { t, advance } = trackerWith(limits);
          for (const o of ops) {
            const v = apply(t, advance, o);
            expect(isTyped(v)).toBe(true);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('is deterministic: the same limits and ops produce the same verdict sequence', () => {
    fc.assert(
      fc.property(fc.array(op, { maxLength: 120 }), (ops) => {
        const runOnce = (): BudgetVerdict[] => {
          const { t, advance } = trackerWith(DEFAULT_BUDGET);
          return ops.map((o) => apply(t, advance, o));
        };
        expect(runOnce()).toEqual(runOnce());
      }),
      { numRuns: 200 },
    );
  });
});

describe('BudgetTracker — each pathology maps to its OWN reason (RT-04, P)', () => {
  it('N identical consecutive tool calls stop with repeated-identical-calls', () => {
    // The first call SEEDS the signature (one call is not yet a repeat), so detection needs the
    // threshold to be at least 2 — which is why the default is 3. At the n-th identical call the
    // count reaches n and the run is declared stuck.
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 8 }), (n) => {
        const { t } = trackerWith({ ...DEFAULT_BUDGET, maxRepeatedIdenticalCalls: n });
        let last: BudgetVerdict = { stop: false };
        for (let i = 0; i < n - 1; i++) {
          last = t.observeToolCall('grep', '{"q":"x"}');
          expect(last).toEqual({ stop: false }); // not yet stuck
        }
        last = t.observeToolCall('grep', '{"q":"x"}');
        expect(last).toEqual({ stop: true, reason: 'repeated-identical-calls' });
      }),
      { numRuns: 50 },
    );
  });

  it('N idle rounds stop with no-progress', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 8 }), (n) => {
        const { t } = trackerWith({ ...DEFAULT_BUDGET, maxNoProgressRounds: n });
        let last: BudgetVerdict = { stop: false };
        for (let i = 0; i < n; i++) last = t.afterModelRound({ madeProgress: false });
        expect(last).toEqual({ stop: true, reason: 'no-progress' });
      }),
      { numRuns: 50 },
    );
  });

  it('exceeding the model-call limit stops with model-call-limit', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 15 }), (n) => {
        const { t } = trackerWith({ ...DEFAULT_BUDGET, maxModelCallsPerTurn: n });
        for (let i = 0; i < n; i++) expect(t.beforeModelCall()).toEqual({ stop: false });
        expect(t.beforeModelCall()).toEqual({ stop: true, reason: 'model-call-limit' });
      }),
      { numRuns: 50 },
    );
  });

  it('elapsed time past the wall limit stops with time-limit', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100_000 }), (ms) => {
        const { t, advance } = trackerWith({ ...DEFAULT_BUDGET, maxWallMs: ms });
        advance(ms);
        expect(t.beforeModelCall()).toEqual({ stop: true, reason: 'time-limit' });
      }),
      { numRuns: 50 },
    );
  });

  it('retries past the retry limit stop with retry-limit', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 15 }), (n) => {
        const { t } = trackerWith({ ...DEFAULT_BUDGET, maxRetries: n });
        for (let i = 0; i < n; i++) expect(t.recordRetry()).toEqual({ stop: false });
        expect(t.recordRetry()).toEqual({ stop: true, reason: 'retry-limit' });
      }),
      { numRuns: 50 },
    );
  });
});
