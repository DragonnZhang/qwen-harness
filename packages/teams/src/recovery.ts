import type { TaskGraph } from '@qwen-harness/tasks';
import type { Actor } from '@qwen-harness/protocol';

/**
 * Team recovery (AG-12/AG-13, defaults.md "Team recovery defaults").
 *
 * The durable things are the team definition, the inbox, the task graph, and each member's LOGICAL
 * identity. Operating-system processes are NOT durable. So after a runtime loss:
 *
 *   - a previous process incarnation becomes `lost`, never `running` — we never show a dead process
 *     as alive;
 *   - a teammate whose heartbeat has expired has its owned tasks RELEASED and requeued (once the
 *     lease is up), so the work is not stranded on a dead member;
 *   - resuming a team spawns a NEW incarnation under the SAME logical member id, and records the
 *     lineage; a message addressed to an old incarnation is rejected.
 *
 * These are the rules that let a team survive a crash without either losing work or double-running
 * it.
 */

export type IncarnationState = 'running' | 'lost' | 'stopped';

export interface MemberIncarnation {
  readonly memberId: string;
  readonly incarnationId: string;
  state: IncarnationState;
  lastHeartbeatAt: number;
}

export interface HeartbeatOptions {
  /** After this long without a heartbeat, an incarnation is considered lost. */
  readonly heartbeatTimeoutMs: number;
  /** After an owner is lost, wait this long (the lease) before reclaiming its tasks. */
  readonly leaseMs: number;
}

export const DEFAULT_HEARTBEAT: HeartbeatOptions = {
  heartbeatTimeoutMs: 45_000,
  leaseMs: 60_000,
};

/**
 * Tracks member incarnations and heartbeats, and drives recovery. It never mutates the OS; it
 * decides which incarnations are lost and which tasks to reclaim, and the caller acts on that.
 */
export class TeamRecovery {
  readonly #incarnations = new Map<string, MemberIncarnation>();
  readonly #opts: HeartbeatOptions;

  constructor(opts: HeartbeatOptions = DEFAULT_HEARTBEAT) {
    this.#opts = opts;
  }

  /** Register a new incarnation for a logical member. Any prior incarnation becomes `lost`. */
  spawn(memberId: string, incarnationId: string, now: number): MemberIncarnation {
    const prior = this.#incarnations.get(memberId);
    if (prior !== undefined && prior.state === 'running') {
      // A logical member has at most one running incarnation; the prior one is lost, not replaced
      // silently — its lineage is recorded by the new incarnation id.
      prior.state = 'lost';
    }
    const inc: MemberIncarnation = {
      memberId,
      incarnationId,
      state: 'running',
      lastHeartbeatAt: now,
    };
    this.#incarnations.set(memberId, inc);
    return inc;
  }

  heartbeat(memberId: string, incarnationId: string, now: number): boolean {
    const inc = this.#incarnations.get(memberId);
    // A heartbeat from an OLD incarnation is rejected — only the current one counts.
    if (inc === undefined || inc.incarnationId !== incarnationId || inc.state !== 'running')
      return false;
    inc.lastHeartbeatAt = now;
    return true;
  }

  /**
   * Mark every incarnation whose heartbeat has expired as `lost`. Returns the members that just
   * became lost, so the caller can reclaim their tasks.
   */
  detectLost(now: number): string[] {
    const lost: string[] = [];
    for (const inc of this.#incarnations.values()) {
      if (inc.state === 'running' && now - inc.lastHeartbeatAt > this.#opts.heartbeatTimeoutMs) {
        inc.state = 'lost';
        lost.push(inc.memberId);
      }
    }
    return lost;
  }

  state(memberId: string): IncarnationState | 'unknown' {
    return this.#incarnations.get(memberId)?.state ?? 'unknown';
  }

  /**
   * Reclaim the tasks owned by a lost member: release them back to the pool so another teammate can
   * claim them. This never DOUBLE-runs work — a released task re-enters the claimable pool; whether
   * the lost member's in-flight side effect completed is a separate question the side-effect ledger
   * answers (SS-05), not this.
   */
  reclaimTasks(tasks: TaskGraph, lostMemberId: string, actor: Actor): number[] {
    const reclaimed: number[] = [];
    for (const task of tasks.list()) {
      if (
        task.owner === lostMemberId &&
        (task.status === 'claimed' || task.status === 'in-progress')
      ) {
        tasks.release(task.id, actor);
        reclaimed.push(task.id);
      }
    }
    return reclaimed;
  }
}
