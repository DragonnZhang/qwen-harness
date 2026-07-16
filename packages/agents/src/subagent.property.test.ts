import {
  NO_MANAGED_RESTRICTIONS,
  RECOMMENDED_MANAGED_POLICY,
  defaultAuthority,
  isAtMost,
  type Authority,
  type ManagedPolicy,
} from '@qwen-harness/policy';
import { SequentialIds } from '@qwen-harness/testkit';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SUBAGENT_LIMITS,
  SubagentError,
  SubagentSupervisor,
  type SubagentRunner,
  type SubagentSpec,
} from './index.ts';

/**
 * The subagent bounding invariants as properties (AG-03).
 *
 * The security-critical one: a child NEVER receives more authority than its parent, for ANY
 * combination of parent profile, requested profile, and managed policy — a child cannot escalate by
 * asking. And the resource bounds hold: spawning past the total-child limit is refused, and a
 * supervisor already at the depth limit cannot spawn at all, so a child can never grow an unbounded
 * tree of grandchildren.
 */

const WS = '/workspace';
const PROFILES = ['plan', 'ask', 'auto-accept-edits', 'yolo'] as const;

const profile = (): fc.Arbitrary<(typeof PROFILES)[number]> => fc.constantFrom(...PROFILES);
const managedArb = (): fc.Arbitrary<ManagedPolicy> =>
  fc.constantFrom(NO_MANAGED_RESTRICTIONS, RECOMMENDED_MANAGED_POLICY);

const recordingRunner = (): SubagentRunner => ({
  run: () => Promise.resolve({ ok: true, summary: 'x', modelCalls: 1 }),
});

const spec = (requested: Authority): SubagentSpec => ({
  label: 'child',
  prompt: 'do a thing',
  mode: { context: 'fresh', timing: 'foreground' },
  requestedAuthority: requested,
  model: 'qwen3.7-max',
  maxModelCalls: 5,
  maxWallMs: 30_000,
});

describe('subagent authority never widens (AG-03, P)', () => {
  it('the computed child authority is at most the parent, for any profiles and managed policy', () => {
    fc.assert(
      fc.property(profile(), profile(), managedArb(), (parentP, requestedP, managed) => {
        const parent = defaultAuthority(parentP, WS, managed);
        const sup = new SubagentSupervisor({
          authority: parent,
          managed,
          depth: 0,
          ids: new SequentialIds(),
        });
        const requested = defaultAuthority(requestedP, WS, managed);
        const child = sup.childAuthority(requested);
        // The core no-escalation guarantee: requesting `yolo` from an `ask` parent yields `ask`, never
        // more. The child is bounded by the parent regardless of what it asked for.
        expect(isAtMost(child, parent)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});

describe('subagent resource bounds hold (AG-03, P)', () => {
  it('refuses to spawn past the total-child limit', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async (limit) => {
        const managed = NO_MANAGED_RESTRICTIONS;
        const sup = new SubagentSupervisor({
          authority: defaultAuthority('yolo', WS, managed),
          managed,
          depth: 0,
          ids: new SequentialIds(),
          limits: { ...DEFAULT_SUBAGENT_LIMITS, maxTotalChildren: limit, maxActiveChildren: 99 },
        });
        const runner = recordingRunner();
        const req = defaultAuthority('ask', WS, managed);
        for (let i = 0; i < limit; i++) {
          await sup.spawn(spec(req), runner, new AbortController().signal);
        }
        // The (limit+1)th spawn is refused with the specific typed reason.
        await expect(sup.spawn(spec(req), runner, new AbortController().signal)).rejects.toThrow(
          SubagentError,
        );
        expect(sup.totalSpawned).toBe(limit);
      }),
      { numRuns: 30 },
    );
  });

  it('a supervisor at or past the depth limit cannot spawn at all', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 3 }),
        fc.integer({ min: 0, max: 5 }),
        async (maxDepth, depth) => {
          const managed = NO_MANAGED_RESTRICTIONS;
          const sup = new SubagentSupervisor({
            authority: defaultAuthority('yolo', WS, managed),
            managed,
            depth,
            ids: new SequentialIds(),
            limits: { ...DEFAULT_SUBAGENT_LIMITS, maxDepth },
          });
          const attempt = sup.spawn(
            spec(defaultAuthority('ask', WS, managed)),
            recordingRunner(),
            new AbortController().signal,
          );
          if (depth >= maxDepth) {
            await expect(attempt).rejects.toThrow(SubagentError); // depth-exceeded
          } else {
            await expect(attempt).resolves.toBeDefined();
          }
        },
      ),
      { numRuns: 40 },
    );
  });
});
