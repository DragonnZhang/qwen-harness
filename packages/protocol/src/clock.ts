/**
 * Time is an interface, never an ambient call.
 *
 * `protocol` must open no clock I/O, and the runtime must be replayable (RT-08). Both fall out of
 * the same rule: nothing in the product calls `Date.now()` directly. It asks a `Clock`.
 * Tests inject a deterministic clock; production injects the system one from an I/O-owning layer.
 */
export interface Clock {
  now(): number;
  /** Resolves after `ms`. Cancellable, because every wait must join the abort tree (RT-06). */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** A clock whose time only ever moves when a test moves it. */
export class ManualClock implements Clock {
  #now: number;
  #timers: {
    at: number;
    resolve: () => void;
    reject: (e: unknown) => void;
    signal?: AbortSignal;
  }[] = [];

  constructor(startMs = 0) {
    this.#now = startMs;
  }

  now(): number {
    return this.#now;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error('aborted'));
    return new Promise<void>((resolve, reject) => {
      const entry = {
        at: this.#now + ms,
        resolve,
        reject,
        ...(signal ? { signal } : {}),
      };
      this.#timers.push(entry);
      signal?.addEventListener(
        'abort',
        () => {
          this.#timers = this.#timers.filter((t) => t !== entry);
          reject(new Error('aborted'));
        },
        { once: true },
      );
    });
  }

  /** Advance time and fire every timer that is now due, in due order. */
  advance(ms: number): void {
    this.#now += ms;
    const due = this.#timers.filter((t) => t.at <= this.#now).sort((a, b) => a.at - b.at);
    this.#timers = this.#timers.filter((t) => t.at > this.#now);
    for (const t of due) t.resolve();
  }

  get pendingTimers(): number {
    return this.#timers.length;
  }
}
