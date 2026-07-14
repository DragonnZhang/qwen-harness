/**
 * Unit tests for the `@`-file-completion surface (UI-04, U + S).
 *
 * The directory reader is injected, so confinement, filtering, ordering, and inert display are proven
 * without touching the real filesystem. The two security properties are asserted directly:
 *   - CONFINEMENT: a partial that resolves outside the workspace root lists nothing.
 *   - INERT DISPLAY: a hostile filename is returned as sanitized `SafeText` (no escape survives).
 */

import { describe, expect, it, vi } from 'vitest';

import {
  atCompletionQuery,
  completionEdit,
  listFileMatches,
  type DirReader,
} from '../../src/file-complete.ts';

const ESC = String.fromCharCode(27);

/** A fake tree: workspace root has `src/` (dir), `README.md`, `.hidden`; `src/` has `Editor.tsx`. */
const reader: DirReader = (absDir) => {
  if (absDir.endsWith('/src')) return [{ name: 'Editor.tsx', isDir: false }];
  // The root: whatever `resolve('/work', '')` is.
  if (absDir.endsWith('/work')) {
    return [
      { name: 'src', isDir: true },
      { name: 'README.md', isDir: false },
      { name: 'app.ts', isDir: false },
      { name: '.hidden', isDir: false },
    ];
  }
  return [];
};

describe('atCompletionQuery', () => {
  it('extracts the trailing @-token partial, or null when there is none', () => {
    expect(atCompletionQuery('@')).toBe('');
    expect(atCompletionQuery('@src/Ed')).toBe('src/Ed');
    expect(atCompletionQuery('read @src/Ed')).toBe('src/Ed');
    expect(atCompletionQuery('@a @b')).toBe('b');
    expect(atCompletionQuery('hello')).toBeNull();
    expect(atCompletionQuery('/help')).toBe(null); // a slash line is handled as a command, not a file
    // A trailing space ends the token — the menu closes.
    expect(atCompletionQuery('@src ')).toBeNull();
    // Multi-line buffers never complete files.
    expect(atCompletionQuery('@src\nmore')).toBeNull();
  });
});

describe('listFileMatches', () => {
  it('lists root entries, directories first then alphabetical, hiding dotfiles', () => {
    const matches = listFileMatches('/work', '', { readdir: reader });
    expect(matches.map((m) => m.insert)).toEqual(['src/', 'app.ts', 'README.md']);
    expect(matches[0]?.isDir).toBe(true);
    // The dotfile is hidden when the prefix does not itself start with a dot.
    expect(matches.some((m) => m.insert.includes('.hidden'))).toBe(false);
  });

  it('filters by the final-segment prefix', () => {
    const matches = listFileMatches('/work', 'READ', { readdir: reader });
    expect(matches.map((m) => m.insert)).toEqual(['README.md']);
  });

  it('descends into a subdirectory named in the partial', () => {
    const matches = listFileMatches('/work', 'src/Ed', { readdir: reader });
    expect(matches.map((m) => m.insert)).toEqual(['src/Editor.tsx']);
  });

  it('SECURITY — a partial that climbs out of the workspace lists nothing (confinement)', () => {
    const spy = vi.fn(reader);
    expect(listFileMatches('/work', '../etc', { readdir: spy })).toEqual([]);
    expect(listFileMatches('/work', '../../etc/passwd', { readdir: spy })).toEqual([]);
    // Confinement is decided BEFORE any read — the reader is never even consulted for an escape.
    expect(spy).not.toHaveBeenCalled();
  });

  it('SECURITY — an absolute partial is never a workspace completion', () => {
    expect(listFileMatches('/work', '/etc/passwd', { readdir: reader })).toEqual([]);
  });

  it('SECURITY — a hostile filename is returned as inert SafeText (no escape survives)', () => {
    const hostile: DirReader = () => [{ name: `evil${ESC}[31mRED${ESC}[0m.txt`, isDir: false }];
    const [match] = listFileMatches('/work', '', { readdir: hostile });
    expect(match).toBeDefined();
    // The display string carries no escape introducer; the raw `insert` is only ever text, not a path we open.
    expect(String(match?.display)).not.toContain(`${ESC}[`);
    expect(String(match?.display)).toContain('RED'); // the visible content remains
  });

  it('respects the limit', () => {
    const many: DirReader = () =>
      Array.from({ length: 50 }, (_, i) => ({
        name: `f${String(i).padStart(2, '0')}`,
        isDir: false,
      }));
    expect(listFileMatches('/work', '', { readdir: many, limit: 5 })).toHaveLength(5);
  });
});

describe('completionEdit', () => {
  it('replaces the whole @-token with @<path>', () => {
    const match = { display: 'src/Editor.tsx' as never, insert: 'src/Editor.tsx', isDir: false };
    // Buffer `read @src/Ed`: token `@src/Ed` is 7 chars → delete 7, insert `@src/Editor.tsx`.
    expect(completionEdit('read @src/Ed', match)).toEqual({
      deleteCount: 7,
      insert: '@src/Editor.tsx',
    });
  });

  it('is a no-op when there is no @-token', () => {
    const match = { display: 'x' as never, insert: 'x', isDir: false };
    expect(completionEdit('hello', match)).toEqual({ deleteCount: 0, insert: '' });
  });
});
