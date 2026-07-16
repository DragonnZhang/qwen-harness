import {
  TaskGraph,
  TodoList,
  type CreateTaskInput,
  type Task,
  type TodoInput,
} from '@qwen-harness/tasks';
import type { Actor, Clock } from '@qwen-harness/protocol';
import { TaskStore, type EventStore } from '@qwen-harness/storage';

import type { FireHook } from './hooks.ts';

/**
 * The durable task graph and the turn-local todo checklist, made reachable from the CLI
 * (WK-01..WK-08).
 *
 * These are TWO deliberately separate systems and this file keeps them that way (WK-02): `task ...`
 * drives the durable dependency graph (`@qwen-harness/tasks` + the SQLite `TaskStore`), whose ids
 * never repeat and whose state machine, dependency rules, and atomic claiming are all enforced by the
 * domain layer. `task todo ...` is the ephemeral working checklist — plain data, no persistence, no
 * owner — exposed so the legacy `TodoWrite` bulk-replace shape stays usable without ever being
 * conflated with a durable {@link Task}.
 *
 * The graph is reconstructed from the durable `task_events` log every time, so a task created in one
 * process is visible (and claimable, and completable) in the next — it survives a restart because it
 * is never held only in memory.
 */

const TASK_ACTOR: Actor = { kind: 'user', id: 'act_user01' as Actor['id'] };

/** Open the durable task graph over an existing event store. */
export function openTaskGraph(store: EventStore, clock: Clock): TaskGraph {
  return new TaskGraph({ store: new TaskStore({ store, clock }) });
}

/**
 * Create a durable task. TaskCreated (HK-01) fires from THIS CLI wrapper — never from inside the
 * `@qwen-harness/tasks` domain package — after the task is durably created, so a hook can observe a
 * genuine new task. `fireHook` is guarded and observe-only: it cannot change or veto the created task.
 */
export async function createTask(
  graph: TaskGraph,
  input: CreateTaskInput,
  fireHook?: FireHook,
): Promise<Task> {
  const task = graph.create(input, TASK_ACTOR);
  await fireHook?.('TaskCreated', { id: task.id, subject: task.subject });
  return task;
}

export function listTasks(graph: TaskGraph, includeDeleted: boolean): Task[] {
  return graph.list({ includeDeleted });
}

export function getTask(graph: TaskGraph, id: number): Task | undefined {
  return graph.get(id);
}

/** Atomically claim a task. A lost race returns `{ ok: false }`; it is data, not an exception. */
export function claimTask(
  graph: TaskGraph,
  id: number,
  owner: string,
): { ok: true; task: Task } | { ok: false; reason: string } {
  return graph.claim(id, owner, TASK_ACTOR);
}

export function startTask(graph: TaskGraph, id: number): Task {
  return graph.start(id, TASK_ACTOR);
}

/**
 * Complete a durable task. TaskCompleted (HK-01) fires from THIS CLI wrapper after the transition,
 * observe-only and guarded — it cannot un-complete the task or alter which tasks it unblocked.
 */
export async function completeTask(
  graph: TaskGraph,
  id: number,
  fireHook?: FireHook,
): Promise<{ task: Task; newlyUnblocked: readonly Task[] }> {
  const result = graph.complete(id, TASK_ACTOR);
  await fireHook?.('TaskCompleted', {
    id: result.task.id,
    unblocked: result.newlyUnblocked.map((t) => t.id),
  });
  return result;
}

export function releaseTask(graph: TaskGraph, id: number): Task {
  return graph.release(id, TASK_ACTOR);
}

export function deleteTask(
  graph: TaskGraph,
  id: number,
): { task: Task; newlyUnblocked: readonly Task[] } {
  return graph.delete(id, TASK_ACTOR);
}

/** A compact, JSON/text-friendly rendering of a task for `task list` / `task get`. */
export function renderTask(task: Task): string {
  const deps = task.blockedBy.length > 0 ? `  blockedBy=[${task.blockedBy.join(',')}]` : '';
  const owner = task.owner ? `  owner=${task.owner}` : '';
  return `#${task.id}  [${task.status}]  ${task.subject}${owner}${deps}`;
}

/**
 * The ephemeral working checklist (WK-01/WK-02). `TodoWrite` bulk-replace semantics: the input is the
 * whole list. This is a pure transformation — it validates and renders the projection — and touches
 * nothing in the durable graph.
 */
export function normalizeTodos(inputs: readonly TodoInput[]): ReturnType<TodoList['projection']> {
  const list = new TodoList();
  list.set(inputs);
  return list.projection();
}
