import type { ActorId, CorrelationId, SideEffectState, ThreadId } from '@qwen-harness/protocol';
import type { EventStore } from '@qwen-harness/storage';

/**
 * Indeterminate side-effect recovery (SS-05).
 *
 * The engine persists the INTENT of every side effect before it runs and the RESULT before it
 * continues. Between those two writes the row is `in-flight`. If the process dies in that window —
 * `kill -9`, an OOM, a pulled plug — the row stays `in-flight` forever, and nobody knows whether
 * the write landed, whether the shell command ran, or whether the network call reached its peer.
 *
 * `EventStore.recoverInterrupted()` and `listIndeterminate()` implemented the answer to that and
 * were called by NOTHING. The safety property still held by accident (`mayExecute` refuses an
 * `in-flight` key exactly as it refuses an `indeterminate` one), but an operator had no way to see
 * a stuck side effect and no way to clear it — the session was simply wedged, permanently, with no
 * diagnosis. This module is the missing half.
 *
 * THE RULE THAT MAKES THIS SAFE: an indeterminate side effect is INSPECTED, never guessed.
 *
 *   - Recovery promotes `in-flight` to `indeterminate`. It does NOT promote it to `known-failed`,
 *     because "it probably didn't finish" is exactly the assumption that double-applies a payment,
 *     a `git push`, or an `rm -rf`.
 *   - Recovery NEVER replays. Nothing here re-executes anything. The most a recovered row can do is
 *     become visible.
 *   - Only a human closes one, by telling us what they FOUND when they looked. `resolveSideEffect`
 *     records that finding as a durable, attributed event. There is deliberately no `--assume`, no
 *     `--all`, and no heuristic: an operator who cannot determine the outcome must not be handed a
 *     flag that pretends they did.
 */

export interface RecoveryReport {
  /** Rows moved from `in-flight` to `indeterminate` because their owning process is gone. */
  readonly promoted: number;
}

/**
 * Called at startup, BEFORE a turn runs. Any `in-flight` row belongs to a process that no longer
 * exists — we are the process now, and we did not start it — so it cannot still be running.
 *
 * This must run before the engine consults `mayExecute`, so that a resumed turn sees the honest
 * `indeterminate` state rather than a stale `in-flight` one. Both are refused, so the safety
 * direction is unchanged either way; what changes is that the row becomes visible to `listStuck`
 * and therefore resolvable.
 */
export function recoverInterrupted(store: EventStore): RecoveryReport {
  return store.recoverInterrupted();
}

export interface StuckSideEffect {
  readonly id: string;
  readonly normalizedAction: string;
  readonly destructive: boolean;
}

/** Every side effect in this session whose outcome is unknown. */
export function listStuck(store: EventStore, threadId: ThreadId): StuckSideEffect[] {
  return store.listIndeterminate(threadId);
}

/** What the operator FOUND when they inspected. Not a guess, and not a default. */
export type Finding = 'completed' | 'failed';

const FINDING_STATE: Record<Finding, SideEffectState> = {
  completed: 'known-complete',
  failed: 'known-failed',
};

export class SideEffectNotFound extends Error {
  constructor(readonly sideEffectId: string) {
    super(`no indeterminate side effect ${sideEffectId} in this session`);
    this.name = 'SideEffectNotFound';
  }
}

/**
 * Close out an indeterminate side effect with what a human actually observed.
 *
 * The two findings are not symmetric, and the asymmetry is the whole point:
 *
 *   - `completed` -> `known-complete`. `mayExecute` will now REFUSE to run this action again. That
 *     is the safe direction for a side effect that already landed: the harness will not repeat it.
 *   - `failed` -> `known-failed`. `mayExecute` will now ALLOW a retry. This is the dangerous
 *     direction, and it is why this is an explicit human statement about a specific side-effect id
 *     rather than anything the harness can infer. Saying `failed` about an action that in fact
 *     succeeded is how you get the double write. The CLI prints that warning before it asks.
 *
 * Recorded as an ordinary durable event, attributed to the user actor, so the audit log shows who
 * declared what and when. It is appended to the log, not patched into the projection — an operator
 * decision is history, and `rebuildProjections()` must reproduce it.
 */
export function resolveSideEffect(
  store: EventStore,
  input: {
    threadId: ThreadId;
    sideEffectId: string;
    finding: Finding;
    correlationId: CorrelationId;
    actorId: string;
  },
): { state: SideEffectState } {
  const stuck = store.listIndeterminate(input.threadId);
  const target = stuck.find((s) => s.id === input.sideEffectId);
  if (target === undefined) throw new SideEffectNotFound(input.sideEffectId);

  const thread = store.getThread(input.threadId);
  if (thread === undefined) throw new SideEffectNotFound(input.sideEffectId);

  const state = FINDING_STATE[input.finding];
  store.append({
    threadId: input.threadId,
    correlationId: input.correlationId,
    // The profile the thread runs under. An operator decision is not a permission escalation: it
    // records an observation, it does not authorize an action.
    permissionProfile: thread.permissionProfile,
    actor: { kind: 'user', id: input.actorId as ActorId },
    payload: {
      type: 'side-effect-settled',
      sideEffectId: input.sideEffectId as never,
      state,
      // No result digest: we did not produce this result, we were told about it. Claiming a digest
      // we never computed would put a fabricated identity into the audit trail.
      resultDigest: null,
    },
  });

  return { state };
}
