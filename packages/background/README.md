# @qwen-harness/background

One **unified lifecycle** for background work (capability matrix J, BG-01..BG-06).

This package is pure coordination and a state machine. It opens no host capability (the architecture
gate forbids it), takes time as an injected `Clock`, and takes process spawning as an injected
`Runner` — so the lifecycle is deterministic and testable without real processes or wall-clock waits.
The manager **reports and steers**; it never touches a real process itself.

## Categories (BG-03)

Exactly the three categories whose owners exist today, through one lifecycle:

```ts
type BackgroundCategory = 'local-shell' | 'local-workflow' | 'dream-consolidation';
```

Agent, teammate, remote, and MCP background work are added later, once those owners land — a no-op
placeholder category would be a lie the lifecycle would have to special-case, so it is absent.

## Placement (BG-01)

```ts
import { classifyForeground } from '@qwen-harness/background';
classifyForeground({ explicit: 'background' }); // an explicit choice always wins
classifyForeground({ hint: { longLived: true } }); // conservative fallback (NOT a duration guess)
```

Foreground/background is an explicit parameter. With nothing stated, the fallback is conservative:
default to **foreground** (keep work visible and attached) unless the hint clearly indicates
long-lived, non-interactive work — the only case safe to background on its own.

## The manager (BG-02, BG-04, BG-05, BG-06)

```ts
import { BackgroundManager } from '@qwen-harness/background';

const manager = new BackgroundManager({ clock, ids, runner });
const task = manager.start({ category: 'local-shell', owner, permissionContext, placement: 'background' });
// `task.id` and a status snapshot are available synchronously — the caller never waits (BG-02).

manager.get(task.id); // status, owner, permission context, incremental output, output ref
manager.provideInput(task.id, 'yes'); // resume a task that requested input
manager.stop(task.id); // cancel + cleanup (idempotent)
await manager.awaitTask(task.id); // resolve on a terminal state
manager.list(); // the /tasks + TUI data surface (BG-06)
```

- **BG-02**: start returns a unique id immediately and exposes status, owner, permission context,
  incremental output + a durable `outputRef`, stop, await, and a completion notification.
- **BG-04**: the completion notification is a **new attributed event** with its own id — never the
  originating tool-call id; a duplicate exit is **idempotent** (one effect only).
- **BG-05**: bounded output preview with warn/hard-stop thresholds, **four-way foreground
  concurrency** with FIFO admission of a queued fifth task, a typed input request, a **30-second
  input watchdog**, a **five-minute blocked** transition when no input/approval channel appears,
  cancellation, and cleanup. Nothing ever guesses input or auto-approves.

Statuses: `queued` -> `running` <-> `awaiting_input` -> `blocked`, terminating in
`succeeded` / `failed` / `cancelled`.

## Notification priority (BG-05)

`NotificationQueue` is a four-level FIFO priority queue with anti-starvation:

1. approval / elicitation / shutdown / security-failure / typed input request
2. task failure/completion, agent/team state, lost remote work
3. ordinary background completion and Cron fire
4. progress and periodic status

A higher-priority item preempts a waiting lower one; after ten consecutive higher-priority deliveries
one waiting lower item is forced through, so level 4 can never starve forever.

## Durability (BG-04)

The manager is storage-agnostic. An optional `BackgroundEventSink` records a task's start and
settlement; `eventStoreBackgroundSink` maps them onto the `@qwen-harness/storage` side-effect ledger
(intent at start, `known-complete`/`known-failed` at settlement), giving completion durable,
attributed, idempotent semantics — a completed task's side effect is never replayed.

## Layout

- `category.ts` — the three categories and the BG-01 placement classifier.
- `notifications.ts` — the four-level FIFO priority queue with anti-starvation.
- `runner.ts` — the injected process boundary.
- `sink.ts` — the optional durable sink and its EventStore adapter.
- `manager.ts` — the `BackgroundManager` lifecycle, input watchdog, and concurrency.
