import { describe, expect, it } from 'vitest';

import {
  InMemoryBoundaryStore,
  clearCommand,
  compactCommand,
  contextCommand,
  evaluateCompaction,
  isDiminishingReturns,
} from './index.ts';

const msg = (role, text) => ({ type: 'message', role, text });

const preserved = {
  goal: 'do the thing',
  constraints: [],
  plan: [],
  tasks: [],
  activeFiles: [],
  decisions: [],
  errors: [],
  obligations: [],
};

describe('/context', () => {
  it('returns the budget breakdown and a printable status line', () => {
    const report = contextCommand({ contextWindow: 1000, items: [msg('user', 'x'.repeat(400))] });
    expect(report.budget.usableInputBudget).toBe(850);
    expect(report.budget.usedTokens).toBe(102); // "user: " + 400 chars -> ceil(406/4)
    expect(report.status).toContain('102/850');
  });
});

describe('/clear', () => {
  it('resets to an empty transcript and reports a fresh budget', () => {
    const cleared = clearCommand({ contextWindow: 1000, clearedAt: 1234 });
    expect(cleared.items).toEqual([]);
    expect(cleared.refs).toEqual([]);
    expect(cleared.clearedAt).toBe(1234);
    expect(cleared.budget.usedTokens).toBe(0);
    expect(cleared.budget.availableTokens).toBe(850);
  });

  it('defaults clearedAt to null when no clock value is supplied', () => {
    expect(clearCommand({ contextWindow: 1000 }).clearedAt).toBeNull();
  });
});

describe('/compact', () => {
  const bigTranscript = [msg('user', 'do the thing'), msg('assistant', 'x'.repeat(8000))];

  it('commits a compaction that frees enough tokens', async () => {
    const outcome = await compactCommand({
      items: bigTranscript,
      boundaryStore: new InMemoryBoundaryStore(),
      summarizer: () => ({ prose: 'small', preserved }),
    });
    expect(outcome.kind).toBe('compacted');
    if (outcome.kind === 'compacted') {
      expect(outcome.result.freedTokens).toBeGreaterThan(0);
    }
  });

  it('returns the typed no-further-reduction signal instead of looping when it frees too little', async () => {
    // Already-tiny transcript: the rendered summary is not meaningfully smaller.
    const tiny = [msg('user', 'do the thing')];
    const outcome = await compactCommand({
      items: tiny,
      boundaryStore: new InMemoryBoundaryStore(),
      summarizer: () => ({ prose: 'x'.repeat(500), preserved }),
    });
    expect(outcome.kind).toBe('no-further-reduction');
    if (outcome.kind === 'no-further-reduction') {
      expect(outcome.reason).toBeTruthy();
    }
  });
});

describe('diminishing returns', () => {
  it('evaluateCompaction flags a low-yield compaction', () => {
    const result = {
      boundaryRef: 'bnd_1',
      summary: 's',
      preserved,
      tokensBefore: 1000,
      tokensAfter: 980, // freed 2%, below the 10% default
      freedTokens: 20,
      compactedItemCount: 3,
      trigger: 'proactive',
    };
    expect(evaluateCompaction(result).kind).toBe('no-further-reduction');
    expect(evaluateCompaction({ ...result, tokensAfter: 500, freedTokens: 500 }).kind).toBe(
      'compacted',
    );
  });

  it('isDiminishingReturns detects thrashing', () => {
    expect(isDiminishingReturns(1000, 990)).toBe(true); // freed 1%
    expect(isDiminishingReturns(1000, 500)).toBe(false); // freed 50%
    expect(isDiminishingReturns(0, 0)).toBe(true); // nothing to reduce
  });
});
