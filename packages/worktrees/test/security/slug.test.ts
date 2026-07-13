import { FixtureRepo } from '@qwen-harness/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createWorktree, validateSlug, WorktreeError } from '../../src/index.ts';

describe('worktree slug validation (GT-01, path-traversal safety)', () => {
  it.each([
    '../escape',
    '..',
    'a/b',
    '/abs',
    'name with spaces',
    'dot.dot',
    'UPPER',
    '',
    'x'.repeat(100),
    '.hidden',
  ])('rejects the unsafe slug %j', (slug) => {
    expect(() => validateSlug(slug)).toThrow(WorktreeError);
  });

  it.each(['feature-x', 'fix_123', 'a', 'task-42-part-2'])('accepts the safe slug %j', (slug) => {
    expect(() => validateSlug(slug)).not.toThrow();
  });

  it('a traversal slug cannot create a worktree outside the controlled dir', () => {
    const repo = FixtureRepo.create({ 'a.txt': 'x\n' });
    try {
      expect(() => createWorktree({ repoRoot: repo.root, slug: '../../../etc', now: 1 })).toThrow(
        WorktreeError,
      );
    } finally {
      repo.dispose();
    }
  });
});
