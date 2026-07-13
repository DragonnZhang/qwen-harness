import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { acquireLease, isLeaseHeld, LeaseError, readLeasePid } from '../../src/index.ts';

describe('single-writer lease (SS-08)', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qh-lease-'));
    path = join(dir, 'thread.lock');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('acquires a lease and records the pid', () => {
    const lease = acquireLease(path, 12345);
    expect(readLeasePid(path)).toBe(12345);
    expect(isLeaseHeld(path)).toBe(false); // pid 12345 is not alive in this test process
    lease.release();
    expect(readLeasePid(path)).toBeNull();
  });

  it('refuses a second acquire while a LIVE holder has it', () => {
    // The current process pid IS alive, so a second acquire must be refused.
    const lease = acquireLease(path, process.pid);
    try {
      expect(() => acquireLease(path, process.pid + 1)).toThrow(LeaseError);
      // The error names the live holder.
      try {
        acquireLease(path, process.pid + 1);
      } catch (e) {
        expect((e as LeaseError).code).toBe('held');
        expect((e as LeaseError).holderPid).toBe(process.pid);
      }
    } finally {
      lease.release();
    }
  });

  it('reclaims a STALE lock from a dead process', () => {
    // A lock from a pid that does not exist (very high) is stale and reclaimable.
    const deadPid = 2_000_000_000;
    acquireLease(path, deadPid).release();
    // Simulate a stale lock by writing a dead pid directly, then acquiring.
    acquireLease(path, deadPid); // writes deadPid
    // A fresh daemon reclaims the stale lock.
    const fresh = acquireLease(path, process.pid);
    expect(readLeasePid(path)).toBe(process.pid);
    fresh.release();
  });
});
