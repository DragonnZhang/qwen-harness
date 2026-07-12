/**
 * Integration: the backend runs an ordinary tool end-to-end and behaves like a normal process
 * runner — separate stdout/stderr, real exit codes, real timing — while being fully confined.
 *
 * The security suite proves what CANNOT happen; this proves the happy path still works, because a
 * sandbox that also breaks legitimate tools is not shippable.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { BubblewrapBackend, DisabledBackend } from '../../src/backend.ts';
import { SANDBOX_WORKSPACE, makeWorkspace, specFor, NODE, SH, type Workspace } from '../security/helpers.ts';

const backend = new BubblewrapBackend(() => Date.now());
let ws: Workspace;

beforeEach(() => {
  ws = makeWorkspace();
});
afterEach(() => ws.cleanup());

describe('a normal command runs and reports faithfully', () => {
  it('separates stdout and stderr and returns the real exit code', async () => {
    const result = await backend.run(
      specFor(ws, {
        command: SH,
        args: ['-c', 'echo to-out; echo to-err 1>&2; exit 7'],
      }),
    );
    expect(result.stdout.trim()).toBe('to-out');
    expect(result.stderr.trim()).toBe('to-err');
    expect(result.exitCode).toBe(7);
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it('reads a file the workspace provides and writes one back', async () => {
    writeFileSync(join(ws.workspace, 'input.txt'), 'from-host');
    const result = await backend.run(
      specFor(ws, {
        command: NODE,
        args: [
          '-e',
          `const fs=require('fs');const d=fs.readFileSync('${SANDBOX_WORKSPACE}/input.txt','utf8');fs.writeFileSync('${SANDBOX_WORKSPACE}/output.txt',d.toUpperCase());`,
        ],
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(ws.workspace, 'output.txt'), 'utf8')).toBe('FROM-HOST');
  });

  it('honors a caller AbortSignal', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const promise = backend.run(
      specFor(ws, {
        command: SH,
        args: ['-c', 'sleep 30', 'qh-abort-signal'],
        timeoutMs: 30_000,
        signal: controller.signal,
      }),
    );
    setTimeout(() => controller.abort(), 250);
    const result = await promise;
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.timedOut).toBe(false);
  });
});

describe('the disabled (yolo) backend records the choice and still runs', () => {
  it('audits every unconfined run before it starts', async () => {
    const records: unknown[] = [];
    const disabled = new DisabledBackend(
      { isolationDisabled: (r) => records.push(r) },
      { now: () => Date.now() },
    );
    // The disabled backend runs UNCONFINED on the host, so its cwd must be a real host directory,
    // not the sandbox mount alias.
    const result = await disabled.run(
      specFor(ws, { command: SH, args: ['-c', 'echo yolo-ran'], cwd: ws.workspace }),
    );
    expect(result.stdout.trim()).toBe('yolo-ran');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ reason: 'yolo', command: SH });
  });
});
