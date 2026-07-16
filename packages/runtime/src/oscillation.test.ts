import { ManualClock } from '@qwen-harness/protocol';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { BudgetTracker, DEFAULT_BUDGET } from './budget.ts';

/**
 * The runtime detects OSCILLATION — a short cycle of distinct tool calls repeated without end
 * (ER-06). This is a pathology the consecutive-identical detector cannot see, because in `A-B-A-B`
 * every call differs from the one just before it; it terminates the turn with its own typed reason.
 */

const track = (): BudgetTracker => {
  const clock = new ManualClock(0);
  return new BudgetTracker(DEFAULT_BUDGET, () => clock.now());
};

const A = ['read_file', '{"path":"a.ts"}'] as const;
const B = ['read_file', '{"path":"b.ts"}'] as const;
const C = ['read_file', '{"path":"c.ts"}'] as const;

describe('oscillation detection (ER-06, U)', () => {
  it('stops an A-B-A-B-A-B two-cycle with reason "oscillation"', () => {
    const t = track();
    const seq = [A, B, A, B, A, B];
    const verdicts = seq.map(([n, a]) => t.observeToolCall(n, a));
    // The first five alternations are allowed; the sixth call completes the third full cycle.
    expect(verdicts.slice(0, 5).every((v) => !v.stop)).toBe(true);
    const last = verdicts[5]!;
    expect(last.stop).toBe(true);
    expect(last.stop && last.reason).toBe('oscillation');
  });

  it('stops an A-B-C three-cycle repeated three times with reason "oscillation"', () => {
    const t = track();
    const seq = [A, B, C, A, B, C, A, B, C];
    const verdicts = seq.map(([n, a]) => t.observeToolCall(n, a));
    expect(verdicts[8]!.stop && verdicts[8]!.reason).toBe('oscillation');
  });

  it('does NOT flag genuinely varied work as oscillation', () => {
    const t = track();
    const varied = [
      A,
      B,
      C,
      ['grep', '{"q":"x"}'],
      ['write_file', '{"path":"d"}'],
      ['list', '{}'],
    ] as const;
    for (const [n, a] of varied) expect(t.observeToolCall(n, a).stop).toBe(false);
  });

  it('an all-identical run is repeated-identical-calls, never oscillation', () => {
    const t = track();
    const verdicts = [A, A, A].map(([n, a]) => t.observeToolCall(n, a));
    const stopped = verdicts.find((v) => v.stop);
    expect(stopped?.stop && stopped.reason).toBe('repeated-identical-calls');
  });
});

describe('oscillation detection is total over any short repeated cycle (ER-06, P)', () => {
  it('any 2- or 3-length cycle of distinct calls, repeated three times, is caught', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 6 }), { minLength: 2, maxLength: 3 }),
        (cycle) => {
          const t = track();
          let stoppedReason: string | null = null;
          // Repeat the distinct-signature cycle three full times.
          for (let rep = 0; rep < 3 && stoppedReason === null; rep++) {
            for (const arg of cycle) {
              const v = t.observeToolCall('tool', arg);
              if (v.stop) {
                stoppedReason = v.reason;
                break;
              }
            }
          }
          expect(stoppedReason).toBe('oscillation');
        },
      ),
      { numRuns: 200 },
    );
  });
});
