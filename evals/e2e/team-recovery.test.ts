import { EventStore, TaskStore } from '@qwen-harness/storage';
import type { Actor, ActorId } from '@qwen-harness/protocol';
import { TaskGraph } from '@qwen-harness/tasks';
import { Inbox, Teammate, TeamRecovery } from '@qwen-harness/teams';
import { ManualClock, SequentialIds } from '@qwen-harness/testkit';
import { describe, expect, it } from 'vitest';

/**
 * Teammate loss -> reclaim -> requeue -> complete-once, end to end (AG-12).
 *
 * A teammate claims and starts a task, then vanishes (a crash: no completion, no more heartbeats).
 * The recovery machinery detects it lost, reclaims its in-flight task, and a live teammate — running
 * the REAL autonomous loop — drains the pool, finishing the abandoned task along with the rest. The
 * golden assertion is the anti-duplication one: every task is completed EXACTLY once, and the
 * abandoned task is finished by the survivor, never double-run by the ghost.
 */

const actor = (id: string): Actor => ({ kind: 'teammate', id: id as ActorId, label: id });

function makeGraph(): TaskGraph {
  const clock = new ManualClock(1000);
  const store = new EventStore({ path: ':memory:', clock, ids: new SequentialIds() });
  return new TaskGraph({ store: new TaskStore({ store, clock }) });
}

describe('team recovery golden path: a lost teammate’s work is finished exactly once (AG-12)', () => {
  it('detects the loss, reclaims the in-flight task, and a survivor completes the whole pool once', async () => {
    const graph = makeGraph();
    for (let i = 0; i < 3; i++) graph.create({ subject: `t${i}`, activeForm: 'x' }, actor('lead'));

    const recovery = new TeamRecovery({ heartbeatTimeoutMs: 100, leaseMs: 100 });

    // Teammate A claims and STARTS task 1, then crashes — it never completes and never heartbeats.
    recovery.spawn('mem_a', 'inc_a', 0);
    graph.claim(1, 'mem_a', actor('mem_a'));
    graph.start(1, actor('mem_a'));

    // Recovery notices A is gone (heartbeat expired) and reclaims its in-flight task.
    expect(recovery.detectLost(1000)).toEqual(['mem_a']);
    expect(recovery.reclaimTasks(graph, 'mem_a', actor('system'))).toEqual([1]);

    // A live survivor runs the REAL loop and drains everything, including the reclaimed task.
    const workLog: number[] = [];
    recovery.spawn('mem_b', 'inc_b', 1000);
    const survivor = new Teammate({
      memberId: 'mem_b',
      incarnationId: 'inc_b',
      inbox: new Inbox(),
      tasks: graph,
      actor: actor('mem_b'),
      work: (taskId) => {
        workLog.push(taskId);
        return Promise.resolve({ ok: true });
      },
      signal: new AbortController().signal,
    });

    for (let round = 0; round < 10; round++) {
      const claimable = graph
        .list()
        .some((t) => t.owner === null && (t.status === 'pending' || t.status === 'released'));
      if (!claimable) break;
      await survivor.step();
    }

    const tasks = graph.list();
    // Every task done, exactly once, and the reclaimed one was finished by the survivor.
    expect(tasks.every((t) => t.status === 'completed')).toBe(true);
    expect(tasks.every((t) => t.owner === 'mem_b')).toBe(true);
    expect([...workLog].sort((a, b) => a - b)).toEqual([1, 2, 3]);
    // No duplicate execution — the ghost never re-ran task 1.
    expect(new Set(workLog).size).toBe(workLog.length);
  });
});
