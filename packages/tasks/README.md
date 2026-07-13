# @qwen-harness/tasks

Work tracking for the harness. This package deliberately contains **two distinct systems** that
must never be conflated (capability matrix E, WK-01/WK-02):

| | `TodoList` (turn-local todo checklist) | `TaskGraph` (durable dependency task graph) |
|---|---|---|
| Lifetime | ephemeral, per turn | persistent, cross-turn |
| Identity | list-local ids, reset on bulk replace | high-water numeric ids, never reused |
| Persistence | none — plain data carried through compaction | append-only event log in `@qwen-harness/storage` |
| Ownership | none | nullable `owner`, atomically claimed |
| Dependencies | none | `blocks` / `blockedBy`, cycle-checked |
| States | `pending` / `in-progress` / `completed` | `pending` / `blocked` / `claimed` / `in-progress` / `completed` / `released` / `deleted` |

A todo change writes nothing to the task graph, and a task change writes no todo. They are separate
on purpose: the todo list is the agent's scratch checklist for the current turn; the task graph is
durable, shareable, dependency-aware work that survives crashes and is claimed by agents/teammates.

## System A — the turn-local todo checklist (WK-01/WK-02)

`TodoList` is in-memory working memory. Each entry has `content` (imperative label), `activeForm`
(present-continuous label shown while it runs), a `status`, and an explicit `order`.

```ts
import { TodoList } from '@qwen-harness/tasks';

const todos = new TodoList();
todos.set([
  // Legacy `TodoWrite`-style bulk replace stays usable (WK-02).
  { content: 'Read the spec', activeForm: 'Reading the spec', status: 'completed' },
  { content: 'Write the code', activeForm: 'Writing the code', status: 'in-progress' },
]);
todos.add({ content: 'Run the tests', activeForm: 'Running the tests' });
todos.projection(); // { items, activeLabel, counts } — the shape the TUI renders

// Carried across a compaction boundary as plain data:
const restored = TodoList.fromSnapshot(todos.snapshot());
```

## System B — the durable dependency task graph (WK-03..WK-08)

`TaskGraph` holds the **rules** (state machine, dependency reasoning, atomic claiming) and drives
`@qwen-harness/storage`'s `TaskStore`, which owns the SQLite log and projection. Task state is an
append-only `task_events` log projected into `task_nodes` / `task_deps`, in the same database and
under the same single-writer guarantees as the main event store.

```ts
import { EventStore, TaskStore } from '@qwen-harness/storage';
import { TaskGraph } from '@qwen-harness/tasks';

const store = new TaskStore({ store: eventStore, clock });
const graph = new TaskGraph({ store });

const setup = graph.create({ subject: 'Set up', activeForm: 'Setting up' }, actor);
const build = graph.create(
  { subject: 'Build', activeForm: 'Building', blockedBy: [setup.id] },
  actor,
); // build.status === 'blocked'

const claim = graph.claim(setup.id, 'agent-a', actor); // { ok: true } | { ok: false, reason }
graph.start(setup.id, actor);
const { newlyUnblocked } = graph.complete(setup.id, actor); // [build] — now runnable

graph.subscribe((event) => {/* hooks + TUI consume the SAME committed task events (WK-08) */});
```

### Guarantee: atomic claiming is TOCTOU-safe (WK-06)

`claim(taskId, owner)` runs its read-and-conditional-write **inside one SQLite transaction**. It
re-reads the current owner *inside* that transaction and appends the claim event only if the task is
still unowned and claimable. Because the store is single-writer and better-sqlite3 transactions are
serialized, two agents racing for the same task cannot both win — the loser re-reads an already-owned
row and gets `{ ok: false }`. A lost race is ordinary data, not an exception. The concurrency
property test (`test/integration`) races many claimers across two `TaskGraph` instances sharing one
store and asserts every task ends with exactly one owner.

### Guarantee: ids are never reused (WK-07)

A single-row high-water counter is allocated inside the same transaction as task creation and only
ever **increases**. Deleting a task never rewinds it, so a deleted id can never be handed out again —
reuse is impossible by construction, not prevented by a uniqueness check after the fact. A rebuild of
the projection from the log leaves the counter untouched, so retired ids stay retired across recovery.

### Guarantee: crash survival (WK-07)

The event and the projection it implies commit together, so a crash never leaves a task whose log and
whose materialized state disagree. `graph.rebuild()` replays `task_events` in one transaction and
lands on a byte-identical projection — the integration suite asserts this against a graph that
exercises every event type.

### State machine (WK-04) and dependencies (WK-05)

Legal transitions are encoded as data in `state-machine.ts` and validated on every mutation; illegal
transitions are rejected. A task cannot begin until every task in its `blockedBy` is completed:
tasks with an incomplete blocker are held in `blocked` (not claimable), and completing an upstream
task reports **exactly** the downstream tasks that became runnable. Dependency cycles and missing
references are rejected at creation and at link time via a topological check (property-tested against
an independent DFS cycle oracle in `dependencies.test.ts`).

## Layout

- `todo.ts` — the turn-local checklist (System A).
- `state-machine.ts` — durable task statuses and the legal-transition table.
- `dependencies.ts` — pure cycle detection, blocker resolution, and newly-unblocked computation.
- `task-graph.ts` — the durable `TaskGraph` domain over the storage `TaskStore` (System B).

The SQLite log/projection lives in `@qwen-harness/storage` (`task-store.ts`, migration v2). This
package never opens a database directly — the architecture gate forbids it — it drives storage's
transaction primitive so its read-decide-write happens inside one transaction.
