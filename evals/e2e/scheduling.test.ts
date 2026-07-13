import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { backgroundIdempotencyKey } from '@qwen-harness/background';
import type { ThreadId } from '@qwen-harness/protocol';
import { EventStore } from '@qwen-harness/storage';
import { ManualClock, SequentialIds } from '@qwen-harness/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * CHECKPOINT-10 GOLDEN PATH 6 — SCHEDULING.
 *
 * "background test and one-shot/recurring Cron survive supported restarts, notify the correct thread,
 *  and obey permission, sandbox, and budget."
 *
 * The proof is not in-process: every scenario drives the REAL CLI (`@qwen-harness/cli` `main`) in a
 * SEPARATE OS process via `scheduling-worker.mjs`, then a DIFFERENT fresh process reconstructs the
 * durable definition from the event log and fires/inspects it. That is a real restart — the first
 * process has fully exited; nothing is held in memory across the boundary. Time is injected so cron
 * minute markers are deterministic, but the durability, reconstruction, sandboxing, and the managed
 * ceiling are all the production paths.
 *
 * What each test PROVES:
 *   - recurring/one-shot Cron: a job created by one process is reconstructed and FIRED by a later
 *     process (survives restart), its firing lands on the OWNER's thread (notifies the correct
 *     thread), and a second identical poll fires nothing (no double-fire — the durable `job-fired`
 *     record + the side-effect ledger both refuse it).
 *   - ceiling: a job whose creation-time ceiling ALLOWS a shell is DENIED at fire time when the
 *     supervisor runs under a managed `maxProfile: plan` — a scheduled job can never exceed the
 *     ceiling (obeys permission), and it goes through the real sandbox/budget pipeline.
 *   - background: a completed background task's RESULT is durable — a fresh process sees it complete
 *     and the ledger refuses to re-run it.
 */

const WORKER = fileURLToPath(new URL('./scheduling-worker.mjs', import.meta.url));
const EVALS_DIR = fileURLToPath(new URL('..', import.meta.url));

/** A minute-aligned instant, so cron markers are exact. 1_700_000_040_000 % 60_000 === 0. */
const M0 = 1_700_000_040_000;
/** The poll instant: past the first recurring marker (M0+60s) and the one-shot (M0+30s). */
const T = M0 + 90_000;

interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(
  workCwd: string,
  now: number,
  args: readonly string[],
  managedPath?: string,
): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [WORKER, workCwd, String(now), managedPath ?? '-', ...args],
      { cwd: EVALS_DIR, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

/** The last non-empty stdout line parsed as JSON — the CLI prints one JSON document under `--json`. */
function lastJson<T>(result: CliResult): T {
  const line = result.stdout.trim().split('\n').filter(Boolean).at(-1);
  if (line === undefined) throw new Error(`no JSON output; stderr=${result.stderr}`);
  return JSON.parse(line) as T;
}

function openDb(workCwd: string): EventStore {
  return new EventStore({
    path: join(workCwd, '.qwen-harness', 'sessions.sqlite'),
    clock: new ManualClock(M0),
    ids: new SequentialIds(),
  });
}

interface Job {
  readonly id: string;
  readonly threadId: string;
}
interface FireOutcome {
  readonly jobId: string;
  readonly threadId: string;
  readonly scheduledInstant: number;
  readonly effectiveProfile: string;
  readonly ok: boolean;
  readonly detail: string | null;
  readonly executed: boolean;
}
interface Supervised {
  readonly fired: readonly FireOutcome[];
}

describe('checkpoint-10 golden path 6: scheduling survives restart and obeys the ceiling', () => {
  let dir: string;
  let planManaged: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qh-sched-'));
    planManaged = join(dir, 'managed-plan.json');
    writeFileSync(planManaged, JSON.stringify({ version: 1, maxProfile: 'plan' }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // -----------------------------------------------------------------------------------------
  // Recurring Cron: create in one process, fire in another, exactly once, on the right thread.
  // -----------------------------------------------------------------------------------------
  it('a recurring job survives a restart, fires once on the owner thread, and never double-fires', async () => {
    const work = join(dir, 'recurring');
    const notify = 'thr_notify0001' as ThreadId;

    // Process 1: create the durable recurring job, then exit.
    const created = await runCli(work, M0, [
      'cron',
      'add',
      '--recurring',
      '* * * * *',
      '--thread',
      notify,
      '--profile',
      'auto-accept-edits',
      '--json',
      '--',
      'node',
      '-e',
      'process.stdout.write("R")',
    ]);
    expect(created.code).toBe(0);
    const job = lastJson<Job>(created);
    expect(job.id).toMatch(/^job_/);

    // Process 2 (a real restart): reconstruct from the log and fire the due instant.
    const run1 = await runCli(work, T, ['cron', 'run', '--now', String(T), '--json']);
    expect(run1.code).toBe(0);
    const fired1 = lastJson<Supervised>(run1).fired;
    expect(fired1).toHaveLength(1);
    expect(fired1[0]?.jobId).toBe(job.id);
    expect(fired1[0]?.threadId).toBe(notify); // notifies the CORRECT thread
    expect(fired1[0]?.ok).toBe(true); // the sandboxed, preapproved command actually ran
    expect(fired1[0]?.executed).toBe(true);
    expect(fired1[0]?.effectiveProfile).toBe('auto-accept-edits');

    // Process 3 (another restart), same instant: the durable `job-fired` + ledger refuse a re-fire.
    const run2 = await runCli(work, T, ['cron', 'run', '--now', String(T), '--json']);
    expect(lastJson<Supervised>(run2).fired).toHaveLength(0);

    // The durable ledger agrees: exactly one firing landed, on the notify thread, and it is complete.
    const store = openDb(work);
    try {
      const notifyFires = store
        .readThread(notify)
        .filter(
          (e) =>
            e.payload.type === 'side-effect-intent' &&
            e.payload.intent.normalizedAction.startsWith(`cron-fire:${job.id}`),
        );
      expect(notifyFires).toHaveLength(1);

      // The firing is NOT on the scheduler's own bookkeeping thread — it went to the owner's thread.
      const schedulerFires = store
        .readThread('thr_cron_scheduler0' as ThreadId)
        .filter(
          (e) =>
            e.payload.type === 'side-effect-intent' &&
            e.payload.intent.normalizedAction.startsWith('cron-fire:'),
        );
      expect(schedulerFires).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  // -----------------------------------------------------------------------------------------
  // One-shot Cron: fires once after a restart, then is terminal (`fired`) — no re-run.
  // -----------------------------------------------------------------------------------------
  it('a one-shot job survives a restart, fires exactly once, and becomes terminal', async () => {
    const work = join(dir, 'oneshot');
    const notify = 'thr_oneshot0001' as ThreadId;

    const created = await runCli(work, M0, [
      'cron',
      'add',
      '--one-shot',
      '--at',
      String(M0 + 30_000),
      '--thread',
      notify,
      '--profile',
      'auto-accept-edits',
      '--json',
      '--',
      'node',
      '-e',
      'process.stdout.write("O")',
    ]);
    expect(created.code).toBe(0);
    const job = lastJson<Job>(created);

    const run1 = await runCli(work, T, ['cron', 'run', '--now', String(T), '--json']);
    const fired = lastJson<Supervised>(run1).fired;
    expect(fired).toHaveLength(1);
    expect(fired[0]?.jobId).toBe(job.id);
    expect(fired[0]?.ok).toBe(true);

    // A second poll fires nothing, and the durable job is now terminal `fired`.
    const run2 = await runCli(work, T, ['cron', 'run', '--now', String(T), '--json']);
    expect(lastJson<Supervised>(run2).fired).toHaveLength(0);

    const list = await runCli(work, T, ['cron', 'list', '--json']);
    const jobs = lastJson<{ jobs: { id: string; status: string }[] }>(list).jobs;
    expect(jobs.find((j) => j.id === job.id)?.status).toBe('fired');
  });

  // -----------------------------------------------------------------------------------------
  // The managed ceiling binds SCHEDULED work exactly as it binds a normal run: a job whose ceiling
  // allows a shell is DENIED at fire time under a managed `maxProfile: plan`.
  // -----------------------------------------------------------------------------------------
  it('a cron job cannot exceed the managed ceiling: a plan clamp denies the scheduled shell', async () => {
    const work = join(dir, 'ceiling');
    const notify = 'thr_notify0001' as ThreadId;

    // Created with a permissive (unmanaged) ceiling that WOULD allow the shell.
    const created = await runCli(work, M0, [
      'cron',
      'add',
      '--recurring',
      '* * * * *',
      '--thread',
      notify,
      '--profile',
      'yolo',
      '--json',
      '--',
      'node',
      '-e',
      'process.stdout.write("x")',
    ]);
    expect(created.code).toBe(0);
    const job = lastJson<Job>(created);

    // The supervisor runs under a managed ceiling clamping to `plan`. The fire-time authority is the
    // captured ceiling INTERSECTED with managed policy — so the shell is unavailable and refused.
    const run = await runCli(work, T, ['cron', 'run', '--now', String(T), '--json'], planManaged);
    const fired = lastJson<Supervised>(run).fired;
    expect(fired).toHaveLength(1);
    expect(fired[0]?.jobId).toBe(job.id);
    expect(fired[0]?.effectiveProfile).toBe('plan'); // clamped down from the yolo ceiling
    expect(fired[0]?.ok).toBe(false); // the shell could not run under the ceiling
    expect(fired[0]?.detail ?? '').toContain('plan');
  });

  // -----------------------------------------------------------------------------------------
  // Background: a completed task's RESULT is durable and is not re-run by a fresh process.
  // -----------------------------------------------------------------------------------------
  it("a background task's result survives a restart and the ledger refuses to re-run it", async () => {
    const work = join(dir, 'background');
    const thread = 'thr_bgthread01' as ThreadId;

    const started = await runCli(work, M0, [
      'background',
      'start',
      '--category',
      'local-shell',
      '--thread',
      thread,
      '--profile',
      'auto-accept-edits',
      '--json',
      '--',
      'node',
      '-e',
      'process.stdout.write("B")',
    ]);
    expect(started.code).toBe(0);
    const view = lastJson<{ taskId: string; status: string }>(started);
    expect(view.status).toBe('succeeded');

    // A fresh process reads the durable ledger: the completed task is visible after the restart.
    const list = await runCli(work, M0, ['background', 'list', '--thread', thread, '--json']);
    const record = lastJson<{ tasks: { taskId: string; state: string }[] }>(list).tasks.find(
      (t) => t.taskId === view.taskId,
    );
    expect(record?.state).toBe('known-complete');

    // And the ledger refuses to run the same task again — completion is idempotent across a restart.
    const store = openDb(work);
    try {
      expect(store.mayExecute(backgroundIdempotencyKey(view.taskId)).allowed).toBe(false);
    } finally {
      store.close();
    }
  });
});
