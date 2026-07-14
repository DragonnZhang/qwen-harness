import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { CorrelationId, ThreadId } from '@qwen-harness/protocol';
import { ManualClock, SequentialIds, USER_ACTOR } from '@qwen-harness/testkit';

import { EventStore, exportJsonl, importJsonl } from '../../src/index.ts';

/**
 * RT-09 (property): unknown FUTURE event payloads survive export -> import byte-for-byte.
 *
 * The fixture suite proves one hand-written "from-the-future" event survives. This proves the
 * invariant over the whole space: for ANY number of future events, each carrying an arbitrarily
 * shaped JSON payload with a `type` this build has never heard of, exporting the store to JSONL and
 * importing it back reproduces every unknown payload with not one byte altered — no dropped field,
 * no reordered key, no coerced value — and classifies each as `unknown` with its original type
 * intact.
 *
 * Why this would FAIL if the behavior regressed: the payload is compared by its canonical JSON
 * string against exactly what was stored. If import silently dropped an unrecognized event, or
 * re-validated it against the known schema and stripped extra fields, or lost `originalType`, the
 * string comparison / count / type check would diverge and fast-check would shrink to a minimal
 * counterexample.
 */

const THREAD = 'thr_000001' as ThreadId;
const CORR = 'cor_000001' as CorrelationId;

function newStore(): EventStore {
  return new EventStore({
    path: ':memory:',
    clock: new ManualClock(1_700_000_000_000),
    ids: new SequentialIds(),
  });
}

/** Arbitrary JSON objects — the "extra fields" a future payload might carry, nested arbitrarily. */
const extraFieldsArb: fc.Arbitrary<Record<string, unknown>> = fc.dictionary(
  fc.string(),
  fc.jsonValue(),
) as fc.Arbitrary<Record<string, unknown>>;

describe('exportJsonl/importJsonl preserves arbitrary unknown payloads (RT-09, property)', () => {
  it('round-trips any set of future events byte-for-byte through export -> import', () => {
    fc.assert(
      fc.property(fc.array(extraFieldsArb, { minLength: 1, maxLength: 8 }), (extras) => {
        const store = newStore();

        // A valid seed event so the thread projection exists (seq 0).
        store.append({
          threadId: THREAD,
          correlationId: CORR,
          permissionProfile: 'ask',
          actor: USER_ACTOR,
          payload: { type: 'thread-created', cwd: '/w', canonicalRepo: null, name: null },
        });

        // Insert each future event directly, exactly as a newer build's writer would: a payload
        // type this build does not know, plus arbitrary shape. Record the canonical stored bytes.
        const insert = store.db.prepare(
          `INSERT INTO events (id, schema_version, thread_id, seq, timestamp, actor_kind, actor_id,
             correlation_id, permission_profile, payload_type, payload)
           VALUES (@id, 99, @threadId, @seq, 123, 'model', 'act_model1', 'cor_000001', 'ask',
             @payloadType, @payload)`,
        );

        const expected = extras.map((extra, i) => {
          // A guaranteed-unknown, unique type. No known event type starts with "future." — so the
          // parser must classify these as `unknown`, never coincidentally match a real schema.
          const type = `future.${i}.${Object.keys(extra).length}`;
          const payload: Record<string, unknown> = { ...extra, type };
          const stored = JSON.stringify(payload);
          insert.run({
            id: `evt_future${String(i).padStart(4, '0')}`,
            threadId: THREAD,
            seq: i + 1,
            payloadType: type,
            payload: stored,
          });
          return { type, stored };
        });

        const jsonl = exportJsonl(store, { exportedAt: 0 });
        const parsed = importJsonl(jsonl);
        store.close();

        // Header count reflects seed + all future events; the parser never dropped one.
        expect(parsed.header.eventCount).toBe(extras.length + 1);
        expect(parsed.unknownCount).toBe(extras.length);

        const unknownByType = new Map<string, unknown>();
        for (const ev of parsed.events) {
          if (ev.payload.type === 'unknown') {
            expect(typeof ev.payload.originalType).toBe('string');
            unknownByType.set(ev.payload.originalType, ev.payload.raw);
          }
        }

        // Every future payload came back, and its bytes are identical to what was stored.
        expect(unknownByType.size).toBe(expected.length);
        for (const { type, stored } of expected) {
          expect(unknownByType.has(type)).toBe(true);
          expect(JSON.stringify(unknownByType.get(type))).toBe(stored);
        }
      }),
      { numRuns: 300 },
    );
  });
});
