/**
 * Property test for the tool-call scheduler (TL-08 `P`).
 *
 * `planBatches` partitions a round's calls into ordered batches. Over ARBITRARY call lists — random
 * read/write mixes, random footprints, random annotations — four invariants must always hold:
 *
 *   1. ORDER + TOTALITY: flattening the batches reproduces the input calls, in the same order, with
 *      none lost and none duplicated. A call the model emitted is neither dropped nor reordered.
 *   2. PARALLEL SAFETY: any batch with more than one call contains only mutually NON-conflicting,
 *      read-only, bounded calls — exactly the ones safe to run at once.
 *   3. MUTATION ISOLATION: a mutating, unbounded, or destructive call is never batched with anything;
 *      it sits alone in a serial batch.
 *   4. BOUNDED WIDTH: no batch exceeds `maxParallel`.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { conflicts, planBatches, type PlannedCall } from './scheduler.ts';

const PATHS = ['/w/a', '/w/b', '/w/c'];

const footprint = fc.record({
  reads: fc.subarray(PATHS, { minLength: 0 }),
  writes: fc.subarray(PATHS, { minLength: 0 }),
  unbounded: fc.boolean(),
});

const annotations = fc.record({
  readOnly: fc.boolean(),
  destructive: fc.boolean(),
  idempotent: fc.boolean(),
  openWorld: fc.boolean(),
});

/** A list of PlannedCalls with unique call ids (`call_0`, `call_1`, …). */
const callList = fc
  .array(
    fc.record({
      toolName: fc.constantFrom('read_file', 'write_file', 'run_shell'),
      annotations,
      footprint,
    }),
    {
      maxLength: 14,
    },
  )
  .map((specs): PlannedCall[] =>
    specs.map((s, i) => ({
      callId: `call_${i}` as never,
      toolName: s.toolName,
      annotations: s.annotations,
      footprint: s.footprint,
    })),
  );

const isSafeParallel = (c: PlannedCall): boolean =>
  c.annotations.readOnly && !c.annotations.destructive && !c.footprint.unbounded;

describe('planBatches invariants (TL-08 P)', () => {
  it('preserves original order and loses/duplicates nothing', () => {
    fc.assert(
      fc.property(callList, fc.integer({ min: 1, max: 8 }), (calls, maxParallel) => {
        const flat = planBatches(calls, { maxParallel }).flatMap((b) =>
          b.calls.map((c) => c.callId),
        );
        expect(flat).toEqual(calls.map((c) => c.callId));
      }),
      { numRuns: 1500 },
    );
  });

  it('never places two conflicting or non-parallelizable calls in one batch', () => {
    fc.assert(
      fc.property(callList, fc.integer({ min: 1, max: 8 }), (calls, maxParallel) => {
        for (const batch of planBatches(calls, { maxParallel })) {
          if (batch.calls.length <= 1) continue;
          // A multi-call batch: every member is safe-parallel and no pair conflicts.
          for (const c of batch.calls) expect(isSafeParallel(c)).toBe(true);
          for (let i = 0; i < batch.calls.length; i++) {
            for (let j = i + 1; j < batch.calls.length; j++) {
              expect(conflicts(batch.calls[i]!, batch.calls[j]!)).toBe(false);
            }
          }
        }
      }),
      { numRuns: 1500 },
    );
  });

  it('isolates every mutating/unbounded/destructive call in its own batch', () => {
    fc.assert(
      fc.property(callList, fc.integer({ min: 1, max: 8 }), (calls, maxParallel) => {
        for (const batch of planBatches(calls, { maxParallel })) {
          if (batch.calls.some((c) => !isSafeParallel(c))) {
            expect(batch.calls).toHaveLength(1);
          }
        }
      }),
      { numRuns: 1500 },
    );
  });

  it('never exceeds maxParallel in any batch', () => {
    fc.assert(
      fc.property(callList, fc.integer({ min: 1, max: 8 }), (calls, maxParallel) => {
        for (const batch of planBatches(calls, { maxParallel })) {
          expect(batch.calls.length).toBeLessThanOrEqual(maxParallel);
        }
      }),
      { numRuns: 1500 },
    );
  });
});
