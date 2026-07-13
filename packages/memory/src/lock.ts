/**
 * Concurrent-writer locking and atomic writes (MM-06).
 *
 * Two guarantees, both mechanical:
 *
 *   - {@link atomicWriteFile} never leaves a partial file. It writes to a unique temp file, fsyncs
 *     it, and `rename`s it over the target. `rename` within one directory is atomic on POSIX, so a
 *     reader sees either the old file or the whole new file — never a half-written one. If the
 *     process dies mid-write, the orphan is the temp file; the real file is untouched. That is the
 *     "crash preserves the prior state" property Dream relies on (MM-04).
 *
 *   - {@link FileLock} serializes writers. A writer creates a lock file with `O_EXCL`; a second
 *     writer either waits or, if the holder's LEASE has expired (a crash left the lock behind),
 *     steals it. The lease is renewable, so a long legitimate operation keeps the lock alive while a
 *     dead holder's lock becomes reclaimable after the lease. Last valid writer wins; no writer ever
 *     observes a corrupt file.
 *
 * This package is a declared I/O owner (scripts/graph.ts) for `node:fs`/`node:fs/promises`/
 * `node:path`, which is what makes it the right home for these primitives.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Clock } from '@qwen-harness/protocol';

/** A minimal system clock for real (non-deterministic) waits. Memory is not a pure package. */
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error('aborted'));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        },
        { once: true },
      );
    });
  }
}

export class MemoryLockError extends Error {
  readonly lockPath: string;
  constructor(lockPath: string, detail: string) {
    super(`memory lock ${lockPath}: ${detail}`);
    this.name = 'MemoryLockError';
    this.lockPath = lockPath;
  }
}

interface LockRecord {
  readonly holder: string;
  readonly acquiredAt: number;
  readonly leaseExpiresAt: number;
}

function isErrno(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === code;
}

export interface AcquireOptions {
  readonly clock: Clock;
  /** An identifier for the holder, recorded in the lock for diagnostics. */
  readonly holder: string;
  /** Lease length; a lock older than this is reclaimable by another writer. Default 5 min. */
  readonly leaseMs?: number;
  /** How long to wait for the lock before giving up. Default 30 s. */
  readonly timeoutMs?: number;
  /** Poll interval while waiting. Default 25 ms. */
  readonly retryMs?: number;
}

/** An exclusive, lease-based lock backed by a single lock file. */
export class FileLock {
  readonly lockPath: string;
  readonly #clock: Clock;
  readonly #holder: string;
  readonly #leaseMs: number;
  #leaseExpiresAt: number;
  #released = false;

  private constructor(
    lockPath: string,
    clock: Clock,
    holder: string,
    leaseMs: number,
    leaseExpiresAt: number,
  ) {
    this.lockPath = lockPath;
    this.#clock = clock;
    this.#holder = holder;
    this.#leaseMs = leaseMs;
    this.#leaseExpiresAt = leaseExpiresAt;
  }

  get leaseExpiresAt(): number {
    return this.#leaseExpiresAt;
  }

  static async acquire(lockPath: string, options: AcquireOptions): Promise<FileLock> {
    const { clock, holder } = options;
    const leaseMs = options.leaseMs ?? 5 * 60 * 1000;
    const timeoutMs = options.timeoutMs ?? 30_000;
    const retryMs = options.retryMs ?? 25;
    const deadline = clock.now() + timeoutMs;

    await mkdir(dirname(lockPath), { recursive: true });

    for (;;) {
      const now = clock.now();
      const record: LockRecord = {
        holder,
        acquiredAt: now,
        leaseExpiresAt: now + leaseMs,
      };
      try {
        // `wx` = O_CREAT | O_EXCL: fails if the lock already exists. This is the atomic test-and-set.
        const handle = await open(lockPath, 'wx');
        try {
          await handle.writeFile(JSON.stringify(record), 'utf8');
        } finally {
          await handle.close();
        }
        return new FileLock(lockPath, clock, holder, leaseMs, record.leaseExpiresAt);
      } catch (err) {
        if (!isErrno(err, 'EEXIST')) throw err;
      }

      // The lock exists. If its lease has expired, the previous holder is gone — steal it.
      const stale = await FileLock.#isStale(lockPath, clock.now());
      if (stale) {
        await rm(lockPath, { force: true }).catch(() => undefined);
        continue;
      }

      if (clock.now() >= deadline) {
        throw new MemoryLockError(lockPath, `not acquired within ${timeoutMs}ms`);
      }
      await clock.sleep(retryMs);
    }
  }

  static async #isStale(lockPath: string, now: number): Promise<boolean> {
    try {
      const raw = await readFile(lockPath, 'utf8');
      const record = JSON.parse(raw) as LockRecord;
      return typeof record.leaseExpiresAt !== 'number' || record.leaseExpiresAt <= now;
    } catch (err) {
      // Gone already (another stealer won) — treat as reclaimable. A corrupt lock is also reclaimable.
      if (isErrno(err, 'ENOENT')) return true;
      return true;
    }
  }

  /**
   * Extend the lease. Throws {@link MemoryLockError} if the lock was lost — stolen by another writer
   * after our lease expired, or removed — so a caller that lost the lock stops before it writes and
   * the prior state is preserved (MM-04).
   */
  async renew(): Promise<void> {
    if (this.#released) throw new MemoryLockError(this.lockPath, 'renew after release');
    let current: LockRecord;
    try {
      current = JSON.parse(await readFile(this.lockPath, 'utf8')) as LockRecord;
    } catch (err) {
      if (isErrno(err, 'ENOENT')) throw new MemoryLockError(this.lockPath, 'lock lost (removed)');
      throw err;
    }
    if (current.holder !== this.#holder) {
      throw new MemoryLockError(this.lockPath, `lock lost (held by ${current.holder})`);
    }
    const now = this.#clock.now();
    const record: LockRecord = {
      holder: this.#holder,
      acquiredAt: current.acquiredAt,
      leaseExpiresAt: now + this.#leaseMs,
    };
    // A plain overwrite is safe: we have verified we still hold the lock.
    const handle = await open(this.lockPath, 'w');
    try {
      await handle.writeFile(JSON.stringify(record), 'utf8');
    } finally {
      await handle.close();
    }
    this.#leaseExpiresAt = record.leaseExpiresAt;
  }

  async release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    // Only remove the lock if we still hold it, so we never delete a lock another writer stole.
    try {
      const current = JSON.parse(await readFile(this.lockPath, 'utf8')) as LockRecord;
      if (current.holder === this.#holder) await rm(this.lockPath, { force: true });
    } catch {
      // Already gone or unreadable: nothing to release.
    }
  }
}

export interface AtomicWriteOptions {
  /**
   * A hook run AFTER the temp file is written and fsynced but BEFORE the rename. Throwing here
   * simulates a crash at the most dangerous instant; the target file must remain the prior version.
   * Used by failure-injection tests (MM-04, evidence F).
   */
  readonly onBeforeRename?: () => void | Promise<void>;
}

/**
 * Write `data` to `path` atomically: temp file -> fsync -> rename. A reader never sees a partial
 * write, and a failure before the rename leaves the previous file intact.
 */
export async function atomicWriteFile(
  path: string,
  data: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(8).toString('hex')}`;
  try {
    const handle = await open(tmp, 'w');
    try {
      await handle.writeFile(data, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (options.onBeforeRename) await options.onBeforeRename();
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}
