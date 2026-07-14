import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  RETRIEVAL_MAX_BYTES,
  RETRIEVAL_MAX_FILES,
  retrieve,
  type MemoryCandidate,
} from './retrieval.ts';
import type { MemoryScope } from './scopes.ts';

/**
 * Property test for memory retrieval (MM-02 `P`).
 *
 * Retrieval runs on every turn against an unbounded, user-authored memory set, so over ANY candidate
 * list it must stay within budget, stay deterministic, and never let one bad file abort the result:
 *   - the per-turn budgets (5 files / 50 KiB) are NEVER exceeded;
 *   - one unreadable candidate (its body read throws) is isolated — retrieval still returns, and the
 *     unreadable memory is never included in the results;
 *   - retrieval is deterministic (identical input → identical ordered result).
 */

/** Each spec becomes a candidate that side-selects on the shared query, with a body of some size. */
const specArb = fc.record({
  body: fc.string({ maxLength: 30_000 }), // a few of these exceed the 50 KiB byte budget together
  throws: fc.boolean(),
});
const listArb = fc.array(specArb, { maxLength: 12 });

function build(specs: readonly { body: string; throws: boolean }[]): MemoryCandidate[] {
  return specs.map((s, i) => ({
    name: `m${i}`,
    description: 'shared topic', // every candidate side-selects on the query below
    type: 'reference',
    scope: 'project' as MemoryScope,
    path: `/mem/m${i}.md`,
    readBody: s.throws
      ? () => {
          throw new Error('unreadable');
        }
      : () => s.body,
  }));
}

const QUERY = 'shared topic';

describe('retrieve invariants (MM-02 P)', () => {
  it('never exceeds the 5-file / 50 KiB per-turn budgets', () => {
    fc.assert(
      fc.property(listArb, (specs) => {
        const r = retrieve(QUERY, build(specs));
        expect(r.usedFiles).toBeLessThanOrEqual(RETRIEVAL_MAX_FILES);
        expect(r.usedBytes).toBeLessThanOrEqual(RETRIEVAL_MAX_BYTES);
        expect(r.memories.length).toBeLessThanOrEqual(RETRIEVAL_MAX_FILES);
      }),
      { numRuns: 1500 },
    );
  });

  it('isolates an unreadable candidate — retrieval still returns and never includes it', () => {
    fc.assert(
      fc.property(listArb, (specs) => {
        const cands = build(specs);
        const r = retrieve(QUERY, cands); // must not throw even when a readBody throws
        // No included memory corresponds to a throwing candidate.
        for (const m of r.memories) {
          const idx = Number(m.name.slice(1));
          expect(specs[idx]?.throws).not.toBe(true);
        }
      }),
      { numRuns: 1500 },
    );
  });

  it('is deterministic — identical input yields identical ordered results', () => {
    fc.assert(
      fc.property(listArb, (specs) => {
        const a = retrieve(QUERY, build(specs)).memories.map((m) => m.name);
        const b = retrieve(QUERY, build(specs)).memories.map((m) => m.name);
        expect(a).toEqual(b);
      }),
      { numRuns: 1000 },
    );
  });
});
