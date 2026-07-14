/**
 * The `@`-file completion surface (UI-04).
 *
 * Typing `@` in the editor opens a menu that completes a path to a file or directory in the
 * workspace. It is the file-mention analogue of the slash-command menu: a pure query extractor
 * ({@link atCompletionQuery}) plus a host lister ({@link listFileMatches}) that the editor renders
 * and, on selection, splices back into the buffer.
 *
 * SAFETY (the `S` evidence class). Two independent guards:
 *
 *   1. CONFINEMENT — a partial is resolved against the workspace root and the resulting directory
 *      must stay INSIDE it. `@../../etc/passwd` resolves outside the root, so it lists NOTHING; the
 *      completion menu can never enumerate or leak paths outside the workspace the user opened.
 *   2. INERT DISPLAY — a directory entry is an untrusted filename (an attacker can create a file whose
 *      name embeds escape sequences or bidi overrides). Every displayed name is returned as
 *      {@link SafeText} via {@link sanitize}, so it can never style the terminal or spoof a path.
 *
 * The lister takes its directory reader by injection so the confinement and sorting logic is tested
 * without touching the real filesystem, and the real editor passes a `node:fs` reader.
 */

import { readdirSync, type Dirent } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

import { sanitize, type SafeText } from '@qwen-harness/protocol';

/** One completion candidate. `display` is inert; `insert` is the literal text spliced into the buffer. */
export interface FileMatch {
  /** Workspace-relative path, SANITIZED for rendering — never used to build a filesystem path. */
  readonly display: SafeText;
  /** The raw workspace-relative path to splice after `@` (a directory ends with `/`). */
  readonly insert: string;
  readonly isDir: boolean;
}

/** A directory reader: names + is-directory flags for one directory. Injected for testability. */
export type DirReader = (absDir: string) => ReadonlyArray<{ name: string; isDir: boolean }>;

/** The default reader — a real synchronous `node:fs` listing. Symlinks are reported as their target. */
export const fsDirReader: DirReader = (absDir) => {
  let entries: Dirent[];
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    // A missing or unreadable directory simply yields no completions — never an error to the UI.
    return [];
  }
  return entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
};

/**
 * Extract the `@`-token being completed from a buffer, or `null` when the menu should be closed.
 *
 * The menu is open when the buffer is a single line whose LAST whitespace-delimited token starts with
 * `@` (the token the cursor, at end of input, is extending). The returned value is the partial path
 * AFTER the `@`. `@` → ``, `read @src/Ed` → `src/Ed`, `@a @b` → `b`, `hello` → `null`, a multi-line
 * buffer → `null`. A slash-command line (`/…`) is never a file completion.
 */
export function atCompletionQuery(text: string): string | null {
  if (text.includes('\n')) return null;
  // The token under the (end-of-input) cursor is everything after the last space; `lastIndexOf`
  // returns -1 when there is no space, so `slice(0)` yields the whole single token. A trailing space
  // makes the token empty, which does not start with `@`, so the menu closes — as intended.
  const token = text.slice(text.lastIndexOf(' ') + 1);
  if (!token.startsWith('@')) return null;
  return token.slice(1);
}

/** Split a partial into the directory portion (may be empty) and the final-segment prefix. */
function splitPartial(partial: string): { dir: string; prefix: string } {
  const slash = partial.lastIndexOf('/');
  if (slash === -1) return { dir: '', prefix: partial };
  return { dir: partial.slice(0, slash), prefix: partial.slice(slash + 1) };
}

/**
 * List up to `limit` workspace entries whose final path segment begins with the partial's prefix,
 * directories first then files, each alphabetical. Returns `[]` when the target directory would fall
 * outside `cwd` (the confinement guard) — an absolute partial or one that climbs out with `..`.
 */
export function listFileMatches(
  cwd: string,
  partial: string,
  opts: { readdir?: DirReader; limit?: number } = {},
): readonly FileMatch[] {
  const readdir = opts.readdir ?? fsDirReader;
  const limit = opts.limit ?? 20;
  const { dir, prefix } = splitPartial(partial);

  // An absolute `@/…` is never a workspace-relative completion.
  if (isAbsolute(dir) || isAbsolute(partial)) return [];

  const root = resolve(cwd);
  const target = resolve(root, dir);
  // CONFINEMENT: the directory to enumerate must be the root itself or strictly beneath it.
  if (target !== root && !target.startsWith(root + sep)) return [];

  const entries = readdir(target)
    .filter((e) => !e.name.startsWith('.') || prefix.startsWith('.')) // hide dotfiles unless asked
    .filter((e) => e.name.startsWith(prefix))
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
    .slice(0, limit);

  return entries.map((e) => {
    const rel = dir === '' ? e.name : `${dir}/${e.name}`;
    const insert = e.isDir ? `${rel}/` : rel;
    return {
      display: sanitize(insert, { origin: 'user', multiline: false, maxLength: 120 }).text,
      insert,
      isDir: e.isDir,
    };
  });
}

/**
 * Given the buffer and a chosen match, compute the buffer edit: how many characters of the trailing
 * `@partial` token to delete, and the literal text (`@<path>`) to insert in its place. The editor
 * applies this by deleting `deleteCount` graphemes leftward and inserting `insert`.
 */
export function completionEdit(
  text: string,
  match: FileMatch,
): { deleteCount: number; insert: string } {
  const query = atCompletionQuery(text);
  if (query === null) return { deleteCount: 0, insert: '' };
  // The token on screen is `@` + query; replace the whole token with `@` + the chosen path.
  return { deleteCount: query.length + 1, insert: `@${match.insert}` };
}
