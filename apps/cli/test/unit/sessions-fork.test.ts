import type { CorrelationId, ThreadId, TurnId } from '@qwen-harness/protocol';
import { EventStore } from '@qwen-harness/storage';
import { ManualClock, SequentialIds, USER_ACTOR } from '@qwen-harness/testkit';
import { beforeEach, describe, expect, it } from 'vitest';

import { exportSession, forkSession } from '../../src/index.ts';

/**
 * Fork lineage and the stable export schema (SS-03, class U).
 *
 * Fork must create a NEW identity that records where it came from, while leaving the original
 * untouched; a fork of a fork chains lineage. Export must be the typed-EVENT schema (a JSONL header
 * plus one event per line) — decoupled from the internal SQLite tables — so an export written today
 * still imports into a future build.
 */

const THREAD = 'thr_000001' as ThreadId;
const CORR = 'cor_000001' as CorrelationId;
const NOW = 1_700_000_000_000;

describe('fork lineage + export schema (SS-03 U)', () => {
  let store: EventStore;
  let clock: ManualClock;
  let ids: SequentialIds;

  beforeEach(() => {
    clock = new ManualClock(NOW);
    ids = new SequentialIds();
    store = new EventStore({ path: ':memory:', clock, ids });
    store.append({
      threadId: THREAD,
      correlationId: CORR,
      permissionProfile: 'ask',
      actor: USER_ACTOR,
      payload: { type: 'thread-created', cwd: '/w', canonicalRepo: null, name: null },
    });
    // Mint the turn id from the SAME id source the fork uses, so the fork's remapped turn id is a
    // fresh one and never collides with this original.
    store.append({
      threadId: THREAD,
      turnId: ids.next('trn') as TurnId,
      correlationId: CORR,
      permissionProfile: 'ask',
      actor: USER_ACTOR,
      payload: { type: 'turn-started', userText: 'hello' },
    });
  });

  it('fork records lineage and copies history without changing the original', () => {
    const forkId = 'thr_fork01' as ThreadId;
    const result = forkSession(store, THREAD, forkId, { now: NOW, actorId: 'act_system', ids });
    expect(result.newThreadId).toBe(forkId);
    expect(result.copiedEvents).toBeGreaterThan(0);

    // The fork exists with lineage; the original is untouched (its own lineage stays null).
    expect(store.getThread(forkId)?.forkedFrom?.threadId).toBe(THREAD);
    expect(store.getThread(THREAD)?.forkedFrom).toBeNull();
    // The fork carries the original's history (the copied turn), plus its own lineage events.
    expect(store.readThread(forkId).some((e) => e.payload.type === 'turn-started')).toBe(true);
    expect(store.readThread(forkId).some((e) => e.payload.type === 'thread-forked')).toBe(true);
  });

  it('a fork of a fork chains lineage to its immediate parent', () => {
    const forkId = 'thr_fork01' as ThreadId;
    forkSession(store, THREAD, forkId, { now: NOW, actorId: 'act_system', ids });
    const grandId = 'thr_fork02' as ThreadId;
    forkSession(store, forkId, grandId, { now: NOW, actorId: 'act_system', ids });
    expect(store.getThread(grandId)?.forkedFrom?.threadId).toBe(forkId);
  });

  it('export is the typed-event JSONL schema — a header line then one event per line', () => {
    const jsonl = exportSession(store, THREAD, NOW);
    const lines = jsonl.split('\n').filter((l) => l.length > 0);
    const header = JSON.parse(lines[0]!) as { format: string; eventCount: number };
    expect(header.format).toBe('qwen-harness/jsonl'); // a public format id, not a table name
    expect(header.eventCount).toBe(lines.length - 1);
    // Every remaining line is a typed event (has a payload.type), not a raw SQL row.
    for (const line of lines.slice(1)) {
      expect((JSON.parse(line) as { payload: { type: string } }).payload.type).toBeTypeOf('string');
    }
  });
});
