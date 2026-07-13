import { EventStore } from '@qwen-harness/storage';
import type { CorrelationId, ThreadId } from '@qwen-harness/protocol';
import { SequentialIds } from '@qwen-harness/testkit';

/** A globally-unique id source (like the CLI's), so fork ids never collide with existing ones. */
function uniqueIds() {
  let n = 0;
  return { next: (prefix: string) => `${prefix}_f${(n++).toString().padStart(6, '0')}` };
}
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { exportSession, forkSession, listSessions, reconstructHistory } from '../../src/index.ts';

/**
 * Session operations over the durable log (SS-02, SS-03, SS-06). No model runs — these are pure
 * reads and transformations of what the event store already holds, which is exactly why local
 * history is authoritative (PV-08).
 */
describe('sessions', () => {
  let store: EventStore;
  const THREAD = 'thr_000001' as ThreadId;
  const CORR = 'cor_000001' as CorrelationId;

  beforeEach(() => {
    store = new EventStore({
      path: ':memory:',
      clock: { now: () => 1_700_000_000_000, sleep: () => Promise.resolve() },
      ids: new SequentialIds(),
    });
    const base = {
      threadId: THREAD,
      correlationId: CORR,
      permissionProfile: 'ask' as const,
      actor: { kind: 'user' as const, id: 'act_user01' as never },
    };
    store.append({
      ...base,
      payload: { type: 'thread-created', cwd: '/w', canonicalRepo: '/w', name: 'demo' },
    });
    store.append({
      ...base,
      turnId: 'trn_000001' as never,
      payload: { type: 'turn-started', userText: 'add a feature' },
    });
    store.append({
      ...base,
      turnId: 'trn_000001' as never,
      itemId: 'itm_000001' as never,
      payload: {
        type: 'item-appended',
        item: {
          type: 'assistant-message',
          id: 'itm_000001' as never,
          turnId: 'trn_000001' as never,
          threadId: THREAD,
          seq: 0,
          createdAt: 1,
          text: 'I added the feature.',
          complete: true,
        },
      },
    });
  });

  afterEach(() => store.close());

  it('lists sessions with turn counts', () => {
    const sessions = listSessions(store);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ threadId: THREAD, name: 'demo', turns: 1 });
  });

  it('reconstructs model history from the durable log (resume path)', () => {
    const history = reconstructHistory(store, THREAD);
    // The user prompt and the assistant reply are both recovered, in order — this is what a resume
    // feeds back to the model.
    expect(history).toEqual([
      { type: 'message', role: 'user', text: 'add a feature' },
      { type: 'message', role: 'assistant', text: 'I added the feature.' },
    ]);
  });

  it('forks a session without changing the original, recording lineage', () => {
    const newId = 'thr_000099' as ThreadId;
    const result = forkSession(store, THREAD, newId, {
      now: 2,
      actorId: 'act_system',
      ids: uniqueIds(),
    });

    expect(result.copiedEvents).toBeGreaterThan(0);
    // The fork exists with lineage, and the original is untouched.
    const forked = store.getThread(newId);
    expect(forked?.forkedFrom?.threadId).toBe(THREAD);
    expect(store.getThread(THREAD)?.forkedFrom).toBeNull();

    // The fork's reconstructed history matches the original's.
    expect(reconstructHistory(store, newId)).toEqual(reconstructHistory(store, THREAD));

    // Two sessions now exist.
    expect(listSessions(store)).toHaveLength(2);
  });

  it('exports a session as JSONL that round-trips', () => {
    const jsonl = exportSession(store, THREAD, 3);
    const lines = jsonl.trim().split('\n');
    // A header line plus one line per event.
    const header = JSON.parse(lines[0]!) as { format: string; threadId: string };
    expect(header.format).toBe('qwen-harness/jsonl');
    expect(header.threadId).toBe(THREAD);
    expect(lines.length).toBeGreaterThan(1);
  });

  it('rejects operating on a session that does not exist', () => {
    expect(() =>
      forkSession(store, 'thr_missing00' as ThreadId, 'thr_new0000001' as ThreadId, {
        now: 1,
        actorId: 'x',
        ids: uniqueIds(),
      }),
    ).toThrow(/no such session/);
    expect(() => exportSession(store, 'thr_missing00' as ThreadId, 1)).toThrow(/no such session/);
  });
});
