/**
 * @qwen-harness/scheduler
 *
 * Cron parsing and a runtime-independent scheduler (capability matrix J, CR-01..CR-05, CR-07).
 *
 * The package is pure coordination: it opens no host capability (the architecture gate forbids it),
 * takes time as an injected `Clock`/instant rather than calling `Date.now()`, and reports due work
 * instead of running it. Durability is an injected append-only log port backed, in production, by
 * `@qwen-harness/storage`.
 *
 *   - `cron.ts`      — the pure five-field parser, minute matcher, and `nextFireAfter`.
 *   - `job.ts`       — the job model, the 50-job / 7-day / jitter defaults, deterministic jitter.
 *   - `store.ts`     — the durable-log port, an in-memory backend, and the EventStore adapter.
 *   - `scheduler.ts` — create/list/delete, the live `due` poll with coalescing, and downtime resume.
 */

export { parseCron, matches, nextFireAfter, nominalIntervalMs, CronError } from './cron.ts';
export type { CronExpr, CronErrorCode, CronFieldName } from './cron.ts';

export {
  deterministicJitterMs,
  hashString,
  MAX_JOBS_PER_OWNER,
  RECURRING_EXPIRY_MS,
  MAX_JITTER_MS,
  JITTER_FRACTION,
} from './job.ts';
export type { CronJob, JobKind, JobStatus } from './job.ts';

export { InMemorySchedulerStore, eventStoreSchedulerStore, foldRecords } from './store.ts';
export type { SchedulerStore, SchedulerRecord, DurableJobSnapshot, FoldedJob } from './store.ts';

export { Scheduler } from './scheduler.ts';
export type {
  SchedulerOptions,
  CreateJobInput,
  CreateRecurringInput,
  CreateOneShotInput,
  DueResult,
  DowntimeSummary,
} from './scheduler.ts';
