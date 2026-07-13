import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ThreadId } from '@qwen-harness/protocol';
import { EventStore } from '@qwen-harness/storage';
import { ManualClock, SequentialIds } from '@qwen-harness/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { teamThreadId, type LeadSummary } from '@qwen-harness/cli';

/**
 * CHECKPOINT-10 GOLDEN PATH 5 — TEAM EXECUTION.
 *
 * "lead creates dependent tasks, launches isolated teammates/worktrees, handles permission and plan
 *  approvals, resolves concurrent claiming, receives background results, and shuts down cleanly."
 *
 * The proof is NOT in-process. The test spawns the real CLI `main()` (built `@qwen-harness/cli`) as a
 * LEAD in a separate OS process; that lead in turn spawns each TEAMMATE as its OWN separate process in
 * its OWN git worktree (via `team-worker.mjs`). Teammates claim DEPENDENT tasks concurrently through
 * the durable `tasks` TaskStore's atomic claim — two teammates cannot both win one task — and do real
 * sandboxed work inside their isolated worktrees. Plan/permission approvals round-trip over the
 * durable protocol bus. Time is injected so nothing depends on wall-clock ordering; the orchestration,
 * the process isolation, the worktrees, and the managed ceiling are all the production paths.
 *
 * What each test PROVES by REAL execution:
 *   - full path: N REAL teammate processes claim 4 DEPENDENT tasks with NO collision (exactly one
 *     work-result per task), each works in its OWN worktree (files land there, never in the lead
 *     workspace), plan reject→revise→approve and a permission bubble both round-trip, the lead
 *     receives every result, and the team shuts down clean — no orphan process, no leaked worktree.
 *   - ceiling: under a managed `maxProfile: plan`, a teammate is CLAMPED to plan and its sandboxed
 *     shell is DENIED — a teammate's authority can never exceed the lead's / managed ceiling.
 *   - status: after a clean run, `team status` reconstructs every member as `stopped` from the
 *     durable log — a finished process is never reported running (AG-13).
 */

const WORKER = fileURLToPath(new URL('./team-worker.mjs', import.meta.url));
const EVALS_DIR = fileURLToPath(new URL('..', import.meta.url));

const NOW = 1_700_000_040_000;

interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(
  workCwd: string,
  args: readonly string[],
  managedPath?: string,
): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [WORKER, workCwd, String(NOW), managedPath ?? '-', ...args],
      { cwd: EVALS_DIR, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

function lastJson<T>(result: CliResult): T {
  const line = result.stdout.trim().split('\n').filter(Boolean).at(-1);
  if (line === undefined) throw new Error(`no JSON output; stderr=${result.stderr}`);
  return JSON.parse(line) as T;
}

/** Count the RAW durable result records for a team — one per work attempt (proves no double-run). */
function rawResultRecords(workCwd: string, team: string): { taskId: number; ok: boolean }[] {
  const store = new EventStore({
    path: join(workCwd, '.qwen-harness', 'sessions.sqlite'),
    clock: new ManualClock(NOW),
    ids: new SequentialIds(),
  });
  try {
    const out: { taskId: number; ok: boolean }[] = [];
    for (const event of store.readThread(teamThreadId(team) as ThreadId)) {
      if (event.payload.type !== 'side-effect-intent') continue;
      const action = event.payload.intent.normalizedAction;
      const prefix = 'team-result:v1:';
      if (!action.startsWith(prefix)) continue;
      const parsed = JSON.parse(action.slice(prefix.length)) as { taskId: number; ok: boolean };
      out.push({ taskId: parsed.taskId, ok: parsed.ok });
    }
    return out;
  } finally {
    store.close();
  }
}

function gitWorktreeCount(repoRoot: string): number {
  const out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return out.split('\n').filter((l) => l.startsWith('worktree ')).length;
}

describe('checkpoint-10 golden path 5: team execution (real processes, isolated worktrees)', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'qh-team-'));
    // A real git repo with a base commit, so worktrees can branch from HEAD.
    const git = (...a: string[]): void => {
      execFileSync('git', a, { cwd: repo, stdio: ['ignore', 'ignore', 'ignore'] });
    };
    git('init', '--quiet', '--initial-branch=main');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'user.name', 'Fixture');
    git('config', 'core.hooksPath', '/dev/null');
    writeFileSync(join(repo, 'README.md'), '# team fixture\n');
    git('add', '-A');
    git('commit', '--quiet', '-m', 'base');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  // -------------------------------------------------------------------------------------------
  // The full golden path.
  // -------------------------------------------------------------------------------------------
  it('lead + 3 real teammates: dependent tasks, isolated worktrees, approvals, no collision, clean shutdown', async () => {
    const tasks = JSON.stringify([
      { subject: 't1' },
      { subject: 't2' },
      { subject: 'R:t3', blockedBy: [1] }, // plan reject→revise→approve; depends on t1
      { subject: 'P:t4', blockedBy: [2] }, // permission bubble; depends on t2
    ]);

    const run = await runCli(repo, [
      'team',
      'run',
      '--team',
      'alpha',
      '--members',
      '3',
      '--tasks',
      tasks,
      '--profile',
      'auto-accept-edits',
      '--json',
    ]);
    expect(run.code, `stderr=${run.stderr}`).toBe(0);
    const summary = lastJson<LeadSummary>(run);

    // Dependent tasks were all created and all completed.
    expect(summary.tasksCreated).toBe(4);
    expect(summary.tasksCompleted).toBe(4);

    // Concurrent claiming with NO collision: exactly one work-result per task, every one succeeded.
    const raw = rawResultRecords(repo, 'alpha');
    expect(raw).toHaveLength(4);
    expect(raw.every((r) => r.ok)).toBe(true);
    expect([...new Set(raw.map((r) => r.taskId))].sort()).toEqual([1, 2, 3, 4]);

    // The lead RECEIVED every result.
    expect(summary.results).toHaveLength(4);
    expect(summary.results.every((r) => r.ok)).toBe(true);

    // Isolation: every result file landed in its teammate's worktree, never in the lead workspace.
    expect(summary.isolationVerified).toBe(true);
    expect(existsSync(join(repo, 'results'))).toBe(false);

    // Plan + permission approvals both round-tripped (AG-09 / PS-09).
    expect(summary.plansRejected).toBeGreaterThanOrEqual(1);
    expect(summary.plansApproved).toBeGreaterThanOrEqual(4);
    expect(summary.permissionsGranted).toBeGreaterThanOrEqual(1);

    // The managed ceiling clamped each teammate — never widened above the lead's request.
    expect(summary.members).toHaveLength(3);
    expect(summary.members.every((m) => m.grantedProfile === 'auto-accept-edits')).toBe(true);

    // Clean shutdown: every child exited 0, and NO worktree leaked.
    expect(summary.cleanShutdown).toBe(true);
    expect(summary.worktreesLeaked).toBe(0);
    expect(summary.members.every((m) => m.exitCode === 0)).toBe(true);
    expect(summary.members.every((m) => m.worktreeRemoved)).toBe(true);

    // Independently: git agrees no team worktree survives — only the main working tree remains.
    expect(gitWorktreeCount(repo)).toBe(1);
  });

  // -------------------------------------------------------------------------------------------
  // The managed ceiling binds a teammate exactly as it binds the lead.
  // -------------------------------------------------------------------------------------------
  it('a teammate cannot exceed the managed ceiling: a plan clamp DENIES the sandboxed work', async () => {
    const planManaged = join(repo, 'managed-plan.json');
    writeFileSync(planManaged, JSON.stringify({ version: 1, maxProfile: 'plan' }));

    const run = await runCli(
      repo,
      [
        'team',
        'run',
        '--team',
        'beta',
        '--members',
        '1',
        '--tasks',
        JSON.stringify([{ subject: 't1' }]),
        // The teammate REQUESTS the widest profile; the managed ceiling must still clamp it to plan.
        '--profile',
        'auto-accept-edits',
        '--teammate-profile',
        'yolo',
        '--json',
      ],
      planManaged,
    );
    // The RUN itself completes cleanly; the denial is in the result, not a crash.
    expect(run.code, `stderr=${run.stderr}`).toBe(0);
    const summary = lastJson<LeadSummary>(run);

    // The teammate was clamped to plan (never the requested yolo, never the lead's auto-accept-edits).
    expect(summary.members[0]?.grantedProfile).toBe('plan');

    // Its sandboxed shell was DENIED by the ceiling — the work did not run and no file was written.
    expect(summary.results).toHaveLength(1);
    expect(summary.results[0]?.ok).toBe(false);
    expect(summary.results[0]?.detail ?? '').toMatch(/plan|denied/i);
    expect(summary.isolationVerified).toBe(false);
    expect(existsSync(join(repo, 'results'))).toBe(false);

    // Even a denied-work run shuts down cleanly and leaks no worktree.
    expect(summary.cleanShutdown).toBe(true);
    expect(summary.worktreesLeaked).toBe(0);
    expect(gitWorktreeCount(repo)).toBe(1);
  });

  // -------------------------------------------------------------------------------------------
  // `team status` reconstructs member state from the durable log — a dead process is never running.
  // -------------------------------------------------------------------------------------------
  it('team status shows every finished member as stopped after a clean run (AG-13)', async () => {
    const run = await runCli(repo, [
      'team',
      'run',
      '--team',
      'gamma',
      '--members',
      '2',
      '--tasks',
      JSON.stringify([{ subject: 't1' }, { subject: 't2' }]),
      '--profile',
      'auto-accept-edits',
      '--json',
    ]);
    expect(run.code, `stderr=${run.stderr}`).toBe(0);

    // A FRESH process reconstructs the roster from the durable log: no incarnation is `running`.
    const status = await runCli(repo, ['team', 'status', '--team', 'gamma', '--json']);
    expect(status.code).toBe(0);
    const parsed = lastJson<{ members: { member: string; state: string }[] }>(status);
    expect(parsed.members).toHaveLength(2);
    expect(parsed.members.every((m) => m.state === 'stopped')).toBe(true);
  });
});
