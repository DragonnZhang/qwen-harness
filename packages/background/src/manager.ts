/**
 * The unified background lifecycle (BG-01..BG-06).
 *
 * One manager runs every supported category of background work through ONE state machine. Process
 * spawning is injected (a {@link Runner}) and time is injected (a {@link Clock}), so the lifecycle is
 * deterministic and testable without real processes or wall-clock waits. The manager reports and
 * steers; it never touches a real process itself.
 *
 * Statuses:
 *   queued          a foreground task waiting for one of the four concurrency slots.
 *   running         actively executing.
 *   awaiting_input  a typed input request (or a tripped input watchdog) is pending.
 *   blocked         no input/approval channel appeared within five minutes; suspended, not guessed.
 *   succeeded / failed / cancelled   terminal.
 */

import { harnessError, type Actor, type Clock, type IdSource } from '@qwen-harness/protocol';
import type { Authority } from '@qwen-harness/policy';

import {
  classifyForeground,
  type BackgroundCategory,
  type ForegroundHint,
  type Placement,
} from './category.ts';
import type { BackgroundEventSink } from './sink.ts';
import {
  levelOf,
  NotificationQueue,
  type Notification,
  type NotificationKind,
} from './notifications.ts';
import type { InputRequest, Runner, RunnerControl, RunnerExit } from './runner.ts';

export const FOREGROUND_CONCURRENCY = 4;
export const OUTPUT_WARN_BYTES = 10 * 1024 * 1024;
export const OUTPUT_HARD_STOP_BYTES = 5 * 1024 * 1024 * 1024;
export const OUTPUT_PREVIEW_BYTES = 64 * 1024;
export const INPUT_WATCHDOG_MS = 30_000;
export const BLOCKED_AFTER_MS = 5 * 60_000;

export type TaskStatus =
  'queued' | 'running' | 'awaiting_input' | 'blocked' | 'succeeded' | 'failed' | 'cancelled';

const TERMINAL: readonly TaskStatus[] = ['succeeded', 'failed', 'cancelled'];

export function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL.includes(status);
}

export interface StartInput {
  readonly category: BackgroundCategory;
  readonly owner: Actor;
  /** Explicit placement wins; otherwise `hint` drives the conservative fallback (BG-01). */
  readonly placement?: Placement;
  readonly hint?: ForegroundHint;
  /** The originating model tool-call id, if any. The completion event never reuses it (BG-04). */
  readonly toolCallId?: string;
  /** The permission context the work runs under (BG-02). */
  readonly permissionContext: Authority;
  /** Opaque launch payload handed to the runner. */
  readonly payload?: unknown;
  /** Whether an approval/input channel exists; without one, an input wait eventually blocks (BG-05). */
  readonly approvalChannel?: boolean;
}

/** A read-only snapshot of a task — the surface `/tasks` and the TUI consume (BG-06). */
export interface BackgroundTaskView {
  readonly id: string;
  readonly category: BackgroundCategory;
  readonly placement: Placement;
  readonly owner: Actor;
  readonly toolCallId: string | null;
  readonly permissionContext: Authority;
  readonly status: TaskStatus;
  readonly outputBytes: number;
  readonly outputPreview: string;
  /** A durable reference to the full output (offloaded elsewhere); stable per task. */
  readonly outputRef: string;
  readonly outputTruncated: boolean;
  readonly outputWarned: boolean;
  readonly lastInputRequest: InputRequest | null;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly exit: RunnerExit | null;
}

interface TaskRecord {
  readonly id: string;
  readonly category: BackgroundCategory;
  readonly placement: Placement;
  readonly owner: Actor;
  readonly toolCallId: string | null;
  readonly permissionContext: Authority;
  readonly payload: unknown;
  readonly approvalChannel: boolean;
  status: TaskStatus;
  control: RunnerControl | null;
  outputBytes: number;
  outputPreview: string;
  outputTruncated: boolean;
  outputWarned: boolean;
  lastInputRequest: InputRequest | null;
  /** When the current input-wait (typed or detected) began; drives the watchdog and blocked timers. */
  awaitingSince: number | null;
  /** A detected (undeclared) input wait not yet promoted to `awaiting_input`. */
  detectedWaitSince: number | null;
  readonly createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  exit: RunnerExit | null;
  readonly waiters: ((view: BackgroundTaskView) => void)[];
}

export interface BackgroundManagerOptions {
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly runner: Runner;
  /** Optional durable sink; when present, task start/settle are recorded through storage (BG-04). */
  readonly sink?: BackgroundEventSink;
  readonly foregroundConcurrency?: number;
}

export class BackgroundManager {
  readonly #clock: Clock;
  readonly #ids: IdSource;
  readonly #runner: Runner;
  readonly #sink: BackgroundEventSink | undefined;
  readonly #limit: number;
  readonly #tasks = new Map<string, TaskRecord>();
  /** FIFO order of queued foreground task ids, admitted as slots free (BG-05). */
  readonly #queue: string[] = [];
  readonly #notifications = new NotificationQueue();

  constructor(opts: BackgroundManagerOptions) {
    this.#clock = opts.clock;
    this.#ids = opts.ids;
    this.#runner = opts.runner;
    this.#sink = opts.sink;
    this.#limit = opts.foregroundConcurrency ?? FOREGROUND_CONCURRENCY;
  }

  get notifications(): NotificationQueue {
    return this.#notifications;
  }

  // -------------------------------------------------------------------------
  // BG-02: start returns a unique id IMMEDIATELY
  // -------------------------------------------------------------------------

  start(input: StartInput): BackgroundTaskView {
    const placement = classifyForeground({
      ...(input.placement ? { explicit: input.placement } : {}),
      ...(input.hint ? { hint: input.hint } : {}),
    });
    const id = this.#ids.next('bgt');
    const now = this.#clock.now();

    const task: TaskRecord = {
      id,
      category: input.category,
      placement,
      owner: input.owner,
      toolCallId: input.toolCallId ?? null,
      permissionContext: input.permissionContext,
      payload: input.payload ?? null,
      approvalChannel: input.approvalChannel ?? false,
      status: 'queued',
      control: null,
      outputBytes: 0,
      outputPreview: '',
      outputTruncated: false,
      outputWarned: false,
      lastInputRequest: null,
      awaitingSince: null,
      detectedWaitSince: null,
      createdAt: now,
      startedAt: null,
      endedAt: null,
      exit: null,
      waiters: [],
    };
    this.#tasks.set(id, task);
    this.#sink?.recordStart(this.#view(task));

    // A background task, or a foreground task with a free slot, launches now; otherwise it queues.
    if (placement === 'background' || this.#foregroundRunning() < this.#limit) {
      this.#launch(task);
    } else {
      this.#queue.push(id);
    }

    // The id and a status snapshot are available synchronously — the caller never waits (BG-02).
    return this.#view(task);
  }

  // -------------------------------------------------------------------------
  // BG-02 surface: status / output / stop / await
  // -------------------------------------------------------------------------

  get(id: string): BackgroundTaskView | undefined {
    const task = this.#tasks.get(id);
    return task ? this.#view(task) : undefined;
  }

  /** The list/inspect data surface for `/tasks` and the TUI (BG-06). */
  list(): BackgroundTaskView[] {
    return [...this.#tasks.values()].map((t) => this.#view(t));
  }

  inspect(id: string): BackgroundTaskView | undefined {
    return this.get(id);
  }

  /** Provide input to a task that requested it, resuming it (BG-05). */
  provideInput(id: string, value: string): void {
    const task = this.#require(id);
    if (task.status !== 'awaiting_input' && task.status !== 'blocked') {
      throw harnessError({
        origin: 'user',
        category: 'background.not_awaiting_input',
        message: `task ${id} is ${task.status}, not awaiting input`,
      });
    }
    task.status = 'running';
    task.awaitingSince = null;
    task.detectedWaitSince = null;
    task.lastInputRequest = null;
    task.control?.provideInput(value);
  }

  /** Cancel a task and clean up (BG-05). Idempotent: cancelling a terminal task is a no-op. */
  stop(id: string): void {
    const task = this.#require(id);
    if (isTerminalStatus(task.status)) return;
    task.control?.cancel();
    this.#settle(task, 'cancelled', { ok: false, code: null, reason: 'cancelled' });
  }

  /** Resolve when the task reaches a terminal state (BG-02). */
  awaitTask(id: string): Promise<BackgroundTaskView> {
    const task = this.#require(id);
    if (isTerminalStatus(task.status)) return Promise.resolve(this.#view(task));
    return new Promise((resolve) => task.waiters.push(resolve));
  }

  // -------------------------------------------------------------------------
  // BG-05: input watchdog and blocked transition
  // -------------------------------------------------------------------------

  /**
   * Advance the input watchdog and blocked timers against the injected clock (BG-05). Called from the
   * runtime loop. A detected input wait promotes to `awaiting_input` after 30 seconds; an
   * `awaiting_input` task with no approval channel becomes `blocked` after five minutes. Nothing here
   * ever guesses input or auto-approves.
   */
  checkWatchdogs(now: number): void {
    for (const task of this.#tasks.values()) {
      if (
        task.status === 'running' &&
        task.detectedWaitSince !== null &&
        now - task.detectedWaitSince >= INPUT_WATCHDOG_MS
      ) {
        // The watchdog suspends the process and formally requests input (priority-1).
        this.#enterAwaitingInput(task, { prompt: 'input required (watchdog)' }, now);
      }

      if (
        task.status === 'awaiting_input' &&
        !task.approvalChannel &&
        task.awaitingSince !== null &&
        now - task.awaitingSince >= BLOCKED_AFTER_MS
      ) {
        task.status = 'blocked';
        this.#notify(task, 'status', `task ${task.id} blocked: no input channel`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #launch(task: TaskRecord): void {
    task.status = 'running';
    task.startedAt = this.#clock.now();
    task.control = this.#runner.start(
      { taskId: task.id, category: task.category, payload: task.payload },
      {
        onOutput: (chunk) => this.#onOutput(task, chunk),
        onInputRequest: (request) => this.#enterAwaitingInput(task, request, this.#clock.now()),
        onInputWaitDetected: () => this.#onInputWaitDetected(task),
        onExit: (exit) => this.#onExit(task, exit),
      },
    );
  }

  #onOutput(task: TaskRecord, chunk: string): void {
    if (isTerminalStatus(task.status)) return;
    task.outputBytes += chunk.length;

    if (task.outputPreview.length < OUTPUT_PREVIEW_BYTES) {
      const room = OUTPUT_PREVIEW_BYTES - task.outputPreview.length;
      task.outputPreview += chunk.slice(0, room);
      if (chunk.length > room) task.outputTruncated = true;
    } else {
      task.outputTruncated = true;
    }

    if (!task.outputWarned && task.outputBytes >= OUTPUT_WARN_BYTES) {
      task.outputWarned = true;
      this.#notify(task, 'status', `task ${task.id} output exceeded ${OUTPUT_WARN_BYTES} bytes`);
    }
    if (task.outputBytes >= OUTPUT_HARD_STOP_BYTES) {
      task.control?.cancel();
      this.#settle(task, 'failed', {
        ok: false,
        code: null,
        reason: 'output hard-stop limit exceeded',
      });
    }
  }

  #onInputWaitDetected(task: TaskRecord): void {
    if (task.status !== 'running') return;
    // Record the start of a detected wait; the 30s watchdog promotes it later.
    if (task.detectedWaitSince === null) task.detectedWaitSince = this.#clock.now();
  }

  #enterAwaitingInput(task: TaskRecord, request: InputRequest, now: number): void {
    if (isTerminalStatus(task.status)) return;
    task.status = 'awaiting_input';
    task.awaitingSince = now;
    task.detectedWaitSince = null;
    task.lastInputRequest = request;
    // A typed input request emits a priority-1 notification (docs/product/defaults.md).
    this.#notify(task, 'input-request', `task ${task.id} requests input: ${request.prompt}`);
  }

  #onExit(task: TaskRecord, exit: RunnerExit): void {
    // Idempotency (BG-04): a duplicate exit for an already-settled task is a no-op — one effect only.
    if (isTerminalStatus(task.status)) return;
    this.#settle(task, exit.ok ? 'succeeded' : 'failed', exit);
  }

  #settle(task: TaskRecord, status: TaskStatus, exit: RunnerExit): void {
    if (isTerminalStatus(task.status)) return;
    task.status = status;
    task.exit = exit;
    task.endedAt = this.#clock.now();
    task.control = null;

    // The completion notification is a NEW attributed event with its own id — never the tool-call id
    // (BG-04). Success is an ordinary background completion (level 3); failure is a task failure
    // (level 2).
    const kind: NotificationKind =
      status === 'succeeded' ? 'background-completion' : 'task-failure';
    this.#notify(task, kind, `task ${task.id} ${status}`);
    this.#sink?.recordCompletion(this.#view(task), status === 'succeeded');

    const view = this.#view(task);
    for (const waiter of task.waiters.splice(0)) waiter(view);

    // Free the slot this task held and admit the next queued foreground task, FIFO.
    if (task.placement === 'foreground') this.#admitNext();
  }

  #admitNext(): void {
    while (this.#foregroundRunning() < this.#limit && this.#queue.length > 0) {
      const nextId = this.#queue.shift();
      if (nextId === undefined) return;
      const next = this.#tasks.get(nextId);
      if (next && next.status === 'queued') this.#launch(next);
    }
  }

  #foregroundRunning(): number {
    let n = 0;
    for (const task of this.#tasks.values()) {
      if (
        task.placement === 'foreground' &&
        !isTerminalStatus(task.status) &&
        task.status !== 'queued'
      ) {
        n += 1;
      }
    }
    return n;
  }

  #notify(task: TaskRecord, kind: NotificationKind, message: string): void {
    const notification: Notification = {
      id: this.#ids.next('ntf'),
      kind,
      level: levelOf(kind),
      subjectId: task.id,
      message,
      createdAt: this.#clock.now(),
    };
    this.#notifications.enqueue(notification);
  }

  #require(id: string): TaskRecord {
    const task = this.#tasks.get(id);
    if (!task) {
      throw harnessError({
        origin: 'user',
        category: 'background.unknown_task',
        message: `no background task ${id}`,
      });
    }
    return task;
  }

  #view(task: TaskRecord): BackgroundTaskView {
    return {
      id: task.id,
      category: task.category,
      placement: task.placement,
      owner: task.owner,
      toolCallId: task.toolCallId,
      permissionContext: task.permissionContext,
      status: task.status,
      outputBytes: task.outputBytes,
      outputPreview: task.outputPreview,
      outputRef: `bgout_${task.id}`,
      outputTruncated: task.outputTruncated,
      outputWarned: task.outputWarned,
      lastInputRequest: task.lastInputRequest,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      endedAt: task.endedAt,
      exit: task.exit,
    };
  }
}
