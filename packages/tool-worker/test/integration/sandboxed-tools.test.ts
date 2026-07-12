import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ToolWorkerClient, type WorkerGrant } from '../../src/index.ts';

/**
 * End-to-end through the REAL sandbox: the client spawns a bubblewrap worker, the worker performs
 * the file/shell/git operation inside the sandbox, and the typed response comes back. This proves
 * the capability-scoped RPC and the "model I/O runs only in the sandboxed worker" boundary work
 * against a real process, not a mock.
 */
const client = new ToolWorkerClient();
const available = client.detect().available;

const GRANT: WorkerGrant = {
  readable: ['workspace', 'scratch'],
  writable: ['workspace', 'scratch'],
  shell: true,
  network: false,
  limits: { wallMs: 20_000, maxOutputBytes: 1_000_000, maxFileBytes: 10_000_000 },
};

const READONLY_GRANT: WorkerGrant = { ...GRANT, writable: [], shell: false };

describe('sandboxed tool worker (SB-04, TL-02)', () => {
  it('the sandbox is available — this suite proves real isolation, not a mock', () => {
    expect(available, client.detect().detail).toBe(true);
  });

  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'qh-wk-'));
    writeFileSync(join(workspace, 'hello.txt'), 'line one\nline two\nline three\n');
  });
  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  it('reads a file through the sandbox, with pagination metadata', async () => {
    const res = await client.run({
      workspaceRoot: workspace,
      isolation: 'workspace-write',
      grant: GRANT,
      request: {
        op: 'read',
        path: { handle: 'workspace', relative: 'hello.txt' },
        offsetLine: 0,
        limitLines: 2,
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const r = res.result as { content: string; totalLines: number; hasMore: boolean };
      expect(r.content).toBe('line one\nline two');
      expect(r.totalLines).toBe(4);
      expect(r.hasMore).toBe(true);
    }
  });

  it('writes a file through the sandbox — the write lands on the host workspace', async () => {
    const res = await client.run({
      workspaceRoot: workspace,
      isolation: 'workspace-write',
      grant: GRANT,
      request: {
        op: 'write',
        path: { handle: 'workspace', relative: 'new.ts' },
        content: 'export const x = 1;\n',
      },
    });
    expect(res.ok).toBe(true);
    // The real file exists on the host afterward.
    expect(readFileSync(join(workspace, 'new.ts'), 'utf8')).toBe('export const x = 1;\n');
  });

  it('edits a file and returns a diff, rejecting a stale edit', async () => {
    const first = await client.run({
      workspaceRoot: workspace,
      isolation: 'workspace-write',
      grant: GRANT,
      request: {
        op: 'edit',
        path: { handle: 'workspace', relative: 'hello.txt' },
        oldText: 'line two',
        newText: 'LINE TWO',
        expectedDigest: null,
      },
    });
    expect(first.ok).toBe(true);
    expect(readFileSync(join(workspace, 'hello.txt'), 'utf8')).toContain('LINE TWO');

    // A stale edit (wrong expected digest) must be REFUSED, not silently applied (TL-04).
    const stale = await client.run({
      workspaceRoot: workspace,
      isolation: 'workspace-write',
      grant: GRANT,
      request: {
        op: 'edit',
        path: { handle: 'workspace', relative: 'hello.txt' },
        oldText: 'line one',
        newText: 'X',
        expectedDigest: 'deadbeefdeadbeefdeadbeefdeadbeef',
      },
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.category).toBe('stale-file');
  });

  it('runs a shell command inside the sandbox with separated stdout/stderr', async () => {
    const res = await client.run({
      workspaceRoot: workspace,
      isolation: 'workspace-write',
      grant: GRANT,
      request: {
        op: 'shell',
        command: '/usr/bin/env',
        argv: ['sh', '-c', 'echo out; echo err 1>&2; exit 3'],
        cwd: { handle: 'workspace', relative: '.' },
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const r = res.result as { exitCode: number; stdout: string; stderr: string };
      expect(r.stdout.trim()).toBe('out');
      expect(r.stderr.trim()).toBe('err');
      expect(r.exitCode).toBe(3);
    }
  });

  it('REFUSES a write when the grant is read-only (defense beyond the sandbox mount)', async () => {
    const res = await client.run({
      workspaceRoot: workspace,
      isolation: 'read-only',
      grant: READONLY_GRANT,
      request: {
        op: 'write',
        path: { handle: 'workspace', relative: 'blocked.txt' },
        content: 'x',
      },
    });
    // The grant check fails before the write even reaches the (also read-only) filesystem.
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.category).toBe('permission-denied');
    expect(() => readFileSync(join(workspace, 'blocked.txt'))).toThrow();
  });

  it('REFUSES a path that escapes the workspace, even with a full grant', async () => {
    const res = await client.run({
      workspaceRoot: workspace,
      isolation: 'workspace-write',
      grant: GRANT,
      request: {
        op: 'read',
        path: { handle: 'workspace', relative: '../../../etc/passwd' },
        offsetLine: 0,
        limitLines: 10,
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.category).toBe('path-escape');
  });
});
