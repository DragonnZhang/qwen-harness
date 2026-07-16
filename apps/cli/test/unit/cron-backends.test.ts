import { describe, expect, it } from 'vitest';

import { cronBackendAvailability } from '../../src/scheduler.ts';

/**
 * The three scheduling backends declare EXPLICIT availability (CR-06). The session scheduler is always
 * available; the local daemon and the remote routine peer are available only on their signals, and
 * each states a reason so a caller is never silently downgraded to a weaker backend.
 */

describe('cron backends declare explicit availability (CR-06)', () => {
  it('with no daemon and no remote: only the session scheduler is available', () => {
    const s = cronBackendAvailability({ daemonRunning: false, remoteEndpoint: null });
    const by = (b: string) => s.find((x) => x.backend === b)!;
    expect(by('session-scheduler').available).toBe(true);
    expect(by('local-daemon').available).toBe(false);
    expect(by('remote-routine-peer').available).toBe(false);
  });

  it('a running daemon and a configured remote each flip to available with a stated reason', () => {
    const s = cronBackendAvailability({
      daemonRunning: true,
      remoteEndpoint: 'wss://peer.example',
    });
    const by = (b: string) => s.find((x) => x.backend === b)!;
    expect(by('local-daemon').available).toBe(true);
    expect(by('local-daemon').detail).toContain('lease');
    expect(by('remote-routine-peer').available).toBe(true);
    expect(by('remote-routine-peer').detail).toContain('wss://peer.example');
  });

  it('every backend states a non-empty reason — availability is never silent', () => {
    for (const flags of [
      { daemonRunning: false, remoteEndpoint: null },
      { daemonRunning: true, remoteEndpoint: 'x' },
    ]) {
      for (const b of cronBackendAvailability(flags)) {
        expect(b.detail.length).toBeGreaterThan(0);
      }
    }
    // All three backends are always reported — the set is stable, not conditionally hidden.
    expect(cronBackendAvailability({ daemonRunning: false, remoteEndpoint: null })).toHaveLength(3);
  });
});
