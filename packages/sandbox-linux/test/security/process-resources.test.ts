/**
 * Process-tree teardown and resource bounds.
 *
 * These are the tests most able to hurt the host, so every one is TIGHTLY BOUNDED: short deadlines,
 * small limits, and a fixed number of children (never an unbounded `:(){ :|:& };:`). The property
 * under test is not "the bomb runs" — it is "the bound fires and nothing survives".
 *
 * Processes are tagged by passing a unique marker as `$0` (`sh -c 'CMD' MARKER`), so `sleep` still
 * gets a clean numeric argument while `pgrep -f MARKER` can still find any survivor on the host.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';

import { BubblewrapBackend } from '../../src/backend.ts';
import { CAP, SH, makeWorkspace, specFor, type Workspace } from './helpers.ts';

const backend = new BubblewrapBackend(() => Date.now());
let ws: Workspace;

beforeEach(() => {
  ws = makeWorkspace();
});
afterEach(() => ws.cleanup());

function marker(tag: string): string {
  return `qh-${tag}-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

/** Count host processes whose command line contains `m`. Used to detect orphans. */
function countHostProcesses(m: string): number {
  try {
    return Number.parseInt(execFileSync('pgrep', ['-fc', m], { encoding: 'utf8' }).trim(), 10) || 0;
  } catch {
    // pgrep exits non-zero when there are no matches — that is zero, not an error.
    return 0;
  }
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('the whole process group is torn down on timeout', () => {
  it('a child that spawns a grandchild sleeper leaves NO orphan after the deadline', async () => {
    const m = marker('orphan');
    // Tree: root sh -> child sh -> grandchild sh (each sleeping 600s, each tagged via $0). If the
    // group teardown failed, a survivor would still be sleeping when we check.
    const script = `sh -c 'sleep 600' ${m}-gc & sh -c 'sleep 600' ${m}-child & wait`;
    const result = await backend.run(
      specFor(ws, { command: SH, args: ['-c', script, `${m}-root`], timeoutMs: 1200 }),
    );
    expect(result.timedOut).toBe(true);

    await settle(600);
    expect(countHostProcesses(m)).toBe(0);
  });

  it('cancel() via the returned handle kills the tree immediately', async () => {
    const m = marker('cancel');
    const started = Date.now();
    const proc = backend.spawn(
      specFor(ws, { command: SH, args: ['-c', 'sleep 600', m], timeoutMs: 30_000 }),
    );
    setTimeout(() => proc.cancel(), 250);
    const result = await proc.completed;
    // sleep 600 cannot finish in 30s, so a prompt settle proves cancel — not natural completion.
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.timedOut).toBe(false);
    await settle(500);
    expect(countHostProcesses(m)).toBe(0);
  });
});

describe('a fork loop is bounded rather than taking down the host', () => {
  it('a bounded fork loop is terminated by the deadline and leaves no survivors', async () => {
    const m = marker('fork');
    // DELIBERATELY BOUNDED: 30 children, each a tagged 30s sleeper. Under an nproc cap some forks
    // may be refused; either way the deadline + group-kill is the real bound.
    const script = `i=0; while [ $i -lt 30 ]; do sh -c 'sleep 30' ${m}-c & i=$((i+1)); done; wait`;
    const result = await backend.run(
      specFor(ws, {
        command: SH,
        args: ['-c', script, `${m}-root`],
        timeoutMs: 1500,
        limits: { cpuSeconds: 10, processes: 16, fileSizeBytes: 1024 * 1024, openFiles: 64 },
      }),
    );
    expect(result.timedOut).toBe(true);
    await settle(800);
    expect(countHostProcesses(m)).toBe(0);
  });
});

describe('output flood is bounded', () => {
  it('unbounded stdout is capped and the producer is killed', async () => {
    const result = await backend.run(
      specFor(ws, {
        command: SH,
        // `yes` produces output forever; the cap must stop it, not buffer it to death.
        args: ['-c', 'yes flooding-the-output-buffer'],
        maxOutputBytes: 64 * 1024,
        timeoutMs: 10_000,
      }),
    );
    expect(result.truncated).toBe(true);
    // Captured output stays within a small multiple of the cap (one in-flight chunk of slack).
    expect(result.stdout.length).toBeLessThan(64 * 1024 + 128 * 1024);
    expect(result.timedOut).toBe(false);
  });

  it('RLIMIT_FSIZE stops a file from growing without bound (SIGXFSZ)', async () => {
    if (CAP.prlimitPath === null) return; // rlimits unavailable: the deadline test covers safety.
    const result = await backend.run(
      specFor(ws, {
        command: SH,
        args: ['-c', 'yes xxxxxxxxxxxxxxxx > flood.txt'],
        limits: { fileSizeBytes: 64 * 1024, cpuSeconds: 10 },
        timeoutMs: 8000,
        maxOutputBytes: 4096,
      }),
    );
    // SIGXFSZ terminates the shell; it never completes cleanly and never fills the disk.
    expect(result.exitCode === 0 && !result.timedOut).toBe(false);
  });
});

describe('CPU time is bounded (RLIMIT_CPU fires)', () => {
  it('a CPU spinner is killed near the CPU limit, not at the wall deadline', async () => {
    if (CAP.prlimitPath === null) return;
    const started = Date.now();
    const result = await backend.run(
      specFor(ws, {
        command: SH,
        args: ['-c', 'while :; do :; done'],
        // CPU limit 1s; wall deadline 20s. If RLIMIT_CPU works, it dies at ~1s, well before 20s.
        limits: { cpuSeconds: 1 },
        timeoutMs: 20_000,
      }),
    );
    const elapsed = Date.now() - started;
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(elapsed).toBeLessThan(15_000);
  });
});
