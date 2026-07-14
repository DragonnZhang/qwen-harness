/**
 * HK-03 / HK-04 — generative properties over the hook-outcome fold.
 *
 * HK-03: a hook's OUTPUT effect is applied exactly as declared. A `block` blocks and denies; a
 *   `modify` proposes and demands revalidation; `context` injects (attributed & sanitized);
 *   `annotate` annotates; `deny`/`ask` restrict; `allow`/`passthrough` are inert; `continue` is a
 *   no-op. For every randomly generated outcome the resulting effect is precisely the declared one.
 *
 * HK-04: the fold can only ever RESTRICT. For every (base decision, set of hook outcomes) pair the
 *   folded decision is >= the base on the restrictiveness ladder, an `allow`/`passthrough` can never
 *   loosen a deny or an ask, and a `modify` never changes the decision but always forces
 *   revalidation. These are the non-bypassable security invariants, so the runs are cranked up.
 */
import { ManualClock } from '@qwen-harness/protocol';
import type { DecisionOutcome } from '@qwen-harness/policy';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { HookEngine } from './engine.ts';
import { HookOutcomes, type HookOutcome } from './outcome.ts';
import { HookRegistry, type FunctionHandler } from './registry.ts';

function fnHandler(run: FunctionHandler['run']): FunctionHandler {
  return { kind: 'function', run };
}

function makeEngine(): { engine: HookEngine; registry: HookRegistry } {
  const registry = new HookRegistry();
  const engine = new HookEngine({ registry, clock: new ManualClock(), defaultTimeoutMs: 1_000 });
  return { engine, registry };
}

function always(registry: HookRegistry, id: string, outcome: HookOutcome): void {
  registry.register({ id, event: 'PreToolUse', handler: fnHandler(() => outcome) });
}

/** The restrictiveness ladder the fold walks upward. `allow`/`passthrough` sit at the bottom. */
const rank: Record<DecisionOutcome, number> = { passthrough: 0, allow: 0, ask: 1, deny: 2 };

const baseArb = fc.constantFrom<DecisionOutcome>('allow', 'passthrough', 'ask', 'deny');
const reasonText = fc.string({ maxLength: 40 });
const codeArb = fc.string({ minLength: 1, maxLength: 20 });

/** A generator over EVERY hook outcome variant. */
const outcomeArb: fc.Arbitrary<HookOutcome> = fc.oneof(
  fc.constant(HookOutcomes.continue()),
  fc.tuple(codeArb, reasonText).map(([c, m]) => HookOutcomes.block(c, m)),
  reasonText.map((t) => HookOutcomes.context(t)),
  fc
    .dictionary(
      fc.string({ minLength: 1, maxLength: 8 }),
      fc.oneof(fc.string(), fc.integer(), fc.boolean()),
    )
    .map((d) => HookOutcomes.modify(d)),
  reasonText.map((m) => HookOutcomes.allow(m)),
  reasonText.map((m) => HookOutcomes.passthrough(m)),
  fc.tuple(codeArb, reasonText).map(([c, m]) => HookOutcomes.deny(c, m)),
  fc.tuple(codeArb, reasonText).map(([c, m]) => HookOutcomes.ask(c, m)),
  fc.tuple(codeArb, reasonText).map(([c, m]) => HookOutcomes.stop(c, m)),
  fc
    .array(
      fc.record({
        key: fc.string({ minLength: 1, maxLength: 10 }),
        value: fc.string({ maxLength: 20 }),
      }),
      { minLength: 1, maxLength: 3 },
    )
    .map((a) => HookOutcomes.annotate(a)),
);

describe('HK-03: a single hook output produces exactly its declared effect', () => {
  it('property: the exact effect is applied, and the decision is never elevated', async () => {
    await fc.assert(
      fc.asyncProperty(baseArb, outcomeArb, async (base, outcome) => {
        const { engine, registry } = makeEngine();
        always(registry, 'h', outcome);
        const res = await engine.run(
          'PreToolUse',
          { toolName: 'Bash', toolInput: { command: 'ls' } },
          { currentDecision: base },
        );

        // Universal HK-04 guard: the fold is never looser than what it was handed.
        expect(rank[res.decision]).toBeGreaterThanOrEqual(rank[base]);

        switch (outcome.type) {
          case 'continue':
            expect(res.decision).toBe(base);
            expect(res.blocked).toBe(false);
            break;
          case 'block':
            expect(res.blocked).toBe(true);
            expect(res.decision).toBe('deny');
            expect(res.blockReason?.hookId).toBe('h');
            break;
          case 'context':
            expect(res.decision).toBe(base);
            expect(res.injectedContext).toHaveLength(1);
            expect(res.injectedContext[0]?.hookId).toBe('h');
            break;
          case 'modify':
            expect(res.decision).toBe(base);
            expect(res.modifiedInput?.needsRevalidation).toBe(true);
            expect(res.modifiedInput?.toolInput).toEqual(outcome.toolInput);
            break;
          case 'allow':
          case 'passthrough':
            expect(res.decision).toBe(base);
            expect(res.ignoredElevations).toHaveLength(1);
            expect(res.ignoredElevations[0]?.requested).toBe(outcome.type);
            break;
          case 'deny':
            expect(res.decision).toBe('deny');
            break;
          case 'ask':
            expect(res.decision).toBe(rank[base] >= rank.ask ? base : 'ask');
            break;
          case 'stop':
            expect(res.decision).toBe(base);
            expect(res.stopped).toBe(true);
            break;
          case 'annotate':
            expect(res.decision).toBe(base);
            expect(res.annotations).toHaveLength(1);
            expect(res.annotations[0]?.hookId).toBe('h');
            break;
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('HK-04: the fold can only restrict, never elevate', () => {
  // Permission-bearing outcomes plus continue. No `block` here so every hook runs (no short-circuit),
  // which lets the expected decision be written as a pure left fold over restrictions.
  const permOutcomeArb: fc.Arbitrary<HookOutcome> = fc.oneof(
    fc.constant(HookOutcomes.continue()),
    reasonText.map((m) => HookOutcomes.allow(m)),
    reasonText.map((m) => HookOutcomes.passthrough(m)),
    fc.tuple(codeArb, reasonText).map(([c, m]) => HookOutcomes.ask(c, m)),
    fc.tuple(codeArb, reasonText).map(([c, m]) => HookOutcomes.deny(c, m)),
  );

  it('property: folding many opinions applies only restrictions; allow/passthrough are inert', async () => {
    await fc.assert(
      fc.asyncProperty(
        baseArb,
        fc.array(permOutcomeArb, { maxLength: 5 }),
        async (base, outcomes) => {
          const { engine, registry } = makeEngine();
          outcomes.forEach((o, i) => always(registry, `h${i}`, o));
          const res = await engine.run(
            'PreToolUse',
            { toolName: 'Bash' },
            { currentDecision: base },
          );

          // Frozen expectation: start at base, move UP for each ask/deny, ignore everything else.
          let expected = rank[base];
          for (const o of outcomes) {
            if (o.type === 'deny') expected = Math.max(expected, rank.deny);
            else if (o.type === 'ask') expected = Math.max(expected, rank.ask);
          }
          const label: DecisionOutcome = expected === 2 ? 'deny' : expected === 1 ? 'ask' : base;
          expect(res.decision).toBe(label);
          expect(rank[res.decision]).toBeGreaterThanOrEqual(rank[base]);

          const elevations = outcomes.filter(
            (o) => o.type === 'allow' || o.type === 'passthrough',
          ).length;
          expect(res.ignoredElevations).toHaveLength(elevations);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('property: an allow/passthrough can never loosen a deny or an ask', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<DecisionOutcome>('ask', 'deny'),
        fc.constantFrom<'allow' | 'passthrough'>('allow', 'passthrough'),
        reasonText,
        async (base, kind, msg) => {
          const { engine, registry } = makeEngine();
          always(
            registry,
            'evil',
            kind === 'allow' ? HookOutcomes.allow(msg) : HookOutcomes.passthrough(msg),
          );
          const res = await engine.run(
            'PreToolUse',
            { toolName: 'Bash' },
            { currentDecision: base },
          );
          expect(res.decision).toBe(base);
          expect(res.ignoredElevations[0]?.requested).toBe(kind);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('property: a modify never changes the decision and always forces revalidation', async () => {
    await fc.assert(
      fc.asyncProperty(
        baseArb,
        fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), fc.string()),
        async (base, input) => {
          const { engine, registry } = makeEngine();
          always(registry, 'm', HookOutcomes.modify(input));
          const res = await engine.run(
            'PreToolUse',
            { toolName: 'Bash', toolInput: { command: 'ls' } },
            { currentDecision: base },
          );
          expect(res.decision).toBe(base);
          expect(res.modifiedInput?.needsRevalidation).toBe(true);
          expect(res.modifiedInput?.toolInput).toEqual(input);
        },
      ),
      { numRuns: 200 },
    );
  });
});
