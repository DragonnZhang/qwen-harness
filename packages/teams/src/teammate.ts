import type { Actor } from '@qwen-harness/protocol';
import type { TaskGraph } from '@qwen-harness/tasks';

import type { Inbox, InboxEntry } from './inbox.ts';

/**
 * The autonomous teammate loop (AG-11).
 *
 * A teammate cycles WORK -> IDLE -> WORK. Each iteration, in this ORDER:
 *   1. handle shutdown FIRST — a shutdown request always wins, so a team can always be stopped;
 *   2. drain the inbox and handle protocol messages;
 *   3. atomically CLAIM a pending, unowned, unblocked task and work it;
 *   4. if there is nothing to do, go IDLE and sleep until the inbox wakes it.
 *
 * The claim is atomic (AG-06/WK-06): two teammates racing for one task cannot both win, because the
 * claim re-reads ownership inside the task graph's transaction. This loop is what makes a team make
 * progress without a central dispatcher assigning every task.
 */

export type TeammatePhase = 'work' | 'idle' | 'shutting-down' | 'stopped';

export interface TeammateContext {
  readonly memberId: string;
  readonly incarnationId: string;
  readonly inbox: Inbox;
  readonly tasks: TaskGraph;
  readonly actor: Actor;
  /** Runs one claimed task. Injected so the loop is testable without a real model. */
  work(taskId: number, signal: AbortSignal): Promise<{ ok: boolean }>;
  readonly signal: AbortSignal;
}

export interface LoopStep {
  readonly phase: TeammatePhase;
  readonly claimedTask: number | null;
  readonly handledMessages: number;
}

export class Teammate {
  #phase: TeammatePhase = 'idle';
  #shutdownRequested = false;
  readonly #ctx: TeammateContext;

  constructor(ctx: TeammateContext) {
    this.#ctx = ctx;
  }

  get phase(): TeammatePhase {
    return this.#phase;
  }

  /**
   * Run ONE iteration of the loop. Returns what it did. Kept as a single step (rather than an
   * infinite loop) so tests can drive the machine deterministically and assert each transition.
   */
  async step(): Promise<LoopStep> {
    if (this.#phase === 'stopped')
      return { phase: 'stopped', claimedTask: null, handledMessages: 0 };

    // 1. Shutdown wins over everything.
    const messages = this.#ctx.inbox.drain();
    const handled = this.#handleMessages(messages);
    if (this.#shutdownRequested || this.#ctx.signal.aborted) {
      this.#phase = 'stopped';
      return { phase: 'stopped', claimedTask: null, handledMessages: handled };
    }

    // 2. Try to claim and work a task. A task is claimable when it is unowned and in a claimable
    //    state (pending/released) with all blockers resolved — the graph makes the final atomic
    //    decision inside claim(), this filter is just to avoid obviously-doomed attempts.
    const claimable = this.#ctx.tasks
      .list()
      .filter((t) => t.owner === null && (t.status === 'pending' || t.status === 'released'));
    for (const task of claimable) {
      const result = this.#ctx.tasks.claim(task.id, this.#ctx.memberId, this.#ctx.actor);
      if (result.ok) {
        this.#phase = 'work';
        this.#ctx.tasks.start(task.id, this.#ctx.actor);
        const outcome = await this.#ctx.work(task.id, this.#ctx.signal);
        if (outcome.ok) this.#ctx.tasks.complete(task.id, this.#ctx.actor);
        else this.#ctx.tasks.release(task.id, this.#ctx.actor);
        return { phase: this.#phase, claimedTask: task.id, handledMessages: handled };
      }
      // Another teammate claimed it first — that is fine, try the next one.
    }

    // 3. Nothing to do: go idle.
    this.#phase = 'idle';
    return { phase: 'idle', claimedTask: null, handledMessages: handled };
  }

  #handleMessages(messages: readonly InboxEntry[]): number {
    for (const entry of messages) {
      if (entry.message.type === 'shutdown-request' || entry.message.type === 'termination') {
        this.#shutdownRequested = true;
      }
    }
    return messages.length;
  }

  /** Sleep until a message arrives (the IDLE phase), unless shutting down. */
  async waitForWork(): Promise<void> {
    if (this.#shutdownRequested || this.#ctx.signal.aborted) return;
    await this.#ctx.inbox.waitForMessage(this.#ctx.signal).catch(() => {});
  }
}
