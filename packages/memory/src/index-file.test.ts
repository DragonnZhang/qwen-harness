import { describe, expect, it } from 'vitest';

import { MEMORY_INDEX_MAX_BYTES, MEMORY_INDEX_MAX_LINES, loadMemoryIndex } from './index-file.ts';

/** The MEMORY.md load cap (MM-01): first 200 lines OR 25 KiB, whichever comes first. */
describe('MEMORY.md index load cap (MM-01)', () => {
  it('loads a small index whole, untruncated', () => {
    const text = '# Memory index\n- **a** (user): note a\n- **b** (project): note b\n';
    const loaded = loadMemoryIndex(text);
    expect(loaded.truncated).toBe(false);
    expect(loaded.stoppedBy).toBeNull();
    expect(loaded.content).toBe(text);
  });

  it('truncates a 300-line index at exactly 200 lines', () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`);
    const loaded = loadMemoryIndex(lines.join('\n'));
    expect(loaded.truncated).toBe(true);
    expect(loaded.stoppedBy).toBe('lines');
    expect(loaded.lines).toBe(MEMORY_INDEX_MAX_LINES);
    expect(loaded.content.split('\n')).toHaveLength(200);
    expect(loaded.content.split('\n')[199]).toBe('line 200');
    expect(loaded.content).not.toContain('line 201');
  });

  it('stops at the 25 KiB byte boundary before 200 lines when lines are large', () => {
    // Each line is ~1 KiB; ~26 of them exceed 25 KiB well before 200 lines.
    const big = 'x'.repeat(1024);
    const lines = Array.from({ length: 200 }, () => big);
    const loaded = loadMemoryIndex(lines.join('\n'));
    expect(loaded.truncated).toBe(true);
    expect(loaded.stoppedBy).toBe('bytes');
    expect(loaded.bytes).toBeLessThanOrEqual(MEMORY_INDEX_MAX_BYTES);
    expect(loaded.lines).toBeLessThan(MEMORY_INDEX_MAX_LINES);
  });

  it('counts bytes as UTF-8, not UTF-16 code units', () => {
    // A 3-byte character repeated; the byte budget must reflect real serialized size.
    const line = '数'.repeat(200); // 200 chars, 600 bytes each line
    const lines = Array.from({ length: 100 }, () => line);
    const loaded = loadMemoryIndex(lines.join('\n'), { maxBytes: 5 * 1024, maxLines: 1000 });
    expect(loaded.bytes).toBeLessThanOrEqual(5 * 1024);
    expect(loaded.stoppedBy).toBe('bytes');
  });

  it('exposes the frozen defaults', () => {
    expect(MEMORY_INDEX_MAX_LINES).toBe(200);
    expect(MEMORY_INDEX_MAX_BYTES).toBe(25 * 1024);
  });
});
