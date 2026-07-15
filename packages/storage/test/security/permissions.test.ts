import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CorrelationId, ThreadId } from '@qwen-harness/protocol';
import { ManualClock, SequentialIds, USER_ACTOR } from '@qwen-harness/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EventStore } from '../../src/index.ts';

/**
 * The session store is private and does not interleave writers (SS-07, S).
 *
 * A session database holds transcripts, tool output, and permission context — it must not be
 * world-readable. It is created 0600 (owner only). And the concurrency hardening that stops two
 * processes from interleaving a thread is in place: WAL plus a fail-fast busy timeout, so a second
 * connection reads only COMMITTED data and never a torn write.
 */

describe('session store file permissions + locking (SS-07)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qh-perms-'));
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

  it('creates the database file owner-only (0600), never world- or group-readable', () => {
    const path = join(dir, 'sessions.sqlite');
    const store = new EventStore({ path, clock: new ManualClock(1), ids: new SequentialIds() });
    create(store, 'thr_secret0001');
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    // No group/other bits set at all.
    expect(mode & 0o077).toBe(0);
    store.close();
  });

  it('is WAL with a fail-fast busy timeout, and a second connection reads only committed data', () => {
    const path = join(dir, 'sessions.sqlite');
    const a = new EventStore({ path, clock: new ManualClock(1), ids: new SequentialIds() });
    create(a, 'thr_committed01');

    // A second connection (as another process would open) sees the committed thread, not a torn write.
    const b = new EventStore({ path, clock: new ManualClock(2), ids: new SequentialIds() });
    expect(b.getThread('thr_committed01' as ThreadId)).toBeDefined();

    // The locking hardening is actually configured, not merely intended.
    expect(String(b.db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
    expect(Number(b.db.pragma('busy_timeout', { simple: true }))).toBeGreaterThan(0);

    a.close();
    b.close();
  });
});
