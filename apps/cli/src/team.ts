import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { SubagentSupervisor } from '@qwen-harness/agents';
import {
  defaultAuthority,
  isAtMost,
  type Authority,
  type ManagedPolicy,
} from '@qwen-harness/policy';
import type {
  Actor,
  ActorId,
  Clock,
  CorrelationId,
  IdSource,
  PermissionProfile,
  SideEffectId,
  ThreadId,
  TurnId,
} from '@qwen-harness/protocol';
import { TaskStore, type EventStore } from '@qwen-harness/storage';
import { TaskGraph, type ClaimResult, type CompleteResult, type Task } from '@qwen-harness/tasks';
import {
  Inbox,
  ProtocolMessageSchema,
  ProtocolTracker,
  TeamRecovery,
  Teammate,
  type ProtocolMessage,
} from '@qwen-harness/teams';
import {
  createWorktree,
  isWorktreeDirty,
  listWorktrees,
  removeWorktree,
  type WorktreeRecord,
} from '@qwen-harness/worktrees';

import { buildBackgroundPipeline, runSandboxedShell, type ShellWorkload } from './background.ts';
import type { RunAuthority } from './policy-from-config.ts';
import { authorityOf, preapprovalRule } from './scheduler.ts';

/**
 * The multi-agent TEAM subsystem, made reachable from the CLI (section F: golden path 5).
 *
 * A LEAD process creates dependent tasks, then launches N teammates as REAL, SEPARATE OS processes,
 * each in its OWN git worktree. The teammates are not threads and not a shared-process fiction: each
 * is `process.execPath` running the production `main()` with `team teammate`, opening the SAME durable
 * SQLite event store, and CLAIMING tasks through the `tasks` TaskStore's atomic, TOCTOU-safe claim —
 * so two teammates racing for one task cannot both win (WK-06/AG-11), across process boundaries.
 *
 * Coordination that is NOT the task graph — plan/permission approvals, shutdown — travels over a
 * DURABLE protocol bus persisted on the team thread (AG-06/AG-07). Every message crosses the
 * `ProtocolMessageSchema` zod boundary on read, and a teammate validates each response against its
 * outstanding request with a `ProtocolTracker` (AG-08): a response only counts if it answers a real
 * request, of the right type, from the member it was sent to.
 *
 * Authority is the core invariant. A teammate's authority is `intersect(requested, lead, managed)`
 * (computed by the `agents` `SubagentSupervisor`); it can never broaden. The managed ceiling binds a
 * teammate exactly as it binds the lead — a teammate whose ceiling clamps to `plan` is DENIED the
 * sandboxed shell mechanically, by the same pipeline a model tool call goes through (background.ts).
 *
 * Worktrees are real isolation, owned by the LEAD: it creates one per teammate before spawning and
 * removes them all at shutdown, refusing to silently discard dirty work (GT-04) — so a clean run
 * leaves no orphaned process and no leaked worktree.
 */

// ---------------------------------------------------------------------------------------------
// Identities, threads, constants
// ---------------------------------------------------------------------------------------------

/** The logical id every message to/from the lead uses on the bus. Not a member. */
export const LEAD_ID = 'lead';

const LEAD_ACTOR: Actor = { kind: 'system', id: 'act_teamlead' as ActorId, label: 'lead' };

/** One shared teammate actor id; the acting MEMBER is carried in the label and the task owner. */
function teammateActor(member: string): Actor {
  return { kind: 'teammate', id: 'act_teammate' as ActorId, label: member };
}

/** The durable team thread that carries the task graph, the protocol bus, results, and heartbeats. */
export function teamThreadId(team: string): ThreadId {
  return `thr_team_${team}` as ThreadId;
}

const BUS_PREFIX = 'team-bus:v1:';
const RESULT_PREFIX = 'team-result:v1:';
const MEMBER_PREFIX = 'team-member:v1:';
const HEARTBEAT_PREFIX = 'team-heartbeat:v1:';
const STOPPED_PREFIX = 'team-stopped:v1:';

/** How long a teammate/lead poll loop may run, as a count of `pollMs` waits. Bounds wall time. */
const MAX_POLLS = 1_200;
const POLL_MS = 25;
/** Emit a heartbeat roughly every this many polls, to pace the shared write lock (~0.4s at POLL_MS). */
const HEARTBEAT_EVERY = 16;
/** A teammate revises and resubmits a rejected plan at most this many times before abandoning (AG-09). */
const MAX_PLAN_REVISIONS = 3;

// ---------------------------------------------------------------------------------------------
// Durable protocol bus (AG-06/AG-07): protocol messages persisted on the team thread.
// ---------------------------------------------------------------------------------------------

interface BusEnvelope {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly message: ProtocolMessage;
}

interface BusEntry {
  readonly seq: number;
  readonly env: BusEnvelope;
}

function appendIntent(
  store: EventStore,
  ids: IdSource,
  threadId: ThreadId,
  profile: PermissionProfile,
  actor: Actor,
  normalizedAction: string,
  idempotencyKey: string,
): void {
  store.append({
    threadId,
    turnId: ids.next('trn') as TurnId,
    correlationId: ids.next('cor') as CorrelationId,
    permissionProfile: profile,
    actor,
    payload: {
      type: 'side-effect-intent',
      intent: {
        sideEffectId: ids.next('sfx') as SideEffectId,
        idempotencyKey,
        kind: 'other',
        destructive: false,
        normalizedAction,
      },
    },
  });
}

/**
 * True for the transient SQLite write-lock errors a peer holding the writer briefly produces —
 * including `SQLITE_BUSY_SNAPSHOT`, which a read-then-write transaction hits when another process
 * committed in between, and which `busy_timeout` does NOT retry for us. These are the expected
 * consequence of four real processes sharing one WAL database; the fix is to retry, not to serialize.
 */
function isWriteLock(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code.startsWith('SQLITE_BUSY')) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /SQLITE_BUSY|database is locked/i.test(message);
}

/** A synchronous backoff, so the synchronous TaskStore transaction can be retried in place. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Retry a SYNCHRONOUS store operation through transient write-lock contention. */
function retrySync<T>(fn: () => T): T {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (error) {
      if (!isWriteLock(error) || attempt >= 60) throw error;
      sleepSync(8 + attempt * 4);
    }
  }
}

/**
 * The shared task graph, hardened for CONCURRENT processes. `claim`/`start`/`complete`/`release` each
 * run a read-then-write SQLite transaction, so under real contention one loses to a peer's commit with
 * a transient `SQLITE_BUSY(_SNAPSHOT)`. The atomic claim's CORRECTNESS is unchanged — a lost RACE
 * still returns `{ ok: false }` and is not retried; only a transient LOCK is retried, so the graph
 * stays the single collision-free serialization point across every teammate process (WK-06/AG-11).
 */
class RetryingTaskGraph extends TaskGraph {
  override claim(id: number, owner: string, actor: Parameters<TaskGraph['claim']>[2]): ClaimResult {
    return retrySync(() => super.claim(id, owner, actor));
  }
  override start(id: number, actor: Parameters<TaskGraph['start']>[1]): Task {
    return retrySync(() => super.start(id, actor));
  }
  override complete(id: number, actor: Parameters<TaskGraph['complete']>[1]): CompleteResult {
    return retrySync(() => super.complete(id, actor));
  }
  override release(id: number, actor: Parameters<TaskGraph['release']>[1]): Task {
    return retrySync(() => super.release(id, actor));
  }
  override create(
    input: Parameters<TaskGraph['create']>[0],
    actor: Parameters<TaskGraph['create']>[1],
  ): Task {
    return retrySync(() => super.create(input, actor));
  }
}

/** Open the shared, contention-hardened task graph over the durable event store. */
function openGraph(deps: TeamDeps): TaskGraph {
  return new RetryingTaskGraph({ store: new TaskStore({ store: deps.store, clock: deps.clock }) });
}

/**
 * The team runs FOUR real processes against one SQLite file (a lead and its teammates). WAL lets them
 * read concurrently, but only one may write at a time; a peer mid-commit surfaces a transient lock.
 * This retries the append with backoff so a durable coordination write is never LOST to contention —
 * the ledger is still the single serialization point, we just wait our turn for it politely.
 */
async function appendIntentRetry(
  deps: TeamDeps,
  threadId: ThreadId,
  profile: PermissionProfile,
  actor: Actor,
  normalizedAction: string,
  idempotencyKey: string,
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      appendIntent(
        deps.store,
        deps.ids,
        threadId,
        profile,
        actor,
        normalizedAction,
        idempotencyKey,
      );
      return;
    } catch (error) {
      if (!isWriteLock(error) || attempt === 39) throw error;
      await deps.clock.sleep(10 + attempt * 5);
    }
  }
}

/** Post a protocol message to the durable bus. Ordered by the store's per-thread monotonic seq. */
async function postMessage(
  deps: TeamDeps,
  threadId: ThreadId,
  profile: PermissionProfile,
  actor: Actor,
  env: BusEnvelope,
): Promise<void> {
  await appendIntentRetry(
    deps,
    threadId,
    profile,
    actor,
    BUS_PREFIX + JSON.stringify(env),
    `team-bus:${env.id}`,
  );
}

/**
 * Read every bus message on the team thread, in seq order. Each is re-validated at this untrusted
 * boundary: the envelope shape AND the `ProtocolMessage` itself must parse, or the entry is dropped
 * rather than acted on.
 */
function readBus(store: EventStore, threadId: ThreadId): BusEntry[] {
  const out: BusEntry[] = [];
  for (const event of store.readThread(threadId)) {
    if (event.payload.type !== 'side-effect-intent') continue;
    const action = event.payload.intent.normalizedAction;
    if (!action.startsWith(BUS_PREFIX)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(action.slice(BUS_PREFIX.length));
    } catch {
      continue;
    }
    if (typeof raw !== 'object' || raw === null) continue;
    const rec = raw as Record<string, unknown>;
    const message = ProtocolMessageSchema.safeParse(rec['message']);
    if (
      !message.success ||
      typeof rec['id'] !== 'string' ||
      typeof rec['from'] !== 'string' ||
      typeof rec['to'] !== 'string'
    ) {
      continue;
    }
    out.push({
      seq: event.seq,
      env: { id: rec['id'], from: rec['from'], to: rec['to'], message: message.data },
    });
  }
  return out;
}

/** The `correlationId` of a request/response message, if it carries one. */
function correlationOf(message: ProtocolMessage): string | null {
  return 'correlationId' in message ? message.correlationId : null;
}

// ---------------------------------------------------------------------------------------------
// Durable results (AG-05) and roster/heartbeat records (AG-13) on the team thread.
// ---------------------------------------------------------------------------------------------

export interface TeamResult {
  readonly taskId: number;
  readonly member: string;
  readonly ok: boolean;
  readonly detail: string | null;
  readonly relPath: string | null;
}

async function recordResult(
  deps: TeamDeps,
  threadId: ThreadId,
  profile: PermissionProfile,
  actor: Actor,
  result: TeamResult,
): Promise<void> {
  await appendIntentRetry(
    deps,
    threadId,
    profile,
    actor,
    RESULT_PREFIX + JSON.stringify(result),
    `team-result:${result.taskId}`,
  );
}

/** Every durable teammate result, deduplicated by task id (a task's result is recorded once). */
export function readResults(store: EventStore, threadId: ThreadId): TeamResult[] {
  const byTask = new Map<number, TeamResult>();
  for (const event of store.readThread(threadId)) {
    if (event.payload.type !== 'side-effect-intent') continue;
    const action = event.payload.intent.normalizedAction;
    if (!action.startsWith(RESULT_PREFIX)) continue;
    try {
      const parsed = JSON.parse(action.slice(RESULT_PREFIX.length)) as TeamResult;
      if (typeof parsed.taskId === 'number') byTask.set(parsed.taskId, parsed);
    } catch {
      // A malformed result record is ignored, never crashes the reader.
    }
  }
  return [...byTask.values()].sort((a, b) => a.taskId - b.taskId);
}

interface RosterEntry {
  readonly member: string;
  readonly incarnation: string;
  registeredAt: number;
  lastHeartbeatAt: number;
  stopped: boolean;
}

/** Reconstruct the member roster + last-heartbeat from the durable log (AG-13). */
function readRoster(store: EventStore, threadId: ThreadId): Map<string, RosterEntry> {
  const roster = new Map<string, RosterEntry>();
  for (const event of store.readThread(threadId)) {
    if (event.payload.type !== 'side-effect-intent') continue;
    const action = event.payload.intent.normalizedAction;
    const at = event.timestamp;
    if (action.startsWith(MEMBER_PREFIX)) {
      try {
        const { member, incarnation } = JSON.parse(action.slice(MEMBER_PREFIX.length)) as {
          member: string;
          incarnation: string;
        };
        roster.set(member, {
          member,
          incarnation,
          registeredAt: at,
          lastHeartbeatAt: at,
          stopped: false,
        });
      } catch {
        /* ignore */
      }
    } else if (action.startsWith(HEARTBEAT_PREFIX)) {
      try {
        const { member } = JSON.parse(action.slice(HEARTBEAT_PREFIX.length)) as { member: string };
        const entry = roster.get(member);
        if (entry) entry.lastHeartbeatAt = at;
      } catch {
        /* ignore */
      }
    } else if (action.startsWith(STOPPED_PREFIX)) {
      try {
        const { member } = JSON.parse(action.slice(STOPPED_PREFIX.length)) as { member: string };
        const entry = roster.get(member);
        if (entry) entry.stopped = true;
      } catch {
        /* ignore */
      }
    }
  }
  return roster;
}

// ---------------------------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------------------------

export interface TeamDeps {
  readonly store: EventStore;
  readonly ids: IdSource;
  readonly clock: Clock;
  readonly homeDir: string;
  readonly cwd: string;
}

/** Ensure the durable team thread exists. */
function ensureTeamThread(deps: TeamDeps, team: string, profile: PermissionProfile): ThreadId {
  const threadId = teamThreadId(team);
  if (deps.store.getThread(threadId) === undefined) {
    deps.store.append({
      threadId,
      correlationId: deps.ids.next('cor') as CorrelationId,
      permissionProfile: profile,
      actor: LEAD_ACTOR,
      payload: {
        type: 'thread-created',
        cwd: deps.cwd,
        canonicalRepo: deps.cwd,
        name: `team ${team}`,
      },
    });
  }
  return threadId;
}

// ---------------------------------------------------------------------------------------------
// The LEAD
// ---------------------------------------------------------------------------------------------

export interface TaskSpec {
  readonly subject: string;
  readonly blockedBy?: readonly number[];
}

/** Untrusted-boundary schema for the `--tasks` JSON an operator supplies to `team run`. */
const TaskSpecsSchema = z.array(
  z.object({
    subject: z.string().min(1),
    blockedBy: z.array(z.number().int().positive()).optional(),
  }),
);

/** Parse and validate the `--tasks` JSON. Throws a typed error on malformed input. */
export function parseTaskSpecs(json: string): TaskSpec[] {
  const parsed: unknown = JSON.parse(json);
  return TaskSpecsSchema.parse(parsed).map((t) => ({
    subject: t.subject,
    ...(t.blockedBy && t.blockedBy.length > 0 ? { blockedBy: t.blockedBy } : {}),
  }));
}

export interface LeadOptions {
  readonly team: string;
  readonly tasks: readonly TaskSpec[];
  /** How many teammates to launch. Each gets its own worktree and process. */
  readonly members: number;
  /** The profile each teammate REQUESTS; it is intersected down to the ceiling before use. */
  readonly requestedProfile: PermissionProfile;
  /** The path to the worker script the lead re-invokes to run a teammate process. */
  readonly worker: string;
  /** The managed-policy file to pass to each teammate, so the ceiling binds it exactly as the lead. */
  readonly managedPath?: string | undefined;
  /** Keep worktrees after shutdown (for direct isolation inspection). Default removes them. */
  readonly keepWorktrees?: boolean;
  readonly now: number;
}

export interface MemberSummary {
  readonly member: string;
  readonly incarnation: string;
  readonly worktree: string;
  /** The profile the teammate actually ran under — proof the ceiling clamped it (never widened). */
  readonly grantedProfile: PermissionProfile;
  readonly exitCode: number | null;
  readonly worktreeWasDirty: boolean;
  readonly worktreeRemoved: boolean;
}

export interface LeadSummary {
  readonly team: string;
  readonly threadId: ThreadId;
  readonly tasksCreated: number;
  readonly tasksCompleted: number;
  readonly members: readonly MemberSummary[];
  readonly results: readonly TeamResult[];
  /** True when every result file landed in its teammate's worktree and NOT in the lead workspace. */
  readonly isolationVerified: boolean;
  readonly worktreesLeaked: number;
  readonly cleanShutdown: boolean;
  readonly plansRejected: number;
  readonly plansApproved: number;
  readonly permissionsGranted: number;
}

interface LiveChild {
  readonly member: string;
  readonly incarnation: string;
  readonly worktree: WorktreeRecord;
  readonly grantedProfile: PermissionProfile;
  exitCode: number | null;
  exited: boolean;
  readonly handle: SpawnedChild;
}

/**
 * Run the LEAD: create dependent tasks, launch real teammate processes in isolated worktrees, route
 * plan/permission approvals over the durable bus, receive results, and shut down cleanly.
 */
export async function runLead(
  deps: TeamDeps,
  runAuthority: RunAuthority,
  opts: LeadOptions,
): Promise<LeadSummary> {
  const profile = runAuthority.profile;
  const threadId = ensureTeamThread(deps, opts.team, profile);
  const graph = openGraph(deps);

  // 1. Create the dependent task graph. Blocker references are 1-based on the ids the graph assigns.
  const createdIds: number[] = [];
  for (const spec of opts.tasks) {
    const blockedBy = (spec.blockedBy ?? []).map((n) => createdIds[n - 1] ?? n);
    const task = graph.create(
      {
        subject: spec.subject,
        activeForm: `working on ${spec.subject}`,
        ...(blockedBy.length > 0 ? { blockedBy } : {}),
      },
      LEAD_ACTOR,
    );
    createdIds.push(task.id);
  }

  // 2. Compute each teammate's authority as intersect(requested, lead, managed) and launch it.
  const leadCeiling = authorityOf(runAuthority, deps.cwd);

  const children: LiveChild[] = [];
  for (let i = 0; i < opts.members; i++) {
    const member = deps.ids.next('mem');
    const incarnation = deps.ids.next('inc');
    const worktree = createWorktree({ repoRoot: deps.cwd, slug: member, now: opts.now });

    const granted = teammateAuthority(
      leadCeiling,
      runAuthority.managedPolicy,
      deps.ids,
      opts.requestedProfile,
      worktree.path,
    );

    // Durable roster record so `team status` (and recovery) can see this incarnation.
    await appendIntentRetry(
      deps,
      threadId,
      profile,
      LEAD_ACTOR,
      MEMBER_PREFIX + JSON.stringify({ member, incarnation }),
      `team-member:${member}:${incarnation}`,
    );

    const child = spawnTeammate(deps, opts, {
      member,
      incarnation,
      threadId,
      worktree: worktree.path,
      grantedProfile: granted.profile,
    });
    const live: LiveChild = {
      member,
      incarnation,
      worktree,
      grantedProfile: granted.profile,
      exitCode: null,
      exited: false,
      handle: child,
    };
    children.push(live);
    child.onExit((code) => {
      live.exited = true;
      live.exitCode = code;
    });
  }

  // 3. Orchestration: answer protocol requests to the lead, and shut the team down once work is done.
  const answered = new Set<string>();
  const respondedCorrelations = new Set<string>();
  let plansApproved = 0;
  let plansRejected = 0;
  let permissionsGranted = 0;
  let shutdownSent = false;

  for (let poll = 0; poll < MAX_POLLS; poll++) {
    for (const entry of readBus(deps.store, threadId)) {
      if (entry.env.to !== LEAD_ID) continue;
      if (answered.has(entry.env.id)) continue;
      answered.add(entry.env.id);
      const decision = decideAsLead(entry.env);
      if (decision === null) continue;
      const correlation = correlationOf(decision);
      if (correlation !== null) {
        if (respondedCorrelations.has(correlation)) continue;
        respondedCorrelations.add(correlation);
      }
      if (decision.type === 'plan-approval-response') {
        if (decision.approved) plansApproved++;
        else plansRejected++;
      }
      if (decision.type === 'permission-response' && decision.granted) permissionsGranted++;
      await postMessage(deps, threadId, profile, LEAD_ACTOR, {
        id: deps.ids.next('msg'),
        from: LEAD_ID,
        to: entry.env.from,
        message: decision,
      });
    }

    const allTerminal = graph
      .list()
      .every((t) => t.status === 'completed' || t.status === 'deleted');
    if (allTerminal && !shutdownSent) {
      shutdownSent = true;
      for (const child of children) {
        const correlationId = deps.ids.next('cor') as CorrelationId;
        await postMessage(deps, threadId, profile, LEAD_ACTOR, {
          id: deps.ids.next('msg'),
          from: LEAD_ID,
          to: child.member,
          message: { type: 'shutdown-request', correlationId },
        });
      }
    }

    if (children.every((c) => c.exited)) break;
    await deps.clock.sleep(POLL_MS);
  }

  // Any child still alive after the bound is force-killed so no orphan process survives the lead.
  for (const child of children) {
    if (!child.exited) {
      child.handle.kill();
      child.exited = true;
    }
  }

  // 4. Collect results and verify isolation, then clean up the worktrees.
  const results = readResults(deps.store, threadId);
  const roster = readRoster(deps.store, threadId);
  const isolationVerified = verifyIsolation(deps.cwd, children, results);

  const memberSummaries: MemberSummary[] = [];
  let leaked = 0;
  for (const child of children) {
    const dirty = existsSync(child.worktree.path) ? isWorktreeDirty(child.worktree.path) : false;
    let removed = false;
    if (!opts.keepWorktrees && existsSync(child.worktree.path)) {
      // Refuse to LOSE work silently: a teammate that wrote result files leaves a dirty worktree, so
      // removal is an explicit, audited discard (GT-04) rather than a silent delete.
      removeWorktree({ repoRoot: deps.cwd, record: child.worktree, discard: true });
      removed = true;
    }
    memberSummaries.push({
      member: child.member,
      incarnation: child.incarnation,
      worktree: child.worktree.path,
      grantedProfile: child.grantedProfile,
      exitCode: child.exitCode,
      worktreeWasDirty: dirty,
      worktreeRemoved: removed,
    });
  }

  if (!opts.keepWorktrees) {
    const remaining = new Set(listWorktrees(deps.cwd).map((w) => w.path));
    for (const child of children) if (remaining.has(child.worktree.path)) leaked++;
  }

  const cleanShutdown = children.every(
    (c) => c.exited && (c.exitCode === 0 || c.exitCode === null),
  );
  const tasksCompleted = graph.list().filter((t) => t.status === 'completed').length;

  return {
    team: opts.team,
    threadId,
    tasksCreated: createdIds.length,
    tasksCompleted,
    members: memberSummaries,
    results,
    isolationVerified,
    worktreesLeaked: leaked,
    cleanShutdown: cleanShutdown && [...roster.values()].every((r) => r.stopped || !shutdownSent),
    plansApproved,
    plansRejected,
    permissionsGranted,
  };
}

/**
 * The lead's plan/permission policy. Deterministic and driven by the task subject embedded in the
 * plan, so an e2e can exercise reject→revise→approve without wall-clock timing:
 *   - a plan for a task whose subject starts with `R:` is REJECTED at revision 0 with feedback and
 *     approved once revised (AG-09);
 *   - every other plan is approved;
 *   - a permission request is granted (the lead is the human-in-the-loop for its teammates, PS-09).
 */
function decideAsLead(env: BusEnvelope): ProtocolMessage | null {
  const message = env.message;
  if (message.type === 'plan-approval-request') {
    const needsRevision = /(?:^|\s)R:/.test(message.plan) && /^rev0:/.test(message.plan);
    if (needsRevision) {
      return {
        type: 'plan-approval-response',
        correlationId: message.correlationId,
        approved: false,
        feedback: 'please revise: add a verification step',
      };
    }
    return {
      type: 'plan-approval-response',
      correlationId: message.correlationId,
      approved: true,
      feedback: null,
    };
  }
  if (message.type === 'permission-request') {
    return { type: 'permission-response', correlationId: message.correlationId, granted: true };
  }
  return null;
}

/** Verify every result file exists in its teammate's worktree and NOT in the lead workspace. */
function verifyIsolation(
  cwd: string,
  children: readonly LiveChild[],
  results: readonly TeamResult[],
): boolean {
  const byMember = new Map(children.map((c) => [c.member, c.worktree.path] as const));
  let verifiedAtLeastOne = false;
  for (const result of results) {
    if (!result.ok || result.relPath === null) continue;
    const worktree = byMember.get(result.member);
    if (worktree === undefined) return false;
    const inWorktree = existsSync(join(worktree, result.relPath));
    const inMain = existsSync(join(cwd, result.relPath));
    if (!inWorktree || inMain) return false;
    verifiedAtLeastOne = true;
  }
  return verifiedAtLeastOne;
}

/**
 * Compute a teammate's authority as `intersect(requested, lead, managed)` (AG-03). Uses the `agents`
 * `SubagentSupervisor`, which performs the intersection and asserts the child never exceeds the
 * parent; a redundant `isAtMost` check here fails closed at the launch boundary if that ever breaks.
 * A teammate can therefore only ever hold a NARROWER authority than the lead, never a wider one.
 */
export function teammateAuthority(
  leadCeiling: Authority,
  managed: ManagedPolicy,
  ids: IdSource,
  requestedProfile: PermissionProfile,
  workspaceRoot: string,
): Authority {
  const supervisor = new SubagentSupervisor({ authority: leadCeiling, managed, depth: 0, ids });
  // Request with empty workspaceRoots so the child INHERITS the lead's roots under intersection; the
  // teammate's actual worktree cwd is passed to the sandbox separately (like a background workload).
  const requested: Authority = {
    ...defaultAuthority(requestedProfile, workspaceRoot, managed),
    workspaceRoots: [],
  };
  const granted = supervisor.childAuthority(requested);
  if (!isAtMost(granted, leadCeiling)) {
    throw new Error('computed teammate authority exceeds the lead ceiling');
  }
  return granted;
}

interface SpawnedChild {
  readonly stderr: string[];
  onExit(cb: (code: number | null) => void): void;
  kill(): void;
}

/** Launch one teammate as a REAL separate OS process running `main('team teammate ...')`. */
function spawnTeammate(
  deps: TeamDeps,
  opts: LeadOptions,
  spec: {
    member: string;
    incarnation: string;
    threadId: ThreadId;
    worktree: string;
    grantedProfile: PermissionProfile;
  },
): SpawnedChild {
  const args = [
    opts.worker,
    deps.cwd,
    String(opts.now),
    opts.managedPath ?? '-',
    'team',
    'teammate',
    '--team',
    opts.team,
    '--member',
    spec.member,
    '--incarnation',
    spec.incarnation,
    '--worktree',
    spec.worktree,
    '--profile',
    spec.grantedProfile,
  ];
  const child = spawn(process.execPath, args, {
    cwd: deps.cwd,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const stderr: string[] = [];
  child.stderr?.on('data', (d: Buffer) => stderr.push(d.toString()));
  const callbacks: ((code: number | null) => void)[] = [];
  child.on('exit', (code) => {
    for (const cb of callbacks) cb(code);
  });
  return {
    stderr,
    onExit(cb) {
      callbacks.push(cb);
    },
    kill() {
      child.kill('SIGKILL');
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The TEAMMATE
// ---------------------------------------------------------------------------------------------

export interface TeammateOptions {
  readonly team: string;
  readonly member: string;
  readonly incarnation: string;
  readonly worktree: string;
  /** The profile granted by the lead; re-clamped to managed policy in this process. */
  readonly grantedAuthority: Authority;
  readonly now: number;
}

export interface TeammateSummary {
  readonly member: string;
  readonly incarnation: string;
  readonly tasksAttempted: number;
  readonly tasksSucceeded: number;
  readonly stoppedByShutdown: boolean;
}

/**
 * Run a teammate: the autonomous WORK→IDLE loop (AG-11) driven by the `teams` `Teammate` class over
 * the SHARED durable task graph, with plan/permission approvals bubbled to the lead over the bus.
 * Shutdown always wins, so the team can always be stopped cleanly (AG-10).
 */
export async function runTeammate(deps: TeamDeps, opts: TeammateOptions): Promise<TeammateSummary> {
  const threadId = teamThreadId(opts.team);
  const profile = opts.grantedAuthority.profile;
  const actor = teammateActor(opts.member);
  const graph = openGraph(deps);
  const inbox = new Inbox();
  const tracker = new ProtocolTracker();
  const pipeline = buildBackgroundPipeline();

  const recovery = new TeamRecovery();
  recovery.spawn(opts.member, opts.incarnation, opts.now);

  const controller = new AbortController();
  let attempted = 0;
  let succeeded = 0;
  let stoppedByShutdown = false;
  const seenBusIds = new Set<string>();

  /** Deliver every not-yet-seen bus message addressed to me into the inbox (ordered, idempotent). */
  const pumpInbox = (): void => {
    for (const entry of readBus(deps.store, threadId)) {
      if (entry.env.to !== opts.member) continue;
      inbox.deliver(entry.env.id, entry.env.from, entry.env.message, deps.clock.now());
      seenBusIds.add(entry.env.id);
    }
  };

  /** Wait for a specific response to me (matched by correlation + type), bounded by MAX_POLLS. */
  const awaitResponse = async (
    correlationId: string,
    responseType: ProtocolMessage['type'],
  ): Promise<ProtocolMessage | null> => {
    for (let poll = 0; poll < MAX_POLLS; poll++) {
      if (controller.signal.aborted) return null;
      for (const entry of readBus(deps.store, threadId)) {
        if (entry.env.to !== opts.member) continue;
        const message = entry.env.message;
        if (message.type === responseType && correlationOf(message) === correlationId) {
          const match = tracker.matchResponse(message, entry.env.from, opts.member);
          if (!match.ok) throw new Error(`protocol integrity: ${match.reason}`);
          return message;
        }
        // A shutdown that arrives while we wait aborts the wait so the team can stop promptly.
        if (message.type === 'shutdown-request' || message.type === 'termination') {
          controller.abort();
          return null;
        }
      }
      await deps.clock.sleep(POLL_MS);
    }
    return null;
  };

  const post = async (message: ProtocolMessage): Promise<void> => {
    await postMessage(deps, threadId, profile, actor, {
      id: deps.ids.next('msg'),
      from: opts.member,
      to: LEAD_ID,
      message,
    });
  };

  /** Do one claimed task: plan approval (AG-09) → permission (PS-09) → sandboxed work in the worktree. */
  const work = async (taskId: number, signal: AbortSignal): Promise<{ ok: boolean }> => {
    attempted++;
    const task = graph.get(taskId);
    const subject = task?.subject ?? `task ${taskId}`;

    // PLAN APPROVAL — the teammate stays read-only (no shell) until the lead approves (AG-09).
    let approved = false;
    for (let revision = 0; revision < MAX_PLAN_REVISIONS && !approved; revision++) {
      const correlationId = deps.ids.next('cor');
      const request: ProtocolMessage = {
        type: 'plan-approval-request',
        correlationId,
        plan: `rev${revision}: ${subject}`,
      };
      tracker.register(request, opts.member, LEAD_ID);
      await post(request);
      const response = await awaitResponse(correlationId, 'plan-approval-response');
      if (response === null) {
        await recordResult(deps, threadId, profile, actor, {
          taskId,
          member: opts.member,
          ok: false,
          detail: 'no plan approval (shutdown or timeout)',
          relPath: null,
        });
        return { ok: true };
      }
      if (response.type === 'plan-approval-response' && response.approved) approved = true;
    }
    if (!approved) {
      await recordResult(deps, threadId, profile, actor, {
        taskId,
        member: opts.member,
        ok: false,
        detail: 'plan rejected after revisions',
        relPath: null,
      });
      return { ok: true };
    }

    // PERMISSION BUBBLE (PS-09) for tasks that declare they need one.
    if (subject.startsWith('P:')) {
      const correlationId = deps.ids.next('cor');
      const request: ProtocolMessage = {
        type: 'permission-request',
        correlationId,
        action: `sandboxed shell for task ${taskId}`,
      };
      tracker.register(request, opts.member, LEAD_ID);
      await post(request);
      const response = await awaitResponse(correlationId, 'permission-response');
      if (response === null || (response.type === 'permission-response' && !response.granted)) {
        await recordResult(deps, threadId, profile, actor, {
          taskId,
          member: opts.member,
          ok: false,
          detail: 'permission denied or unavailable',
          relPath: null,
        });
        return { ok: true };
      }
    }

    // THE WORK — a real sandboxed command in THIS teammate's worktree, under its ceiling-bound
    // authority. Under a managed `plan` ceiling the shell is DENIED here mechanically (AG-03).
    const relPath = `results/task-${taskId}.done`;
    const script = resultScript(taskId, opts.member);
    const workload: ShellWorkload = {
      command: 'node',
      argv: ['-e', script],
      cwd: opts.worktree,
      authority: {
        ...opts.grantedAuthority,
        workspaceRoots: [opts.worktree],
        rules: [...opts.grantedAuthority.rules, preapprovalRule('node', ['-e', script])],
      },
    };
    const result = await runSandboxedShell(
      pipeline,
      workload,
      deps.homeDir,
      deps.clock.now(),
      signal,
    );
    await recordResult(deps, threadId, profile, actor, {
      taskId,
      member: opts.member,
      ok: result.ok,
      detail: result.reason ?? null,
      relPath: result.ok ? relPath : null,
    });
    return { ok: true };
  };

  const teammate = new Teammate({
    memberId: opts.member,
    incarnationId: opts.incarnation,
    inbox,
    tasks: graph,
    actor,
    work,
    signal: controller.signal,
  });

  // The autonomous loop. Shutdown wins; otherwise claim+work; otherwise wait for work or the whole
  // task graph to finish. Bounded by MAX_POLLS so a headless run can never spin forever.
  for (let poll = 0; poll < MAX_POLLS; poll++) {
    pumpInbox();
    // A durable heartbeat, so `team status`/recovery never shows a dead process as running (AG-13).
    // Throttled so it paces the shared write lock rather than saturating it (this is coordination,
    // not a benchmark): one heartbeat roughly every HEARTBEAT_EVERY polls plus one at start.
    if (poll % HEARTBEAT_EVERY === 0) {
      await heartbeat(deps, threadId, profile, actor, opts.member, opts.incarnation);
    }

    const step = await teammate.step();
    if (step.phase === 'stopped') {
      stoppedByShutdown = true;
      break;
    }
    if (step.claimedTask !== null) {
      if (readResults(deps.store, threadId).some((r) => r.taskId === step.claimedTask && r.ok)) {
        succeeded++;
      }
      continue;
    }

    // Idle: if the whole graph is terminal there is nothing left for anyone — exit. Otherwise a
    // blocker may still be completing on another teammate, so wait briefly and re-check.
    const allTerminal = graph
      .list()
      .every((t) => t.status === 'completed' || t.status === 'deleted');
    if (allTerminal) break;
    if (controller.signal.aborted) break;
    await deps.clock.sleep(POLL_MS);
  }

  // Clean shutdown: release anything still owned (so nothing is stranded), and record it durably.
  for (const task of graph.list()) {
    if (
      task.owner === opts.member &&
      (task.status === 'claimed' || task.status === 'in-progress')
    ) {
      graph.release(task.id, actor);
    }
  }
  await appendIntentRetry(
    deps,
    threadId,
    profile,
    actor,
    STOPPED_PREFIX + JSON.stringify({ member: opts.member, incarnation: opts.incarnation }),
    `team-stopped:${opts.member}:${opts.incarnation}`,
  );

  return {
    member: opts.member,
    incarnation: opts.incarnation,
    tasksAttempted: attempted,
    tasksSucceeded: succeeded,
    stoppedByShutdown,
  };
}

function heartbeat(
  deps: TeamDeps,
  threadId: ThreadId,
  profile: PermissionProfile,
  actor: Actor,
  member: string,
  incarnation: string,
): Promise<void> {
  return appendIntentRetry(
    deps,
    threadId,
    profile,
    actor,
    HEARTBEAT_PREFIX + JSON.stringify({ member, incarnation }),
    `team-heartbeat:${deps.ids.next('hb')}`,
  );
}

/** A node script that writes the task's result file into the CWD (the teammate's worktree). */
function resultScript(taskId: number, member: string): string {
  return (
    `const fs=require('node:fs');` +
    `fs.mkdirSync('results',{recursive:true});` +
    `fs.writeFileSync('results/task-${taskId}.done',${JSON.stringify(member)});` +
    `process.stdout.write('ok');`
  );
}

// ---------------------------------------------------------------------------------------------
// `team status` — reconstruct member state from the durable log (AG-13).
// ---------------------------------------------------------------------------------------------

export interface MemberStatus {
  readonly member: string;
  readonly incarnation: string;
  readonly state: 'running' | 'lost' | 'stopped';
  readonly lastHeartbeatAt: number;
}

/**
 * Reconstruct the team roster and classify each member. A member with a stopped record is `stopped`;
 * otherwise heartbeats older than the timeout as of `now` are `lost`, never `running` (AG-13). The
 * classification uses the `teams` `TeamRecovery` heartbeat model, driven by the durable timestamps.
 */
export function teamStatus(
  store: EventStore,
  team: string,
  now: number,
  timeoutMs = 45_000,
): MemberStatus[] {
  const threadId = teamThreadId(team);
  const roster = readRoster(store, threadId);
  const recovery = new TeamRecovery({ heartbeatTimeoutMs: timeoutMs, leaseMs: timeoutMs });
  const out: MemberStatus[] = [];
  for (const entry of roster.values()) {
    recovery.spawn(entry.member, entry.incarnation, entry.registeredAt);
    recovery.heartbeat(entry.member, entry.incarnation, entry.lastHeartbeatAt);
    recovery.detectLost(now);
    const state: MemberStatus['state'] = entry.stopped
      ? 'stopped'
      : recovery.state(entry.member) === 'lost'
        ? 'lost'
        : 'running';
    out.push({
      member: entry.member,
      incarnation: entry.incarnation,
      state,
      lastHeartbeatAt: entry.lastHeartbeatAt,
    });
  }
  return out.sort((a, b) => a.member.localeCompare(b.member));
}
