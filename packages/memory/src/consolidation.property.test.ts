import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { consolidateMemories, type MemoryRecord } from './consolidation.ts';
import type { Memory } from './frontmatter.ts';
import type { MemoryScope } from './scopes.ts';

/**
 * Property test for memory consolidation (MM-04 `P`).
 *
 * Consolidation deduplicates and conflict-resolves an unbounded, user/model-authored memory set, and
 * a later pass must never undo an earlier one. Over arbitrary record sets:
 *   - it is IDEMPOTENT — consolidating the survivors again changes nothing (twice = once);
 *   - each surviving NAME is unique, and the survivors' names are exactly the distinct input names
 *     (nothing invented, nothing dropped) when no staleness window is applied;
 *   - a name's winner is the NEWEST record with that name (newer wins; a tie is broken by specificity
 *     but the kept `updatedAt` still equals the max);
 *   - `kept` is name-sorted.
 */

const specArb = fc.record({
  name: fc.constantFrom('a', 'b', 'c', 'style', 'build'),
  body: fc.string({ maxLength: 10 }),
  updatedAt: fc.integer({ min: 0, max: 1000 }),
});
const listArb = fc.array(specArb, { maxLength: 16 });

function build(
  specs: readonly { name: string; body: string; updatedAt: number }[],
): MemoryRecord[] {
  return specs.map((s, i) => ({
    memory: {
      name: s.name,
      description: `d-${s.name}`,
      type: 'project',
      body: s.body,
    } satisfies Memory,
    provenance: { scope: 'project' as MemoryScope, path: `/mem/${i}.md` },
    updatedAt: s.updatedAt,
  }));
}

describe('consolidateMemories invariants (MM-04 P)', () => {
  it('is idempotent — consolidating the survivors again changes nothing', () => {
    fc.assert(
      fc.property(listArb, (specs) => {
        const once = consolidateMemories(build(specs)).kept;
        const twice = consolidateMemories([...once]).kept;
        expect(twice.map((r) => r.memory.name)).toEqual(once.map((r) => r.memory.name));
        expect(twice.map((r) => r.memory.body)).toEqual(once.map((r) => r.memory.body));
      }),
      { numRuns: 1500 },
    );
  });

  it('keeps each name exactly once — survivors are the distinct input names, name-sorted', () => {
    fc.assert(
      fc.property(listArb, (specs) => {
        const records = build(specs);
        const kept = consolidateMemories(records).kept;
        const keptNames = kept.map((r) => r.memory.name);
        expect(new Set(keptNames).size).toBe(keptNames.length); // unique
        expect(new Set(keptNames)).toEqual(new Set(records.map((r) => r.memory.name))); // nothing lost/invented
        expect([...keptNames]).toEqual([...keptNames].sort()); // name-sorted
      }),
      { numRuns: 1500 },
    );
  });

  it('resolves each name to its newest record (kept updatedAt is the max for that name)', () => {
    fc.assert(
      fc.property(listArb, (specs) => {
        const records = build(specs);
        for (const kept of consolidateMemories(records).kept) {
          const maxForName = Math.max(
            ...records.filter((r) => r.memory.name === kept.memory.name).map((r) => r.updatedAt),
          );
          expect(kept.updatedAt).toBe(maxForName);
        }
      }),
      { numRuns: 1500 },
    );
  });
});
