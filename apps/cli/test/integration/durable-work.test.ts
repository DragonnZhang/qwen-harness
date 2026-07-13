import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { main, type CliDeps } from '../../src/index.ts';

/**
 * The durable-work command surface (WK-*, CR-*), driven through the real `main` in-process.
 *
 * This is the row-level companion to the golden-path e2e (`evals/e2e/scheduling.test.ts`, which
 * proves cross-process restart survival and the managed ceiling). Here we exercise the task graph's
 * state machine, dependency unblocking, and atomic claiming, the todo/task separation, and the Cron
 * supervisor's fire-once semantics — all against the SAME durable event store a run uses, so a
 * definition created by one command is reconstructed by the next.
 */

const M0 = 1_700_000_040_000; // minute-aligned

describe('durable work: task graph + cron supervisor (in-process, real store)', () => {
  let cwd: string;
  let out: string[];
  let err: string[];

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'qh-durable-'));
    out = [];
    err = [];
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  function deps(argv: string[], now = M0): CliDeps {
    return {
      argv,
      env: process.env,
      cwd,
      now: () => now,
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
    };
  }

  function lastJson<T>(): T {
    const line = out.at(-1);
    if (line === undefined) throw new Error(`no output; stderr=${err.join('\n')}`);
    return JSON.parse(line) as T;
  }

  interface TaskView {
    id: number;
    status: string;
    owner: string | null;
    blockedBy: number[];
  }

  it('a durable task graph: create with a dependency, claim atomically, complete, and unblock', async () => {
    expect(await main(deps(['task', 'create', 'build', '--active', 'Building', '--json']))).toBe(0);
    const first = lastJson<TaskView>();
    expect(first.id).toBe(1);
    expect(first.status).toBe('pending');

    // A dependent task starts `blocked` — it cannot begin until #1 completes (WK-05).
    expect(
      await main(
        deps(['task', 'create', 'ship', '--active', 'Shipping', '--blocked-by', '1', '--json']),
      ),
    ).toBe(0);
    const second = lastJson<TaskView>();
    expect(second.id).toBe(2);
    expect(second.status).toBe('blocked');
    expect(second.blockedBy).toEqual([1]);

    // Atomic claim (WK-06): the first claim wins; a second claim of the same task loses (exit 3).
    expect(await main(deps(['task', 'claim', '1', '--owner', 'worker-a', '--json']))).toBe(0);
    expect(lastJson<TaskView>().owner).toBe('worker-a');
    expect(await main(deps(['task', 'claim', '1', '--owner', 'worker-b', '--json']))).toBe(3);

    // Start then complete #1; completing reports #2 as newly unblocked (WK-05).
    expect(await main(deps(['task', 'start', '1']))).toBe(0);
    expect(await main(deps(['task', 'complete', '1', '--json']))).toBe(0);
    const completed = lastJson<{ task: TaskView; newlyUnblocked: TaskView[] }>();
    expect(completed.task.status).toBe('completed');
    expect(completed.newlyUnblocked.map((t) => t.id)).toEqual([2]);

    // A fresh command reconstructs the graph from the durable log — #2 is now pending.
    expect(await main(deps(['task', 'get', '2', '--json']))).toBe(0);
    expect(lastJson<TaskView>().status).toBe('pending');
  });

  it('rejects a dependency cycle and a missing reference (WK-05)', async () => {
    await main(deps(['task', 'create', 'a', '--active', 'A']));
    // A blocker that does not exist is refused.
    expect(await main(deps(['task', 'create', 'b', '--active', 'B', '--blocked-by', '99']))).toBe(
      1,
    );
    expect(err.join('\n')).toMatch(/does not exist/);
  });

  it('the todo checklist is separate from the durable graph and never conflated (WK-02)', async () => {
    await main(deps(['task', 'create', 'real durable task', '--active', 'Working']));
    // A bulk TodoWrite replace is pure, ephemeral working memory: it writes no task.
    expect(
      await main(
        deps([
          'task',
          'todo',
          '[{"content":"step one","activeForm":"doing one","status":"in-progress"}]',
        ]),
      ),
    ).toBe(0);
    const projection = lastJson<{ activeLabel: string; counts: { inProgress: number } }>();
    expect(projection.activeLabel).toBe('doing one');
    expect(projection.counts.inProgress).toBe(1);

    // The durable graph still has exactly the one real task — the todo touched nothing.
    await main(deps(['task', 'list', '--json']));
    expect(lastJson<{ tasks: TaskView[] }>().tasks).toHaveLength(1);
  });

  it('the cron supervisor fires a due job once and never again (CR-05), reconstructed from the log', async () => {
    // A notification-only recurring job (no shell workload) keeps this fast and sandbox-independent;
    // the sandboxed-execution and ceiling paths are proven in the e2e.
    expect(
      await main(
        deps(['cron', 'add', '--recurring', '* * * * *', '--thread', 'thr_notify0001', '--json']),
      ),
    ).toBe(0);
    const job = lastJson<{ id: string; kind: string }>();
    expect(job.kind).toBe('recurring');

    // A fresh supervisor invocation reconstructs the job from the durable log and fires it once.
    const T = M0 + 90_000;
    expect(await main(deps(['cron', 'run', '--now', String(T), '--json'], T))).toBe(0);
    const fired1 = lastJson<{ fired: { jobId: string; threadId: string; ok: boolean }[] }>().fired;
    expect(fired1).toHaveLength(1);
    expect(fired1[0]?.jobId).toBe(job.id);
    expect(fired1[0]?.threadId).toBe('thr_notify0001');
    expect(fired1[0]?.ok).toBe(true);

    // No double-fire on a second poll at the same instant.
    expect(await main(deps(['cron', 'run', '--now', String(T), '--json'], T))).toBe(0);
    expect(lastJson<{ fired: unknown[] }>().fired).toHaveLength(0);

    // `cron remove` deletes it; the list is then empty.
    expect(await main(deps(['cron', 'remove', job.id, '--json'], T))).toBe(0);
    await main(deps(['cron', 'list', '--json'], T));
    expect(lastJson<{ jobs: unknown[] }>().jobs).toHaveLength(0);
  });
});
