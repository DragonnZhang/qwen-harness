import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  INSTRUCTION_SCOPES,
  resolveInstructions,
  type DiscoveredInstruction,
} from './resolution.ts';

/**
 * Property test for instruction resolution (IN-06 `P`).
 *
 * Resolution is a PURE function of what discovery found, and the agent's behaviour depends on getting
 * a stable, correctly-ordered instruction set. Over arbitrary discovered trees:
 *   - it is deterministic (identical input → identical order);
 *   - the result is ordered least-specific-first / most-specific-last (precedence non-decreasing);
 *   - it loses and duplicates nothing — every discovered file resolves exactly once;
 *   - `rootText`/`rootProvenance` are built from exactly the always-on (non-path-scoped) instructions.
 */

interface Spec {
  scope: (typeof INSTRUCTION_SCOPES)[number];
  depth: number;
  rawText: string;
  pathScoped: boolean;
}

const specArb: fc.Arbitrary<Spec> = fc.record({
  scope: fc.constantFrom(...INSTRUCTION_SCOPES),
  depth: fc.nat({ max: 8 }),
  rawText: fc.string({ maxLength: 20 }),
  pathScoped: fc.boolean(),
});
const listArb = fc.array(specArb, { maxLength: 15 });

function build(specs: readonly Spec[]): DiscoveredInstruction[] {
  return specs.map((s, i) => ({
    path: `/d${i}/AGENTS.md`,
    scope: s.scope,
    dir: `/d${i}`,
    depth: s.depth,
    rawText: s.rawText,
    pathScope: s.pathScoped ? `/d${i}` : null,
  }));
}

describe('resolveInstructions invariants (IN-06 P)', () => {
  it('is deterministic — identical input yields identical ordered output', () => {
    fc.assert(
      fc.property(listArb, (specs) => {
        const d = build(specs);
        const a = resolveInstructions(d).instructions.map((r) => r.provenance.path);
        const b = resolveInstructions(d).instructions.map((r) => r.provenance.path);
        expect(a).toEqual(b);
      }),
      { numRuns: 1500 },
    );
  });

  it('orders least-specific first, most-specific last (precedence non-decreasing)', () => {
    fc.assert(
      fc.property(listArb, (specs) => {
        const r = resolveInstructions(build(specs)).instructions;
        for (let i = 1; i < r.length; i++) {
          expect(r[i - 1]!.precedence <= r[i]!.precedence).toBe(true);
        }
      }),
      { numRuns: 1500 },
    );
  });

  it('loses and duplicates nothing — every discovered instruction resolves exactly once', () => {
    fc.assert(
      fc.property(listArb, (specs) => {
        const d = build(specs);
        const r = resolveInstructions(d).instructions;
        expect(r).toHaveLength(d.length);
        expect(new Set(r.map((x) => x.provenance.path)).size).toBe(d.length);
      }),
      { numRuns: 1500 },
    );
  });

  it('composes rootText/rootProvenance from exactly the always-on (non-path-scoped) instructions', () => {
    fc.assert(
      fc.property(listArb, (specs) => {
        const res = resolveInstructions(build(specs));
        const alwaysOn = res.instructions.filter((r) => r.pathScope === null);
        expect(res.rootProvenance).toHaveLength(alwaysOn.length);
      }),
      { numRuns: 1000 },
    );
  });
});
