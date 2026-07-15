import { EventStore, TaskStore } from '@qwen-harness/storage';
import type { Actor, ActorId } from '@qwen-harness/protocol';
import { TaskGraph } from '@qwen-harness/tasks';
import { ManualClock, SequentialIds } from '@qwen-harness/testkit';
import { describe, expect, it } from 'vitest';

import { TeamRecovery } from './recovery.ts';

/**
 * Lost-teammate detection and task reclaim, without duplicate execution (AG-12, U + F).
 *
 * A teammate that fails, times out, or loses its heartbeat must have its OWNED, in-flight work
 * released back to the pool — and only its own work — so another teammate can finish it. The releasing
 * never double-runs a task: a released task re-enters the claimable pool and is completed by exactly
 * one teammate. `test/integration/teammate.test.ts` shows the one happy case; this pins the selective
 * reclaim (U) and the full lost -> reclaim -> complete-once flow (F).
 */

function makeGraph(): TaskGraph {
  const clock = new ManualClock(1000);
  const store = new EventStore({ path: ':memory:', clock, ids: new SequentialIds() });
  return new TaskGraph({ store: new TaskStore({ store, clock }) });
}

const actor = (id: string): Actor => ({ kind: 'teammate', id: id as ActorId, label: id });

describe('lost detection + selective reclaim (AG-12, U)', () => {
  it('reclaims ONLY the lost member’s claimed/in-progress tasks, leaving all others untouched', () => {
    const graph = makeGraph();
    for (let i = 0; i < 4; i++) graph.create({ subject: `t${i}`, activeForm: 'x' }, actor('lead'));

    // task 1: lost member, in-progress (reclaim). task 2: lost member, claimed (reclaim).
    graph.claim(1, 'mem_lost', actor('mem_lost'));
    graph.start(1, actor('mem_lost'));
    graph.claim(2, 'mem_lost', actor('mem_lost'));
    // task 3: a DIFFERENT member's in-progress work (must NOT be touched).
    graph.claim(3, 'mem_other', actor('mem_other'));
    graph.start(3, actor('mem_other'));
    // task 4: still pending, unowned (nothing to reclaim).

    const reclaimed = new TeamRecovery().reclaimTasks(graph, 'mem_lost', actor('mem_system'));
    expect(reclaimed.sort()).toEqual([1, 2]);

    const byId = new Map(graph.list().map((t) => [t.id, t]));
    expect(byId.get(1)!.owner).toBeNull(); // released
    expect(byId.get(2)!.owner).toBeNull();
    expect(byId.get(3)!.owner).toBe('mem_other'); // untouched
    expect(byId.get(3)!.status).toBe('in-progress');
    expect(byId.get(4)!.status).toBe('pending');
  });

  it('detectLost marks a member whose heartbeat expired, and spares a fresh one', () => {
    const recovery = new TeamRecovery({ heartbeatTimeoutMs: 100, leaseMs: 100 });
    recovery.spawn('stale', 'inc1', 0);
    recovery.spawn('fresh', 'inc1', 0);
    recovery.heartbeat('fresh', 'inc1', 950); // fresh keeps beating

    const lost = recovery.detectLost(1000);
    expect(lost).toEqual(['stale']);
    expect(recovery.state('stale')).toBe('lost');
    expect(recovery.state('fresh')).toBe('running');
  });
});

describe('reclaim never double-runs work (AG-12, F)', () => {
  it('a lost member’s in-flight task is reclaimed and completed EXACTLY once by another', () => {
    const graph = makeGraph();
    graph.create({ subject: 'owned work', activeForm: 'x' }, actor('lead'));

    const recovery = new TeamRecovery({ heartbeatTimeoutMs: 100, leaseMs: 100 });
    recovery.spawn('mem_a', 'inc1', 0);
    graph.claim(1, 'mem_a', actor('mem_a'));
    graph.start(1, actor('mem_a'));

    // mem_a stops heartbeating; time passes; it is detected lost and its task reclaimed.
    expect(recovery.detectLost(1000)).toEqual(['mem_a']);
    expect(recovery.reclaimTasks(graph, 'mem_a', actor('mem_system'))).toEqual([1]);
    expect(graph.list().find((t) => t.id === 1)!.owner).toBeNull();

    // mem_b picks it up and finishes it. The ORIGINAL owner can no longer complete it.
    const claim = graph.claim(1, 'mem_b', actor('mem_b'));
    expect(claim.ok).toBe(true);
    graph.start(1, actor('mem_b'));
    graph.complete(1, actor('mem_b'));

    const task = graph.list().find((t) => t.id === 1)!;
    expect(task.status).toBe('completed');
    expect(task.owner).toBe('mem_b'); // completed once, by the reclaimer — never double-run
  });
});
