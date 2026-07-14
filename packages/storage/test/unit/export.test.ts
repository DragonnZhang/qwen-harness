import type { CorrelationId, ThreadId, TurnId } from '@qwen-harness/protocol';
import { ManualClock, SequentialIds, USER_ACTOR } from '@qwen-harness/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EventStore } from '../../src/event-store.ts';
import { EXPORT_FORMAT_VERSION, exportJsonl, importJsonl, replayInto } from '../../src/export.ts';

/**
 * Focused unit tests for the JSONL export/replay CONTRACT (SS-06, class U).
 *
 * The property test (`export-unknown-roundtrip.property.test.ts`) fuzzes unknown-event survival and
 * the security test (`redaction.test.ts`) proves scrubbing; this covers the export FORMAT itself and
 * `importJsonl`'s validation branches — the header shape, the one-event-per-line layout, and the
 * errors that a corrupt or too-new export must raise rather than silently mis-import.
 */

const THREAD = 'thr_000001' as ThreadId;
const CORR = 'cor_000001' as CorrelationId;
const NOW = 1_700_000_000_000;

describe('JSONL export/import contract (SS-06 U)', () => {
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
    store.append({
      threadId: THREAD,
      turnId: 'trn_000001' as TurnId,
      correlationId: CORR,
      permissionProfile: 'ask',
      actor: USER_ACTOR,
      payload: { type: 'turn-started', userText: 'hello' },
    });
  });

  afterEach(() => store.close());

  it('writes one header line then one JSON event per line', () => {
    const jsonl = exportJsonl(store, { threadId: THREAD, exportedAt: NOW });
    const lines = jsonl.split('\n').filter((l) => l.length > 0);
    const header = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(header['format']).toBe('qwen-harness/jsonl');
    expect(header['formatVersion']).toBe(EXPORT_FORMAT_VERSION);
    expect(header['threadId']).toBe(THREAD);
    expect(header['eventCount']).toBe(2);
    // The remaining lines are the two events, in order, each valid JSON.
    expect(lines).toHaveLength(3);
    const first = JSON.parse(lines[1]!) as { payload: { type: string } };
    expect(first.payload.type).toBe('thread-created');
  });

  it('round-trips the events (export → import) preserving order and identity', () => {
    const original = store.readThread(THREAD);
    const result = importJsonl(exportJsonl(store, { threadId: THREAD, exportedAt: NOW }));
    expect(result.header.eventCount).toBe(original.length);
    expect(result.unknownCount).toBe(0);
    expect(result.events.map((e) => e.id)).toEqual(original.map((e) => e.id));
    expect(result.events.map((e) => e.payload.type)).toEqual(original.map((e) => e.payload.type));
  });

  it('replay into a FRESH store rebuilds the identical thread projection', () => {
    const jsonl = exportJsonl(store, { threadId: THREAD, exportedAt: NOW });
    const fresh = new EventStore({ path: ':memory:', clock, ids });
    replayInto(fresh, importJsonl(jsonl).events);
    const before = store.readThread(THREAD).map((e) => ({ seq: e.seq, type: e.payload.type }));
    const after = fresh.readThread(THREAD).map((e) => ({ seq: e.seq, type: e.payload.type }));
    expect(after).toEqual(before);
    fresh.close();
  });

  it('rejects a missing header, a foreign format, a too-new version, and a count mismatch', () => {
    expect(() => importJsonl('')).toThrow(/header/i);
    expect(() => importJsonl('{"format":"something-else"}\n')).toThrow(/format/i);
    const tooNew = JSON.stringify({
      format: 'qwen-harness/jsonl',
      formatVersion: EXPORT_FORMAT_VERSION + 1,
      exportedAt: NOW,
      threadId: THREAD,
      eventCount: 0,
    });
    expect(() => importJsonl(`${tooNew}\n`)).toThrow(/version/i);
    // A header that claims more events than the body contains is a corrupt export.
    const jsonl = exportJsonl(store, { threadId: THREAD, exportedAt: NOW });
    const lines = jsonl.split('\n').filter((l) => l.length > 0);
    const badHeader = JSON.stringify({ ...JSON.parse(lines[0]!), eventCount: 99 });
    expect(() => importJsonl([badHeader, ...lines.slice(1)].join('\n'))).toThrow(/events/i);
  });
});
