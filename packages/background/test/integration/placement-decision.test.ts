import { describe, expect, it } from 'vitest';

import { defaultAuthority, NO_MANAGED_RESTRICTIONS } from '@qwen-harness/policy';
import type { CorrelationId, ThreadId, TurnId } from '@qwen-harness/protocol';
import { EventStore } from '@qwen-harness/storage';
import { ManualClock, SequentialIds, USER_ACTOR } from '@qwen-harness/testkit';

import { BackgroundManager, eventStoreBackgroundSink } from '../../src/index.ts';
import { FakeRunner } from '../fake-runner.ts';

/**
 * The foreground/background PLACEMENT DECISION (BG-01) exercised on the REAL manager path — a real
 * {@link BackgroundManager} over the REAL EventStore sink, driven by the real classifier. The unit
 * tests cover `classifyForeground` in isolation; this proves the DECISION is what the live lifecycle
 * actually acts on: an explicit placement always wins, and with no explicit choice the only case that
 * detaches to background is long-lived AND non-interactive. Crucially it is NOT a duration guess — the
 * decision is fixed synchronously at `start()`, before any time passes and before the runner reports
 * anything, and depends ONLY on the hint flags.
 */

const THREAD = 'thr_000001' as ThreadId;
const TURN = 'trn_000001' as TurnId;
const CORR = 'cor_000001' as CorrelationId;
const BASE = 1_700_000_050_000;
const AUTHORITY = defaultAuthority('ask', '/repo', NO_MANAGED_RESTRICTIONS);

function newEventStore(): EventStore {
  const store = new EventStore({
    path: ':memory:',
    clock: new ManualClock(BASE),
    ids: new SequentialIds(),
  });
  store.append({
    threadId: THREAD,
    actor: USER_ACTOR,
    correlationId: CORR,
    permissionProfile: 'ask',
    payload: { type: 'thread-created', cwd: '/workspace', canonicalRepo: '/workspace', name: null },
  });
  return store;
}

/** A manager wired to the durable EventStore sink, with a single foreground slot so placement is observable. */
function newManager(store: EventStore): {
  manager: BackgroundManager;
  runner: FakeRunner;
  clock: ManualClock;
} {
  const runner = new FakeRunner();
  const clock = new ManualClock(BASE);
  const sink = eventStoreBackgroundSink({
    store,
    threadId: THREAD,
    turnId: TURN,
    actor: { kind: 'background', id: USER_ACTOR.id },
    correlationId: CORR,
    permissionProfile: 'ask',
    ids: new SequentialIds(),
  });
  const manager = new BackgroundManager({
    clock,
    ids: new SequentialIds(),
    runner,
    sink,
    foregroundConcurrency: 1,
  });
  return { manager, runner, clock };
}

describe('foreground/background placement decision on the real manager (BG-01)', () => {
  it('applies the heuristic: long-lived + non-interactive detaches to background, and it does NOT consume a foreground slot', () => {
    const store = newEventStore();
    const { manager, runner } = newManager(store);

    // A long-lived, non-interactive job (a watch/daemon) — the ONE case safe to background on its own.
    const daemon = manager.start({
      category: 'local-shell',
      owner: USER_ACTOR,
      hint: { longLived: true, interactive: false },
      permissionContext: AUTHORITY,
    });
    expect(daemon.placement).toBe('background');
    // A background task launches immediately (it never queues for the concurrency limit).
    expect(daemon.status).toBe('running');
    expect(runner.started(daemon.id)).toBe(true);

    // The single foreground slot is still FREE — the background decision detached the daemon from the
    // four-way limit. Prove it by filling the slot with a plain foreground job...
    const fg1 = manager.start({
      category: 'local-shell',
      owner: USER_ACTOR,
      permissionContext: AUTHORITY,
    });
    expect(fg1.placement).toBe('foreground');
    expect(fg1.status).toBe('running');

    // ...and a second foreground job must now QUEUE (the daemon did not take the slot; fg1 did).
    const fg2 = manager.start({
      category: 'local-shell',
      owner: USER_ACTOR,
      permissionContext: AUTHORITY,
    });
    expect(fg2.placement).toBe('foreground');
    expect(fg2.status).toBe('queued');
  });

  it('an EXPLICIT placement always wins over a background-leaning hint (not a duration guess)', () => {
    const store = newEventStore();
    const { manager } = newManager(store);

    // Occupy the single foreground slot so a foreground decision is observable as a queue.
    manager.start({ category: 'local-shell', owner: USER_ACTOR, permissionContext: AUTHORITY });

    // Same background-leaning hint as the daemon above, but the caller explicitly said FOREGROUND.
    // If the hint won, this would be background+running; because EXPLICIT wins, it is foreground and
    // must queue behind the busy slot.
    const forced = manager.start({
      category: 'local-shell',
      owner: USER_ACTOR,
      placement: 'foreground',
      hint: { longLived: true, interactive: false },
      permissionContext: AUTHORITY,
    });
    expect(forced.placement).toBe('foreground');
    expect(forced.status).toBe('queued');

    // And the reverse: an explicit BACKGROUND wins over an interactive (foreground-leaning) hint.
    const forcedBg = manager.start({
      category: 'local-shell',
      owner: USER_ACTOR,
      placement: 'background',
      hint: { interactive: true },
      permissionContext: AUTHORITY,
    });
    expect(forcedBg.placement).toBe('background');
    expect(forcedBg.status).toBe('running');
  });

  it('stays FOREGROUND when the hint is not clearly long-lived-and-non-interactive (conservative default)', () => {
    const store = newEventStore();
    const { manager, clock } = newManager(store);

    // Long-lived but INTERACTIVE → foreground (interactive keeps it attached to the user).
    const interactive = manager.start({
      category: 'local-shell',
      owner: USER_ACTOR,
      hint: { longLived: true, interactive: true },
      permissionContext: AUTHORITY,
    });
    expect(interactive.placement).toBe('foreground');

    // NOT long-lived (and no explicit choice) → foreground, regardless of interactivity.
    const store2 = newEventStore();
    const { manager: m2 } = newManager(store2);
    const shortJob = m2.start({
      category: 'local-shell',
      owner: USER_ACTOR,
      hint: { longLived: false },
      permissionContext: AUTHORITY,
    });
    expect(shortJob.placement).toBe('foreground');

    // The decision is fixed at start() from the flags alone — advancing the clock never changes it
    // (there is no duration guess to re-evaluate).
    clock.advance(10 * 60_000);
    expect(manager.get(interactive.id)?.placement).toBe('foreground');
  });
});
