import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  WorktreeStore,
  reconcile,
  toPersisted,
  WorktreeError,
  type WorktreeOrigin,
  type WorktreeRecord,
} from '../../src/index.ts';

/**
 * Durable worktree persistence + recovery, at the unit level (GT-03).
 *
 * The manifest round-trips every field the spec requires — origin cwd/branch/head, path/branch/base,
 * owner/session, recovery state — a FRESH store instance reads what a prior one wrote (the restart
 * path), a missing checkout reconciles to `orphaned`, and a corrupt/malformed manifest fails loudly or
 * isolates the bad entry rather than losing the rest.
 */

const ORIGIN: WorktreeOrigin = {
  originalCwd: '/repo',
  originalBranch: 'main',
  originalHead: '0'.repeat(40),
};

describe('WorktreeStore persistence (GT-03)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qh-wtstore-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const record = (slug: string, path: string): WorktreeRecord => ({
    slug,
    path,
    branch: `qh/${slug}`,
    base: '1'.repeat(40),
    repoRoot: root,
    createdAt: 42,
  });

  const persist = (slug: string, path: string) =>
    toPersisted(record(slug, path), { origin: ORIGIN, owner: 'agent-1', session: 'thr_0001' });

  it('round-trips every GT-03 field, and a fresh store reads what a prior one wrote', () => {
    const present = join(root, 'checkout');
    mkdirSync(present, { recursive: true });
    new WorktreeStore(root).save(persist('feature', present));

    // A brand-new instance — as a restarted process would build — reads the durable manifest.
    const reloaded = new WorktreeStore(root).get('feature');
    expect(reloaded).toBeDefined();
    expect(reloaded!.origin).toEqual(ORIGIN);
    expect(reloaded!.owner).toBe('agent-1');
    expect(reloaded!.session).toBe('thr_0001');
    expect(reloaded!.branch).toBe('qh/feature');
    expect(reloaded!.base).toBe('1'.repeat(40));
    expect(reloaded!.recoveryState).toBe('active'); // the checkout dir exists
  });

  it('marks a record orphaned when its checkout directory is gone (recovery state)', () => {
    const gone = join(root, 'deleted-checkout'); // never created
    expect(persist('lost', gone).recoveryState).toBe('orphaned');
  });

  it('save is an upsert keyed by slug, and remove drops exactly one', () => {
    const store = new WorktreeStore(root);
    store.save(persist('a', join(root, 'a')));
    store.save(persist('b', join(root, 'b')));
    store.save({ ...persist('a', join(root, 'a')), owner: 'agent-2' }); // replace a
    expect(store.list()).toHaveLength(2);
    expect(store.get('a')!.owner).toBe('agent-2');
    store.remove('a');
    expect(store.list().map((w) => w.slug)).toEqual(['b']);
  });

  it('reconcile re-derives recovery state from the filesystem and persists it', () => {
    const store = new WorktreeStore(root);
    const alive = join(root, 'alive');
    mkdirSync(alive, { recursive: true });
    store.save({ ...persist('alive', alive), recoveryState: 'orphaned' }); // stale state on disk
    store.save({ ...persist('dead', join(root, 'dead')), recoveryState: 'active' }); // stale

    const result = reconcile(store);
    const byState = Object.fromEntries(result.map((w) => [w.slug, w.recoveryState]));
    expect(byState).toEqual({ alive: 'active', dead: 'orphaned' });
    // Persisted, not just returned: a fresh store sees the reconciled state.
    expect(new WorktreeStore(root).get('dead')!.recoveryState).toBe('orphaned');
  });

  it('a corrupt manifest fails loudly rather than silently returning nothing', () => {
    mkdirSync(join(root, '.qwen-harness'), { recursive: true });
    writeFileSync(join(root, '.qwen-harness', 'worktrees.json'), '{ not valid json', 'utf8');
    expect(() => new WorktreeStore(root).list()).toThrow(WorktreeError);
  });

  it('one malformed entry is dropped without losing the well-formed ones', () => {
    mkdirSync(join(root, '.qwen-harness'), { recursive: true });
    const good = persist('good', join(root, 'good'));
    writeFileSync(
      join(root, '.qwen-harness', 'worktrees.json'),
      JSON.stringify({ version: 1, worktrees: [good, { slug: 'broken' }] }),
      'utf8',
    );
    const list = new WorktreeStore(root).list();
    expect(list.map((w) => w.slug)).toEqual(['good']);
  });
});
