import { describe, expect, it } from 'vitest';

import { TranscriptInspector } from './inspector.ts';
import { buildTranscript } from './view-model.ts';

let seq = 0;
function base(type, id, extra) {
  seq += 1;
  return { id, turnId: 't1', threadId: 'th1', seq, createdAt: 0, type, ...extra };
}

const rows = buildTranscript([
  base('user-message', 'u1', { text: 'please fix the parser bug' }),
  base('assistant-message', 'a1', { text: 'looking at the tokenizer now', complete: true }),
  base('tool-call', 'tc1', {
    callId: 'c1',
    toolName: 'grep',
    argumentsJson: '{"pattern":"tokenizer"}',
    arguments: null,
  }),
  base('assistant-message', 'a2', { text: 'the fix is in place', complete: true }),
]).rows;

describe('transcript inspector (UI-09)', () => {
  it('collapses and expands rows by id', () => {
    let inspector = new TranscriptInspector();
    expect(inspector.isCollapsed('a1')).toBe(false);

    inspector = inspector.collapse('a1');
    expect(inspector.isCollapsed('a1')).toBe(true);

    inspector = inspector.toggle('a1');
    expect(inspector.isCollapsed('a1')).toBe(false);

    const projection = inspector.collapseAll(rows).project(rows);
    expect(projection.every((p) => p.collapsed)).toBe(true);
    expect(projection.map((p) => p.index)).toEqual([0, 1, 2, 3]);
  });

  it('searches content and returns matching row indices', () => {
    const inspector = new TranscriptInspector();
    expect(inspector.search(rows, 'tokenizer')).toEqual([1, 2]); // assistant text + tool args
    expect(inspector.search(rows, 'parser')).toEqual([0]);
    expect(inspector.search(rows, 'nonexistent')).toEqual([]);
    expect(inspector.search(rows, '')).toEqual([]); // empty query matches nothing
  });

  it('produces a filtered projection of matching rows', () => {
    const inspector = new TranscriptInspector();
    const filtered = inspector.filter(rows, 'fix');
    expect(filtered.map((r) => r.id)).toEqual(['u1', 'a2']);
  });
});
