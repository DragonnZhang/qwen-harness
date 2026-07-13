import { ManualClock } from '@qwen-harness/protocol';
import { describe, expect, it } from 'vitest';

import { RemoteSession } from '../../src/index.ts';

/**
 * Reconnect + resume-from-sequence: after a drop, the peer replays only the outbound frames the
 * other side never acknowledged, and duplicate replays are idempotent. This is what makes remote
 * work survive a disconnect without loss or double-execution.
 */
describe('reconnect and resume-from-sequence', () => {
  it('replays only unacknowledged frames after a reconnect', () => {
    const clock = new ManualClock(0);
    const worker = new RemoteSession({ now: () => clock.now(), authorityCeilingDigest: 'd' });
    worker.markConnected();

    // Worker sends three event batches.
    worker.frame({ type: 'event-batch', events: [1] }, { messageId: 'e0' }); // seq 0
    worker.frame({ type: 'event-batch', events: [2] }, { messageId: 'e1' }); // seq 1
    worker.frame({ type: 'event-batch', events: [3] }, { messageId: 'e2' }); // seq 2

    // The peer acknowledged up to seq 1 before the connection dropped.
    worker.receive({
      version: 1,
      messageId: 'ack',
      correlationId: null,
      causationId: null,
      threadId: null,
      turnId: null,
      taskId: null,
      sequence: 0,
      deadline: null,
      authorityCeilingDigest: 'd',
      payload: { type: 'ack', ackSequence: 1 },
    });

    // On reconnect, only seq 2 is unacknowledged and gets replayed.
    const toReplay = worker.unacknowledged();
    expect(toReplay.map((e) => e.sequence)).toEqual([2]);

    // The receiver applies the replay idempotently — a frame it already saw is a no-op.
    const receiver = new RemoteSession({ now: () => clock.now(), authorityCeilingDigest: 'd' });
    receiver.receive({ ...toReplay[0]! }); // first delivery
    const again = receiver.receive({ ...toReplay[0]! }); // duplicate replay
    expect(again.deliver).toBeNull();
  });
});
