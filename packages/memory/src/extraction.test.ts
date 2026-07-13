import { createRedactor } from '@qwen-harness/storage';
import { CANARY_API_KEY } from '@qwen-harness/testkit';
import { describe, expect, it } from 'vitest';

import { maybeExtract, type MemoryProposal, type TurnOutcome } from './extraction.ts';
import { dedupKey } from './dedup.ts';

/** Safe extraction (MM-03): eligibility gate, empty no-op, secret rejection, dedup. */
describe('extraction (MM-03)', () => {
  const lesson: MemoryProposal = {
    name: 'prefers-pnpm',
    description: 'The user builds with pnpm.',
    type: 'user',
    body: 'Run pnpm, not npm.',
  };
  const completed: TurnOutcome = { completed: true, cancelled: false };

  it('extracts a lesson from a naturally completed turn', () => {
    const result = maybeExtract(completed, {
      propose: () => [lesson],
      redactor: createRedactor(),
    });
    expect(result.skipped).toBeNull();
    expect(result.extracted).toHaveLength(1);
    expect(result.extracted[0]?.name).toBe('prefers-pnpm');
  });

  it('does NOT extract from a cancelled turn (clean no-op)', () => {
    const result = maybeExtract(
      { completed: true, cancelled: true },
      { propose: () => [lesson], redactor: createRedactor() },
    );
    expect(result.skipped).toBe('turn-not-eligible');
    expect(result.extracted).toHaveLength(0);
  });

  it('does NOT extract from a non-completed turn', () => {
    const result = maybeExtract(
      { completed: false, cancelled: false },
      { propose: () => [lesson], redactor: createRedactor() },
    );
    expect(result.skipped).toBe('turn-not-eligible');
  });

  it('treats an empty proposal as a clean no-op, not an error', () => {
    const result = maybeExtract(completed, { propose: () => [], redactor: createRedactor() });
    expect(result.skipped).toBe('empty-proposal');
    expect(result.extracted).toHaveLength(0);
    expect(result.rejected).toHaveLength(0);
  });

  it('REJECTS a candidate carrying a canary secret; it never reaches the extracted set', () => {
    const withSecret: MemoryProposal = {
      name: 'deploy-steps',
      description: 'How to deploy',
      type: 'project',
      body: `Export the key: ${CANARY_API_KEY} then run deploy.`,
    };
    const result = maybeExtract(completed, {
      propose: () => [withSecret],
      redactor: createRedactor(),
    });
    expect(result.extracted).toHaveLength(0);
    expect(result.rejected).toContainEqual({ kind: 'contains-secret', name: 'deploy-steps' });
    // Absolutely nothing in the result contains the canary.
    expect(JSON.stringify(result)).not.toContain(CANARY_API_KEY);
  });

  it('rejects a secret hidden in the description too, not just the body', () => {
    const result = maybeExtract(completed, {
      propose: () => [{ ...lesson, description: `key ${CANARY_API_KEY}` }],
      redactor: createRedactor(),
    });
    expect(result.rejected[0]?.kind).toBe('contains-secret');
    expect(result.extracted).toHaveLength(0);
  });

  it('deduplicates against already-stored memories', () => {
    const existing = [dedupKey({ name: lesson.name, body: lesson.body })];
    const result = maybeExtract(completed, {
      propose: () => [lesson],
      redactor: createRedactor(),
      existing,
    });
    expect(result.extracted).toHaveLength(0);
    expect(result.rejected).toContainEqual({ kind: 'duplicate', name: 'prefers-pnpm' });
  });

  it('deduplicates identical proposals within one batch', () => {
    const result = maybeExtract(completed, {
      propose: () => [lesson, { ...lesson }],
      redactor: createRedactor(),
    });
    expect(result.extracted).toHaveLength(1);
    expect(result.rejected).toContainEqual({ kind: 'duplicate', name: 'prefers-pnpm' });
  });

  it('rejects an invalid proposal (bad slug name) without throwing', () => {
    const result = maybeExtract(completed, {
      propose: () => [{ ...lesson, name: 'Not A Slug' }],
      redactor: createRedactor(),
    });
    expect(result.extracted).toHaveLength(0);
    expect(result.rejected[0]?.kind).toBe('invalid');
  });
});
