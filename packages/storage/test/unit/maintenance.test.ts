import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CorrelationId, ThreadId } from '@qwen-harness/protocol';
import { ManualClock, SequentialIds, USER_ACTOR } from '@qwen-harness/testkit';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EventStore } from '../../src/index.ts';

/**
 * Retention, vacuum, and backup (SS-07, U + P).
 *
 * Retention operates at THREAD granularity: a session whose last activity predates the cutoff is
 * dropped whole — its events and every projection row — while a recently-active session is untouched
 * and keeps its full append-only history. VACUUM reclaims the freed space, and an online backup
 * produces a file that reopens as a complete store. The property pins the retention boundary exactly
 * and proves a second prune is a no-op.
 */

describe('store maintenance (SS-07)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qh-maint-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const storeAt = (clock: ManualClock): EventStore =>
    new EventStore({ path: join(dir, 'sessions.sqlite'), clock, ids: new SequentialIds() });

  function createThread(store: EventStore, id: string): void {
    store.append({
      threadId: id as ThreadId,
      correlationId: `cor_${id}` as CorrelationId,
      permissionProfile: 'ask',
      actor: USER_ACTOR,
      payload: { type: 'thread-created', cwd: '/w', canonicalRepo: null, name: null },
    });
  }

  it('prune drops threads older than the cutoff and keeps recent ones, with their history', () => {
    const clock = new ManualClock(1_000);
    const store = storeAt(clock);
    createThread(store, 'thr_old00001');
    clock.advance(9_000); // now 10_000
    createThread(store, 'thr_new00001');

    // Cutoff = now - olderThanMs = 12_000 - 5_000 = 7_000. The old thread (updated 1_000) is stale.
    const result = store.prune({ olderThanMs: 5_000, now: 12_000 });
    expect(result.threadsPruned).toBe(1);
    expect(result.eventsPruned).toBeGreaterThan(0);

    const ids = store.listThreads().map((t) => t.id);
    expect(ids).toEqual(['thr_new00001']);
    expect(store.readThread('thr_old00001' as ThreadId)).toHaveLength(0); // history gone
    expect(store.readThread('thr_new00001' as ThreadId).length).toBeGreaterThan(0); // history kept
    store.close();
  });

  it('vacuum runs after a prune without disturbing surviving data', () => {
    const clock = new ManualClock(1_000);
    const store = storeAt(clock);
    createThread(store, 'thr_keep00001');
    store.prune({ olderThanMs: 1, now: 500 }); // cutoff in the past → nothing pruned
    expect(() => store.vacuum()).not.toThrow();
    expect(store.listThreads().map((t) => t.id)).toEqual(['thr_keep00001']);
    store.close();
  });

  it('an online backup reopens as a complete store with the data intact', async () => {
    const store = storeAt(new ManualClock(1_000));
    createThread(store, 'thr_backup0001');
    const dest = join(dir, 'backup.sqlite');
    await store.backup(dest);
    store.close();

    const restored = new EventStore({
      path: dest,
      clock: new ManualClock(0),
      ids: new SequentialIds(),
    });
    expect(restored.listThreads().map((t) => t.id)).toEqual(['thr_backup0001']);
    restored.close();
    expect(existsSync(dest)).toBe(true);
  });

  it('retention boundary is exact and pruning is idempotent (P)', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 100_000 }), { minLength: 1, maxLength: 12 }),
        fc.integer({ min: 1, max: 100_000 }),
        (times, cutoff) => {
          const local = mkdtempSync(join(tmpdir(), 'qh-maint-p-'));
          try {
            const clock = new ManualClock(0);
            const store = new EventStore({
              path: join(local, 's.sqlite'),
              clock,
              ids: new SequentialIds(),
            });
            const sorted = [...times].sort((a, b) => a - b);
            sorted.forEach((t, i) => {
              clock.advance(t - clock.now());
              createThread(store, `thr_${String(i).padStart(8, '0')}`);
            });

            const survivorsExpected = sorted.filter((t) => t >= cutoff).length;
            // now chosen so `now - olderThanMs === cutoff`.
            store.prune({ olderThanMs: 1_000_000, now: cutoff + 1_000_000 });

            expect(store.listThreads()).toHaveLength(survivorsExpected);
            // A second prune with the same cutoff removes nothing more.
            expect(
              store.prune({ olderThanMs: 1_000_000, now: cutoff + 1_000_000 }).threadsPruned,
            ).toBe(0);
            store.close();
          } finally {
            rmSync(local, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});
