import type { Clock, IdSource } from '@qwen-harness/protocol';

/**
 * Production `Clock`/`IdSource`. `mcp` is not a pure package, so it MAY touch `Date.now` — but the
 * whole client is written against the injected interfaces so a test can drive it with a
 * `ManualClock` and `SequentialIds` and get a deterministic result (RT-08). These are the boring
 * real implementations the composition root injects.
 */
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error('aborted'));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        },
        { once: true },
      );
    });
  }
}

export class RandomIds implements IdSource {
  next(prefix: string): string {
    // Only used as an opaque, unique suffix; not a security token.
    const rand = Math.random().toString(36).slice(2, 12).padEnd(10, '0');
    return `${prefix}_${rand}`;
  }
}
