/**
 * The background notification priority queue (BG-05, docs/product/defaults.md).
 *
 * Four priority levels, FIFO within a level, plus anti-starvation: after ten consecutive deliveries
 * that skipped a waiting lower-priority item, the queue forces one lower item through. Without that
 * clause a steady stream of approvals (level 1) could starve status updates (level 4) forever.
 */

/**
 * Notification kinds, grouped by the exact levels frozen in defaults:
 *   1  approval / elicitation / shutdown / security-failure / typed input request
 *   2  task failure/completion, agent/team state, lost remote work
 *   3  ordinary background completion and Cron fire
 *   4  progress and periodic status
 */
export type NotificationKind =
  | 'approval'
  | 'elicitation'
  | 'shutdown'
  | 'security-failure'
  | 'input-request'
  | 'task-failure'
  | 'agent-state'
  | 'team-state'
  | 'lost-remote'
  | 'background-completion'
  | 'cron-fire'
  | 'progress'
  | 'status';

export type NotificationLevel = 1 | 2 | 3 | 4;

export const NOTIFICATION_LEVELS: Record<NotificationKind, NotificationLevel> = {
  approval: 1,
  elicitation: 1,
  shutdown: 1,
  'security-failure': 1,
  'input-request': 1,
  'task-failure': 2,
  'agent-state': 2,
  'team-state': 2,
  'lost-remote': 2,
  'background-completion': 3,
  'cron-fire': 3,
  progress: 4,
  status: 4,
};

export function levelOf(kind: NotificationKind): NotificationLevel {
  return NOTIFICATION_LEVELS[kind];
}

export interface Notification {
  /** A NEW, unique id — never a reused tool-call id (BG-04). */
  readonly id: string;
  readonly kind: NotificationKind;
  readonly level: NotificationLevel;
  /** The task or subject this notification concerns. */
  readonly subjectId: string;
  readonly message: string;
  readonly createdAt: number;
}

/** After this many consecutive higher-priority deliveries, force one waiting lower item through. */
export const STARVATION_THRESHOLD = 10;

const LEVELS: readonly NotificationLevel[] = [1, 2, 3, 4];

/**
 * A four-level FIFO priority queue with anti-starvation. `enqueue` appends to a level; `deliver`
 * returns the next notification to show, honoring priority, FIFO order, and the starvation guard.
 */
export class NotificationQueue {
  readonly #byLevel = new Map<NotificationLevel, Notification[]>([
    [1, []],
    [2, []],
    [3, []],
    [4, []],
  ]);
  /** Consecutive deliveries that skipped a waiting lower-priority item. */
  #consecutiveHigh = 0;

  enqueue(notification: Notification): void {
    this.#queue(notification.level).push(notification);
  }

  get size(): number {
    return LEVELS.reduce((n, level) => n + this.#queue(level).length, 0);
  }

  /** Peek at the level `deliver` would draw from next, without removing anything. */
  peekLevel(): NotificationLevel | null {
    const top = this.#topLevel();
    if (top === null) return null;
    if (this.#consecutiveHigh >= STARVATION_THRESHOLD) {
      const lower = this.#topLevelAbove(top);
      if (lower !== null) return lower;
    }
    return top;
  }

  /**
   * Deliver the next notification, or `null` if empty. Normally the highest-priority (lowest-numbered)
   * non-empty level wins, FIFO within it. But once {@link STARVATION_THRESHOLD} higher-priority
   * deliveries have skipped a waiting lower item, the highest-priority WAITING LOWER item is delivered
   * instead and the counter resets.
   */
  deliver(): Notification | null {
    const top = this.#topLevel();
    if (top === null) return null;

    const lower = this.#topLevelAbove(top);

    if (this.#consecutiveHigh >= STARVATION_THRESHOLD && lower !== null) {
      this.#consecutiveHigh = 0;
      return this.#queue(lower).shift() ?? null;
    }

    // Draw from the top level. If a lower item was waiting, this delivery starved it — count it.
    this.#consecutiveHigh = lower !== null ? this.#consecutiveHigh + 1 : 0;
    return this.#queue(top).shift() ?? null;
  }

  /** Drain every notification in delivery order. */
  drain(): Notification[] {
    const out: Notification[] = [];
    let next = this.deliver();
    while (next !== null) {
      out.push(next);
      next = this.deliver();
    }
    return out;
  }

  #queue(level: NotificationLevel): Notification[] {
    const q = this.#byLevel.get(level);
    // The map is constructed with all four levels, so this is always defined.
    if (!q) throw new Error(`unreachable: missing queue for level ${level}`);
    return q;
  }

  #topLevel(): NotificationLevel | null {
    for (const level of LEVELS) if (this.#queue(level).length > 0) return level;
    return null;
  }

  #topLevelAbove(level: NotificationLevel): NotificationLevel | null {
    for (const candidate of LEVELS) {
      if (candidate > level && this.#queue(candidate).length > 0) return candidate;
    }
    return null;
  }
}
