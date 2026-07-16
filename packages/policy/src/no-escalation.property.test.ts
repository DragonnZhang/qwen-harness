import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { intersect, isAtMost, type Authority } from './authority.ts';
import { type ManagedPolicy, PROFILE_RANK, ISOLATION_RANK } from './managed.ts';

/**
 * Authority is never silently upgraded (PS-10, P).
 *
 * PS-10: repeated denials and prompt fatigue must be handled "without silently upgrading authority",
 * and automated classification "may reduce prompts only inside hard policy". The structural guarantee
 * behind that promise is that authority is derived by INTERSECTION, never by honoring a request that
 * asks for more. This property models the adversary directly: however permissive the REQUEST is — the
 * shape a client that keeps trying to escalate past a denial would send — the derived authority is
 * still no greater than the parent ceiling AND no greater than the managed hard policy. There is no
 * sequence of requests that widens it.
 */

const PROFILES = ['plan', 'ask', 'auto-accept-edits', 'yolo'] as const;
const ISOLATIONS = ['read-only', 'workspace-write', 'disabled'] as const;

const authority = (): fc.Arbitrary<Authority> =>
  fc.record({
    profile: fc.constantFrom(...PROFILES),
    isolation: fc.constantFrom(...ISOLATIONS),
    networkAllowed: fc.boolean(),
    workspaceRoots: fc.constantFrom(['/repo'], ['/repo', '/repo/pkg'], ['/repo/pkg']),
    rules: fc.constant([]),
    grants: fc.constant([]),
    maxChildDepth: fc.nat({ max: 5 }),
  });

const managed = (): fc.Arbitrary<ManagedPolicy> =>
  fc.record({
    version: fc.constant(1),
    rules: fc.constant([]),
    maxProfile: fc.constantFrom(...PROFILES),
    maxIsolation: fc.constantFrom(...ISOLATIONS),
    networkAllowed: fc.boolean(),
    maxChildDepth: fc.nat({ max: 5 }),
  });

describe('no request can silently upgrade authority (PS-10, P)', () => {
  it('the derived authority never exceeds the parent ceiling or the managed hard policy', () => {
    fc.assert(
      fc.property(authority(), authority(), managed(), (requested, parent, policy) => {
        // The parent ceiling must itself be within the managed policy — the runtime never hands out a
        // parent that already violates hard policy. Model that precondition.
        const parentInPolicy: Authority = {
          ...parent,
          profile:
            PROFILE_RANK[parent.profile] <= PROFILE_RANK[policy.maxProfile]
              ? parent.profile
              : policy.maxProfile,
        };

        const child = intersect(requested, parentInPolicy, policy);

        // Structural invariant: the child holds no more than its parent, in every dimension.
        expect(isAtMost(child, parentInPolicy)).toBe(true);
        // Hard policy is an absolute ceiling: classification/derivation stays inside it.
        expect(PROFILE_RANK[child.profile]).toBeLessThanOrEqual(PROFILE_RANK[policy.maxProfile]);
        expect(ISOLATION_RANK[child.isolation]).toBeLessThanOrEqual(
          ISOLATION_RANK[policy.maxIsolation],
        );
        // Network is a conjunction of all three — a request cannot conjure it.
        if (child.networkAllowed) {
          expect(
            requested.networkAllowed && parentInPolicy.networkAllowed && policy.networkAllowed,
          ).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });
});
