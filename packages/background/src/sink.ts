/**
 * Optional durable persistence for the background lifecycle (BG-04).
 *
 * The manager is storage-agnostic; when a sink is injected it records a task's start and settlement
 * through it. The EventStore-backed adapter maps them onto the side-effect ledger — a background task
 * IS a persisted side effect: intent at start, `known-complete`/`known-failed` at settlement — which
 * gives completion durable, attributed, idempotent semantics for free. The manager already guards
 * against a duplicate settlement, and the ledger's stable idempotency key is the second line of that
 * defense.
 *
 * The protocol event schema is frozen with no background-specific payload; the side-effect ledger is
 * the honest, existing fit rather than an invented one.
 */

import type {
  Actor,
  CorrelationId,
  IdSource,
  PermissionProfile,
  SideEffectId,
  ThreadId,
  TurnId,
} from '@qwen-harness/protocol';
import type { EventStore } from '@qwen-harness/storage';

import type { BackgroundTaskView } from './manager.ts';

export interface BackgroundEventSink {
  recordStart(task: BackgroundTaskView): void;
  /** Records a settlement exactly once; `ok` distinguishes completion from failure. */
  recordCompletion(task: BackgroundTaskView, ok: boolean): void;
}

/** The stable idempotency key for a task's side effect, so `mayExecute` reflects its completion. */
export function backgroundIdempotencyKey(taskId: string): string {
  return `background.v1:${taskId}`;
}

interface EventStoreBackgroundContext {
  readonly store: EventStore;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly actor: Actor;
  readonly correlationId: CorrelationId;
  readonly permissionProfile: PermissionProfile;
  readonly ids: IdSource;
}

/**
 * A {@link BackgroundEventSink} backed by the real {@link EventStore}. `recordStart` persists a
 * side-effect intent keyed by the task id; `recordCompletion` marks it started then settled, so a
 * later `store.mayExecute(key)` correctly refuses to re-run a known-complete task.
 */
export function eventStoreBackgroundSink(ctx: EventStoreBackgroundContext): BackgroundEventSink {
  const sideEffectIds = new Map<string, SideEffectId>();

  const base = {
    threadId: ctx.threadId,
    turnId: ctx.turnId,
    actor: ctx.actor,
    correlationId: ctx.correlationId,
    permissionProfile: ctx.permissionProfile,
  };

  return {
    recordStart(task: BackgroundTaskView): void {
      const sideEffectId = ctx.ids.next('sfx') as SideEffectId;
      sideEffectIds.set(task.id, sideEffectId);
      ctx.store.append({
        ...base,
        payload: {
          type: 'side-effect-intent',
          intent: {
            sideEffectId,
            idempotencyKey: backgroundIdempotencyKey(task.id),
            kind: 'other',
            destructive: false,
            normalizedAction: `background:${task.category}:${task.id}`,
          },
        },
      });
    },

    recordCompletion(task: BackgroundTaskView, ok: boolean): void {
      const sideEffectId = sideEffectIds.get(task.id);
      if (!sideEffectId) return;
      ctx.store.append({ ...base, payload: { type: 'side-effect-started', sideEffectId } });
      ctx.store.append({
        ...base,
        payload: {
          type: 'side-effect-settled',
          sideEffectId,
          state: ok ? 'known-complete' : 'known-failed',
          resultDigest: task.outputRef,
        },
      });
    },
  };
}
