import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { Inbox } from './inbox.ts';
import type { ProtocolMessage } from './protocol.ts';

/**
 * The inbox invariants as a PROPERTY, plus crash-replay recovery (AG-06).
 *
 * `inbox.test.ts` pins the ordered/idempotent/wake behaviors on fixed cases. Here: across ANY sequence
 * of deliveries (with duplicate ids forced by a small id pool), `deliver` returns true exactly for a
 * first sighting, ordering follows a strictly-increasing sequence in first-seen order, `pending`
 * equals the count of distinct ids, and a drain empties the inbox. The `F` case is the failure that
 * idempotency exists for: a writer that crashed mid-append and REPLAYS its batch must not duplicate a
 * single message — the inbox after a full replay is byte-identical to the inbox before it.
 */

const msg = (text: string): ProtocolMessage => ({ type: 'message', text });

const idPool = fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f');
const ops = fc.array(fc.record({ id: idPool, now: fc.integer({ min: 0, max: 10_000 }) }), {
  maxLength: 80,
});

describe('Inbox invariants (AG-06, P)', () => {
  it('is ordered, idempotent, and pending-consistent across any delivery sequence', () => {
    fc.assert(
      fc.property(ops, (sequence) => {
        const inbox = new Inbox();
        const firstSeen: string[] = [];
        const seen = new Set<string>();

        for (const op of sequence) {
          const isNew = !seen.has(op.id);
          expect(inbox.deliver(op.id, 'sender', msg(op.id), op.now)).toBe(isNew);
          if (isNew) {
            seen.add(op.id);
            firstSeen.push(op.id);
          }
        }

        // Pending counts DISTINCT ids; nothing is double-counted.
        expect(inbox.pending).toBe(firstSeen.length);

        const drained = inbox.drain();
        // Delivered in first-seen order, on a strictly-increasing sequence.
        expect(drained.map((e) => e.id)).toEqual(firstSeen);
        for (let i = 1; i < drained.length; i++) {
          expect(drained[i]!.seq).toBeGreaterThan(drained[i - 1]!.seq);
        }
        // A drain empties the inbox.
        expect(inbox.pending).toBe(0);

        // Idempotency is permanent: replaying every id after a drain delivers nothing new.
        for (const op of sequence) {
          expect(inbox.deliver(op.id, 'sender', msg(op.id), op.now)).toBe(false);
        }
        expect(inbox.pending).toBe(0);
      }),
      { numRuns: 500 },
    );
  });
});

describe('Inbox crash-replay recovery (AG-06, F)', () => {
  it('a replayed delivery batch (writer crash + retry) never duplicates a message', () => {
    fc.assert(
      fc.property(ops, (sequence) => {
        const inbox = new Inbox();
        for (const op of sequence) inbox.deliver(op.id, 'sender', msg(op.id), op.now);
        const before = inbox.peek().map((e) => ({ id: e.id, seq: e.seq }));

        // The writer crashed after appending, could not confirm, and REPLAYS the whole batch.
        for (const op of sequence) inbox.deliver(op.id, 'sender', msg(op.id), op.now + 1);

        // The inbox is unchanged — same entries, same order, same sequence numbers. No duplication.
        expect(inbox.peek().map((e) => ({ id: e.id, seq: e.seq }))).toEqual(before);
      }),
      { numRuns: 300 },
    );
  });
});
