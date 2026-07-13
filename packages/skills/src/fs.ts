/**
 * The filesystem port (and its real Node implementation).
 *
 * `skills` is a declared I/O owner (scripts/graph.ts) — this is the ONLY file in the package that
 * opens `node:fs`. Two reasons it is a port rather than direct calls scattered through the package:
 *
 *   1. Two-level loading (IN-01) is a claim about WHICH reads happen. `readHead` (frontmatter only)
 *      and `readFile` (the whole body) are separate operations precisely so a test can count them
 *      and prove the body is never read until a skill is invoked. A single `readFileSync` sprinkled
 *      through the package would make that claim untestable — and therefore unenforceable.
 *   2. `realpath` is the security primitive of IN-02. Isolating it here keeps the containment check
 *      in one auditable place.
 */

import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';

import { SkillReadError } from './errors.ts';

/** How many bytes of a skill file may be read to obtain its frontmatter. */
export const DEFAULT_HEAD_BYTES = 8 * 1024;

export interface SkillFileSystem {
  /**
   * Read at most `maxBytes` from the START of a file. This is the metadata read (IN-01): it is
   * bounded, so a hostile 2 GiB SKILL.md cannot be pulled into memory during a directory scan.
   * A file that does not exist yields `undefined` — a missing file is not an error, it is absence.
   */
  readHead(path: string, maxBytes: number): string | undefined;
  /** Read a whole file. The BODY read — legal only on invocation/selection. */
  readFile(path: string): string;
  /** Canonicalize, following every symlink. Throws when the path does not exist. */
  realpath(path: string): string;
  isDirectory(path: string): boolean;
  isFile(path: string): boolean;
  /** Directory entries, sorted, for a deterministic scan. A missing directory yields `[]`. */
  listEntries(dir: string): readonly string[];
}

/** The real filesystem. */
export function nodeSkillFileSystem(): SkillFileSystem {
  return {
    readHead(path: string, maxBytes: number): string | undefined {
      let fd: number;
      try {
        fd = openSync(path, 'r');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw new SkillReadError(path, err);
      }
      try {
        const buffer = Buffer.alloc(maxBytes);
        const read = readSync(fd, buffer, 0, maxBytes, 0);
        return buffer.subarray(0, read).toString('utf8');
      } catch (err) {
        throw new SkillReadError(path, err);
      } finally {
        closeSync(fd);
      }
    },

    readFile(path: string): string {
      try {
        return readFileSync(path, 'utf8');
      } catch (err) {
        throw new SkillReadError(path, err);
      }
    },

    realpath(path: string): string {
      try {
        return realpathSync(path);
      } catch (err) {
        throw new SkillReadError(path, err);
      }
    },

    isDirectory(path: string): boolean {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    },

    isFile(path: string): boolean {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    },

    listEntries(dir: string): readonly string[] {
      try {
        return readdirSync(dir).sort();
      } catch {
        return [];
      }
    },
  };
}
