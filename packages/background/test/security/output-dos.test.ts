import { NO_MANAGED_RESTRICTIONS, defaultAuthority } from '@qwen-harness/policy';
import type { Actor, ActorId } from '@qwen-harness/protocol';
import { ManualClock, SequentialIds } from '@qwen-harness/testkit';
import { describe, expect, it } from 'vitest';

import { BackgroundManager, type StartInput } from '../../src/index.ts';
import { FakeRunner } from '../fake-runner.ts';

/**
 * A runaway task cannot exhaust the host via unbounded output (BG-05, S).
 *
 * The output ceiling is a resource-exhaustion defense: a task that floods output — whether buggy or
 * adversarial — is FORCE-stopped at the limit, not allowed to fill memory or disk. The ceiling is
 * injected small here so the DoS behavior is provable without actually producing gigabytes; in
 * production it is the frozen 5 GiB default.
 */

const OWNER: Actor = { kind: 'user', id: 'act_user' as ActorId, label: 'user' };
const AUTHORITY = defaultAuthority('ask', '/workspace', NO_MANAGED_RESTRICTIONS);

function managerWithCeiling(hardStopBytes: number): {
  manager: BackgroundManager;
  runner: FakeRunner;
} {
  const runner = new FakeRunner();
  const manager = new BackgroundManager({
    clock: new ManualClock(0),
    ids: new SequentialIds(),
    runner,
    hardStopBytes,
  });
  return { manager, runner };
}

const start = (manager: BackgroundManager): StartInput & { id: string } => {
  const task = manager.start({
    category: 'local-shell',
    owner: OWNER,
    permissionContext: AUTHORITY,
    placement: 'background',
  });
  return { category: 'local-shell', owner: OWNER, permissionContext: AUTHORITY, id: task.id };
};

describe('output-flood DoS is hard-stopped (BG-05, S)', () => {
  it('a task that floods output past the ceiling is force-stopped and settled failed', async () => {
    const { manager, runner } = managerWithCeiling(100);
    const { id } = start(manager);
    const done = manager.awaitTask(id);

    // The adversarial flood: far more output than the ceiling allows.
    runner.emitOutput(id, 'x'.repeat(500));

    // Force-stopped: cancelled at the runner and settled as a failure — never left running to fill up.
    expect(manager.get(id)?.status).toBe('failed');
    expect(runner.cancelled(id)).toBe(true);
    await expect(done).resolves.toMatchObject({ status: 'failed' });
  });

  it('output UNDER the ceiling keeps the task running — no false positive', () => {
    const { manager, runner } = managerWithCeiling(1000);
    const { id } = start(manager);
    runner.emitOutput(id, 'y'.repeat(200)); // well under 1000
    expect(manager.get(id)?.status).toBe('running');
    expect(runner.cancelled(id)).toBe(false);
  });
});
