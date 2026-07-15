import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  WorktreeStore,
  toPersisted,
  type WorktreeOrigin,
  type WorktreeRecord,
} from '../../src/index.ts';

/**
 * The optional task binding is metadata on the WORKTREE side only (GT-05, U + P).
 *
 * A worktree may be bound to a task, but the binding lives in the worktree manifest — `bind` never
 * takes or touches a task graph, so it structurally cannot change a task's state. The binding is
 * optional (a worktree without one is valid), round-trips durably, and toggling it leaves every other
 * field of the record untouched.
 */

const ORIGIN: WorktreeOrigin = {
  originalCwd: '/repo',
  originalBranch: 'main',
  originalHead: '0'.repeat(40),
};

describe('worktree task binding (GT-05)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qh-wtbind-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const record = (slug: string): WorktreeRecord => ({
    slug,
    path: join(root, slug),
    branch: `qh/${slug}`,
    base: '1'.repeat(40),
    repoRoot: root,
    createdAt: 42,
  });

  const persist = (slug: string, boundTaskId?: number) =>
    toPersisted(record(slug), {
      origin: ORIGIN,
      owner: 'agent-1',
      session: 'thr_1',
      ...(boundTaskId !== undefined ? { boundTaskId } : {}),
    });

  it('a worktree with no binding is valid — the binding is optional', () => {
    const store = new WorktreeStore(root);
    store.save(persist('free'));
    expect(store.get('free')!.boundTaskId).toBeUndefined();
  });

  it('bind sets the task id, unbind clears it, and both survive a reload', () => {
    const store = new WorktreeStore(root);
    store.save(persist('w'));

    expect(store.bind('w', 7)!.boundTaskId).toBe(7);
    expect(new WorktreeStore(root).get('w')!.boundTaskId).toBe(7); // durable

    expect(store.bind('w', null)!.boundTaskId).toBeUndefined();
    expect(new WorktreeStore(root).get('w')!.boundTaskId).toBeUndefined();
  });

  it('binding an unknown slug is a no-op that reports it', () => {
    expect(new WorktreeStore(root).bind('nope', 1)).toBeUndefined();
  });

  it('toggling the binding never disturbs any other field (P)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(fc.integer({ min: 0, max: 999 }), fc.constant(null)), { maxLength: 20 }),
        (ops) => {
          const store = new WorktreeStore(root);
          store.save(persist('w'));
          const baseline = { ...store.get('w')! };
          delete (baseline as { boundTaskId?: number }).boundTaskId;

          let expected: number | null = null;
          for (const op of ops) {
            store.bind('w', op);
            expected = op;
          }

          const final = store.get('w')!;
          // The binding reflects the last op (absent after a null), and nothing else moved.
          if (expected === null) expect(final.boundTaskId).toBeUndefined();
          else expect(final.boundTaskId).toBe(expected);
          const { boundTaskId: _b, ...rest } = final;
          expect(rest).toEqual(baseline);
        },
      ),
      { numRuns: 200 },
    );
  });
});
