/**
 * Property test for `unifiedDiff` (TL-04 `P`).
 *
 * The invariant an edit's diff must satisfy: it is a faithful description of the change. We prove it
 * by RECONSTRUCTION — parse the emitted hunk and re-apply it to `before`; the result must equal
 * `after`, for arbitrary line contents and arbitrary edits. A diff that dropped, reordered, or
 * mislabeled a line would fail to reconstruct. We also check the `@@` header's line counts always
 * match the body it heads.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { unifiedDiff } from '../../src/handlers.ts';

/** Re-apply a single-hunk unified diff produced by {@link unifiedDiff} to `before`. */
function applyDiff(before: string, diff: string): string {
  const lines = diff.split('\n');
  const header = lines.find((l) => l.startsWith('@@'))!;
  const m = header.match(/@@ -(\d+),(\d+) \+\d+,\d+ @@/)!;
  const from = Number(m[1]) - 1; // 0-based first line of the a-window
  const aWindow = Number(m[2]); // number of a-side lines the hunk replaces
  const body = lines.slice(lines.indexOf(header) + 1);
  // The new window is the context + added lines, in order (removed lines dropped). Context lines
  // (' ') are common to both sides; added lines ('+') are the b-side; removed ('-') are a-side only.
  const newWindow = body
    .filter((l) => l.startsWith(' ') || l.startsWith('+'))
    .map((l) => l.slice(1));
  const beforeLines = before.split('\n');
  return [...beforeLines.slice(0, from), ...newWindow, ...beforeLines.slice(from + aWindow)].join(
    '\n',
  );
}

const line = fc.stringMatching(/^[ -~]{0,8}$/); // short printable lines, no newlines
const doc = fc.array(line, { maxLength: 12 }).map((ls) => ls.join('\n'));

describe('unifiedDiff round-trips (TL-04 P)', () => {
  it('applying the emitted diff to `before` reconstructs `after`, for any edit', () => {
    fc.assert(
      fc.property(doc, doc, (before, after) => {
        const diff = unifiedDiff('f', before, after);
        expect(applyDiff(before, diff)).toBe(after);
      }),
      { numRuns: 2000 },
    );
  });

  it('the @@ header line counts always equal the body it heads', () => {
    fc.assert(
      fc.property(doc, doc, (before, after) => {
        const lines = unifiedDiff('f', before, after).split('\n');
        const header = lines.find((l) => l.startsWith('@@'))!;
        const m = header.match(/@@ -\d+,(\d+) \+\d+,(\d+) @@/)!;
        const body = lines.slice(lines.indexOf(header) + 1);
        const aLines = body.filter((l) => l.startsWith(' ') || l.startsWith('-')).length;
        const bLines = body.filter((l) => l.startsWith(' ') || l.startsWith('+')).length;
        expect(aLines).toBe(Number(m[1]));
        expect(bLines).toBe(Number(m[2]));
      }),
      { numRuns: 2000 },
    );
  });
});
