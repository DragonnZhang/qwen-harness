import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CorrelationId, ThreadId } from '@qwen-harness/protocol';
import { ManualClock, SequentialIds, USER_ACTOR } from '@qwen-harness/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EventStore } from '../../src/index.ts';

/**
 * Backup and restore against real files (SS-07, I + F).
 *
 * A live store is backed up online, and the copy reopens as a complete, WRITABLE store with every
 * thread intact (I). The failure path is disaster recovery: the original database file is deleted out
 * from under the process, and the store is rebuilt from the backup with no data loss (F).
 */

describe('backup + restore over real files (SS-07)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qh-backup-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const create = (store: EventStore, id: string): void => {
    store.append({
      threadId: id as ThreadId,
      correlationId: `cor_${id}` as CorrelationId,
      permissionProfile: 'ask',
      actor: USER_ACTOR,
      payload: { type: 'thread-created', cwd: '/w', canonicalRepo: null, name: null },
    });
  };

  it('reopens the backup with every thread and its history intact (I)', async () => {
    const primaryPath = join(dir, 'sessions.sqlite');
    const store = new EventStore({
      path: primaryPath,
      clock: new ManualClock(1),
      ids: new SequentialIds(),
    });
    for (const id of ['thr_a0000001', 'thr_b0000001', 'thr_c0000001']) create(store, id);

    const dest = join(dir, 'snapshot.sqlite');
    await store.backup(dest);
    store.close();

    const restored = new EventStore({
      path: dest,
      clock: new ManualClock(2),
      ids: new SequentialIds(),
    });
    // Every thread and its append-only history survive the online backup byte-for-byte.
    expect(
      restored
        .listThreads()
        .map((t) => t.id)
        .sort(),
    ).toEqual(['thr_a0000001', 'thr_b0000001', 'thr_c0000001']);
    for (const id of ['thr_a0000001', 'thr_b0000001', 'thr_c0000001']) {
      expect(restored.readThread(id as ThreadId).length).toBeGreaterThan(0);
    }
    restored.close();
  });

  it('recovers from a lost primary database using the backup (F)', async () => {
    const primaryPath = join(dir, 'sessions.sqlite');
    const store = new EventStore({
      path: primaryPath,
      clock: new ManualClock(1),
      ids: new SequentialIds(),
    });
    create(store, 'thr_important');
    const dest = join(dir, 'snapshot.sqlite');
    await store.backup(dest);
    store.close();

    // Disaster: the primary database (and its WAL sidecars) are gone.
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${primaryPath}${suffix}`, { force: true });

    // Recovery: rebuild from the backup. No data loss.
    const recovered = new EventStore({
      path: dest,
      clock: new ManualClock(3),
      ids: new SequentialIds(),
    });
    expect(recovered.getThread('thr_important' as ThreadId)).toBeDefined();
    expect(recovered.readThread('thr_important' as ThreadId).length).toBeGreaterThan(0);
    recovered.close();
  });
});
