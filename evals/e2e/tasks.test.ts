import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main, type CliDeps } from '@qwen-harness/cli';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Durable tasks vs legacy todos, end to end through the REAL CLI (WK-02).
 *
 * The two systems must NOT be conflated: the durable dependency graph (`task create/claim/complete`)
 * persists and drives blocking; the legacy `task todo` write is a turn-local checklist projection that
 * NEVER touches the durable graph. This golden task drives both through `main()` and proves a bulk
 * `todo` write leaves the durable graph exactly as it was, then that completing a dependency unblocks
 * its dependent.
 */

interface TaskView {
  id: number;
  status: string;
  owner: string | null;
  blockedBy: number[];
}

describe('durable tasks vs legacy todos (WK-02)', () => {
  let cwd: string;
  let out: string[];

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'qh-tasks-e2e-'));
    out = [];
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  const deps = (argv: string[]): CliDeps => ({
    argv,
    env: {},
    cwd,
    now: () => 1_700_000_000_000,
    stdout: (l) => out.push(l),
    stderr: () => {},
  });

  const lastJson = <T>(): T => JSON.parse(out.at(-1)!) as T;

  it('a durable dependency graph; a bulk todo write mutates NO durable task; completing unblocks', async () => {
    // Durable graph: task 2 depends on task 1.
    expect(await main(deps(['task', 'create', 'build', '--active', 'Building', '--json']))).toBe(0);
    expect(lastJson<TaskView>().id).toBe(1);
    expect(
      await main(
        deps(['task', 'create', 'ship', '--active', 'Shipping', '--blocked-by', '1', '--json']),
      ),
    ).toBe(0);
    expect(lastJson<TaskView>().blockedBy).toEqual([1]);

    // A legacy TodoWrite: a turn-local checklist that must NOT create a durable task.
    out = [];
    expect(
      await main(
        deps([
          'task',
          'todo',
          JSON.stringify([{ content: 'read code', activeForm: 'Reading code' }]),
        ]),
      ),
    ).toBe(0);

    // The durable graph is unchanged — still exactly the two tasks, not conflated with the todo.
    out = [];
    await main(deps(['task', 'list', '--json']));
    const listed = lastJson<{ tasks: TaskView[] }>();
    const tasks = Array.isArray(listed) ? (listed as unknown as TaskView[]) : listed.tasks;
    expect(tasks.map((t) => t.id).sort()).toEqual([1, 2]);

    // Completing the dependency unblocks its dependent.
    out = [];
    expect(await main(deps(['task', 'claim', '1', '--owner', 'w', '--json']))).toBe(0);
    await main(deps(['task', 'start', '1']));
    out = [];
    expect(await main(deps(['task', 'complete', '1', '--json']))).toBe(0);
    const completed = lastJson<{ task: TaskView; newlyUnblocked: TaskView[] }>();
    expect(completed.task.status).toBe('completed');
    expect(completed.newlyUnblocked.map((t) => t.id)).toEqual([2]);
    // A fresh command reconstructs the graph from the durable log — task 2 is now pending (unblocked).
    out = [];
    await main(deps(['task', 'get', '2', '--json']));
    expect(lastJson<TaskView>().status).toBe('pending');
  });
});
