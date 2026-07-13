/**
 * The on-disk memory store (MM-01, MM-05, MM-06).
 *
 * Memory FILES are Markdown on disk — that is the product's memory format, not an implementation
 * detail — so this store owns reading and writing them. It is the concrete home of the I/O this
 * package is a declared owner of (scripts/graph.ts). Everything with real safety weight is delegated
 * to the primitives that were built and tested in isolation:
 *
 *   - parse/serialize -> frontmatter.ts   (typed, file-named errors)
 *   - locking + atomic write -> lock.ts   (no partial files, crash-safe)
 *   - redaction -> @qwen-harness/storage  (a stored memory never contains a secret)
 *
 * Listing is FAILURE-ISOLATED: one unreadable or malformed memory file is recorded and skipped, and
 * the rest still load (MM-02). A write goes through the lock and the atomic rename, so two concurrent
 * writers to one file cannot corrupt it and the last valid write wins (MM-06).
 */

import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { Clock } from '@qwen-harness/protocol';
import type { Redactor } from '@qwen-harness/storage';

import type { Memory } from './frontmatter.ts';
import { MemoryFormatError, parseMemory, serializeMemory } from './frontmatter.ts';
import { MEMORY_INDEX_FILENAME, loadMemoryIndex, type LoadedIndex } from './index-file.ts';
import { atomicWriteFile, FileLock } from './lock.ts';
import type { MemoryCandidate } from './retrieval.ts';
import type { MemoryProvenance, MemoryScope } from './scopes.ts';

/** A memory as loaded from disk, with its provenance and last-modified time. */
export interface LoadedMemoryRecord {
  readonly memory: Memory;
  readonly provenance: MemoryProvenance;
  /** File mtime in epoch ms — the `updatedAt` consolidation uses to resolve conflicts. */
  readonly updatedAt: number;
}

export interface ListResult {
  readonly records: readonly LoadedMemoryRecord[];
  /** Files that could not be read or parsed. Recorded, never fatal (MM-02). */
  readonly errors: readonly { path: string; error: Error }[];
}

function isErrno(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === code;
}

export interface MemoryStoreOptions {
  readonly clock: Clock;
  /**
   * A redactor applied at the STORAGE boundary on every write, so a memory file on disk can never
   * contain a secret even if an upstream filter missed one (defence in depth, mirrors
   * @qwen-harness/storage's redact-before-persist rule).
   */
  readonly redactor?: Redactor;
}

export class MemoryStore {
  readonly #clock: Clock;
  readonly #redactor: Redactor | undefined;

  constructor(options: MemoryStoreOptions) {
    this.#clock = options.clock;
    this.#redactor = options.redactor;
  }

  /** Read and parse one memory file. Throws {@link MemoryFormatError} naming the file on bad input. */
  async readMemory(path: string, scope: MemoryScope): Promise<LoadedMemoryRecord> {
    const text = await readFile(path, 'utf8');
    const info = await stat(path);
    const memory = parseMemory(text, path);
    return { memory, provenance: { scope, path }, updatedAt: info.mtimeMs };
  }

  /**
   * Load every `*.md` memory in a directory except the index. Unreadable or malformed files are
   * collected in `errors` and skipped — the failure-isolation boundary for retrieval (MM-02).
   */
  async listMemories(dir: string, scope: MemoryScope): Promise<ListResult> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return { records: [], errors: [] };
      throw err;
    }

    const records: LoadedMemoryRecord[] = [];
    const errors: { path: string; error: Error }[] = [];
    for (const entry of entries.sort()) {
      if (!entry.endsWith('.md') || entry === MEMORY_INDEX_FILENAME) continue;
      const path = join(dir, entry);
      try {
        records.push(await this.readMemory(path, scope));
      } catch (err) {
        errors.push({
          path,
          error: err instanceof Error ? err : new MemoryFormatError(path, String(err)),
        });
      }
    }
    return { records, errors };
  }

  /** Load `MEMORY.md` for a scope directory, truncated to the first 200 lines / 25 KiB (MM-01). */
  async loadIndex(dir: string): Promise<LoadedIndex> {
    try {
      const text = await readFile(join(dir, MEMORY_INDEX_FILENAME), 'utf8');
      return loadMemoryIndex(text);
    } catch (err) {
      if (isErrno(err, 'ENOENT')) {
        return { content: '', truncated: false, lines: 0, bytes: 0, stoppedBy: null };
      }
      throw err;
    }
  }

  /**
   * Write a memory to `<dir>/<name>.md`, serialized and redacted, under a per-file lock and an atomic
   * rename. Returns the file path. Two concurrent writers to the same name serialize on the lock;
   * neither can observe a partial file (MM-06).
   */
  async writeMemory(
    dir: string,
    memory: Memory,
    scope: MemoryScope,
    options: { holder?: string; leaseMs?: number; timeoutMs?: number } = {},
  ): Promise<{ path: string; provenance: MemoryProvenance }> {
    const path = join(dir, `${memory.name}.md`);
    const serialized = serializeMemory(memory);
    const data = this.#redactor ? this.#redactor.redact(serialized) : serialized;

    const lock = await FileLock.acquire(`${path}.lock`, {
      clock: this.#clock,
      holder: options.holder ?? 'memory-store',
      ...(options.leaseMs !== undefined ? { leaseMs: options.leaseMs } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    try {
      await atomicWriteFile(path, data);
    } finally {
      await lock.release();
    }
    return { path, provenance: { scope, path } };
  }

  /** Remove a memory file (a retired or superseded memory). Missing is not an error. */
  async removeMemory(path: string): Promise<void> {
    await rm(path, { force: true });
  }

  /** Write `MEMORY.md` atomically. `onBeforeRename` is a failure-injection hook for tests (MM-04). */
  async writeIndex(
    dir: string,
    content: string,
    options: { onBeforeRename?: () => void | Promise<void> } = {},
  ): Promise<string> {
    const path = join(dir, MEMORY_INDEX_FILENAME);
    const data = this.#redactor ? this.#redactor.redact(content) : content;
    await atomicWriteFile(path, data, options);
    return path;
  }
}

/**
 * Turn loaded records into retrieval candidates. `readBody` returns the already-loaded body, so
 * side-selection stays cheap; retrieval's own try/catch still isolates any body it cannot use.
 */
export function recordsToCandidates(records: readonly LoadedMemoryRecord[]): MemoryCandidate[] {
  return records.map((record) => ({
    name: record.memory.name,
    description: record.memory.description,
    type: record.memory.type,
    scope: record.provenance.scope,
    path: record.provenance.path,
    readBody: () => record.memory.body,
  }));
}
