import { beforeEach, describe, expect, it } from 'vitest';

import { defaultAuthority, NO_MANAGED_RESTRICTIONS } from '@qwen-harness/policy';
import type { CorrelationId, ThreadId, TurnId } from '@qwen-harness/protocol';
import { EventStore } from '@qwen-harness/storage';
import { ManualClock, SequentialIds, USER_ACTOR } from '@qwen-harness/testkit';

import { Scheduler, eventStoreSchedulerStore } from '../../src/index.ts';

/**
 * Durable definitions survive a restart, session definitions do not (CR-04), proved against the REAL
 * EventStore on an in-memory SQLite database — the same code path production uses. A "restart" is a
 * fresh {@link Scheduler} reading the same event log.
 */

const THREAD = 'thr_000001' as ThreadId;
const CORR = 'cor_000001' as CorrelationId;
const BASE = 1_700_000_040_000;
const CEILING = defaultAuthority('ask', '/repo', NO_MANAGED_RESTRICTIONS);

function newEventStore(): EventStore {
  const store = new EventStore({
    path: ':memory:',
    clock: new ManualClock(BASE),
    ids: new SequentialIds(),
  });
  // Threads must exist before any thread-scoped event references them.
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

describe('durable scheduler over the real EventStore (CR-04)', () => {
  let eventStore: EventStore;

  beforeEach(() => {
    eventStore = newEventStore();
  });

  it('reconstructs durable jobs after a restart and drops session-only ones', () => {
    const before = schedulerOver(eventStore);
    const recurring = before.create({
      kind: 'recurring',
      owner: 'owner-a',
      threadId: THREAD,
      cronExpr: '*/10 * * * *',
      workloadTag: 'digest',
      authorityCeiling: CEILING,
      durable: true,
    });
    const oneShot = before.create({
      kind: 'one-shot',
      owner: 'owner-a',
      threadId: THREAD,
      fireAt: BASE + 3_600_000,
      workloadTag: 'reminder',
      authorityCeiling: CEILING,
      durable: true,
    });
    // A session job never touches the durable log.
    before.create({
      kind: 'recurring',
      owner: 'owner-a',
      threadId: THREAD,
      cronExpr: '* * * * *',
      workloadTag: 'ephemeral',
      authorityCeiling: CEILING,
      durable: false,
    });

    // Restart: a fresh scheduler reading the same event log.
    const after = schedulerOver(eventStore);
    const restored = after.list();
    expect(restored).toHaveLength(2);
    expect(after.get(recurring.id)?.cronSource).toBe('*/10 * * * *');
    expect(after.get(recurring.id)?.workloadTag).toBe('digest');
    expect(after.get(oneShot.id)?.fireAt).toBe(BASE + 3_600_000);
    expect(after.get(recurring.id)?.authorityCeiling.profile).toBe('ask');
  });

  it('does not resurrect a durable job that was deleted before the restart', () => {
    const before = schedulerOver(eventStore);
    const job = before.create({
      kind: 'recurring',
      owner: 'owner-a',
      threadId: THREAD,
      cronExpr: '*/10 * * * *',
      workloadTag: 'digest',
      authorityCeiling: CEILING,
      durable: true,
    });
    before.delete(job.id);

    const after = schedulerOver(eventStore);
    expect(after.list()).toHaveLength(0);
    expect(after.get(job.id)).toBeUndefined();
  });
});
