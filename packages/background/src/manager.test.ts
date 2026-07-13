import { describe, expect, it } from 'vitest';

import { defaultAuthority, NO_MANAGED_RESTRICTIONS } from '@qwen-harness/policy';
import type { Actor, ActorId } from '@qwen-harness/protocol';
import { ManualClock, SequentialIds } from '@qwen-harness/testkit';

import {
  BackgroundManager,
  BLOCKED_AFTER_MS,
  INPUT_WATCHDOG_MS,
  OUTPUT_PREVIEW_BYTES,
  OUTPUT_WARN_BYTES,
  type StartInput,
} from './manager.ts';
import { FakeRunner } from '../test/fake-runner.ts';

const BASE = 1_700_000_040_000;
const OWNER: Actor = { kind: 'model', id: 'act_model1' as ActorId };
const AUTHORITY = defaultAuthority('ask', '/repo', NO_MANAGED_RESTRICTIONS);

function setup(): { manager: BackgroundManager; runner: FakeRunner; clock: ManualClock } {
  const clock = new ManualClock(BASE);
  const runner = new FakeRunner();
  const manager = new BackgroundManager({ clock, ids: new SequentialIds(), runner });
  return { manager, runner, clock };
}

function startInput(over: Partial<StartInput> = {}): StartInput {
  return {
    category: 'local-shell',
    owner: OWNER,
    permissionContext: AUTHORITY,
    ...over,
  };
}

describe('BackgroundManager start (BG-02)', () => {
  it('returns a unique id and a status snapshot immediately', () => {
    const { manager, runner } = setup();
    const task = manager.start(startInput({ placement: 'background', toolCallId: 'call_abc' }));
    expect(task.id).toMatch(/^bgt_/);
    expect(task.status).toBe('running');
    expect(task.permissionContext.profile).toBe('ask');
    expect(task.owner).toEqual(OWNER);
    expect(runner.started(task.id)).toBe(true);
  });
});

describe('BackgroundManager lifecycle state machine (BG-02/BG-05)', () => {
  it('runs, requests input, resumes, and completes', async () => {
    const { manager, runner } = setup();
    const task = manager.start(startInput({ placement: 'background' }));

    runner.emitOutput(task.id, 'working...');
    expect(manager.get(task.id)?.outputPreview).toBe('working...');

    runner.requestInput(task.id, { prompt: 'continue?' });
    expect(manager.get(task.id)?.status).toBe('awaiting_input');
    expect(manager.get(task.id)?.lastInputRequest?.prompt).toBe('continue?');

    manager.provideInput(task.id, 'yes');
    expect(manager.get(task.id)?.status).toBe('running');
    expect(runner.inputs(task.id)).toEqual(['yes']);

    const done = manager.awaitTask(task.id);
    runner.exit(task.id, { ok: true, code: 0 });
    expect(manager.get(task.id)?.status).toBe('succeeded');
    await expect(done).resolves.toMatchObject({ status: 'succeeded' });
  });

  it('cancels a running task and cleans up', () => {
    const { manager, runner } = setup();
    const task = manager.start(startInput({ placement: 'background' }));
    manager.stop(task.id);
    expect(manager.get(task.id)?.status).toBe('cancelled');
    expect(runner.cancelled(task.id)).toBe(true);
    // Cancelling again is a no-op (idempotent cleanup).
    expect(() => manager.stop(task.id)).not.toThrow();
  });
});

describe('completion notification (BG-04)', () => {
  it('emits a NEW attributed event, never the tool-call id, and is idempotent on a duplicate exit', () => {
    const { manager, runner } = setup();
    const task = manager.start(startInput({ placement: 'background', toolCallId: 'call_orig' }));

    runner.exit(task.id, { ok: true, code: 0 });
    // A duplicate exit for an already-settled task must have no second effect.
    runner.exit(task.id, { ok: true, code: 0 });

    const completions = manager.notifications
      .drain()
      .filter((n) => n.kind === 'background-completion' && n.subjectId === task.id);
    expect(completions).toHaveLength(1);
    const completion = completions[0];
    expect(completion?.id).toMatch(/^ntf_/);
    expect(completion?.id).not.toBe('call_orig');
    expect(completion?.id).not.toBe(task.id);
  });

  it('classifies a failure as a level-2 task-failure notification', () => {
    const { manager, runner } = setup();
    const task = manager.start(startInput({ placement: 'background' }));
    runner.exit(task.id, { ok: false, code: 1, reason: 'boom' });
    const failures = manager.notifications.drain().filter((n) => n.subjectId === task.id);
    expect(failures.some((n) => n.kind === 'task-failure' && n.level === 2)).toBe(true);
    expect(manager.get(task.id)?.status).toBe('failed');
  });
});

describe('four-way foreground concurrency (BG-05)', () => {
  it('runs four foreground tasks and queues a fifth until a slot frees (FIFO)', () => {
    const { manager, runner } = setup();
    const ids = Array.from(
      { length: 5 },
      () => manager.start(startInput({ placement: 'foreground' })).id,
    );

    // Four run; the fifth is queued and not yet handed to the runner.
    expect(ids.slice(0, 4).map((id) => manager.get(id)?.status)).toEqual(Array(4).fill('running'));
    expect(manager.get(ids[4] as string)?.status).toBe('queued');
    expect(runner.started(ids[4] as string)).toBe(false);

    // Free a slot: the queued task is admitted and launched.
    runner.exit(ids[0] as string, { ok: true, code: 0 });
    expect(manager.get(ids[4] as string)?.status).toBe('running');
    expect(runner.started(ids[4] as string)).toBe(true);
  });

  it('does not gate background tasks on the foreground limit', () => {
    const { manager } = setup();
    const ids = Array.from(
      { length: 6 },
      () => manager.start(startInput({ placement: 'background' })).id,
    );
    expect(ids.every((id) => manager.get(id)?.status === 'running')).toBe(true);
  });
});

describe('input watchdog and blocked transition (BG-05)', () => {
  it('promotes a detected input-wait to awaiting_input after 30s, then blocked after 5 min', () => {
    const { manager, runner, clock } = setup();
    const task = manager.start(startInput({ placement: 'background', approvalChannel: false }));

    runner.detectInputWait(task.id);
    // Before 30s, still running.
    clock.advance(INPUT_WATCHDOG_MS - 1);
    manager.checkWatchdogs(clock.now());
    expect(manager.get(task.id)?.status).toBe('running');

    // At 30s, the watchdog promotes it and requests input (priority-1).
    clock.advance(1);
    manager.checkWatchdogs(clock.now());
    expect(manager.get(task.id)?.status).toBe('awaiting_input');
    expect(manager.notifications.peekLevel()).toBe(1);

    // Five minutes with no approval channel -> blocked (never guessed/auto-approved).
    clock.advance(BLOCKED_AFTER_MS);
    manager.checkWatchdogs(clock.now());
    expect(manager.get(task.id)?.status).toBe('blocked');
  });

  it('immediately enters awaiting_input on a typed input request', () => {
    const { manager, runner } = setup();
    const task = manager.start(startInput({ placement: 'background' }));
    runner.requestInput(task.id, { prompt: 'name?' });
    expect(manager.get(task.id)?.status).toBe('awaiting_input');
    expect(manager.notifications.peekLevel()).toBe(1);
  });
});

describe('output limits and preview (BG-05)', () => {
  it('bounds the inline preview and flags truncation while counting total bytes', () => {
    const { manager, runner } = setup();
    const task = manager.start(startInput({ placement: 'background' }));
    runner.emitOutput(task.id, 'x'.repeat(OUTPUT_PREVIEW_BYTES + 5_000));
    const view = manager.get(task.id);
    expect(view?.outputPreview.length).toBe(OUTPUT_PREVIEW_BYTES);
    expect(view?.outputTruncated).toBe(true);
    expect(view?.outputBytes).toBe(OUTPUT_PREVIEW_BYTES + 5_000);
    expect(view?.outputRef).toBe(`bgout_${task.id}`);
  });

  it('warns once past the 10 MiB threshold', () => {
    const { manager, runner } = setup();
    const task = manager.start(startInput({ placement: 'background' }));
    runner.emitOutput(task.id, 'y'.repeat(OUTPUT_WARN_BYTES));
    expect(manager.get(task.id)?.outputWarned).toBe(true);
  });
});
