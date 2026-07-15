import { EventStore, TaskStore } from '@qwen-harness/storage';
import type { Actor, ActorId } from '@qwen-harness/protocol';
import { TaskGraph } from '@qwen-harness/tasks';
import { ManualClock, SequentialIds } from '@qwen-harness/testkit';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { Inbox } from './inbox.ts';
import { Teammate } from './teammate.ts';

/**
 * The distribution property of a self-organizing team (AG-11, P).
 *
 * Any number of teammates sharing one task pool, stepped concurrently in rounds, drain it so that
 * EVERY task is worked EXACTLY ONCE by EXACTLY ONE teammate — no task double-worked, none stranded.
 * That is the guarantee that lets a team make progress with no central dispatcher: the atomic claim,
 * not a coordinator, is what prevents two teammates doing the same task.
 */

const actor = (id: string): Actor => ({ kind: 'teammate', id: id as ActorId, label: id });

function makeGraph(): TaskGraph {
  const clock = new ManualClock(1000);
  const store = new EventStore({ path: ':memory:', clock, ids: new SequentialIds() });
  return new TaskGraph({ store: new TaskStore({ store, clock }) });
}

describe('team work distribution (AG-11, P)', () => {
  it('N teammates drain M tasks with every task worked exactly once', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 10 }),
        async (memberCount, taskCount) => {
          const graph = makeGraph();
          for (let i = 0; i < taskCount; i++) {
            graph.create({ subject: `task ${i}`, activeForm: 'x' }, actor('mem_lead'));
          }

          const workCount = new Map<number, number>();
          const owners = new Map<number, string>();
          const mates = Array.from({ length: memberCount }, (_, i) => {
            const id = `mem_${i}`;
            return new Teammate({
              memberId: id,
              incarnationId: `${id}-inc`,
              inbox: new Inbox(),
              tasks: graph,
              actor: actor(id),
              work: (taskId) => {
                workCount.set(taskId, (workCount.get(taskId) ?? 0) + 1);
                if (!owners.has(taskId)) owners.set(taskId, id);
                return Promise.resolve({ ok: true });
              },
              signal: new AbortController().signal,
            });
          });

          // Step everyone concurrently, round after round, until the pool is drained. Bounded so a
          // bug that fails to make progress fails the test instead of hanging.
          const maxRounds = taskCount + memberCount + 5;
          for (let round = 0; round < maxRounds; round++) {
            const claimable = graph
              .list()
              .some((t) => t.owner === null && (t.status === 'pending' || t.status === 'released'));
            if (!claimable) break;
            await Promise.all(mates.map((m) => m.step()));
          }

          const tasks = graph.list();
          // Every task completed, exactly once, by exactly one owner.
          expect(tasks.every((t) => t.status === 'completed')).toBe(true);
          expect(workCount.size).toBe(taskCount);
          expect([...workCount.values()].every((c) => c === 1)).toBe(true);
          expect(owners.size).toBe(taskCount);
        },
      ),
      { numRuns: 150 },
    );
  });
});
