import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ToolWorkerClient, type WorkerGrant } from '../../src/index.ts';

/**
 * `git_status` through the REAL sandboxed worker (TL-02, part of the built-in Git tooling).
 *
 * The companion `git_diff` tool is already exercised end to end in `evals/e2e/coding-loop.test.ts`;
 * this covers `git_status`, which had no test. It runs the tool through the actual bubblewrap worker
 * against a real Git repo and proves two things: it reports the working-tree state (modified + tracked
 * + untracked, plus the `--branch` header), and it is READ-SAFE — it needs neither a write nor a shell
 * capability in its grant, and it leaves the working tree untouched.
 */

const client = new ToolWorkerClient();
const available = client.detect().available;

/** No write, no shell: `git_status` must work read-only, proving it is a safe inspection tool. */
const READONLY_GRANT: WorkerGrant = {
  readable: ['workspace', 'scratch'],
  writable: [],
  shell: false,
  network: false,
  limits: { wallMs: 20_000, maxOutputBytes: 1_000_000, maxFileBytes: 10_000_000 },
};

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

describe('git_status through the sandboxed worker (TL-02)', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'qh-git-'));
    git(workspace, 'init', '-q', '-b', 'main');
    git(workspace, 'config', 'user.email', 'test@example.com');
    git(workspace, 'config', 'user.name', 'Test');
    writeFileSync(join(workspace, 'a.ts'), 'export const a = 1;\n');
    git(workspace, 'add', '.');
    git(workspace, 'commit', '-q', '-m', 'init');
  });

  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  it('the sandbox is available — this suite proves real isolation, not a mock', () => {
    expect(available, client.detect().detail).toBe(true);
  });

  it('reports modified and untracked files in porcelain output, read-safely', async () => {
    // Dirty the tree: modify a tracked file and add an untracked one.
    writeFileSync(join(workspace, 'a.ts'), 'export const a = 2;\n');
    writeFileSync(join(workspace, 'untracked.txt'), 'x\n');

    const res = await client.run({
      workspaceRoot: workspace,
      isolation: 'workspace-write',
      grant: READONLY_GRANT,
      request: { op: 'git-status', path: { handle: 'workspace', relative: '.' } },
    });

    expect(res.ok, res.ok ? '' : JSON.stringify(res)).toBe(true);
    if (res.ok) {
      const r = res.result as { porcelain: string };
      // The modified tracked file and the untracked file both appear with their porcelain markers.
      expect(r.porcelain).toMatch(/ M a\.ts/);
      expect(r.porcelain).toMatch(/\?\? untracked\.txt/);
      // The `--branch` header is present, so a caller can see the branch as well as the file states.
      expect(r.porcelain).toContain('## main');
    }

    // READ-SAFE: running status neither needed a write/shell grant nor altered the working tree.
    expect(readFileSync(join(workspace, 'a.ts'), 'utf8')).toBe('export const a = 2;\n');
  });

  it('a clean repository reports only the branch header, no file entries', async () => {
    const res = await client.run({
      workspaceRoot: workspace,
      isolation: 'workspace-write',
      grant: READONLY_GRANT,
      request: { op: 'git-status', path: { handle: 'workspace', relative: '.' } },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const r = res.result as { porcelain: string };
      expect(r.porcelain).toContain('## main');
      // No porcelain file-status lines (every non-header line would start with a 2-char status code).
      const fileLines = r.porcelain.split('\n').filter((l) => l.length > 0 && !l.startsWith('##'));
      expect(fileLines).toEqual([]);
    }
  });
});
