/**
 * Unified-diff parsing into a structure the terminal can colour (UI-02).
 *
 * A diff shown in the TUI comes from a tool — `git diff`, an apply-patch result — so it is
 * UNTRUSTED. Every scrap of its text (paths, hunk headers, each line) crosses `sanitize` with a
 * `tool` origin before it can be rendered, so a diff line that smuggles an ANSI sequence to repaint
 * the screen is made inert (TL-11). The renderer only decides a COLOUR from `DiffLine.kind`; it
 * never re-parses the text, so the "green/red" decision is driven by structure, not by content.
 *
 * The parser is deliberately tolerant: a malformed or partial diff never throws. Anything it does
 * not recognise inside a hunk is treated as context, and content outside any hunk is ignored.
 */

import type { SafeText } from '@qwen-harness/protocol';
import { sanitize } from '@qwen-harness/protocol';

export type DiffLineKind = 'context' | 'add' | 'remove' | 'header';

export interface DiffLine {
  readonly kind: DiffLineKind;
  /** The line content, sanitized and with its leading +/-/space marker removed (except headers). */
  readonly text: SafeText;
}

export interface DiffHunk {
  /** The `@@ -a,b +c,d @@` line, sanitized. */
  readonly header: SafeText;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly DiffLine[];
}

export interface DiffFile {
  readonly oldPath: SafeText | null;
  readonly newPath: SafeText | null;
  readonly hunks: readonly DiffHunk[];
}

export interface ParsedDiff {
  readonly files: readonly DiffFile[];
  /** Every hunk across every file, in document order — the flat list a simple renderer walks. */
  readonly hunks: readonly DiffHunk[];
}

const HUNK_HEADER = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function safe(text: string): SafeText {
  return sanitize(text, { origin: 'tool', multiline: false }).text;
}

/** Cheap structural check: does this text contain at least one unified-diff hunk header? */
export function looksLikeUnifiedDiff(input: string): boolean {
  for (const line of input.split('\n')) {
    if (HUNK_HEADER.test(line)) return true;
  }
  return false;
}

interface MutableHunk {
  header: SafeText;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

interface MutableFile {
  oldPath: SafeText | null;
  newPath: SafeText | null;
  hunks: MutableHunk[];
}

/** Strip a single leading `a/` or `b/` and any trailing tab-delimited timestamp git/diff appends. */
function cleanPath(raw: string): string {
  const withoutMeta = raw.split('\t')[0] ?? raw;
  return withoutMeta.replace(/^[ab]\//, '');
}

export function parseUnifiedDiff(input: string): ParsedDiff {
  const files: MutableFile[] = [];
  let file: MutableFile | null = null;
  let hunk: MutableHunk | null = null;

  const ensureFile = (): MutableFile => {
    if (file === null) {
      file = { oldPath: null, newPath: null, hunks: [] };
      files.push(file);
    }
    return file;
  };

  for (const rawLine of input.split('\n')) {
    // A new file section. `git diff` emits `diff --git`; a plain diff starts straight at `---`.
    if (rawLine.startsWith('diff --git ') || (rawLine.startsWith('--- ') && hunk !== null)) {
      file = { oldPath: null, newPath: null, hunks: [] };
      files.push(file);
      hunk = null;
    }

    if (rawLine.startsWith('--- ')) {
      ensureFile().oldPath = safe(cleanPath(rawLine.slice(4)));
      hunk = null;
      continue;
    }
    if (rawLine.startsWith('+++ ')) {
      ensureFile().newPath = safe(cleanPath(rawLine.slice(4)));
      hunk = null;
      continue;
    }

    const header = HUNK_HEADER.exec(rawLine);
    if (header) {
      hunk = {
        header: safe(rawLine),
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      ensureFile().hunks.push(hunk);
      continue;
    }

    if (hunk === null) {
      // Preamble (`diff --git`, `index ...`, mode lines) or trailing noise — not renderable content.
      continue;
    }

    // Inside a hunk. The first byte is the marker; the rest is content.
    const marker = rawLine.charAt(0);
    if (marker === '+') {
      hunk.lines.push({ kind: 'add', text: safe(rawLine.slice(1)) });
    } else if (marker === '-') {
      hunk.lines.push({ kind: 'remove', text: safe(rawLine.slice(1)) });
    } else if (marker === '\\') {
      // "\ No newline at end of file" — metadata, not a content line.
      hunk.lines.push({ kind: 'header', text: safe(rawLine) });
    } else {
      // A context line starts with a space; a bare empty line is also context.
      hunk.lines.push({ kind: 'context', text: safe(marker === ' ' ? rawLine.slice(1) : rawLine) });
    }
  }

  return {
    files: files.map((f) => ({ oldPath: f.oldPath, newPath: f.newPath, hunks: f.hunks })),
    hunks: files.flatMap((f) => f.hunks),
  };
}
