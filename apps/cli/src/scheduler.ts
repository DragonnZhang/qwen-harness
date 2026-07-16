import {
  Scheduler,
  eventStoreSchedulerStore,
  nextFireAfter,
  parseCron,
  type CronJob,
  type DueResult,
} from '@qwen-harness/scheduler';
import { type Authority, type PolicyRule } from '@qwen-harness/policy';
import type {
  Actor,
  Clock,
  CorrelationId,
  IdSource,
  PermissionProfile,
  SideEffectId,
  ThreadId,
  TurnId,
} from '@qwen-harness/protocol';
import type { EventStore } from '@qwen-harness/storage';

import { buildBackgroundPipeline, runSandboxedShell, type ShellWorkload } from './background.ts';
import type { RunAuthority } from './policy-from-config.ts';

/**
 * Cron, made reachable from the CLI (CR-01..CR-07).
 *
 * The `@qwen-harness/scheduler` package is pure coordination: it decides which jobs are DUE and never
 * runs them. This file is the composition that makes a cron job actually happen: it persists jobs
 * durably (so they survive a restart, CR-04), and its `cron run` supervisor polls for due work and
 * FIRES it — appending a durable, attributed notification to the correct thread and running the
 * workload through the same sandboxed pipeline a model turn uses, under the job's fire-time authority.
 *
 * Why a single-poll supervisor and not a resident loop: a headless CLI must be deterministic and must
 * not spin an unbounded event loop. `cron run` performs ONE poll — it fires everything due as of the
 * evaluated instant and exits. Repetition is the job of an external scheduler (systemd timer / OS
 * cron) or the long-lived daemon, exactly as `docs/product/defaults.md` separates the session
 * scheduler from the daemon/supervisor backend (CR-06). The durability that makes this safe lives in
 * the event log, not in a process staying alive.
 *
 * Durable jobs all live on ONE well-known scheduler thread so a single reconstruction sees every job;
 * each job's own `threadId` is the CONVERSATION thread its firing notifies (CR-03 owner/thread).
 */

/** The well-known thread that holds every durable cron definition for a workspace. */
export const SCHEDULER_THREAD_ID = 'thr_cron_scheduler0' as ThreadId;

const SCHEDULER_ACTOR: Actor = { kind: 'system', id: 'act_scheduler' as Actor['id'] };

/** The idempotency key for one job firing at one instant. A second attempt is refused by the ledger. */
export function cronFireKey(jobId: string, instant: number): string {
  return `cron.v1:${jobId}:${instant}`;
}

/**
 * The shell workload a cron job runs, encoded in its `workloadTag`. A job created with a trailing
 * command carries `{command, argv}`; a job with only a tag carries no command and fires as a
 * notification-only marker. Kept as JSON so the opaque `workloadTag` stays a faithful round-trip.
 */
interface EncodedWorkload {
  readonly command?: string;
  readonly argv?: readonly string[];
  readonly tag?: string;
}

function encodeWorkload(tag: string, command: string | null, argv: readonly string[]): string {
  const payload: EncodedWorkload = command === null ? { tag } : { tag, command, argv: [...argv] };
  return JSON.stringify(payload);
}

function decodeWorkload(workloadTag: string): EncodedWorkload {
  try {
    const value: unknown = JSON.parse(workloadTag);
    if (value && typeof value === 'object') return value as EncodedWorkload;
  } catch {
    // A non-JSON tag is a plain label; there is simply no command to run.
  }
  return { tag: workloadTag };
}

/**
 * A narrow, session-scoped ALLOW rule for exactly the command an operator scheduled/launched. This is
 * the "preapproved narrow rule" defaults.md (CR-07) sanctions for UNATTENDED execution: the operator
 * who typed the command preapproved it, so a sandboxed background/cron run may execute it without an
 * interactive channel it does not have. It is deliberately not a widening of authority: it only turns
 * the profile's `ask` into `allow` for this one command line, and it CANNOT loosen a sealed deny — a
 * ceiling clamped to `plan` still refuses the shell, and any managed/deny rule still wins.
 */
export function preapprovalRule(command: string, argv: readonly string[]): PolicyRule {
  const line = `${command} ${argv.join(' ')}`.trim();
  return {
    id: `cron.preapproved:${line}`,
    scope: 'session',
    effect: 'allow',
    match: { kinds: ['shell'], commandLines: [line] },
    reason: 'preapproved: the operator scheduled/launched exactly this command for unattended run',
  };
}

/** Turn the run's effective authority into the immutable ceiling a job captures at creation (CR-07). */
function authorityOf(
  run: RunAuthority,
  cwd: string,
  extraRules: readonly PolicyRule[] = [],
): Authority {
  return {
    profile: run.profile,
    isolation: run.isolation,
    networkAllowed: run.networkAllowed,
    workspaceRoots: [cwd],
    rules: [...run.rules, ...extraRules],
    grants: [],
    maxChildDepth: run.managedPolicy.maxChildDepth,
  };
}

interface SchedulerContext {
  readonly store: EventStore;
  readonly scheduler: Scheduler;
  readonly ids: IdSource;
  readonly clock: Clock;
  readonly permissionProfile: PermissionProfile;
}

/**
 * Open the durable scheduler for a workspace: ensure the scheduler thread exists, then construct a
 * {@link Scheduler} over an EventStore-backed store. Construction alone reconstructs every durable job
 * from the log (CR-04) — this is the restart-survival seam.
 */
export function openScheduler(opts: {
  store: EventStore;
  ids: IdSource;
  clock: Clock;
  permissionProfile: PermissionProfile;
  workspaceRoot: string;
}): SchedulerContext {
  if (opts.store.getThread(SCHEDULER_THREAD_ID) === undefined) {
    opts.store.append({
      threadId: SCHEDULER_THREAD_ID,
      correlationId: opts.ids.next('cor') as CorrelationId,
      permissionProfile: opts.permissionProfile,
      actor: SCHEDULER_ACTOR,
      payload: {
        type: 'thread-created',
        cwd: opts.workspaceRoot,
        canonicalRepo: opts.workspaceRoot,
        name: 'cron scheduler',
      },
    });
  }

  const store = eventStoreSchedulerStore({
    store: opts.store,
    threadId: SCHEDULER_THREAD_ID,
    // A synthetic turn: durable scheduler records are attributed but belong to no model turn.
    turnId: opts.ids.next('trn') as TurnId,
    actor: SCHEDULER_ACTOR,
    correlationId: opts.ids.next('cor') as CorrelationId,
    permissionProfile: opts.permissionProfile,
    ids: opts.ids,
    clock: opts.clock,
  });

  const scheduler = new Scheduler({ clock: opts.clock, ids: opts.ids, store });
  return {
    store: opts.store,
    scheduler,
    ids: opts.ids,
    clock: opts.clock,
    permissionProfile: opts.permissionProfile,
  };
}

export interface AddCronInput {
  readonly kind: 'recurring' | 'one-shot';
  readonly cronExpr?: string;
  readonly fireAt?: number;
  readonly owner: string;
  readonly threadId: ThreadId;
  readonly tag: string;
  readonly command: string | null;
  readonly argv: readonly string[];
  readonly authorityCeiling: Authority;
}

/** Create a durable cron job. The expression is validated eagerly — a bad cron is rejected here. */
export function addCron(ctx: SchedulerContext, input: AddCronInput): CronJob {
  const workloadTag = encodeWorkload(input.tag, input.command, input.argv);
  if (input.kind === 'recurring') {
    if (input.cronExpr === undefined) throw new Error('recurring cron requires an expression');
    return ctx.scheduler.create({
      kind: 'recurring',
      owner: input.owner,
      threadId: input.threadId,
      cronExpr: input.cronExpr,
      workloadTag,
      authorityCeiling: input.authorityCeiling,
      durable: true,
    });
  }
  if (input.fireAt === undefined) throw new Error('one-shot cron requires a fire instant');
  return ctx.scheduler.create({
    kind: 'one-shot',
    owner: input.owner,
    threadId: input.threadId,
    fireAt: input.fireAt,
    workloadTag,
    authorityCeiling: input.authorityCeiling,
    durable: true,
  });
}

export interface FireOutcome {
  readonly jobId: string;
  readonly threadId: ThreadId;
  readonly scheduledInstant: number;
  readonly firedAt: number;
  /** The effective profile the work ran under, AFTER the ceiling ∩ managed clamp (CR-07). */
  readonly effectiveProfile: PermissionProfile;
  /** Whether the workload command succeeded (true when there was no command to run). */
  readonly ok: boolean;
  readonly detail: string | null;
  /** False when the ledger already recorded this firing — proof of no double-fire across restart. */
  readonly executed: boolean;
}

/**
 * Fire ONE due job: record a durable, idempotent side effect on the CORRECT thread, then run the
 * workload under the fire-time (clamped) authority. The two-level guard is deliberate: the scheduler's
 * durable `firedInstants` already stop it reporting the same instant twice across a restart, and
 * `mayExecute` independently refuses to execute a firing whose ledger row already exists. A crash
 * between the two leaves the side effect `indeterminate`, visible to `qwen-harness side-effects`.
 */
async function fire(
  ctx: SchedulerContext,
  due: DueResult,
  homeDir: string,
  workspaceRoot: string,
  pipeline: ReturnType<typeof buildBackgroundPipeline>,
): Promise<FireOutcome> {
  const job = due.job;
  const key = cronFireKey(job.id, due.scheduledInstant);
  const base = {
    threadId: job.threadId,
    turnId: ctx.ids.next('trn') as TurnId,
    correlationId: ctx.ids.next('cor') as CorrelationId,
    permissionProfile: due.authority.profile,
    actor: SCHEDULER_ACTOR,
  };

  const common: FireOutcome = {
    jobId: job.id,
    threadId: job.threadId,
    scheduledInstant: due.scheduledInstant,
    firedAt: due.firedAt,
    effectiveProfile: due.authority.profile,
    ok: true,
    detail: null,
    executed: true,
  };

  // The independent ledger guard. If this instant already settled durably, do not fire it again.
  if (!ctx.store.mayExecute(key).allowed) {
    return { ...common, ok: true, detail: 'already fired', executed: false };
  }

  const sideEffectId = ctx.ids.next('sfx') as SideEffectId;
  ctx.store.append({
    ...base,
    payload: {
      type: 'side-effect-intent',
      intent: {
        sideEffectId,
        idempotencyKey: key,
        kind: 'other',
        destructive: false,
        normalizedAction: `cron-fire:${job.id}:${job.workloadTag}`,
      },
    },
  });
  ctx.store.append({ ...base, payload: { type: 'side-effect-started', sideEffectId } });

  // Run the workload, if any, through the sandbox under the CLAMPED authority (CR-07 obeys sandbox).
  const workload = decodeWorkload(job.workloadTag);
  let ok = true;
  let detail: string | null = null;
  if (typeof workload.command === 'string') {
    const shell: ShellWorkload = {
      command: workload.command,
      argv: workload.argv ?? [],
      cwd: workspaceRoot,
      authority: due.authority,
    };
    const abort = new AbortController();
    const result = await runSandboxedShell(pipeline, shell, homeDir, ctx.clock.now(), abort.signal);
    ok = result.ok;
    detail = result.reason ?? null;
  }

  ctx.store.append({
    ...base,
    payload: {
      type: 'side-effect-settled',
      sideEffectId,
      state: ok ? 'known-complete' : 'known-failed',
      resultDigest: null,
    },
  });

  return { ...common, ok, detail };
}

export interface SupervisorResult {
  readonly fired: readonly FireOutcome[];
}

/**
 * ONE supervisor poll. Reconstruct-on-open (in {@link openScheduler}) has already brought every
 * durable job back from the log — THAT is what survives a restart (CR-04). Here we simply fire what is
 * DUE as of `now`.
 *
 * Why `due` and NOT `resumeAfterDowntime`: `resumeAfterDowntime` is the once-per-lifetime call a
 * RESIDENT scheduler makes to skip a downtime gap (CR-06's daemon backend). A headless single-poll
 * supervisor is a fresh process every time — there is no separate "we just came up" event to hang a
 * one-time resume on, and calling it each poll would advance every job's cursor past `now` and fire
 * nothing. `due` is the correct primitive: for a recurring job it coalesces to the single LATEST due
 * instant and advances the cursor past it (CR-05 — the intermediate instants are skipped, never
 * replayed, so a long gap fires ONCE, not a catch-up storm), and the durable `job-fired` record it
 * writes means the next poll at the same instant reconstructs a cursor that reports nothing due — no
 * double-fire across a restart.
 */
export async function runSupervisor(
  ctx: SchedulerContext,
  opts: {
    now: number;
    managed: RunAuthority['managedPolicy'];
    homeDir: string;
    workspaceRoot: string;
  },
): Promise<SupervisorResult> {
  const due = ctx.scheduler.due({ now: opts.now, managed: opts.managed });

  const pipeline = buildBackgroundPipeline();
  const fired: FireOutcome[] = [];
  for (const result of due) {
    fired.push(await fire(ctx, result, opts.homeDir, opts.workspaceRoot, pipeline));
  }

  return { fired };
}

/** A stable, human/JSON-friendly view of a job for `cron list`. */
export interface CronListItem {
  readonly id: string;
  readonly kind: CronJob['kind'];
  readonly owner: string;
  readonly threadId: ThreadId;
  readonly status: string;
  readonly durable: boolean;
  readonly cronSource: string | null;
  readonly fireAt: number | null;
  readonly nextFire: number | null;
  readonly workloadTag: string;
}

export function listCron(ctx: SchedulerContext, now: number): CronListItem[] {
  return ctx.scheduler.list().map((job) => ({
    id: job.id,
    kind: job.kind,
    owner: job.owner,
    threadId: job.threadId,
    status: ctx.scheduler.statusOf(job.id) ?? 'active',
    durable: job.durable,
    cronSource: job.cronSource,
    fireAt: job.fireAt,
    nextFire:
      job.kind === 'recurring' && job.cronSource
        ? nextFireAfter(job.cronSource, now).getTime()
        : job.fireAt,
    workloadTag: job.workloadTag,
  }));
}

/** The three CR-06 scheduling backends, from always-available to most capable. */
export type CronBackend = 'session-scheduler' | 'local-daemon' | 'remote-routine-peer';

export interface CronBackendStatus {
  readonly backend: CronBackend;
  readonly available: boolean;
  readonly detail: string;
}

/**
 * Report each scheduling backend's EXPLICIT availability (CR-06). The three backends are separate and
 * their availability is STATED, never guessed or silently downgraded: the session scheduler is always
 * available (a headless single poll reconstructs every durable job and needs no resident process); the
 * local daemon is available only while one holds the single-writer lease; the remote routine peer is
 * available only when a peer endpoint is configured. A caller whose intended backend is unavailable is
 * told exactly why, rather than falling through to a weaker one without notice.
 */
export function cronBackendAvailability(signals: {
  readonly daemonRunning: boolean;
  readonly remoteEndpoint: string | null;
}): readonly CronBackendStatus[] {
  return [
    {
      backend: 'session-scheduler',
      available: true,
      detail: 'always available — a headless single poll needs no resident process',
    },
    {
      backend: 'local-daemon',
      available: signals.daemonRunning,
      detail: signals.daemonRunning
        ? 'a daemon holds the single-writer lease'
        : 'unavailable — no daemon is running (no writer lease is held)',
    },
    {
      backend: 'remote-routine-peer',
      available: signals.remoteEndpoint !== null,
      detail:
        signals.remoteEndpoint !== null
          ? `configured: ${signals.remoteEndpoint}`
          : 'unavailable — no remote routine peer is configured',
    },
  ];
}

export { authorityOf, parseCron };
