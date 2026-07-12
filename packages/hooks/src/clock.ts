/**
 * A real-time `Clock` for production wiring of the engine.
 *
 * `protocol` defines `Clock` as an interface and ships `ManualClock` for deterministic tests. The
 * engine bounds every handler with `clock.sleep`, so a real deployment needs a real clock. This is
 * the only place in `hooks` that reads wall-clock time, and it opens no host capability the
 * architecture gate cares about (timers are compute, not I/O).
 */
import type { Clock } from '@qwen-harness/protocol';
import { setTimeout as sleep } from 'node:timers/promises';

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }

  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    // `AbortError` propagates so a cancelled wait rejects rather than resolving early.
    await sleep(ms, undefined, signal ? { signal } : undefined);
  }
}

/** One shared instance is safe; the clock holds no state. */
export const systemClock = new SystemClock();
