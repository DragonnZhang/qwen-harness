# @qwen-harness/scheduler

Cron parsing and a **runtime-independent** scheduler (capability matrix J, CR-01..CR-05, CR-07).

This package is pure coordination. It opens no host capability (the architecture gate forbids it),
takes time as an injected `Clock`/instant rather than calling `Date.now()`, and **reports** due work
rather than running it — the runtime injects reported work at a safe turn boundary. Durability is an
injected append-only log port backed, in production, by `@qwen-harness/storage`.

## Cron parser and matcher (CR-01)

Standard five-field expressions: `minute hour day-of-month month day-of-week`.

```ts
import { parseCron, matches, nextFireAfter } from '@qwen-harness/scheduler';

parseCron('*/15 9-17 * * 1-5'); // wildcard, step, range, list, and combinations
matches('0 0 13 * 5', someDate); // DOM/DOW OR: the 13th OR any Friday
nextFireAfter('30 9 * * *', now); // next 09:30 strictly after `now`, minute-aligned
```

- Forms: wildcard, `*/n`, `a/n`, `a-b`, `a-b/n`, lists, and any comma-combination of them.
- **DOM/DOW OR semantics**: when BOTH day-of-month and day-of-week are restricted, a date matches on
  EITHER; when only one is restricted, the wildcard side imposes no constraint (Vixie-cron behavior).
- Day-of-week `7` normalizes to Sunday (`0`).
- Local timezone: matching reads local-time components, which is how cron is defined.
- Precise typed validation: `CronError` carries a stable `code`
  (`wrong-field-count` / `out-of-range` / `bad-step` / `bad-range` / `not-a-number` / `empty-field`)
  and the offending field.
- `matches` and `nextFireAfter` are pure and deterministic given an injected instant; `nextFireAfter`
  is bounded and throws on an unsatisfiable expression (e.g. February 30th) rather than looping.

## Scheduler (CR-02..CR-05, CR-07)

```ts
import { Scheduler, InMemorySchedulerStore } from '@qwen-harness/scheduler';

const scheduler = new Scheduler({ clock, ids, store: new InMemorySchedulerStore() });
const job = scheduler.create({
  kind: 'recurring',
  owner: 'owner-a',
  threadId,
  cronExpr: '*/10 * * * *',
  workloadTag: 'digest',
  authorityCeiling, // captured at creation (CR-07)
  durable: true,
});

const due = scheduler.due({ now, busy: false, managed }); // jobs to inject at a safe boundary
```

- **create / list / delete** with a **50-job-per-owner** ceiling and a **7-day** recurring expiry.
- **Deterministic jitter** `min(10% of interval, 15 min)`, seeded from the job id, so a given job
  always jitters by the same amount — reproducible across processes and replays, never `Math.random`.
- `due({ now, busy })` reports due jobs; it never runs them (CR-02). While `busy`, a due job is
  **coalesced once** for that instant and fires at the next non-busy boundary (CR-05).
- `resumeAfterDowntime({ now })` handles a restart (CR-05): a durable recurring job **resumes at the
  next future instant** with missed instants **recorded, not replayed**; a missed durable one-shot is
  marked `missed` (requires explicit rerun); **session jobs never catch up**.
- A single invalid/failing job never kills a poll — each job is evaluated in isolation.
- At fire time the job's captured authority ceiling is **intersected with current managed policy**
  (CR-07) via `intersect` from `@qwen-harness/policy`; the result is exposed on each `DueResult` and
  is never wider than the captured ceiling.

## Durability (CR-04)

Durable jobs persist through an injected append-only log; session jobs are in-memory only and vanish
with the process. `InMemorySchedulerStore` is the default backend; `eventStoreSchedulerStore` records
the log onto the real `@qwen-harness/storage` `EventStore` (as attributed side-effect intents), so a
fresh `Scheduler` over the same log reconstructs exactly the durable job set.

## Layout

- `cron.ts` — the pure five-field parser, minute matcher, and `nextFireAfter`.
- `job.ts` — the job model, the 50-job / 7-day / jitter defaults, deterministic jitter.
- `store.ts` — the durable-log port, an in-memory backend, and the EventStore adapter.
- `scheduler.ts` — create/list/delete, the live `due` poll with coalescing, and downtime resume.
