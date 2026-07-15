import { EventStore, TaskStore } from '@qwen-harness/storage';
import type { Actor, ActorId } from '@qwen-harness/protocol';
import { TaskGraph } from '@qwen-harness/tasks';
import { ManualClock, SequentialIds } from '@qwen-harness/testkit';
import { describe, expect, it } from 'vitest';

import { Inbox } from './inbox.ts';
import { Teammate, type TeammateContext } from './teammate.ts';

/**
 * The autonomous teammate loop as a state machine, and its failure paths (AG-11, U + F).
 *
 * `test/integration/teammate.test.ts` drives the loop over a real graph end to end; this pins the
 * transitions and the fault behavior directly: the ordered WORK -> IDLE cycle, shutdown winning over
 * available work, and — the F case — a FAILED unit of work RELEASING its task back to the pool so it
 * is retryable, never silently completed or stranded.
 */

function makeGraph(): TaskGraph {
  const clock = new ManualClock(1000);
  const store = new EventStore({ path: ':memory:', clock, ids: new SequentialIds() });
  return new TaskGraph({ store: new TaskStore({ store, clock }) });
}

const actor = (id: string): Actor => ({ kind: 'teammate', id: id as ActorId, label: id });

function teammate(graph: TaskGraph, over: Partial<TeammateContext> = {}): Teammate {
  return new Teammate({
    memberId: 'mem_w1',
    incarnationId: 'inc1',
    inbox: new Inbox(),
    tasks: graph,
    actor: actor('mem_w1'),
    work: () => Promise.resolve({ ok: true }),
    signal: new AbortController().signal,
    ...over,
  });
}

describe('teammate loop transitions (AG-11, U)', () => {
  it('claims a pending task, works it to completion, then idles when the pool is empty', async () => {
    const graph = makeGraph();
    graph.create({ subject: 'do it', activeForm: 'doing it' }, actor('mem_lead'));
    const worked: number[] = [];
    const mate = teammate(graph, {
      work: (id) => {
        worked.push(id);
        return Promise.resolve({ ok: true });
      },
    });

    const first = await mate.step();
    expect(first.phase).toBe('work');
    expect(first.claimedTask).toBe(1);
    expect(worked).toEqual([1]);
    expect(graph.list().find((t) => t.id === 1)?.status).toBe('completed');

    const second = await mate.step();
    expect(second.phase).toBe('idle');
    expect(second.claimedTask).toBeNull();
  });

  it('a stopped teammate stays stopped and does no more work', async () => {
    const graph = makeGraph();
    graph.create({ subject: 'x', activeForm: 'x' }, actor('mem_lead'));
    const inbox = new Inbox();
    inbox.deliver('m1', 'mem_lead', { type: 'shutdown-request', correlationId: 'c1' }, 1);
    const mate = teammate(graph, { inbox });

    expect((await mate.step()).phase).toBe('stopped');
    // The task was never claimed, and further steps are inert.
    expect(graph.list().find((t) => t.id === 1)?.owner).toBeNull();
    const again = await mate.step();
    expect(again.phase).toBe('stopped');
    expect(again.claimedTask).toBeNull();
  });

  it('an aborted signal stops the loop before it claims anything', async () => {
    const graph = makeGraph();
    graph.create({ subject: 'x', activeForm: 'x' }, actor('mem_lead'));
    const ac = new AbortController();
    ac.abort();
    const step = await teammate(graph, { signal: ac.signal }).step();
    expect(step.phase).toBe('stopped');
    expect(graph.list().find((t) => t.id === 1)?.owner).toBeNull();
  });
});

describe('teammate failure handling (AG-11, F)', () => {
  it('a failed unit of work RELEASES its task so another teammate can retry it', async () => {
    const graph = makeGraph();
    graph.create({ subject: 'flaky', activeForm: 'x' }, actor('mem_lead'));

    // First teammate: work fails.
    const failing = teammate(graph, {
      memberId: 'mem_fail',
      actor: actor('mem_fail'),
      work: () => Promise.resolve({ ok: false }),
    });
    const failed = await failing.step();
    expect(failed.claimedTask).toBe(1);
    // Released, not completed — it is claimable again, not stranded under the failed owner.
    const t = graph.list().find((x) => x.id === 1)!;
    expect(t.status).not.toBe('completed');
    expect(t.owner).toBeNull();

    // A second teammate re-claims and completes it — the work is retried, not lost.
    const worked: number[] = [];
    const recovering = teammate(graph, {
      memberId: 'mem_ok',
      actor: actor('mem_ok'),
      work: (id) => {
        worked.push(id);
        return Promise.resolve({ ok: true });
      },
    });
    await recovering.step();
    expect(worked).toEqual([1]);
    expect(graph.list().find((x) => x.id === 1)?.status).toBe('completed');
  });
});
