import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { acquireLease, isLeaseHeld, LeaseError, readLeasePid } from '../../src/lease.ts';

/**
 * The single-writer lease invariant (SS-08).
 *
 * The lease is what stops two independent writers from interleaving a thread's turns. Its guarantee
 * is exactly: while a LIVE process holds the lock, no other process can acquire it — and a holder only
 * ever releases its OWN lock, never one a reclaimer has since taken over. `acquireLease` takes an
 * injectable pid, and this test process's own pid is a conveniently always-alive "live holder".
 */

describe('lease helpers (SS-08, U)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qh-lease-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('records and round-trips the holder pid; reports held only for a live holder', () => {
    const path = join(dir, 'lease');
    const handle = acquireLease(path, process.pid);
    expect(handle.pid).toBe(process.pid);
    expect(readLeasePid(path)).toBe(process.pid);
    expect(isLeaseHeld(path)).toBe(true);
    handle.release();
    expect(isLeaseHeld(path)).toBe(false);
    expect(readLeasePid(path)).toBeNull();
  });

  it('release only removes OUR lock — it never clobbers a lease another pid took over', () => {
    const path = join(dir, 'lease');
    const handle = acquireLease(path, process.pid);
    // Simulate a reclaimer overwriting the lock with a different owner after we were declared stale.
    writeFileSync(path, '424242', 'utf8');
    handle.release();
    // Our release must NOT have deleted the other owner's lock.
    expect(readLeasePid(path)).toBe(424242);
  });
});

describe('single-writer: a live holder excludes every other acquirer (SS-08, P)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qh-lease-p-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('no other pid can acquire while this live process holds the lease', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 2 ** 30 }).filter((p) => p !== process.pid),
        (otherPid) => {
          const path = join(dir, `lease-${otherPid}`);
          const held = acquireLease(path, process.pid);
          try {
            let refused: unknown;
            try {
              acquireLease(path, otherPid);
            } catch (e) {
              refused = e;
            }
            expect(refused).toBeInstanceOf(LeaseError);
            expect((refused as LeaseError).code).toBe('held');
            // The original holder is untouched — the lease did not silently change hands.
            expect(readLeasePid(path)).toBe(process.pid);
          } finally {
            held.release();
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});
