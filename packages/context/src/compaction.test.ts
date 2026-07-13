import { describe, expect, it } from 'vitest';

import {
  InMemoryBoundaryStore,
  InvalidCompactionSummaryError,
  compact,
  digestTranscript,
  renderSummary,
} from './compaction.ts';

const msg = (role, text) => ({ type: 'message', role, text });

const preserved = {
  goal: 'ship the budget package',
  constraints: ['no host I/O in context', 'stay deterministic'],
  plan: ['write budget', 'write compaction'],
  tasks: ['CX-01', 'CX-03'],
  activeFiles: ['packages/context/src/budget.ts'],
  decisions: ['use ~4 chars/token estimator'],
  errors: ['tsc TS2532 on undefined index'],
  obligations: ['finish CX-06 commands'],
};

const transcript = [
  msg('user', 'ship the budget package'),
  msg('assistant', 'ok, planning'),
  msg('assistant', 'x'.repeat(4000)),
];

describe('compact', () => {
  it('writes the boundary FIRST, then summarizes', async () => {
    const store = new InMemoryBoundaryStore();
    const order = [];
    const result = await compact({
      items: transcript,
      boundaryStore: {
        write: (b) => {
          order.push('boundary');
          return store.write(b);
        },
      },
      summarizer: (input) => {
        order.push('summarize');
        // The summarizer can see the boundary ref, proving it was written first.
        expect(input.boundaryRef).toBeTruthy();
        return { prose: 'compacted the early planning chatter', preserved };
      },
    });

    expect(order).toEqual(['boundary', 'summarize']);
    // The ref is whatever the injected store returned; the store holds the digested boundary.
    expect(result.boundaryRef).toBe('bnd_000001');
    expect(store.get(result.boundaryRef).digest).toBe(digestTranscript(transcript));
    expect(store.size).toBe(1);
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
    expect(result.freedTokens).toBe(result.tokensBefore - result.tokensAfter);
  });

  it('preserves goal, constraints, tasks, files, and errors in the result and summary text', async () => {
    const result = await compact({
      items: transcript,
      boundaryStore: new InMemoryBoundaryStore(),
      summarizer: () => ({ prose: 'notes', preserved }),
    });

    // Structured preserved context survives on the result.
    expect(result.preserved).toEqual(preserved);
    // ...and the required fields literally appear in the rendered summary.
    expect(result.summary).toContain('ship the budget package');
    expect(result.summary).toContain('no host I/O in context');
    expect(result.summary).toContain('CX-03');
    expect(result.summary).toContain('packages/context/src/budget.ts');
    expect(result.summary).toContain('TS2532');
    expect(result.summary).toContain('finish CX-06 commands');
  });

  it('rejects a summary that drops the goal (invalid model output)', async () => {
    await expect(
      compact({
        items: transcript,
        boundaryStore: new InMemoryBoundaryStore(),
        summarizer: () => ({ prose: 'x', preserved: { ...preserved, goal: '' } }),
      }),
    ).rejects.toBeInstanceOf(InvalidCompactionSummaryError);
  });

  it('supports an injected async summarizer and a focus', async () => {
    const seen = [];
    await compact({
      items: transcript,
      focus: 'keep the error details',
      boundaryStore: new InMemoryBoundaryStore(),
      summarizer: (input) => {
        seen.push(input.focus);
        return Promise.resolve({ prose: 'async', preserved });
      },
    });
    expect(seen).toEqual(['keep the error details']);
  });
});

describe('renderSummary', () => {
  it('omits empty sections but always includes the goal', () => {
    const text = renderSummary({ ...preserved, constraints: [], errors: [] }, '');
    expect(text).toContain('## Goal');
    expect(text).not.toContain('## Constraints');
    expect(text).not.toContain('## Errors');
  });
});
