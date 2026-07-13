import { describe, expect, it } from 'vitest';

import {
  buildIndex,
  consolidateMemories,
  DREAM_MIN_BYTES,
  isDreamEligible,
  type MemoryRecord,
} from './consolidation.ts';
import type { Memory } from './frontmatter.ts';
import type { MemoryScope } from './scopes.ts';

/** Consolidation core (MM-04): dedup, conflict resolution with provenance, retire, eligibility. */
describe('consolidation core (MM-04)', () => {
  const rec = (
    name: string,
    body: string,
    updatedAt: number,
    path = `/mem/${name}.md`,
  ): MemoryRecord => ({
    memory: { name, description: `d-${name}`, type: 'project', body } satisfies Memory,
    provenance: { scope: 'project' as MemoryScope, path },
    updatedAt,
  });

  it('collapses exact duplicates to one', () => {
    const plan = consolidateMemories([
      rec('a', 'same body', 100, '/mem/a1.md'),
      rec('a', 'same body', 200, '/mem/a2.md'),
    ]);
    expect(plan.kept).toHaveLength(1);
    expect(plan.conflicts).toHaveLength(0);
    // The newer copy is kept.
    expect(plan.kept[0]?.updatedAt).toBe(200);
  });

  it('resolves a conflict in favour of the newer memory, recording provenance', () => {
    const plan = consolidateMemories([
      rec('style', 'use tabs', 100, '/mem/old.md'),
      rec('style', 'use two spaces', 200, '/mem/new.md'),
    ]);
    expect(plan.kept).toHaveLength(1);
    expect(plan.kept[0]?.memory.body).toBe('use two spaces');
    expect(plan.conflicts).toHaveLength(1);
    const conflict = plan.conflicts[0]!;
    expect(conflict.name).toBe('style');
    expect(conflict.resolvedBy).toBe('newer');
    expect(conflict.winner.path).toBe('/mem/new.md');
    expect(conflict.losers.map((l) => l.path)).toEqual(['/mem/old.md']);
  });

  it('breaks a same-timestamp conflict toward the more specific (longer) memory', () => {
    const plan = consolidateMemories([
      rec('x', 'short', 100, '/mem/short.md'),
      rec('x', 'a much longer and more specific note', 100, '/mem/long.md'),
    ]);
    expect(plan.kept[0]?.provenance.path).toBe('/mem/long.md');
    expect(plan.conflicts[0]?.resolvedBy).toBe('more-specific');
  });

  it('retires stale content and records it', () => {
    const plan = consolidateMemories([rec('fresh', 'b', 5_000), rec('stale', 'b', 1_000)], {
      staleBefore: 3_000,
    });
    expect(plan.kept.map((r) => r.memory.name)).toEqual(['fresh']);
    expect(plan.retired.map((r) => r.name)).toEqual(['stale']);
  });

  it('rebuilds a deterministic, name-sorted index', () => {
    const plan = consolidateMemories([rec('zebra', 'b', 1), rec('apple', 'b', 1)]);
    const index = buildIndex(plan.kept, { summary: 'nightly consolidation' });
    expect(index).toContain('nightly consolidation');
    expect(index.indexOf('apple')).toBeLessThan(index.indexOf('zebra'));
  });
});

describe('Dream eligibility gates (MM-04, exact defaults)', () => {
  const now = 10 * 24 * 60 * 60 * 1000; // 10 days in
  const never = { sessionsSinceLastConsolidation: 0, lastConsolidationAt: null };

  it('is NOT eligible with only 3 candidates and too few sessions', () => {
    const result = isDreamEligible(
      { sessionsSinceLastConsolidation: 3, lastConsolidationAt: null },
      { count: 3, bytes: 1000 },
      now,
    );
    expect(result.eligible).toBe(false);
  });

  it('is eligible with 5 sessions and 10 candidates', () => {
    const result = isDreamEligible(
      { sessionsSinceLastConsolidation: 5, lastConsolidationAt: null },
      { count: 10, bytes: 0 },
      now,
    );
    expect(result.eligible).toBe(true);
  });

  it('is eligible on the byte trigger (>= 32 KiB) even with few candidates', () => {
    const result = isDreamEligible(
      { sessionsSinceLastConsolidation: 5, lastConsolidationAt: null },
      { count: 2, bytes: DREAM_MIN_BYTES },
      now,
    );
    expect(result.eligible).toBe(true);
  });

  it('needs the volume gate even when the session gate passes', () => {
    const result = isDreamEligible(
      { sessionsSinceLastConsolidation: 5, lastConsolidationAt: null },
      { count: 3, bytes: 1000 },
      now,
    );
    expect(result).toEqual({ eligible: false, reason: 'not-enough-candidates' });
  });

  it('does NOT run twice within 24 hours of the last consolidation', () => {
    const twelveHoursAgo = now - 12 * 60 * 60 * 1000;
    const result = isDreamEligible(
      { sessionsSinceLastConsolidation: 100, lastConsolidationAt: twelveHoursAgo },
      { count: 100, bytes: 1_000_000 },
      now,
    );
    expect(result).toEqual({ eligible: false, reason: 'within-24h' });
  });

  it('runs on the 7-day age trigger with no new sessions', () => {
    const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;
    const result = isDreamEligible(
      { sessionsSinceLastConsolidation: 0, lastConsolidationAt: eightDaysAgo },
      { count: 10, bytes: 0 },
      now,
    );
    expect(result.eligible).toBe(true);
  });

  it('is not eligible after 2 days with < 5 sessions (24h passed, but no trigger)', () => {
    const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;
    const result = isDreamEligible(
      { sessionsSinceLastConsolidation: 2, lastConsolidationAt: twoDaysAgo },
      { count: 50, bytes: 0 },
      now,
    );
    expect(result).toEqual({ eligible: false, reason: 'not-enough-sessions-or-age' });
  });

  it('never-consolidated with enough volume and sessions is eligible', () => {
    expect(
      isDreamEligible({ ...never, sessionsSinceLastConsolidation: 5 }, { count: 10, bytes: 0 }, now)
        .eligible,
    ).toBe(true);
  });
});
