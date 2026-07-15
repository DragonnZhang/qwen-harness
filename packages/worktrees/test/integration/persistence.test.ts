import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';

import { FixtureRepo } from '@qwen-harness/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  WorktreeStore,
  captureWorktreeOrigin,
  createWorktree,
  reconcile,
  toPersisted,
} from '../../src/index.ts';

/**
 * Worktree persistence + recovery against REAL git (GT-03).
 *
 * A real worktree is created, its origin (the repo's real branch/HEAD) is captured, and the record is
 * persisted. A FRESH store instance — a restarted process — reads the durable record with its origin
 * intact (I). Then a checkout directory is deleted underneath the manifest, simulating a crash that
 * lost the working tree, and `reconcile` detects it as `orphaned` while an intact sibling stays
 * `active` (F).
 */

describe('worktree persistence + recovery over real git (GT-03)', () => {
  let repo: FixtureRepo;

  beforeEach(() => {
    repo = FixtureRepo.create({ 'a.txt': 'hello\n' });
  });
  afterEach(() => repo.dispose());

  const headOf = (cwd: string): string =>
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();

  it('persists a real worktree with captured origin and reloads it from a fresh store', () => {
    const wt = createWorktree({ repoRoot: repo.root, slug: 'feature', now: 100 });
    const origin = captureWorktreeOrigin(repo.root);
    // The captured origin is the repo's ACTUAL state, not a guess.
    expect(origin.originalCwd).toBe(repo.root);
    expect(origin.originalHead).toBe(headOf(repo.root));
    expect(origin.originalBranch.length).toBeGreaterThan(0);

    new WorktreeStore(repo.root).save(
      toPersisted(wt, { origin, owner: 'agent-1', session: 'thr_0001' }),
    );

    // A fresh process reads the durable record — path/branch/base, owner/session, origin all survive.
    const reloaded = new WorktreeStore(repo.root).get('feature');
    expect(reloaded).toBeDefined();
    expect(reloaded!.path).toBe(wt.path);
    expect(reloaded!.branch).toBe('qh/feature');
    expect(reloaded!.base).toBe(wt.base);
    expect(reloaded!.origin.originalHead).toBe(origin.originalHead);
    expect(reloaded!.owner).toBe('agent-1');
    expect(reloaded!.session).toBe('thr_0001');
    expect(reloaded!.recoveryState).toBe('active');
  });

  it('reconcile detects an orphaned checkout after a crash, sparing the intact one', () => {
    const alive = createWorktree({ repoRoot: repo.root, slug: 'alive', now: 1 });
    const lost = createWorktree({ repoRoot: repo.root, slug: 'lost', now: 2 });
    const origin = captureWorktreeOrigin(repo.root);
    const store = new WorktreeStore(repo.root);
    for (const wt of [alive, lost]) {
      store.save(toPersisted(wt, { origin, owner: 'agent-1', session: 'thr_0001' }));
    }

    // A crash / manual cleanup removed the `lost` checkout directory out from under the manifest.
    rmSync(lost.path, { recursive: true, force: true });

    const reconciled = reconcile(store);
    const byState = Object.fromEntries(reconciled.map((w) => [w.slug, w.recoveryState]));
    expect(byState['lost']).toBe('orphaned');
    expect(byState['alive']).toBe('active');
    // Durable: a fresh store sees the recovered state, so a later run knows what to clean up.
    expect(new WorktreeStore(repo.root).get('lost')!.recoveryState).toBe('orphaned');
  });
});
