import { describe, expect, it } from 'vitest';

import { looksLikeUnifiedDiff, parseUnifiedDiff } from './diff.ts';

const SAMPLE = [
  'diff --git a/greet.ts b/greet.ts',
  '--- a/greet.ts',
  '+++ b/greet.ts',
  '@@ -1,4 +1,4 @@',
  ' export function greet(name: string) {',
  '-  return "hi " + name;',
  '+  return `hello ${name}`;',
  '   const trimmed = name.trim();',
  '   return trimmed;',
  '@@ -10,2 +10,3 @@',
  ' footer();',
  '+extra();',
].join('\n');

describe('unified diff parsing (UI-02)', () => {
  it('detects a unified diff by its hunk header', () => {
    expect(looksLikeUnifiedDiff(SAMPLE)).toBe(true);
    expect(looksLikeUnifiedDiff('just some prose\nwith +plus lines')).toBe(false);
  });

  it('parses files, hunks, and typed add/remove/context lines', () => {
    const parsed = parseUnifiedDiff(SAMPLE);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]?.oldPath).toBe('greet.ts'); // 'a/' prefix stripped
    expect(parsed.files[0]?.newPath).toBe('greet.ts');
    expect(parsed.hunks).toHaveLength(2);

    const first = parsed.hunks[0];
    expect(first?.oldStart).toBe(1);
    expect(first?.oldLines).toBe(4);
    expect(first?.newStart).toBe(1);
    const kinds = first?.lines.map((l) => l.kind);
    expect(kinds).toEqual(['context', 'remove', 'add', 'context', 'context']);
    expect(first?.lines[1]?.text).toBe('  return "hi " + name;'); // marker stripped
    expect(first?.lines[2]?.text).toBe('  return `hello ${name}`;');
  });

  it('parses a bare diff with no file header', () => {
    const bare = ['@@ -1 +1 @@', '-old', '+new'].join('\n');
    const parsed = parseUnifiedDiff(bare);
    expect(parsed.hunks).toHaveLength(1);
    expect(parsed.hunks[0]?.oldLines).toBe(1); // omitted count defaults to 1
    expect(parsed.files[0]?.oldPath).toBeNull();
  });

  it('sanitizes untrusted diff content (a line cannot smuggle an escape)', () => {
    const hostile = ['@@ -1 +1 @@', '-safe', '+\u001b[2Jmalicious'].join('\n');
    const parsed = parseUnifiedDiff(hostile);
    const addLine = parsed.hunks[0]?.lines.find((l) => l.kind === 'add');
    expect(addLine?.text).not.toContain('\u001b');
    expect(addLine?.text).toContain('malicious');
  });
});
