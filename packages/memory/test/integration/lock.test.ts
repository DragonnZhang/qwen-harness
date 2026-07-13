import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  atomicWriteFile,
  FileLock,
  MemoryLockError,
  MemoryStore,
  SystemClock,
  type Memory,
} from '../../src/index.ts';

/** Concurrent writers and atomic writes against REAL files (MM-06, MM-04). */
describe('locking and atomic writes (MM-06, MM-04)', () => {
  let dir: string;
  const clock = new SystemClock();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qh-memlock-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('atomicWriteFile never leaves a partial file (temp + rename)', async () => {
    const target = join(dir, 'MEMORY.md');
    await atomicWriteFile(target, 'first version\n');
    await atomicWriteFile(target, 'second version\n');
    expect(readFileSync(target, 'utf8')).toBe('second version\n');
    // No temp files linger.
    expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toHaveLength(0);
  });

  it('a crash between temp-write and rename leaves the PRIOR file intact (MM-04, F)', async () => {
    const target = join(dir, 'MEMORY.md');
    await atomicWriteFile(target, 'prior index\n');

    await expect(
      atomicWriteFile(target, 'new index that must not commit\n', {
        onBeforeRename: () => {
          throw new Error('injected crash before rename');
        },
      }),
    ).rejects.toThrow('injected crash');

    // The old content survives untouched; no partial file; no temp orphan.
    expect(readFileSync(target, 'utf8')).toBe('prior index\n');
    expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toHaveLength(0);
  });

  it('the store index write is atomic under an injected crash', async () => {
    const store = new MemoryStore({ clock });
    await store.writeIndex(dir, '# prior\n');
    await expect(
      store.writeIndex(dir, '# doomed\n', {
        onBeforeRename: () => Promise.reject(new Error('crash')),
      }),
    ).rejects.toThrow('crash');
    expect(readFileSync(join(dir, 'MEMORY.md'), 'utf8')).toBe('# prior\n');
  });

  it('two concurrent writers to the same memory file: no corruption, a valid file remains', async () => {
    const store = new MemoryStore({ clock });
    const mem = (body: string): Memory => ({
      name: 'contended',
      description: 'a contended memory',
      type: 'project',
      body,
    });

    // Fire many writers at the same file concurrently.
    const writers = Array.from({ length: 12 }, (_, i) =>
      store.writeMemory(dir, mem(`version ${i}`), 'project', { holder: `w${i}` }),
    );
    const results = await Promise.all(writers);
    const path = results[0]!.path;

    // The file parses cleanly (no interleaved/partial write) and holds exactly one valid version.
    const record = await store.readMemory(path, 'project');
    expect(record.memory.name).toBe('contended');
    expect(record.memory.body).toMatch(/^version \d+$/);

    // Lock file is released; no temp orphans.
    expect(existsSync(`${path}.lock`)).toBe(false);
    expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toHaveLength(0);
  });

  it('an expired lease is reclaimable by another writer (crash recovery)', async () => {
    const lockPath = join(dir, 'x.lock');
    // A short lease held by a "crashed" holder that never releases.
    const dead = await FileLock.acquire(lockPath, {
      clock,
      holder: 'dead',
      leaseMs: 10,
      timeoutMs: 1000,
    });
    // Do not release `dead`; simulate the process vanishing. After the lease elapses, another
    // writer can steal the lock.
    await new Promise((r) => setTimeout(r, 30));
    const fresh = await FileLock.acquire(lockPath, {
      clock,
      holder: 'fresh',
      leaseMs: 5000,
      timeoutMs: 1000,
    });
    expect(fresh.lockPath).toBe(lockPath);
    await fresh.release();
    // The dead holder's release is now a no-op (it no longer holds the lock).
    await dead.release();
  });

  it('renew() throws once the lock has been stolen', async () => {
    const lockPath = join(dir, 'y.lock');
    const a = await FileLock.acquire(lockPath, {
      clock,
      holder: 'a',
      leaseMs: 10,
      timeoutMs: 1000,
    });
    await new Promise((r) => setTimeout(r, 30));
    const b = await FileLock.acquire(lockPath, {
      clock,
      holder: 'b',
      leaseMs: 5000,
      timeoutMs: 1000,
    });
    await expect(a.renew()).rejects.toBeInstanceOf(MemoryLockError);
    await b.release();
  });

  it('times out when the lock is held and unexpired', async () => {
    const lockPath = join(dir, 'z.lock');
    const held = await FileLock.acquire(lockPath, {
      clock,
      holder: 'holder',
      leaseMs: 60_000,
      timeoutMs: 5000,
    });
    await expect(
      FileLock.acquire(lockPath, {
        clock,
        holder: 'waiter',
        leaseMs: 1000,
        timeoutMs: 80,
        retryMs: 10,
      }),
    ).rejects.toBeInstanceOf(MemoryLockError);
    await held.release();
  });
});
