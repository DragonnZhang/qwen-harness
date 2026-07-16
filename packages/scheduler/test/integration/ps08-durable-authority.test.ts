import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultAuthority, isAtMost, NO_MANAGED_RESTRICTIONS } from '@qwen-harness/policy';
import type { ManagedPolicy } from '@qwen-harness/policy';
import type { CorrelationId, ThreadId, TurnId } from '@qwen-harness/protocol';
import { EventStore } from '@qwen-harness/storage';
import { ManualClock, SequentialIds, USER_ACTOR } from '@qwen-harness/testkit';

import { Scheduler, eventStoreSchedulerStore } from '../../src/index.ts';

/**
 * Durable work runs under the intersection of its CAPTURED ceiling and the CURRENT managed policy
 * (PS-08, I).
 *
 * A durable cron job is created — and persisted to the real event log — while managed policy is
 * permissive, so it captures a wide (yolo) ceiling. By the time it fires, the administrator has
 * TIGHTENED managed policy. The job must run under the intersection of its captured ceiling and the
 * CURRENT managed policy, never its stale creation-time authority: a standing durable job cannot be a
 * hole through which yesterday's permissions survive today's tighter policy.
 */

const THREAD = 'thr_000001' as ThreadId;
const CORR = 'cor_000001' as CorrelationId;
const BASE = 1_700_000_040_000;

function newEventStore(): EventStore {
  const store = new EventStore({
    path: ':memory:',
    clock: new ManualClock(BASE),
    ids: new SequentialIds(),
  });
  store.append({
    threadId: THREAD,
    actor: USER_ACTOR,
    correlationId: CORR,
    permissionProfile: 'ask',
    payload: { type: 'thread-created', cwd: '/workspace', canonicalRepo: '/workspace', name: null },
  });
  return store;
}

function schedulerOver(store: EventStore): Scheduler {
  const durable = eventStoreSchedulerStore({
    store,
    threadId: THREAD,
    turnId: 'trn_000001' as TurnId,
    actor: { kind: 'cron', id: USER_ACTOR.id },
    correlationId: CORR,
    permissionProfile: 'ask',
    ids: new SequentialIds(),
    clock: new ManualClock(BASE),
  });
  return new Scheduler({ clock: new ManualClock(BASE), ids: new SequentialIds(), store: durable });
}

describe('durable work re-intersects with current managed policy at fire (PS-08, I)', () => {
  let store: EventStore;
  beforeEach(() => {
    store = newEventStore();
  });
  afterEach(() => store.close());

  it('a durable job captured under a wide ceiling fires clamped by tightened managed policy', () => {
    const wideCeiling = defaultAuthority('yolo', '/repo', NO_MANAGED_RESTRICTIONS);
    const scheduler = schedulerOver(store);
    scheduler.create({
      kind: 'recurring',
      owner: 'owner-a',
      threadId: THREAD,
      cronExpr: '* * * * *',
      workloadTag: 'digest',
      authorityCeiling: wideCeiling,
      durable: true,
    });

    // The job is genuinely DURABLE: its creation is recorded on the real event log (the scheduler
    // writes durable records through the store as `side-effect-intent` events).
    const persisted = store.readAll().some((e) => e.payload.type === 'side-effect-intent');
    expect(persisted).toBe(true);

    // Managed policy has since tightened.
    const tightened: ManagedPolicy = {
      ...NO_MANAGED_RESTRICTIONS,
      maxProfile: 'ask',
      maxIsolation: 'read-only',
      networkAllowed: false,
    };

    const fired = scheduler.due({ now: BASE + 90_000, managed: tightened });
    expect(fired).toHaveLength(1);
    const authority = fired[0]!.authority;

    // It fires under the intersection with CURRENT managed policy — not its captured yolo ceiling.
    expect(authority.profile).toBe('ask');
    expect(authority.isolation).toBe('read-only');
    expect(authority.networkAllowed).toBe(false);
    // Structurally never wider than the captured ceiling either.
    expect(isAtMost(authority, wideCeiling)).toBe(true);
  });
});
