/**
 * @qwen-harness/tasks
 *
 * TWO distinct systems for tracking work, which the runtime must never conflate (WK-01/WK-02):
 *
 *  1. {@link TodoList} — the turn-local todo checklist. Ephemeral, per-turn working memory:
 *     pending/in-progress/completed steps with an `activeForm` label and explicit order, shown in
 *     the TUI and carried across compaction as plain data. No owner, no dependencies, no database.
 *
 *  2. {@link TaskGraph} — the durable dependency task graph. Persistent, cross-turn work with
 *     high-water numeric ids that are never reused (WK-07), a validated state machine (WK-04),
 *     dependency blocking with cycle/missing-reference rejection (WK-05), and atomic TOCTOU-safe
 *     claiming (WK-06). It persists through the storage event log; this package holds the rules,
 *     `@qwen-harness/storage` owns the SQLite log and projection.
 *
 * A todo change touches nothing in the task graph, and a task change writes no todo.
 */

export { TodoList, TODO_STATUSES, TodoStatusSchema, TodoInputSchema } from './todo.ts';
export type { Todo, TodoInput, TodoStatus, TodoProjection } from './todo.ts';

export { TaskGraph, CreateTaskInputSchema } from './task-graph.ts';
export type {
  Task,
  CreateTaskInput,
  ClaimResult,
  CompleteResult,
  TaskGraphListener,
} from './task-graph.ts';

export {
  TASK_STATUSES,
  TaskStatusSchema,
  TASK_TRANSITIONS,
  canTransition,
  isOwned,
  isClaimable,
  isTerminal,
  OWNED_STATUSES,
  CLAIMABLE_STATUSES,
} from './state-machine.ts';
export type { TaskStatus } from './state-machine.ts';

export {
  blockersOf,
  blocksOf,
  wouldCreateCycle,
  detectCycle,
  allBlockersCompleted,
  newlyUnblocked,
} from './dependencies.ts';
export type { DepEdge } from './dependencies.ts';
