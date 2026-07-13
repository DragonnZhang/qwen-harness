import type { ProtocolMessage } from './protocol.ts';

/**
 * A teammate inbox (AG-06). Writes and reads are atomic, ordered, and idempotent, and a write to a
 * sleeping teammate wakes it.
 *
 * Idempotency is by message id: delivering the same message twice (a retry, a duplicate from a
 * reconnect) leaves the inbox unchanged. Ordering is by a monotonic sequence, so a teammate reads
 * messages in the order they were sent. The lead injects ordinary messages only AFTER protocol
 * handling — that ordering is the caller's responsibility; the inbox just preserves what it is given.
 */

export interface InboxEntry {
  readonly id: string;
  readonly seq: number;
  readonly from: string;
  readonly message: ProtocolMessage;
  readonly deliveredAt: number;
}

export class Inbox {
  readonly #entries: InboxEntry[] = [];
  readonly #seen = new Set<string>();
  #seq = 0;
  #wake: (() => void) | null = null;

  /**
   * Deliver a message. Idempotent by id — a duplicate is dropped and returns false. A real delivery
   * appends in order and wakes a sleeping reader.
   */
  deliver(id: string, from: string, message: ProtocolMessage, now: number): boolean {
    if (this.#seen.has(id)) return false;
    this.#seen.add(id);
    this.#entries.push({ id, seq: this.#seq++, from, message, deliveredAt: now });
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
    return true;
  }

  /** Drain all pending messages in order. */
  drain(): InboxEntry[] {
    const out = this.#entries.splice(0, this.#entries.length);
    return out;
  }

  peek(): readonly InboxEntry[] {
    return this.#entries;
  }

  get pending(): number {
    return this.#entries.length;
  }

  /**
   * Wait until a message arrives (or resolve immediately if one is already pending). This is how a
   * teammate sleeps in its IDLE phase without busy-waiting; a `deliver` wakes it.
   */
  waitForMessage(signal?: AbortSignal): Promise<void> {
    if (this.#entries.length > 0) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(new Error('aborted'));
    return new Promise<void>((resolve, reject) => {
      this.#wake = resolve;
      signal?.addEventListener(
        'abort',
        () => {
          this.#wake = null;
          reject(new Error('aborted'));
        },
        { once: true },
      );
    });
  }
}
