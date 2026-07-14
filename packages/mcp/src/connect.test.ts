import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { connectAll } from './connect.ts';
import type { McpClient } from './client.ts';

/**
 * MC-06 property: the bounded-parallel connect pool. Connecting N servers with a concurrency cap
 * must never run more than `cap` handshakes at once and must connect EVERY server exactly once —
 * never dropping one, never connecting one twice. A fake connector records the live in-flight count
 * so the concurrency invariant is observed directly, not assumed.
 */

interface ConcurrencyTracker {
  inFlight: number;
  max: number;
  readonly connected: string[];
}

function fakeClients(n: number, tracker: ConcurrencyTracker): readonly McpClient[] {
  return Array.from({ length: n }, (_unused, i) => {
    const server = `srv_${i}`;
    const fake = {
      server,
      connect: async (): Promise<void> => {
        const now = ++tracker.inFlight;
        if (now > tracker.max) tracker.max = now;
        tracker.connected.push(server);
        // Yield so multiple workers genuinely overlap in flight (else the cap test is vacuous).
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        tracker.inFlight -= 1;
      },
    };
    return fake as unknown as McpClient;
  });
}

describe('connectAll bounded-parallel pool (MC-06, property)', () => {
  it('never exceeds the concurrency cap and connects every server exactly once', async () => {
    let observedMaxAcrossRuns = 0;

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: 1, max: 8 }),
        async (n, cap) => {
          const tracker: ConcurrencyTracker = { inFlight: 0, max: 0, connected: [] };
          const clients = fakeClients(n, tracker);

          const outcomes = await connectAll(clients, cap);

          const effectiveCap = Math.min(cap, n);
          observedMaxAcrossRuns = Math.max(observedMaxAcrossRuns, tracker.max);

          // The cap invariant: in-flight never exceeded the requested (effective) concurrency.
          expect(tracker.max).toBeLessThanOrEqual(cap);
          expect(tracker.max).toBeLessThanOrEqual(effectiveCap);
          // And everything drained back out.
          expect(tracker.inFlight).toBe(0);

          // Every server connected exactly once: no drops, no duplicates.
          const expectedServers = Array.from({ length: n }, (_u, i) => `srv_${i}`);
          expect([...tracker.connected].sort()).toEqual([...expectedServers].sort());

          // The public result reports each server once and successfully.
          expect(outcomes).toHaveLength(n);
          expect(outcomes.every((o) => o.ok && o.error === null)).toBe(true);
          expect(outcomes.map((o) => o.server).sort()).toEqual([...expectedServers].sort());
          return true;
        },
      ),
      { numRuns: 200 },
    );

    // The cap property is only meaningful if the pool actually ran things in parallel.
    expect(observedMaxAcrossRuns).toBeGreaterThan(1);
  });
});
