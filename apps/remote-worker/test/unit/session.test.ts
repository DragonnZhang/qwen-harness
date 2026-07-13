import { ManualClock } from '@qwen-harness/protocol';
import { describe, expect, it } from 'vitest';

import { RemoteSession, type Envelope } from '../../src/index.ts';

function session(clock: ManualClock) {
  return new RemoteSession({
    now: () => clock.now(),
    authorityCeilingDigest: 'sha-ceiling',
    disconnectAfterMs: 45_000,
  });
}

function inbound(seq: number, messageId: string, payload: Envelope['payload']): Envelope {
  return {
    version: 1,
    messageId,
    correlationId: null,
    causationId: null,
    threadId: null,
    turnId: null,
    taskId: null,
    sequence: seq,
    deadline: null,
    authorityCeilingDigest: 'sha-ceiling',
    payload,
  };
}

describe('RemoteSession sequencing + idempotency', () => {
  it('assigns monotonic outbound sequences and remembers them for resume', () => {
    const s = session(new ManualClock(0));
    const a = s.frame({ type: 'input', text: 'one' }, { messageId: 'm1' });
    const b = s.frame({ type: 'input', text: 'two' }, { messageId: 'm2' });
    expect([a.sequence, b.sequence]).toEqual([0, 1]);
    expect(s.unacknowledged().map((e) => e.sequence)).toEqual([0, 1]);
  });

  it('an ack lets us forget acknowledged outbound frames (they need never be replayed)', () => {
    const s = session(new ManualClock(0));
    s.frame({ type: 'input', text: 'one' }, { messageId: 'm1' }); // seq 0
    s.frame({ type: 'input', text: 'two' }, { messageId: 'm2' }); // seq 1
    s.receive(inbound(0, 'ack1', { type: 'ack', ackSequence: 0 }));
    // seq 0 is acknowledged and dropped; seq 1 still needs replay on reconnect.
    expect(s.unacknowledged().map((e) => e.sequence)).toEqual([1]);
    expect(s.lastAckedSequence).toBe(0);
  });

  it('dedupes an inbound message by id — a duplicate has no second effect', () => {
    const s = session(new ManualClock(0));
    const env = inbound(0, 'dup', { type: 'input', text: 'hi' });
    expect(s.receive(env).deliver).not.toBeNull();
    // Same message id again -> no delivery.
    expect(s.receive(env).deliver).toBeNull();
  });

  it('tracks the last inbound sequence as the resume point', () => {
    const s = session(new ManualClock(0));
    s.receive(inbound(0, 'a', { type: 'input', text: 'x' }));
    s.receive(inbound(1, 'b', { type: 'input', text: 'y' }));
    expect(s.lastInboundSequence).toBe(1);
  });
});

describe('RemoteSession heartbeat and disconnect (never-replay)', () => {
  it('marks the peer disconnected after the heartbeat lapses', () => {
    const clock = new ManualClock(1000);
    const s = session(clock);
    s.markConnected();
    expect(s.checkHeartbeat()).toBe(false);
    clock.advance(46_000); // beyond 45s
    expect(s.checkHeartbeat()).toBe(true);
    expect(s.state).toBe('disconnected');
  });

  it('a heartbeat refreshes liveness and can reconnect a disconnected peer', () => {
    const clock = new ManualClock(0);
    const s = session(clock);
    s.markConnected();
    clock.advance(46_000);
    s.checkHeartbeat();
    expect(s.state).toBe('disconnected');
    // A heartbeat arrives -> reconnected.
    s.receive(inbound(5, 'hb', { type: 'heartbeat' }));
    expect(s.state).toBe('connected');
  });
});
