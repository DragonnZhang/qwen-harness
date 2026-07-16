import { ManualClock } from '@qwen-harness/protocol';
import { describe, expect, it } from 'vitest';

import { RemoteSession, type Envelope } from '../../src/index.ts';

/**
 * Remote-peer LIFETIME is heartbeat-gated, and a reconnect resumes rather than re-does (BG-07).
 *
 * BG-07 requires that no process is reported alive without a heartbeat, and that the distinct
 * lifetime events are handled correctly on a drop: a peer that goes silent is marked disconnected
 * (its in-flight work is `unknown`, never blindly replayed), while a reconnect replays ONLY the frames
 * the other side never acknowledged. This is the remote-peer category; the definition (durable),
 * local-process (dies with its parent), and daemon (reconstructs from the log) lifetimes are covered
 * by their own suites — see the checkpoint mapping.
 */

function session(clock: ManualClock): RemoteSession {
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

describe('remote-peer liveness is heartbeat-gated (BG-07, F)', () => {
  it('a peer silent past the window is marked disconnected — never reported alive on silence', () => {
    const clock = new ManualClock(0);
    const s = session(clock);
    s.markConnected();
    expect(s.state).toBe('connected');

    // Exactly at the window: still within tolerance.
    clock.advance(45_000);
    expect(s.checkHeartbeat()).toBe(false);
    expect(s.state).toBe('connected');

    // One ms past the window with no heartbeat: it transitions to disconnected.
    clock.advance(1);
    expect(s.checkHeartbeat()).toBe(true);
    expect(s.state).toBe('disconnected');
  });

  it('a heartbeat within the window refreshes liveness — the peer stays connected', () => {
    const clock = new ManualClock(0);
    const s = session(clock);
    s.markConnected();
    clock.advance(40_000);
    // A heartbeat arrives — liveness is refreshed to now.
    s.receive(inbound(0, 'hb', { type: 'heartbeat' }));
    // 40s more elapse — 80s since connect, but only 40s since the heartbeat.
    clock.advance(40_000);
    expect(s.checkHeartbeat()).toBe(false);
    expect(s.state).toBe('connected');
  });

  it('a reconnect replays ONLY unacknowledged work — acknowledged work is never re-done', () => {
    const clock = new ManualClock(0);
    const s = session(clock);
    s.markConnected();
    s.frame({ type: 'input', text: 'a' }, { messageId: 'm1' }); // seq 0
    s.frame({ type: 'input', text: 'b' }, { messageId: 'm2' }); // seq 1
    // The peer acknowledged seq 0 before the drop.
    s.receive(inbound(0, 'ack', { type: 'ack', ackSequence: 0 }));
    // On reconnect, exactly the unacknowledged frame resumes; the acked one is not repeated.
    expect(s.unacknowledged().map((e) => e.sequence)).toEqual([1]);
  });
});
