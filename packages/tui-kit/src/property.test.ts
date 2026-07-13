import { describe, expect, it } from 'vitest';

import { parseUnifiedDiff } from './diff.ts';
import {
  backspace,
  bufferText,
  createEditor,
  deleteForward,
  insertText,
  moveDown,
  moveLeft,
  moveRight,
  moveUp,
  newline,
  redo,
  undo,
} from './editor.ts';
import { graphemeCount } from './unicode.ts';

/** A deterministic LCG so the "property" tests are reproducible and never flake. */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('property: editor operations preserve buffer integrity (UI-03)', () => {
  it('keeps the cursor in bounds and undo/redo consistent across random op sequences', () => {
    const alphabet = ['a', 'b', ' ', '你', '👍', 'é'];
    for (let seed = 1; seed <= 40; seed += 1) {
      const rng = makeRng(seed);
      let state = createEditor();
      let edits = 0;

      for (let step = 0; step < 60; step += 1) {
        const pick = Math.floor(rng() * 8);
        if (pick === 0) {
          state = insertText(state, alphabet[Math.floor(rng() * alphabet.length)] ?? 'a');
          edits += 1;
        } else if (pick === 1) {
          state = newline(state);
          edits += 1;
        } else if (pick === 2) {
          const before = bufferText(state);
          state = backspace(state);
          if (bufferText(state) !== before) edits += 1;
        } else if (pick === 3) {
          const before = bufferText(state);
          state = deleteForward(state);
          if (bufferText(state) !== before) edits += 1;
        } else if (pick === 4) {
          state = moveLeft(state);
        } else if (pick === 5) {
          state = moveRight(state);
        } else if (pick === 6) {
          state = moveUp(state);
        } else {
          state = moveDown(state);
        }

        // Invariant: the cursor always addresses a real position in the buffer.
        expect(state.cursor.row).toBeGreaterThanOrEqual(0);
        expect(state.cursor.row).toBeLessThan(state.lines.length);
        const lineLen = graphemeCount(state.lines[state.cursor.row] ?? '');
        expect(state.cursor.col).toBeGreaterThanOrEqual(0);
        expect(state.cursor.col).toBeLessThanOrEqual(lineLen);

        // Invariant: the buffer round-trips through split/join.
        expect(bufferText(state).split('\n')).toEqual([...state.lines]);
      }

      // Undo every edit back to empty, then redo forward: the final buffer must reappear.
      const finalText = bufferText(state);
      let rewound = state;
      for (let i = 0; i < edits; i += 1) rewound = undo(rewound);
      expect(bufferText(rewound)).toBe('');

      let replayed = rewound;
      for (let i = 0; i < edits; i += 1) replayed = redo(replayed);
      expect(bufferText(replayed)).toBe(finalText);
    }
  });
});

describe('property: unified diff round-trips (UI-02)', () => {
  it('parses generated hunks back to the same content and counts', () => {
    for (let seed = 1; seed <= 50; seed += 1) {
      const rng = makeRng(seed);
      const kinds = [];
      const bodyLines = [];
      const count = 1 + Math.floor(rng() * 8);
      for (let i = 0; i < count; i += 1) {
        const roll = rng();
        const content = `line${i}word${Math.floor(rng() * 100)}`;
        if (roll < 0.34) {
          kinds.push('context');
          bodyLines.push(` ${content}`);
        } else if (roll < 0.67) {
          kinds.push('add');
          bodyLines.push(`+${content}`);
        } else {
          kinds.push('remove');
          bodyLines.push(`-${content}`);
        }
      }
      const oldCount = kinds.filter((k) => k === 'context' || k === 'remove').length;
      const newCount = kinds.filter((k) => k === 'context' || k === 'add').length;

      const text = [
        '--- a/file.txt',
        '+++ b/file.txt',
        `@@ -1,${oldCount} +1,${newCount} @@`,
        ...bodyLines,
      ].join('\n');

      const parsed = parseUnifiedDiff(text);
      const hunk = parsed.hunks[0];
      expect(hunk).toBeDefined();
      expect(hunk?.oldLines).toBe(oldCount);
      expect(hunk?.newLines).toBe(newCount);
      expect(hunk?.lines.map((l) => l.kind)).toEqual(kinds);
      // Content survives parsing byte-for-byte (marker stripped, no sanitisation needed for ASCII).
      hunk?.lines.forEach((line, i) => {
        expect(line.text).toBe((bodyLines[i] ?? '').slice(1));
      });
    }
  });
});
