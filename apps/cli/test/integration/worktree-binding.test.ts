import { rmSync } from 'node:fs';

import type { Actor, ActorId } from '@qwen-harness/protocol';
import { EventStore, TaskStore } from '@qwen-harness/storage';
import { TaskGraph } from '@qwen-harness/tasks';
import { ManualClock, SequentialIds, FixtureRepo } from '@qwen-harness/testkit';
import {
  WorktreeStore,
  captureWorktreeOrigin,
  createWorktree,
  reconcile,
  toPersisted,
} from '@qwen-harness/worktrees';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Task ownership and workspace ownership are independently recoverable (GT-05, I + F).
 *
 * A worktree is bound to a task through the REAL WorktreeStore while the task lives in the REAL
 * TaskGraph. Binding never changes the task (I). Then a crash orphans the worktree checkout: the task
 * is untouched, and — conversely — completing the task never disturbs the worktree's binding (F). The
 * two stores recover on independent tracks; neither can silently corrupt the other.
 */

const actor = (id: string): Actor => ({ kind: 'teammate', id: id as ActorId, label: id });

describe('task/worktree binding independence (GT-05)', () => {
  let repo: FixtureRepo;
  let graph: TaskGraph;

  beforeEach(() => {
    repo = FixtureRepo.create({ 'a.txt': 'hi\n' });
    const clock = new ManualClock(1000);
    const store = new EventStore({ path: ':memory:', clock, ids: new SequentialIds() });
    graph = new TaskGraph({ store: new TaskStore({ store, clock }) });
  });
  afterEach(() => repo.dispose());

  function bindWorktreeToTask(slug: string, taskId: number) {
    const wt = createWorktree({ repoRoot: repo.root, slug, now: 1 });
    const wtStore = new WorktreeStore(repo.root);
    wtStore.save(
      toPersisted(wt, {
        origin: captureWorktreeOrigin(repo.root),
        owner: 'mem_a',
        session: 'thr_1',
      }),
    );
    wtStore.bind(slug, taskId);
    return { wt, wtStore };
  }

  it('binding a worktree to a task never changes the task’s state (I)', () => {
    graph.create({ subject: 'work', activeForm: 'x' }, actor('lead'));
    graph.claim(1, 'mem_a', actor('mem_a'));
    const before = graph.list().find((t) => t.id === 1)!;
    const snapshot = { owner: before.owner, status: before.status };

    bindWorktreeToTask('feature', 1);

    const after = graph.list().find((t) => t.id === 1)!;
    expect({ owner: after.owner, status: after.status }).toEqual(snapshot); // untouched
    // The binding is recorded on the worktree side, readable by a fresh store.
    expect(new WorktreeStore(repo.root).get('feature')!.boundTaskId).toBe(1);
  });

  it('an orphaned worktree and a completed task recover independently (F)', () => {
    graph.create({ subject: 'work', activeForm: 'x' }, actor('lead'));
    graph.claim(1, 'mem_a', actor('mem_a'));
    const { wt } = bindWorktreeToTask('feature', 1);

    // A crash removed the worktree checkout. Reconcile marks it orphaned...
    rmSync(wt.path, { recursive: true, force: true });
    reconcile(new WorktreeStore(repo.root));

    // ...but the bound task is entirely unaffected — task ownership recovers on its own track.
    const task = graph.list().find((t) => t.id === 1)!;
    expect(task.owner).toBe('mem_a');
    expect(task.status).toBe('claimed');
    const rec = new WorktreeStore(repo.root).get('feature')!;
    expect(rec.recoveryState).toBe('orphaned');
    expect(rec.boundTaskId).toBe(1); // the binding metadata survived the orphaning

    // Conversely, finishing the task does not disturb the worktree binding.
    graph.start(1, actor('mem_a'));
    graph.complete(1, actor('mem_a'));
    expect(graph.list().find((t) => t.id === 1)!.status).toBe('completed');
    expect(new WorktreeStore(repo.root).get('feature')!.boundTaskId).toBe(1);
  });
});
