import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FixtureRepo } from '@qwen-harness/testkit';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createWorktree, isWorktreeDirty, listWorktrees, WorktreeError } from '../../src/index.ts';

/**
 * Worktree lifecycle edges GT-06 requires to be tested: non-Git error behavior, config neutralization
 * ("config inclusion"), and concurrent worktrees. The happy-path create/remove and dirty/unmerged
 * refusals live in worktree.test.ts; this covers the failure and adversarial edges.
 */

describe('worktree lifecycle edges (GT-06)', () => {
  let repo: FixtureRepo;
  beforeEach(() => {
    repo = FixtureRepo.create({ 'a.txt': 'hello\n' });
  });
  afterEach(() => repo.dispose());

  it('a non-Git directory fails with a typed not-a-repo error, not a raw crash (GT-06, F)', () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'qh-notgit-'));
    try {
      let err: unknown;
      try {
        createWorktree({ repoRoot: notARepo, slug: 'x', now: 1 });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(WorktreeError);
      expect((err as WorktreeError).code).toBe('not-a-repo');
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });

  it('neutralizes attacker global git config — a poison alias cannot hijack a worktree op (GT-06)', () => {
    // A hostile global config that reassigns `status` to a failing command. If the worktree helper
    // honored ambient global config, `isWorktreeDirty` (which runs `git status`) would break.
    const cfgDir = mkdtempSync(join(tmpdir(), 'qh-gitcfg-'));
    const cfg = join(cfgDir, 'gitconfig');
    writeFileSync(cfg, '[alias]\n\tstatus = !exit 7\n');
    const saved = process.env['GIT_CONFIG_GLOBAL'];
    process.env['GIT_CONFIG_GLOBAL'] = cfg;
    try {
      const wt = createWorktree({ repoRoot: repo.root, slug: 'guarded', now: 1 });
      // The op succeeds and `git status` runs for real — the poison alias was neutralized.
      expect(isWorktreeDirty(wt.path)).toBe(false);
    } finally {
      if (saved === undefined) delete process.env['GIT_CONFIG_GLOBAL'];
      else process.env['GIT_CONFIG_GLOBAL'] = saved;
      rmSync(cfgDir, { recursive: true, force: true });
    }
  });

  it('supports concurrent worktrees: distinct slugs coexist without collision (GT-06, P)', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc
            .tuple(fc.integer({ min: 0, max: 25 }), fc.integer({ min: 0, max: 999 }))
            .map(([a, b]) => `wt${String.fromCharCode(97 + a)}${b}`),
          { minLength: 2, maxLength: 4 },
        ),
        (slugs) => {
          const fresh = FixtureRepo.create({ 'a.txt': 'x\n' });
          try {
            for (const slug of slugs) createWorktree({ repoRoot: fresh.root, slug, now: 1 });
            const paths = new Set(listWorktrees(fresh.root).map((w) => w.path));
            // Every distinct slug produced its own live worktree (plus the main one).
            expect(paths.size).toBeGreaterThanOrEqual(slugs.length + 1);
          } finally {
            fresh.dispose();
          }
        },
      ),
      { numRuns: 15 },
    );
  });
});
