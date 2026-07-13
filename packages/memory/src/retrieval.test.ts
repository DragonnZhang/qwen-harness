import { describe, expect, it } from 'vitest';

import { retrieve, type MemoryCandidate } from './retrieval.ts';
import type { MemoryScope } from './scopes.ts';

/** Retrieval (MM-02): side-selection, keyword fallback, budgets, provenance, failure isolation. */
describe('retrieval (MM-02)', () => {
  const candidate = (
    over: Partial<MemoryCandidate> & { name: string; body: string },
  ): MemoryCandidate => ({
    description: '',
    type: 'reference',
    scope: 'project' as MemoryScope,
    path: `/mem/${over.name}.md`,
    readBody: () => over.body,
    ...over,
  });

  it('side-selects by name and description without reading bodies', () => {
    let bodyReads = 0;
    const cands = [
      candidate({
        name: 'pnpm-usage',
        description: 'Build and test with pnpm',
        body: 'never read for scoring',
        readBody: () => {
          bodyReads++;
          return 'body';
        },
      }),
      candidate({ name: 'docker-notes', description: 'How to run containers', body: 'x' }),
    ];
    const result = retrieve('pnpm install workflow', cands);
    expect(result.usedFallback).toBe(false);
    expect(result.memories.map((m) => m.name)).toEqual(['pnpm-usage']);
    expect(result.memories[0]?.matchedBy).toBe('side-selection');
    expect(result.memories[0]?.provenance).toEqual({
      scope: 'project',
      path: '/mem/pnpm-usage.md',
    });
    // Body of the matched candidate is read once for inclusion; the non-match is never read.
    expect(bodyReads).toBe(1);
  });

  it('falls back to keyword body matching when nothing matches on metadata', () => {
    const cands = [
      candidate({
        name: 'note-one',
        description: 'general notes',
        body: 'The retry backoff uses full jitter capped at 30 seconds.',
      }),
      candidate({ name: 'note-two', description: 'general notes', body: 'unrelated content' }),
    ];
    const result = retrieve('jitter backoff', cands);
    expect(result.usedFallback).toBe(true);
    expect(result.memories.map((m) => m.name)).toEqual(['note-one']);
    expect(result.memories[0]?.matchedBy).toBe('keyword-fallback');
  });

  it('enforces the 5-file budget', () => {
    const cands = Array.from({ length: 8 }, (_, i) =>
      candidate({ name: `topic-${i}`, description: 'shared keyword alpha', body: 'b' }),
    );
    const result = retrieve('alpha', cands);
    expect(result.usedFiles).toBe(5);
    expect(result.memories).toHaveLength(5);
    expect(result.skipped.filter((s) => s.reason === 'budget-files')).toHaveLength(3);
  });

  it('enforces the 50 KiB byte budget', () => {
    const big = 'y'.repeat(30 * 1024); // 30 KiB each; two fit, the third breaches 50 KiB
    const cands = [
      candidate({ name: 'aaa', description: 'keyword beta', body: big }),
      candidate({ name: 'bbb', description: 'keyword beta', body: big }),
      candidate({ name: 'ccc', description: 'keyword beta', body: big }),
    ];
    const result = retrieve('beta', cands, {});
    expect(result.usedBytes).toBeLessThanOrEqual(50 * 1024);
    expect(result.memories.length).toBeLessThan(3);
    expect(result.skipped.some((s) => s.reason === 'budget-bytes')).toBe(true);
  });

  it('isolates a body read failure: one unreadable candidate does not break retrieval', () => {
    const cands = [
      candidate({
        name: 'broken',
        description: 'keyword gamma',
        body: '',
        readBody: () => {
          throw new Error('EIO: unreadable');
        },
      }),
      candidate({ name: 'good', description: 'keyword gamma', body: 'fine' }),
    ];
    const result = retrieve('gamma', cands);
    expect(result.memories.map((m) => m.name)).toEqual(['good']);
    expect(result.skipped).toContainEqual({ path: '/mem/broken.md', reason: 'unreadable' });
  });

  it('isolates an unreadable candidate during the keyword fallback too', () => {
    const cands = [
      candidate({
        name: 'broken',
        description: 'no metadata match',
        body: '',
        readBody: () => {
          throw new Error('EIO');
        },
      }),
      candidate({ name: 'good', description: 'no metadata match', body: 'contains delta keyword' }),
    ];
    const result = retrieve('delta', cands);
    expect(result.usedFallback).toBe(true);
    expect(result.memories.map((m) => m.name)).toEqual(['good']);
    expect(
      result.skipped.some((s) => s.path === '/mem/broken.md' && s.reason === 'unreadable'),
    ).toBe(true);
  });

  it('returns nothing for a query with no term overlap', () => {
    const cands = [candidate({ name: 'x', description: 'alpha', body: 'beta' })];
    const result = retrieve('completely unrelated', cands);
    expect(result.memories).toHaveLength(0);
  });

  it('is deterministic: equal scores tie-break by name', () => {
    const cands = [
      candidate({ name: 'zeta', description: 'keyword shared', body: 'b' }),
      candidate({ name: 'alpha', description: 'keyword shared', body: 'b' }),
    ];
    const result = retrieve('shared', cands);
    expect(result.memories.map((m) => m.name)).toEqual(['alpha', 'zeta']);
  });
});
