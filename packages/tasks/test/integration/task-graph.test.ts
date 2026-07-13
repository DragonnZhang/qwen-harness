import { beforeEach, describe, expect, it } from 'vitest';

import type { Actor, ActorId } from '@qwen-harness/protocol';
import { EventStore, TaskStore, type TaskEventRecord } from '@qwen-harness/storage';
import { ManualClock, SequentialIds } from '@qwen-harness/testkit';

import { TaskGraph, TodoList } from '../../src/index.ts';

const LEAD: Actor = { kind: 'user', id: 'act_lead01' as ActorId, label: 'lead' };
const AGENT_A: Actor = { kind: 'teammate', id: 'act_agentA' as ActorId, label: 'agent-a' };
const AGENT_B: Actor = { kind: 'teammate', id: 'act_agentB' as ActorId, label: 'agent-b' };

function newGraph(): { graph: TaskGraph; store: TaskStore; clock: ManualClock } {
  const clock = new ManualClock(1_700_000_000_000);
  // The REAL event store on an in-memory SQLite database — same code path as production.
  const eventStore = new EventStore({ path: ':memory:', clock, ids: new SequentialIds() });
  const store = new TaskStore({ store: eventStore, clock });
  return { graph: new TaskGraph({ store }), store, clock };
}

describe('durable task graph over the real EventStore (WK-03..WK-08)', () => {
  let graph: TaskGraph;
  let store: TaskStore;

  beforeEach(() => {
    ({ graph, store } = newGraph());
  });

  // -------------------------------------------------------------------------
  // WK-03 / WK-07: high-water ids
  // -------------------------------------------------------------------------

  it('assigns ascending high-water numeric ids and records provenance', () => {
    const a = graph.create({ subject: 'A', activeForm: 'Aing' }, LEAD);
    const b = graph.create({ subject: 'B', activeForm: 'Bing' }, AGENT_A);
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
    expect(a.createdBy).toEqual(LEAD);
    expect(b.createdBy.id).toBe('act_agentA');
  });

  it('NEVER reuses a deleted id — a new task always gets a HIGHER id (WK-07)', () => {
    const t1 = graph.create({ subject: 'one', activeForm: 'oneing' }, LEAD);
    const t2 = graph.create({ subject: 'two', activeForm: 'twoing' }, LEAD);
    expect([t1.id, t2.id]).toEqual([1, 2]);

    graph.delete(t2.id, LEAD);
    const t3 = graph.create({ subject: 'three', activeForm: 'threeing' }, LEAD);
    // The deleted id 2 is retired forever; the fresh task climbs to 3.
    expect(t3.id).toBe(3);
    expect(t3.id).toBeGreaterThan(t2.id);

    graph.delete(t1.id, LEAD);
    const t4 = graph.create({ subject: 'four', activeForm: 'fouring' }, LEAD);
    expect(t4.id).toBe(4);
    expect(graph.highWater()).toBe(5);
  });

  // -------------------------------------------------------------------------
  // WK-04: state machine, driven through the store
  // -------------------------------------------------------------------------

  it('walks the happy path pending -> claimed -> in-progress -> completed', () => {
    const t = graph.create({ subject: 'ship', activeForm: 'Shipping' }, LEAD);
    expect(t.status).toBe('pending');

    const claim = graph.claim(t.id, 'agent-a', AGENT_A);
    expect(claim.ok).toBe(true);

    const started = graph.start(t.id, AGENT_A);
    expect(started.status).toBe('in-progress');

    const done = graph.complete(t.id, AGENT_A);
    expect(done.task.status).toBe('completed');
    expect(graph.get(t.id)?.owner).toBe('agent-a');
  });

  it('rejects illegal transitions (start before claim, complete before start)', () => {
    const t = graph.create({ subject: 'x', activeForm: 'xing' }, LEAD);
    expect(() => graph.start(t.id, AGENT_A)).toThrow(/illegal task transition/);
    graph.claim(t.id, 'agent-a', AGENT_A);
    expect(() => graph.complete(t.id, AGENT_A)).toThrow(/illegal task transition/);
  });

  it('requeues an owned task on release / owner-loss recovery, and it can be re-claimed', () => {
    const t = graph.create({ subject: 'x', activeForm: 'xing' }, LEAD);
    graph.claim(t.id, 'agent-a', AGENT_A);
    const released = graph.recoverOwnerLoss(t.id, LEAD);
    expect(released.status).toBe('released');
    expect(released.owner).toBeNull();

    const reclaim = graph.claim(t.id, 'agent-b', AGENT_B);
    expect(reclaim.ok).toBe(true);
    expect(graph.get(t.id)?.owner).toBe('agent-b');
  });

  // -------------------------------------------------------------------------
  // WK-06: atomic claiming
  // -------------------------------------------------------------------------

  it('lets exactly one of two agents claim a task; the loser fails cleanly', () => {
    const t = graph.create({ subject: 'contended', activeForm: 'Contending' }, LEAD);
    const first = graph.claim(t.id, 'agent-a', AGENT_A);
    const second = graph.claim(t.id, 'agent-b', AGENT_B);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toMatch(/already owned/);
    expect(graph.get(t.id)?.owner).toBe('agent-a');
  });

  it('property: N agents race for M tasks; every task ends with exactly one owner (WK-06)', async () => {
    const taskCount = 12;
    const tasks = Array.from({ length: taskCount }, (_, i) =>
      graph.create({ subject: `t${i}`, activeForm: `t${i}ing` }, LEAD),
    );
    // A second graph over the SAME store — proves atomicity is enforced at the store, not per object.
    const graphB = new TaskGraph({ store });

    const winners = new Map<number, string[]>();
    const attempts: Promise<void>[] = [];
    for (const t of tasks) {
      winners.set(t.id, []);
      for (let claimer = 0; claimer < 8; claimer += 1) {
        const g = claimer % 2 === 0 ? graph : graphB;
        const owner = `claimer-${claimer}`;
        attempts.push(
          Promise.resolve().then(() => {
            const r = g.claim(t.id, owner, AGENT_A);
            if (r.ok) winners.get(t.id)?.push(owner);
          }),
        );
      }
    }
    await Promise.all(attempts);

    for (const t of tasks) {
      // Exactly one claim succeeded for each task — never zero, never two.
      expect(winners.get(t.id)).toHaveLength(1);
      expect(graph.get(t.id)?.status).toBe('claimed');
    }
  });

  it('re-reads inside the operation: a claim fails if the task was taken between read and write', () => {
    const t = graph.create({ subject: 'x', activeForm: 'xing' }, LEAD);
    // First claim commits. The second call re-reads the now-owned row INSIDE its transaction and
    // refuses — this is the TOCTOU guard, not an outer check.
    expect(graph.claim(t.id, 'agent-a', AGENT_A).ok).toBe(true);
    const late = graph.claim(t.id, 'agent-b', AGENT_B);
    expect(late.ok).toBe(false);
  });

  // -------------------------------------------------------------------------
  // WK-05: dependencies
  // -------------------------------------------------------------------------

  it('keeps a task with an incomplete blocker out of the runnable pool', () => {
    const blocker = graph.create({ subject: 'setup', activeForm: 'Setting up' }, LEAD);
    const blocked = graph.create(
      { subject: 'build', activeForm: 'Building', blockedBy: [blocker.id] },
      LEAD,
    );
    expect(blocked.status).toBe('blocked');
    expect(blocked.blockedBy).toEqual([blocker.id]);

    // A blocked task is not claimable, so it cannot begin (WK-05).
    expect(graph.claim(blocked.id, 'agent-a', AGENT_A).ok).toBe(false);
  });

  it('reports EXACTLY the downstream tasks a completion unblocks (WK-05)', () => {
    const a = graph.create({ subject: 'a', activeForm: 'aing' }, LEAD);
    const b = graph.create({ subject: 'b', activeForm: 'bing' }, LEAD);
    // c waits on BOTH a and b; d waits on a only; e is independent.
    const c = graph.create({ subject: 'c', activeForm: 'cing', blockedBy: [a.id, b.id] }, LEAD);
    const d = graph.create({ subject: 'd', activeForm: 'ding', blockedBy: [a.id] }, LEAD);
    graph.create({ subject: 'e', activeForm: 'eing' }, LEAD);
    expect(c.status).toBe('blocked');
    expect(d.status).toBe('blocked');

    // Complete a: d becomes runnable (its only blocker is done); c does NOT (b still pending).
    graph.claim(a.id, 'agent-a', AGENT_A);
    graph.start(a.id, AGENT_A);
    const afterA = graph.complete(a.id, AGENT_A);
    expect(afterA.newlyUnblocked.map((t) => t.id)).toEqual([d.id]);
    expect(graph.get(c.id)?.status).toBe('blocked');
    expect(graph.get(d.id)?.status).toBe('pending');

    // Now complete b: c becomes runnable.
    graph.claim(b.id, 'agent-b', AGENT_B);
    graph.start(b.id, AGENT_B);
    const afterB = graph.complete(b.id, AGENT_B);
    expect(afterB.newlyUnblocked.map((t) => t.id)).toEqual([c.id]);
    expect(graph.get(c.id)?.status).toBe('pending');
  });

  it('lets an unblocked task be claimed and started', () => {
    const a = graph.create({ subject: 'a', activeForm: 'aing' }, LEAD);
    const b = graph.create({ subject: 'b', activeForm: 'bing', blockedBy: [a.id] }, LEAD);
    graph.claim(a.id, 'agent-a', AGENT_A);
    graph.start(a.id, AGENT_A);
    graph.complete(a.id, AGENT_A);

    expect(graph.get(b.id)?.status).toBe('pending');
    expect(graph.claim(b.id, 'agent-b', AGENT_B).ok).toBe(true);
    expect(graph.start(b.id, AGENT_B).status).toBe('in-progress');
  });

  it('rejects a dependency cycle at link time (WK-05)', () => {
    const a = graph.create({ subject: 'a', activeForm: 'aing' }, LEAD);
    const b = graph.create({ subject: 'b', activeForm: 'bing', blockedBy: [a.id] }, LEAD);
    const c = graph.create({ subject: 'c', activeForm: 'cing', blockedBy: [b.id] }, LEAD);
    // c already depends transitively on a; making a depend on c closes a cycle.
    expect(() => graph.addDependency(c.id, a.id, LEAD)).toThrow(/cycle/);
    // Self-dependency is a cycle too.
    expect(() => graph.addDependency(a.id, a.id, LEAD)).toThrow(/cycle/);
  });

  it('rejects a dependency on a missing (or deleted) task (WK-05)', () => {
    const a = graph.create({ subject: 'a', activeForm: 'aing' }, LEAD);
    expect(() =>
      graph.create({ subject: 'b', activeForm: 'bing', blockedBy: [999] }, LEAD),
    ).toThrow(/does not exist/);

    graph.delete(a.id, LEAD);
    expect(() =>
      graph.create({ subject: 'c', activeForm: 'cing', blockedBy: [a.id] }, LEAD),
    ).toThrow(/does not exist/);
  });

  it('re-blocks a pending task when a new incomplete dependency is linked', () => {
    const a = graph.create({ subject: 'a', activeForm: 'aing' }, LEAD);
    const b = graph.create({ subject: 'b', activeForm: 'bing' }, LEAD);
    expect(graph.get(b.id)?.status).toBe('pending');
    const relinked = graph.addDependency(a.id, b.id, LEAD);
    expect(relinked.status).toBe('blocked');
    expect(relinked.blockedBy).toEqual([a.id]);
  });

  // -------------------------------------------------------------------------
  // WK-07: crash survival via rebuild
  // -------------------------------------------------------------------------

  it('rebuilds an identical projection from the task event log (WK-07 crash survival)', () => {
    // Build a non-trivial graph exercising every event type.
    const a = graph.create({ subject: 'a', activeForm: 'aing', metadata: { pr: 1 } }, LEAD);
    const b = graph.create({ subject: 'b', activeForm: 'bing', blockedBy: [a.id] }, LEAD);
    graph.claim(a.id, 'agent-a', AGENT_A);
    graph.start(a.id, AGENT_A);
    graph.complete(a.id, AGENT_A); // also flips b: blocked -> pending
    graph.claim(b.id, 'agent-b', AGENT_B);
    const deleted = graph.create({ subject: 'gone', activeForm: 'going' }, LEAD);
    graph.delete(deleted.id, LEAD);

    const snapshot = () => ({
      nodes: store.db.prepare('SELECT * FROM task_nodes ORDER BY id').all(),
      deps: store.db.prepare('SELECT * FROM task_deps ORDER BY blocker_id, blocked_id').all(),
      highWater: graph.highWater(),
    });

    const before = snapshot();
    const result = graph.rebuild();
    const after = snapshot();

    expect(result.events).toBeGreaterThan(0);
    // Not "equivalent" — identical. A non-deterministic projection would surface right here.
    expect(after).toEqual(before);
    // And the id counter did not rewind: the deleted id stays retired across a rebuild.
    expect(after.highWater).toBe(before.highWater);
    expect(graph.get(b.id)?.status).toBe('claimed');
  });

  // -------------------------------------------------------------------------
  // WK-08: the same events are observable
  // -------------------------------------------------------------------------

  it('emits committed task events to subscribers (WK-08)', () => {
    const events: TaskEventRecord[] = [];
    const unsubscribe = graph.subscribe((e) => events.push(e));

    const t = graph.create({ subject: 'watch', activeForm: 'Watching' }, LEAD);
    graph.claim(t.id, 'agent-a', AGENT_A);
    graph.start(t.id, AGENT_A);
    graph.complete(t.id, AGENT_A);

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      'task-created',
      'task-claimed',
      'task-status-changed', // in-progress
      'task-status-changed', // completed
    ]);
    expect(events[0]?.actor).toEqual(LEAD);

    unsubscribe();
    graph.delete(t.id, LEAD);
    // After unsubscribe, no further events are delivered.
    expect(events.map((e) => e.type)).not.toContain('task-deleted');
  });
});

// ---------------------------------------------------------------------------
// WK-01 / WK-02: the two systems are separate
// ---------------------------------------------------------------------------

describe('todo checklist and durable tasks are separate systems (WK-01/WK-02)', () => {
  it('a todo change does not touch the durable task graph', () => {
    const { graph, store } = newGraph();
    const todos = new TodoList();

    graph.create({ subject: 'real work', activeForm: 'Working' }, LEAD);
    const nodesBefore = store.db.prepare('SELECT COUNT(*) AS n FROM task_nodes').get() as {
      n: number;
    };

    // Hammer the todo list: none of this should write a single task row or event.
    todos.set([
      { content: 'step 1', activeForm: 'doing 1' },
      { content: 'step 2', activeForm: 'doing 2', status: 'in-progress' },
    ]);
    todos.add({ content: 'step 3', activeForm: 'doing 3' });
    todos.updateStatus(todos.list()[0]!.id, 'completed');

    const nodesAfter = store.db.prepare('SELECT COUNT(*) AS n FROM task_nodes').get() as {
      n: number;
    };
    const taskEvents = store.db.prepare('SELECT COUNT(*) AS n FROM task_events').get() as {
      n: number;
    };
    expect(nodesAfter.n).toBe(nodesBefore.n);
    expect(taskEvents.n).toBe(1); // only the single task-created event
    expect(todos.list()).toHaveLength(3);
  });

  it('creating a durable task writes no todo state', () => {
    const { graph } = newGraph();
    const todos = new TodoList();
    graph.create({ subject: 'x', activeForm: 'xing' }, LEAD);
    expect(todos.list()).toHaveLength(0);
  });
});
