import { openSync, closeSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { constants as FS } from 'node:fs';

/**
 * The single-writer lease (SS-08).
 *
 * One per-user daemon holds the writer lease for a thread; additional clients attach through it or
 * explicitly fork. Two independent SQLite writers must never interleave a thread's turns, and this
 * lease is what enforces that above the storage layer: a second daemon trying to write the same
 * thread cannot acquire the lease and must attach to the holder instead.
 *
 * The mechanism is an exclusive lock file (`O_CREAT | O_EXCL`) holding the holder's pid. O_EXCL is
 * atomic at the filesystem level — exactly one caller creates the file. A stale lock from a crashed
 * process (its pid no longer exists) is reclaimable; a lock held by a live process is not.
 */

export class LeaseError extends Error {
  constructor(
    readonly code: 'held' | 'not-owner' | 'io-error',
    message: string,
    readonly holderPid?: number,
  ) {
    super(message);
    this.name = 'LeaseError';
  }
}

export interface LeaseHandle {
  readonly path: string;
  readonly pid: number;
  release(): void;
}

/** Is a process with this pid alive? `kill(pid, 0)` probes without signaling. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = no such process; EPERM = exists but not ours (still alive).
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Acquire the writer lease, or throw `LeaseError('held')` naming the live holder.
 *
 * A lock file whose recorded pid is dead is treated as stale and reclaimed — a crashed daemon does
 * not lock a user out forever. A lock file whose pid is alive is a genuine conflict.
 */
export function acquireLease(path: string, pid = process.pid): LeaseHandle {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, FS.O_CREAT | FS.O_EXCL | FS.O_WRONLY, 0o600);
      writeFileSync(fd, String(pid), 'utf8');
      closeSync(fd);
      return makeHandle(path, pid);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new LeaseError(
          'io-error',
          `cannot acquire lease at ${path}: ${(e as Error).message}`,
        );
      }
      // The lock exists. Is its holder alive?
      const holder = readLeasePid(path);
      if (holder !== null && holder !== pid && pidAlive(holder)) {
        throw new LeaseError('held', `thread is locked by a live daemon (pid ${holder})`, holder);
      }
      // Stale (dead holder) or ours — reclaim it and retry once.
      try {
        unlinkSync(path);
      } catch {
        // Someone else reclaimed it first; the retry will contend again.
      }
    }
  }
  throw new LeaseError(
    'io-error',
    `could not acquire lease at ${path} after reclaiming a stale lock`,
  );
}

export function readLeasePid(path: string): number | null {
  try {
    const n = Number(readFileSync(path, 'utf8').trim());
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

export function isLeaseHeld(path: string): boolean {
  if (!existsSync(path)) return false;
  const holder = readLeasePid(path);
  return holder !== null && pidAlive(holder);
}

function makeHandle(path: string, pid: number): LeaseHandle {
  let released = false;
  return {
    path,
    pid,
    release() {
      if (released) return;
      released = true;
      // Only remove the lock if WE still hold it — never clobber a lease another process took over
      // after reclaiming ours (which would only happen if we were wrongly declared stale).
      if (readLeasePid(path) === pid) {
        try {
          unlinkSync(path);
        } catch {
          // already gone
        }
      }
    },
  };
}
