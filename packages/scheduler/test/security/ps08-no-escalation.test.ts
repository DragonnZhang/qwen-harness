import { describe, expect, it } from 'vitest';

import {
  defaultAuthority,
  isAtMost,
  NO_MANAGED_RESTRICTIONS,
  PROFILE_RANK,
} from '@qwen-harness/policy';
import type { ManagedPolicy } from '@qwen-harness/policy';
import type { ThreadId } from '@qwen-harness/protocol';
import { ManualClock, SequentialIds } from '@qwen-harness/testkit';

import { Scheduler } from '../../src/index.ts';

/**
 * A standing job is never a hole through which stale privilege escapes current hard policy (PS-08, S).
 *
 * The adversary is time: a job is captured under the most permissive ceiling possible, then hard
 * policy is tightened underneath it in every combination. No matter how wide the captured ceiling, the
 * authority the job fires under is always bounded by the CURRENT managed policy — a job created
 * yesterday cannot run today with permissions the administrator has since revoked.
 */

const THREAD = 'thr_000001' as ThreadId;
const BASE = 1_700_000_040_000;
const PROFILES = ['plan', 'ask', 'auto-accept-edits', 'yolo'] as const;
const ISOLATIONS = ['read-only', 'workspace-write', 'disabled'] as const;

describe('a captured ceiling can never escape current hard policy (PS-08, S)', () => {
  it('however wide the capture, the fired authority is bounded by current managed policy', () => {
    // The widest ceiling an attacker could hope to capture at creation time.
    const captured = defaultAuthority('yolo', '/repo', NO_MANAGED_RESTRICTIONS);

    for (const maxProfile of PROFILES) {
      for (const maxIsolation of ISOLATIONS) {
        for (const networkAllowed of [true, false]) {
          const tightened: ManagedPolicy = {
            ...NO_MANAGED_RESTRICTIONS,
            maxProfile,
            maxIsolation,
            networkAllowed,
          };
          const scheduler = new Scheduler({
            clock: new ManualClock(BASE),
            ids: new SequentialIds(),
          });
          scheduler.create({
            kind: 'recurring',
            owner: 'owner-a',
            threadId: THREAD,
            cronExpr: '* * * * *',
            workloadTag: 'digest',
            authorityCeiling: captured,
            durable: false,
          });

          const fired = scheduler.due({ now: BASE + 90_000, managed: tightened });
          expect(fired).toHaveLength(1);
          const authority = fired[0]!.authority;

          const where = `maxProfile=${maxProfile} maxIsolation=${maxIsolation} network=${networkAllowed}`;
          // Bounded by current hard policy — never the captured yolo.
          expect(PROFILE_RANK[authority.profile], where).toBeLessThanOrEqual(
            PROFILE_RANK[maxProfile],
          );
          expect(authority.networkAllowed && !networkAllowed, `network leak: ${where}`).toBe(false);
          // ...and never wider than what was captured, either.
          expect(isAtMost(authority, captured), where).toBe(true);
        }
      }
    }
  });
});
