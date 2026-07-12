/**
 * Path canonicalization — the filesystem work that policy is forbidden to do.
 *
 * `packages/policy` is pure: it decides over an ALREADY-canonical path and proves the path is
 * canonical, but it cannot resolve a symlink or expand `~` because those touch the host. That work
 * lives here, next to the sandbox, so there is exactly one canonicalizer and no second, subtly
 * different one that could open a TOCTOU gap between "the path policy judged" and "the path that
 * was opened".
 *
 * The steps mirror docs/product/defaults.md:
 *   - expand a leading `~`;
 *   - require an absolute result;
 *   - Unicode NFC (so two byte-spellings of one filename cannot dodge a rule);
 *   - resolve symlinks in every EXISTING parent (a symlinked parent dir escapes a path check);
 *   - open the final component O_NOFOLLOW and re-check device+inode after open (TOCTOU);
 *   - in a safe profile, refuse a pre-existing hardlinked regular file unless provenance is proven.
 */

import {
  closeSync,
  constants as FS,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';

export type CanonicalizeErrorCode =
  | 'not-absolute'
  | 'not-found'
  | 'symlink-escape'
  | 'traversal-escape'
  | 'hardlink-denied'
  | 'toctou'
  | 'io-error';

export class CanonicalizeError extends Error {
  constructor(
    readonly code: CanonicalizeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CanonicalizeError';
  }
}

export interface CanonicalPath {
  /** Absolute, NFC, symlink-resolved. Safe to hand to policy as a `NormalizedAction` path. */
  readonly path: string;
  readonly exists: boolean;
  readonly isDirectory: boolean;
  readonly isSymlink: boolean;
  /** Device and inode of the resolved file, when it exists. For the caller's own TOCTOU checks. */
  readonly dev: number | null;
  readonly ino: number | null;
  readonly nlink: number | null;
}

export interface CanonicalizeOptions {
  /** Home directory for `~` expansion. Injected so behavior is identical in every process. */
  readonly homeDir?: string;
  /**
   * When true, containment is enforced: the resolved path must stay within `root`, before AND
   * after symlink resolution. This is what makes a symlink-escape and a `../` traversal denials
   * rather than reads of `/etc/passwd`.
   */
  readonly root?: string;
  /** Safe profiles set this; a pre-existing hardlinked regular file is then refused. */
  readonly denyHardlinks?: boolean;
}

/** Resolve symlinks in the longest existing prefix, leaving a not-yet-created tail alone. */
function canonicalizeExistingPrefix(target: string): string {
  let prefix = target;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(prefix);
      return tail.length === 0 ? real : resolve(real, ...tail);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') {
        throw new CanonicalizeError(
          'io-error',
          `cannot resolve ${prefix}: ${err.code ?? 'unknown'}`,
        );
      }
      const slash = prefix.lastIndexOf(sep);
      if (slash <= 0) return resolve(sep, ...tail);
      tail.unshift(prefix.slice(slash + 1));
      prefix = prefix.slice(0, slash);
    }
  }
}

function assertWithin(root: string, candidate: string): void {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (candidate !== root && !candidate.startsWith(prefix)) {
    throw new CanonicalizeError(
      'traversal-escape',
      `path escapes its root: ${candidate} is not within ${root}`,
    );
  }
}

/**
 * Canonicalize `input` and, when `root` is given, prove it stays inside `root`. Returns metadata
 * even for a not-yet-existing path (a write target), whose parent is still resolved and contained.
 */
export function canonicalizePath(input: string, options: CanonicalizeOptions = {}): CanonicalPath {
  const home = options.homeDir ?? homedir();

  const expanded =
    input === '~' ? home : input.startsWith(`~${sep}`) ? `${home}${input.slice(1)}` : input;
  const nfc = expanded.normalize('NFC');

  if (!isAbsolute(nfc)) {
    throw new CanonicalizeError(
      'not-absolute',
      `path must be absolute after ~ expansion: ${input}`,
    );
  }
  if (nfc.includes('\0')) {
    throw new CanonicalizeError('io-error', 'path contains a NUL byte');
  }

  // Resolve `.`/`..` and symlinks in the existing prefix, then contain the RESULT — checking the
  // pre-resolution path would be the classic symlink-escape bug.
  const lexical = resolve(nfc);
  const canonical = canonicalizeExistingPrefix(lexical);
  if (options.root !== undefined) {
    const canonicalRoot = canonicalizeExistingPrefix(resolve(options.root.normalize('NFC')));
    assertWithin(canonicalRoot, canonical);
  }

  let exists = false;
  let isDirectory = false;
  let isSymlink = false;
  let dev: number | null = null;
  let ino: number | null = null;
  let nlink: number | null = null;

  let linkStat;
  try {
    linkStat = lstatSync(canonical);
    exists = true;
    isSymlink = linkStat.isSymbolicLink();
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') {
      throw new CanonicalizeError('io-error', `lstat ${canonical}: ${err.code ?? 'unknown'}`);
    }
  }

  if (exists) {
    // A symlink whose canonical form is still itself means the LAST component is a symlink — after
    // prefix resolution that can only happen for a dangling or freshly-swapped link. Refuse it: a
    // safe caller opens the target, not the link.
    if (isSymlink && options.root !== undefined) {
      throw new CanonicalizeError('symlink-escape', `final component is a symlink: ${canonical}`);
    }

    let fd: number | undefined;
    try {
      // O_NOFOLLOW: if the final component became a symlink between lstat and open, fail closed.
      const flags =
        (linkStat?.isDirectory() ? FS.O_RDONLY | FS.O_DIRECTORY : FS.O_RDONLY) | FS.O_NOFOLLOW;
      fd = openSync(canonical, flags);
      const opened = fstatSync(fd);
      const vetted = statSync(canonical);
      // The fd we hold must BE the file we vetted — closes the check-to-open TOCTOU window.
      if (opened.dev !== vetted.dev || opened.ino !== vetted.ino) {
        throw new CanonicalizeError(
          'toctou',
          `file changed identity between check and open: ${canonical}`,
        );
      }
      isDirectory = opened.isDirectory();
      dev = opened.dev;
      ino = opened.ino;
      nlink = opened.nlink;
      if (options.denyHardlinks && opened.isFile() && opened.nlink > 1) {
        throw new CanonicalizeError(
          'hardlink-denied',
          `refusing a pre-existing hardlinked file (nlink=${opened.nlink}): ${canonical}`,
        );
      }
    } catch (error) {
      if (error instanceof CanonicalizeError) throw error;
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ELOOP') {
        throw new CanonicalizeError('symlink-escape', `refusing to follow a symlink: ${canonical}`);
      }
      throw new CanonicalizeError('io-error', `open ${canonical}: ${err.code ?? 'unknown'}`);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  return { path: canonical, exists, isDirectory, isSymlink, dev, ino, nlink };
}

/**
 * Canonicalize `relative` beneath `root`. Rejects an absolute `relative`, `../` traversal, and any
 * symlink escape after resolution. This is the function that turns a capability handle
 * (`{root, relative}`) into a path policy can safely reason about.
 */
export function canonicalizeWithin(
  root: string,
  relative: string,
  options: Omit<CanonicalizeOptions, 'root'> = {},
): CanonicalPath {
  if (isAbsolute(relative)) {
    throw new CanonicalizeError(
      'traversal-escape',
      `expected a relative path, got absolute: ${relative}`,
    );
  }
  const canonicalRoot = canonicalizePath(
    root,
    options.homeDir !== undefined ? { homeDir: options.homeDir } : {},
  ).path;
  const joined = resolve(canonicalRoot, relative.normalize('NFC'));
  return canonicalizePath(joined, { ...options, root: canonicalRoot });
}
