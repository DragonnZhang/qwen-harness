import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ToolWorkerClient, type WorkerGrant } from '../../src/index.ts';

/**
 * Shell indirection is impossible: a command runs via `spawn(command, argv)` with NO shell, so shell
 * metacharacters in an argument are passed through LITERALLY and never interpreted (SC-01).
 *
 * The classic attack is to smuggle a second command through `;`, `$()`, or a backtick inside an
 * argument the model controls. Because there is no `/bin/sh -c` in the path — the executable is
 * exec'd directly with an argv array — the metacharacters are inert data. This proves it against the
 * real sandboxed worker: the injected side effect never happens, and the argument arrives verbatim.
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

describe('the shell surface cannot be hijacked by metacharacter indirection (SC-01, S)', () => {
  it('the sandbox is available — this proves the real no-shell exec path, not a mock', () => {
    expect(available, client.detect().detail).toBe(true);
  });

  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'qh-shellinj-'));
  });
  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  it('a `;`-smuggled second command is NOT executed — the argument is literal', async () => {
    const payload = 'safe; touch INJECTED.txt';
    const res = await client.run({
      workspaceRoot: workspace,
      isolation: 'workspace-write',
      grant: GRANT,
      request: {
        op: 'shell',
        command: '/usr/bin/echo',
        argv: [payload],
        cwd: { handle: 'workspace', relative: '.' },
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const r = res.result as { exitCode: number; stdout: string };
      // echo printed the ENTIRE payload verbatim — no shell split it on `;`.
      expect(r.stdout.trim()).toBe(payload);
      expect(r.exitCode).toBe(0);
    }
    // ...and the smuggled `touch` never ran: no injected file exists in the workspace.
    expect(existsSync(join(workspace, 'INJECTED.txt'))).toBe(false);
  });

  it('a `$()` command substitution is NOT expanded — it arrives as literal text', async () => {
    const payload = 'value=$(touch SUBST.txt)';
    const res = await client.run({
      workspaceRoot: workspace,
      isolation: 'workspace-write',
      grant: GRANT,
      request: {
        op: 'shell',
        command: '/usr/bin/echo',
        argv: [payload],
        cwd: { handle: 'workspace', relative: '.' },
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.result as { stdout: string }).stdout.trim()).toBe(payload);
    expect(existsSync(join(workspace, 'SUBST.txt'))).toBe(false);
  });
});
