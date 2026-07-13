import { EventStore, TaskStore } from '@qwen-harness/storage';
import { TaskGraph } from '@qwen-harness/tasks';
import type { Actor, ActorId } from '@qwen-harness/protocol';
import { ManualClock, SequentialIds } from '@qwen-harness/testkit';
import { beforeEach, describe, expect, it } from 'vitest';

import { Inbox, Teammate, TeamRecovery } from '../../src/index.ts';

/** A real TaskGraph over an in-memory event store — the atomic-claim guarantee is only real here. */
function makeGraph(): TaskGraph {
  const clock = new ManualClock(1000);
  const store = new EventStore({ path: ':memory:', clock, ids: new SequentialIds() });
  return new TaskGraph({ store: new TaskStore({ store, clock }) });
}

const actor = (id: string): Actor => ({ kind: 'teammate', id: id as ActorId, label: id });

describe('autonomous teammate loop (AG-11)', () => {
  let graph: TaskGraph;
  beforeEach(() => {
    graph = makeGraph();
  });

  it('claims and completes a pending task, then goes idle', async () => {
    graph.create({ subject: 'do it', activeForm: 'doing it' }, actor('mem_lead'));
    const worked: number[] = [];
    const teammate = new Teammate({
      memberId: 'mem_w1',
      incarnationId: 'inc1',
      inbox: new Inbox(),
      tasks: graph,
      actor: actor('mem_w1'),
      work: (taskId) => {
        worked.push(taskId);
        return Promise.resolve({ ok: true });
      },
      signal: new AbortController().signal,
    });

    const step = await teammate.step();
    expect(step.claimedTask).toBe(1);
    expect(worked).toEqual([1]);
    // A second step finds nothing to do and idles.
    const idle = await teammate.step();
    expect(idle.phase).toBe('idle');
  });

  it('TWO teammates racing for ONE task — exactly one wins (atomic claim, AG-06/WK-06)', async () => {
    graph.create({ subject: 'contested', activeForm: 'x' }, actor('mem_lead'));

    let workedBy: string | null = null;
    const make = (id: string) =>
      new Teammate({
        memberId: id,
        incarnationId: `${id}-inc`,
        inbox: new Inbox(),
        tasks: graph,
        actor: actor(id),
        work: () => {
          workedBy = workedBy ?? id;
          return Promise.resolve({ ok: true });
        },
        signal: new AbortController().signal,
      });

    const [a, b] = [make('mem_a'), make('mem_b')];
    const [sa, sb] = await Promise.all([a.step(), b.step()]);

    // Exactly one claimed the task; the other found it taken and did not.
    const claims = [sa.claimedTask, sb.claimedTask].filter((c) => c === 1);
    expect(claims).toHaveLength(1);
    expect(workedBy).not.toBeNull();
  });

  it('handles a shutdown message FIRST and stops', async () => {
    graph.create({ subject: 'work', activeForm: 'x' }, actor('mem_lead'));
    const inbox = new Inbox();
    inbox.deliver('m1', 'mem_lead', { type: 'shutdown-request', correlationId: 'c1' }, 1);

    const teammate = new Teammate({
      memberId: 'mem_w',
      incarnationId: 'inc',
      inbox,
      tasks: graph,
      actor: actor('mem_w'),
      work: () => Promise.resolve({ ok: true }),
      signal: new AbortController().signal,
    });
    const step = await teammate.step();
    // Shutdown wins over the available task — the teammate stops without claiming.
    expect(step.phase).toBe('stopped');
    expect(step.claimedTask).toBeNull();
  });
});

describe('team recovery (AG-12/AG-13)', () => {
  it('a lost member releases its tasks for requeue, and a new incarnation shares the id', () => {
    const graph = makeGraph();
    graph.create({ subject: 'owned work', activeForm: 'x' }, actor('mem_lead'));
    graph.claim(1, 'mem_w', actor('mem_w'));
    graph.start(1, actor('mem_w'));

    const recovery = new TeamRecovery({ heartbeatTimeoutMs: 100, leaseMs: 100 });
    recovery.spawn('mem_w', 'inc1', 0);
    // No heartbeat; time passes beyond the timeout.
    const lost = recovery.detectLost(1000);
    expect(lost).toEqual(['mem_w']);
    expect(recovery.state('mem_w')).toBe('lost');

    // Its in-progress task is reclaimed (released back to the pool), not left stranded.
    const reclaimed = recovery.reclaimTasks(graph, 'mem_w', actor('mem_system'));
    expect(reclaimed).toEqual([1]);
    // The task is claimable again.
    expect(graph.list().find((t) => t.id === 1)?.owner).toBeNull();

    // Resume: a NEW incarnation under the SAME logical id; the prior one is lost, never running.
    recovery.spawn('mem_w', 'inc2', 2000);
    expect(recovery.state('mem_w')).toBe('running');
    // A heartbeat from the OLD incarnation is rejected.
    expect(recovery.heartbeat('mem_w', 'inc1', 2001)).toBe(false);
    expect(recovery.heartbeat('mem_w', 'inc2', 2001)).toBe(true);
  });
});
