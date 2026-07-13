import { describe, expect, it } from 'vitest';

import { defaultAuthority, NO_MANAGED_RESTRICTIONS } from '@qwen-harness/policy';
import type { CorrelationId, ThreadId, TurnId } from '@qwen-harness/protocol';
import { EventStore } from '@qwen-harness/storage';
import { ManualClock, SequentialIds, USER_ACTOR } from '@qwen-harness/testkit';

import {
  BackgroundManager,
  backgroundIdempotencyKey,
  eventStoreBackgroundSink,
} from '../../src/index.ts';
import { FakeRunner } from '../fake-runner.ts';

/**
 * The full background lifecycle wired to the REAL EventStore (BG-02/BG-04), on an in-memory SQLite
 * database — the same code path production uses. A completed task lands in the side-effect ledger as
 * `known-complete`, and a duplicate exit never re-settles it: durable proof of idempotent completion.
 */

const THREAD = 'thr_000001' as ThreadId;
const TURN = 'trn_000001' as TurnId;
const CORR = 'cor_000001' as CorrelationId;
const BASE = 1_700_000_040_000;
const AUTHORITY = defaultAuthority('ask', '/repo', NO_MANAGED_RESTRICTIONS);

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

function newManager(store: EventStore): { manager: BackgroundManager; runner: FakeRunner } {
  const runner = new FakeRunner();
  const sink = eventStoreBackgroundSink({
    store,
    threadId: THREAD,
    turnId: TURN,
    actor: { kind: 'background', id: USER_ACTOR.id },
    correlationId: CORR,
    permissionProfile: 'ask',
    ids: new SequentialIds(),
  });
  const manager = new BackgroundManager({
    clock: new ManualClock(BASE),
    ids: new SequentialIds(),
    runner,
    sink,
  });
  return { manager, runner };
}

describe('background lifecycle over the real EventStore (BG-02/BG-04)', () => {
  it('records a completed task as known-complete in the durable ledger', () => {
    const store = newEventStore();
    const { manager, runner } = newManager(store);

    const task = manager.start({
      category: 'dream-consolidation',
      owner: USER_ACTOR,
      placement: 'background',
      permissionContext: AUTHORITY,
    });
    // A fresh task is not yet a completed side effect.
    expect(store.mayExecute(backgroundIdempotencyKey(task.id)).allowed).toBe(true);

    runner.exit(task.id, { ok: true, code: 0 });

    // After completion the ledger refuses to re-run it (never replay a known-complete side effect).
    expect(store.mayExecute(backgroundIdempotencyKey(task.id)).allowed).toBe(false);
  });

  it('does not re-settle the ledger on a duplicate exit (idempotent, BG-04)', () => {
    const store = newEventStore();
    const { manager, runner } = newManager(store);
    const task = manager.start({
      category: 'local-shell',
      owner: USER_ACTOR,
      placement: 'background',
      permissionContext: AUTHORITY,
    });

    runner.exit(task.id, { ok: true, code: 0 });
    runner.exit(task.id, { ok: true, code: 0 });

    const settled = store
      .readThread(THREAD)
      .filter((e) => e.payload.type === 'side-effect-settled');
    expect(settled).toHaveLength(1);
  });
});
