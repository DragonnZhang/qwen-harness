/**
 * Integration: the transcript boundary is persisted through a REAL `storage` EventStore.
 *
 * Proves the CX-03 "write the full transcript boundary first" step lands durably: after compaction
 * the event log and its item projection both contain a `compaction` boundary marker carrying the
 * content digest, and `compact` returns that same digest as its `boundaryRef`. `context` itself
 * opens no database — it drives the injected store.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EventStore } from '@qwen-harness/storage';
import { ManualClock, SequentialIds, SYSTEM_ACTOR } from '@qwen-harness/testkit';

import { compact, digestTranscript, eventStoreBoundaryStore } from '../../src/index.ts';

const threadId = 'thr_000001';
const turnId = 'trn_000001';
const correlationId = 'cor_000001';

let store;
let clock;
let ids;

const preserved = {
  goal: 'persist a boundary through storage',
  constraints: [],
  plan: [],
  tasks: [],
  activeFiles: [],
  decisions: [],
  errors: [],
  obligations: [],
};

beforeEach(() => {
  clock = new ManualClock(1_700_000_000_000);
  ids = new SequentialIds();
  store = new EventStore({ path: ':memory:', clock, ids });
  // A thread must exist before items are appended to it.
  store.append({
    threadId,
    payload: { type: 'thread-created', cwd: '/repo', canonicalRepo: '/repo', name: null },
    actor: SYSTEM_ACTOR,
    correlationId,
    permissionProfile: 'ask',
  });
});

afterEach(() => {
  store?.close?.();
});

describe('storage-backed boundary persistence', () => {
  it('records the boundary on the durable log and returns the digest as the ref', async () => {
    const transcript = [
      { type: 'message', role: 'user', text: 'persist a boundary through storage' },
      { type: 'message', role: 'assistant', text: 'x'.repeat(4000) },
    ];

    let seq = 100;
    const boundaryStore = eventStoreBoundaryStore({
      store,
      threadId,
      turnId,
      actor: SYSTEM_ACTOR,
      correlationId,
      permissionProfile: 'ask',
      ids,
      clock,
      nextItemSeq: () => seq++,
    });

    const result = await compact({
      items: transcript,
      boundaryStore,
      trigger: 'proactive',
      summarizer: () => ({ prose: 'compacted', preserved }),
    });

    // The ref is the content digest of the transcript.
    expect(result.boundaryRef).toBe(digestTranscript(transcript));

    // The boundary marker is durably on the log AND in the item projection.
    const events = store.readThread(threadId);
    const compactionItems = events
      .filter((e) => e.payload.type === 'item-appended' && e.payload.item.type === 'compaction')
      .map((e) => e.payload.item);

    expect(compactionItems).toHaveLength(1);
    expect(compactionItems[0].transcriptBoundaryRef).toBe(result.boundaryRef);
    expect(compactionItems[0].trigger).toBe('proactive');
    expect(compactionItems[0].tokensBefore).toBeGreaterThan(0);
  });
});
