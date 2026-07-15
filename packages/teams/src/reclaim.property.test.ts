import { EventStore, TaskStore } from '@qwen-harness/storage';
import type { Actor, ActorId } from '@qwen-harness/protocol';
import { TaskGraph } from '@qwen-harness/tasks';
import { ManualClock, SequentialIds } from '@qwen-harness/testkit';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { TeamRecovery } from './recovery.ts';

/**
 * Selective reclaim as a PROPERTY (AG-12).
 *
 * For ANY roster of members owning tasks in any state, reclaiming a lost member releases EXACTLY that
 * member's claimed/in-progress tasks — never a completed one (that work is done), never another
 * member's (that work is still owned), never an unowned one — and every task it does not reclaim is
 * left byte-identical. That selectivity is what keeps recovery from stealing or losing live work.
 */

const POOL = ['m0', 'm1', 'm2'] as const;
const actor = (id: string): Actor => ({ kind: 'teammate', id: id as ActorId, label: id });

function makeGraph(): TaskGraph {
  const clock = new ManualClock(1000);
  const store = new EventStore({ path: ':memory:', clock, ids: new SequentialIds() });
  return new TaskGraph({ store: new TaskStore({ store, clock }) });
}

type State = 'pending' | 'claimed' | 'in-progress' | 'completed';

describe('reclaim selectivity (AG-12, P)', () => {
  it('reclaims exactly the lost member’s active tasks and leaves everything else identical', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            state: fc.constantFrom<State>('pending', 'claimed', 'in-progress', 'completed'),
            ownerIdx: fc.integer({ min: 0, max: POOL.length - 1 }),
          }),
          { minLength: 1, maxLength: 20 },
        ),
        fc.integer({ min: 0, max: POOL.length - 1 }),
        (specs, lostIdx) => {
          const graph = makeGraph();
          const lost = POOL[lostIdx]!;

          // Build the roster: task id is 1-based in creation order.
          specs.forEach((spec, i) => {
            const id = i + 1;
            graph.create({ subject: `t${i}`, activeForm: 'x' }, actor('lead'));
            if (spec.state === 'pending') return;
            const owner = POOL[spec.ownerIdx]!;
            graph.claim(id, owner, actor(owner));
            if (spec.state === 'claimed') return;
            graph.start(id, actor(owner));
            if (spec.state === 'in-progress') return;
            graph.complete(id, actor(owner));
          });

          const expected = specs
            .map((spec, i) => ({ id: i + 1, spec }))
            .filter(
              ({ spec }) =>
                POOL[spec.ownerIdx] === lost &&
                (spec.state === 'claimed' || spec.state === 'in-progress'),
            )
            .map(({ id }) => id);

          const before = new Map(
            graph.list().map((t) => [t.id, { owner: t.owner, status: t.status }]),
          );
          const reclaimed = new TeamRecovery().reclaimTasks(graph, lost, actor('system'));

          // Exactly the lost member's active tasks, nothing more or less.
          expect([...reclaimed].sort((a, b) => a - b)).toEqual(expected.sort((a, b) => a - b));

          for (const t of graph.list()) {
            if (reclaimed.includes(t.id)) {
              expect(t.owner).toBeNull(); // released back to the pool
            } else {
              // Untouched: same owner, same status as before the reclaim.
              expect({ owner: t.owner, status: t.status }).toEqual(before.get(t.id));
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
