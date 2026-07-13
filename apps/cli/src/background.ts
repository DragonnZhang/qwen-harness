import {
  BackgroundManager,
  backgroundIdempotencyKey,
  eventStoreBackgroundSink,
  isBackgroundCategory,
  type BackgroundCategory,
  type BackgroundTaskView,
  type Runner,
  type RunnerControl,
} from '@qwen-harness/background';
import { NO_MANAGED_RESTRICTIONS, PolicyEngine, type Authority } from '@qwen-harness/policy';
import type {
  Actor,
  Clock,
  CorrelationId,
  IdSource,
  PermissionProfile,
  ThreadId,
  TurnId,
} from '@qwen-harness/protocol';
import type { EventStore } from '@qwen-harness/storage';
import { BUILTIN_TOOLS, ToolPipeline, registerBuiltins } from '@qwen-harness/tools-builtin';
import { ToolRegistry } from '@qwen-harness/tools-core';
import { ToolWorkerClient, type WorkerGrant } from '@qwen-harness/tool-worker';

/**
 * The background lifecycle, made reachable from the CLI (BG-01..BG-06).
 *
 * The `@qwen-harness/background` package owns the state machine but injects two boundaries: a
 * {@link Runner} (how work actually runs) and time (a {@link Clock}). This file supplies the REAL
 * runner — a shell command executed through the SAME sandboxed tool pipeline a model turn uses — so a
 * background task is genuinely isolated by the sandbox and bounded by the same policy/budget, not a
 * detached unsandboxed process. Nothing here special-cases background work: it runs through
 * `ToolPipeline`, which decides policy over the exact action it executes.
 *
 * Durability (BG-04): the manager is handed the EventStore-backed sink, so a task's start and
 * settlement land on the side-effect ledger. That is what lets a completed background task SURVIVE a
 * restart — a fresh process reads the ledger and, via `mayExecute`, refuses to re-run a task that
 * already completed. The in-memory manager is gone after the process exits; the durable RESULT is not.
 */

/** The system actor a CLI-launched background task is attributed to. */
const BACKGROUND_ACTOR: Actor = { kind: 'system', id: 'act_background' as Actor['id'] };

/**
 * The launch payload the sandbox runner interprets. It carries the ALREADY-CLAMPED authority the
 * work must run under, because the manager does not thread its `permissionContext` to the runner —
 * so the authority travels with the payload and the runner can never widen it.
 */
export interface ShellWorkload {
  readonly command: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  /** The effective authority (already intersected with any ceiling) the sandbox runs under. */
  readonly authority: Authority;
}

/** How a background sandbox command actually ran, mapped from the pipeline outcome. */
export interface ShellRunResult {
  readonly ok: boolean;
  readonly code: number | null;
  readonly text: string;
  readonly reason: string | undefined;
}

/**
 * The worker grant for a background shell command. Shell is allowed (a background task IS a command);
 * network follows the authority, never wider; the limits are the sandbox budget the work is bound by
 * (BG-05 / CR-07 "normal sandbox/budget"). These are rlimits enforced by the sandbox, not JS checks.
 */
function grantFor(authority: Authority): WorkerGrant {
  return {
    readable: ['workspace', 'scratch'],
    writable: ['workspace', 'scratch'],
    shell: true,
    network: authority.networkAllowed,
    limits: { wallMs: 120_000, maxOutputBytes: 2_000_000, maxFileBytes: 10_000_000 },
  };
}

/**
 * Run one shell workload through the sandboxed pipeline under its own authority. This is the single
 * place background/cron work reaches the host, and it reaches it exactly the way a model tool call
 * does: schema → policy → sandbox worker. A workload whose authority forbids the shell (e.g. a job
 * whose ceiling clamped to `plan`) is REFUSED here by policy — the ceiling binds mechanically, not by
 * a second check we could forget to write.
 */
export async function runSandboxedShell(
  pipeline: ToolPipeline,
  workload: ShellWorkload,
  homeDir: string,
  clockNow: number,
  signal: AbortSignal,
): Promise<ShellRunResult> {
  const outcome = await pipeline.execute({
    callId: `bg_${clockNow.toString(36)}`,
    toolName: 'run_shell',
    rawArguments: { command: workload.command, argv: [...workload.argv], cwd: '.' },
    policyContext: {
      profile: workload.authority.profile,
      // The authority is ALREADY clamped by the scheduler/caller; treat it as the ceiling itself.
      // Re-applying a managed clamp here would be a second implementation of the rule.
      managedPolicy: NO_MANAGED_RESTRICTIONS,
      rules: workload.authority.rules,
      grants: workload.authority.grants,
      workspaceRoot: workload.cwd,
      homeDir,
      now: clockNow,
      actor: BACKGROUND_ACTOR,
    },
    grant: grantFor(workload.authority),
    isolation: workload.authority.isolation,
    signal,
  });

  if (outcome.status === 'executed') {
    const response = outcome.response;
    if (response.ok) {
      const result = response.result as { exitCode?: number; stdout?: string; stderr?: string };
      const code = typeof result.exitCode === 'number' ? result.exitCode : 0;
      return {
        ok: code === 0,
        code,
        text: `${result.stdout ?? ''}${result.stderr ? `\n[stderr] ${result.stderr}` : ''}`,
        reason: code === 0 ? undefined : `exit ${code}`,
      };
    }
    return {
      ok: false,
      code: null,
      text: '',
      reason: `${response.error.category}: ${response.error.message}`,
    };
  }

  // Denied / needs-approval / rejected. A background task has no interactive channel, so an
  // ask-required or denied action fails the task rather than silently proceeding (CR-07 / BG-05).
  const reason =
    outcome.status === 'denied'
      ? `denied: ${outcome.reason}`
      : outcome.status === 'needs-approval'
        ? `needs approval (no channel): ${outcome.description}`
        : `rejected (${outcome.stage}): ${outcome.message}`;
  return { ok: false, code: null, text: '', reason };
}

/**
 * A {@link Runner} that executes a {@link ShellWorkload} in the sandbox. The manager owns the
 * lifecycle; this turns its abstract launch into a real, isolated command and reports the exit back.
 */
export function createSandboxRunner(opts: {
  pipeline: ToolPipeline;
  homeDir: string;
  clock: Clock;
}): Runner {
  return {
    start(spec, callbacks): RunnerControl {
      const abort = new AbortController();
      const payload = spec.payload as ShellWorkload | undefined;

      if (!payload || typeof payload.command !== 'string') {
        // A launch with no runnable workload is a caller bug, not a silent success.
        queueMicrotask(() =>
          callbacks.onExit({ ok: false, code: null, reason: 'no shell workload in payload' }),
        );
        return { provideInput() {}, cancel() {} };
      }

      void runSandboxedShell(opts.pipeline, payload, opts.homeDir, opts.clock.now(), abort.signal)
        .then((result) => {
          if (result.text.length > 0) callbacks.onOutput(result.text);
          callbacks.onExit({
            ok: result.ok,
            code: result.code,
            ...(result.reason !== undefined ? { reason: result.reason } : {}),
          });
        })
        .catch((e: unknown) =>
          callbacks.onExit({
            ok: false,
            code: null,
            reason: e instanceof Error ? e.message : String(e),
          }),
        );

      return {
        provideInput() {},
        cancel() {
          abort.abort();
        },
      };
    },
  };
}

/** Build the sandboxed tool pipeline the runner drives. One per CLI command is enough. */
export function buildBackgroundPipeline(client?: ToolWorkerClient): ToolPipeline {
  const registry = registerBuiltins(new ToolRegistry(), BUILTIN_TOOLS);
  return new ToolPipeline({
    registry,
    policy: new PolicyEngine(),
    client: client ?? new ToolWorkerClient(),
    builtins: BUILTIN_TOOLS,
  });
}

/**
 * A single background manager wired to the durable sink, so every start/settlement is recorded on the
 * side-effect ledger of `threadId`. The sink attributes completion to a NEW side-effect id — never the
 * launching tool-call id (BG-04) — and its idempotency key makes a completed task un-repeatable across
 * a restart.
 */
export function createDurableBackgroundManager(opts: {
  store: EventStore;
  threadId: ThreadId;
  turnId: TurnId;
  correlationId: CorrelationId;
  permissionProfile: PermissionProfile;
  actor: Actor;
  clock: Clock;
  ids: IdSource;
  pipeline: ToolPipeline;
  homeDir: string;
}): BackgroundManager {
  return new BackgroundManager({
    clock: opts.clock,
    ids: opts.ids,
    runner: createSandboxRunner({
      pipeline: opts.pipeline,
      homeDir: opts.homeDir,
      clock: opts.clock,
    }),
    sink: eventStoreBackgroundSink({
      store: opts.store,
      threadId: opts.threadId,
      turnId: opts.turnId,
      correlationId: opts.correlationId,
      permissionProfile: opts.permissionProfile,
      actor: opts.actor,
      ids: opts.ids,
    }),
  });
}

/**
 * A durable, cross-restart view of a background task's outcome, reconstructed from the side-effect
 * ledger (BG-07: definition/process/result are distinct — the process is gone after restart, but the
 * durable result is not). `state` is `known-complete`/`known-failed`/`indeterminate`/`in-flight`.
 */
export interface DurableBackgroundRecord {
  readonly taskId: string;
  readonly category: string;
  readonly threadId: ThreadId;
  readonly idempotencyKey: string;
  /** The durable side-effect id, so a caller can settle (cancel) an unfinished task by identity. */
  readonly sideEffectId: string;
  readonly state: string;
}

/**
 * Read every background task ever recorded on a thread from the durable log. A fresh process (a
 * restart) has no in-memory manager, so this is how `background list` still shows past work and how a
 * completed task is recognised as un-runnable.
 */
export function listDurableBackground(
  store: EventStore,
  threadId: ThreadId,
): DurableBackgroundRecord[] {
  const out: DurableBackgroundRecord[] = [];
  for (const event of store.readThread(threadId)) {
    if (event.payload.type !== 'side-effect-intent') continue;
    const action = event.payload.intent.normalizedAction;
    // The sink writes `background:<category>:<taskId>`; anything else on this thread is not ours.
    const match = /^background:([^:]+):(.+)$/.exec(action);
    if (!match) continue;
    const category = match[1] ?? '';
    const taskId = match[2] ?? '';
    const key = backgroundIdempotencyKey(taskId);
    out.push({
      taskId,
      category,
      threadId,
      idempotencyKey: key,
      sideEffectId: event.payload.intent.sideEffectId,
      state: store.sideEffectState(key) ?? 'unknown',
    });
  }
  return out;
}

export { isBackgroundCategory };
export type { BackgroundCategory, BackgroundTaskView };
