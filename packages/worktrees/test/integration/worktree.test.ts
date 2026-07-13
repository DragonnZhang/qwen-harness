import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { FixtureRepo } from '@qwen-harness/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createWorktree,
  hasUnmergedCommits,
  isWorktreeDirty,
  listWorktrees,
  removeWorktree,
  WorktreeError,
  type WorktreeRecord,
} from '../../src/index.ts';

/** Real git worktrees against a real fixture repo — the only honest way to test worktree behavior. */
describe('worktrees (GT-01..GT-06)', () => {
  let repo: FixtureRepo;

  beforeEach(() => {
    repo = FixtureRepo.create({ 'a.txt': 'hello\n', 'README.md': '# demo\n' });
  });
  afterEach(() => repo.dispose());

  it('creates an isolated worktree + branch from HEAD', () => {
    const wt = createWorktree({ repoRoot: repo.root, slug: 'feature-x', now: 1 });
    expect(wt.branch).toBe('qh/feature-x');
    expect(existsSync(wt.path)).toBe(true);
    // The worktree has its own checkout of the same content.
    expect(readFileSync(join(wt.path, 'a.txt'), 'utf8')).toBe('hello\n');
    // git sees two worktrees now.
    expect(listWorktrees(repo.root).length).toBeGreaterThanOrEqual(2);
  });

  it('a clean worktree removes cleanly', () => {
    const wt = createWorktree({ repoRoot: repo.root, slug: 'tmp', now: 1 });
    const result = removeWorktree({ repoRoot: repo.root, record: wt });
    expect(result.removed).toBe(true);
    expect(existsSync(wt.path)).toBe(false);
  });

  it('REFUSES to remove a dirty worktree by default (GT-04)', () => {
    const wt = createWorktree({ repoRoot: repo.root, slug: 'dirty', now: 1 });
    writeFileSync(join(wt.path, 'a.txt'), 'MODIFIED\n');
    expect(isWorktreeDirty(wt.path)).toBe(true);

    expect(() => removeWorktree({ repoRoot: repo.root, record: wt })).toThrow(WorktreeError);
    // The worktree is still there — nothing was lost.
    expect(existsSync(wt.path)).toBe(true);

    // discard: true overrides and records the audit.
    const result = removeWorktree({ repoRoot: repo.root, record: wt, discard: true });
    expect(result).toMatchObject({ removed: true, discardedDirty: true });
    expect(existsSync(wt.path)).toBe(false);
  });

  it('REFUSES to remove a worktree with unmerged commits by default', () => {
    const wt = createWorktree({ repoRoot: repo.root, slug: 'unmerged', now: 1 });
    // Make a commit on the worktree branch that base does not have.
    writeFileSync(join(wt.path, 'new.txt'), 'work\n');
    execInWorktree(wt, ['add', '-A']);
    execInWorktree(wt, ['-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-qm', 'wip']);
    expect(hasUnmergedCommits(wt.path, wt.base)).toBe(true);

    expect(() => removeWorktree({ repoRoot: repo.root, record: wt })).toThrow(/unmerged/);
    // Force-discard works and records it.
    const result = removeWorktree({ repoRoot: repo.root, record: wt, discard: true });
    expect(result.discardedUnmerged).toBe(true);
  });

  it('rejects a collision (same slug twice)', () => {
    createWorktree({ repoRoot: repo.root, slug: 'dup', now: 1 });
    expect(() => createWorktree({ repoRoot: repo.root, slug: 'dup', now: 2 })).toThrow(
      /collision|exists/i,
    );
  });
});

function execInWorktree(wt: WorktreeRecord, args: string[]): void {
  execFileSync('git', args, { cwd: wt.path, stdio: 'ignore' });
}
