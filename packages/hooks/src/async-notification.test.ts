import { ManualClock } from '@qwen-harness/protocol';
import { describe, expect, it } from 'vitest';

import { HookEngine } from './engine.ts';
import { HookOutcomes } from './outcome.ts';
import { HookRegistry } from './registry.ts';

/**
 * Hook handlers support ASYNC NOTIFICATION (HK-02).
 *
 * `Notification` is a first-class hook event, and the engine dispatches every hook asynchronously
 * (handlers return promises the engine awaits). So a hook can register on `Notification` and run —
 * asynchronously, in deterministic order with all the other handler machinery — when a notification
 * occurs. This is the HANDLER-side support the row names; which components FIRE the event is HK-01's
 * concern (event coverage), tracked separately. A notification hook does not fold a permission
 * decision: it observes and may add context, never silently allow.
 */

describe('a hook can handle the Notification event, asynchronously (HK-02)', () => {
  it('runs an async handler registered on Notification, in order, without changing the decision', async () => {
    const registry = new HookRegistry();
    const engine = new HookEngine({
      registry,
      clock: new ManualClock(),
      defaultTimeoutMs: 1_000,
    });

    const order: string[] = [];
    // Two notification hooks — the second is genuinely async (awaits before recording).
    registry.register({
      id: 'notify-a',
      event: 'Notification',
      priority: 0,
      handler: {
        kind: 'function',
        run: () => {
          order.push('a');
          return HookOutcomes.continue();
        },
      },
    });
    registry.register({
      id: 'notify-b',
      event: 'Notification',
      priority: 1,
      handler: {
        kind: 'function',
        run: async () => {
          await Promise.resolve();
          order.push('b');
          return HookOutcomes.context('background task finished');
        },
      },
    });

    const res = await engine.run(
      'Notification',
      { message: 'a background task completed' },
      { currentDecision: 'allow' },
    );

    // Both notification handlers ran, in deterministic (priority) order — the async one awaited.
    expect(order).toEqual(['a', 'b']);
    expect(res.ranHandlers).toBe(2);
    // A notification is observational: it never silently flips the decision.
    expect(res.decision).toBe('allow');
    expect(res.blocked).toBe(false);
  });

  it('a Notification hook matched by content runs only when the matcher fits', async () => {
    const registry = new HookRegistry();
    const engine = new HookEngine({ registry, clock: new ManualClock(), defaultTimeoutMs: 1_000 });
    let ran = false;
    registry.register({
      id: 'only-failures',
      event: 'Notification',
      matcher: { toolName: 'task-failed' },
      handler: {
        kind: 'function',
        run: () => {
          ran = true;
          return HookOutcomes.continue();
        },
      },
    });
    // A non-matching notification does not run the hook...
    await engine.run('Notification', { toolName: 'task-succeeded' }, { currentDecision: 'allow' });
    expect(ran).toBe(false);
    // ...a matching one does.
    await engine.run('Notification', { toolName: 'task-failed' }, { currentDecision: 'allow' });
    expect(ran).toBe(true);
  });
});
