import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main, type CliDeps } from '@qwen-harness/cli';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Auto memory is shared across worktrees of one canonical repo, end to end (MM-05).
 *
 * The headline scope distinction: `auto` memory is keyed by the CANONICAL repository, so a lesson the
 * harness records in one worktree is available in its siblings. This golden task drives the REAL CLI:
 * it writes an `auto` memory from the MAIN worktree and reads it back from a LINKED `git worktree` of
 * the same repo — proving the CLI computes the canonical root (the shared git common dir) rather than
 * naively keying on the cwd. A second, independent repo must NOT see it — the sharing is scoped to the
 * canonical repository, not global to the machine.
 */

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-c', 'user.email=t@t.t', '-c', 'user.name=t', ...args], {
    cwd,
    stdio: 'ignore',
  });
};

describe('auto memory shared across worktrees of one canonical repo (MM-05)', () => {
  let root: string;
  let mainWt: string;
  let linkedWt: string;
  let otherRepo: string;
  let stateDir: string;

  function initRepo(dir: string): void {
    execFileSync('git', ['init', '-q', dir], { stdio: 'ignore' });
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qh-mm05-'));
    mainWt = join(root, 'main');
    linkedWt = join(root, 'linked');
    initRepo(mainWt);
    git(mainWt, 'worktree', 'add', '-q', linkedWt);

    otherRepo = mkdtempSync(join(tmpdir(), 'qh-mm05-other-'));
    initRepo(otherRepo);

    // A shared machine-state root, so `auto` for both worktrees keys under one XDG state home. What
    // distinguishes them is ONLY the canonical repo — exactly what MM-05 is about.
    stateDir = mkdtempSync(join(tmpdir(), 'qh-mm05-state-'));
  });
  afterEach(() => {
    for (const d of [root, otherRepo, stateDir]) rmSync(d, { recursive: true, force: true });
  });

  async function run(
    cwd: string,
    argv: string[],
  ): Promise<{ code: number; out: string[]; err: string[] }> {
    const out: string[] = [];
    const err: string[] = [];
    const deps: CliDeps = {
      argv,
      env: { XDG_STATE_HOME: stateDir },
      cwd,
      now: () => 1_700_000_000_000,
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
    };
    const code = await main(deps);
    return { code, out, err };
  }

  const autoNames = (out: string[]): string[] => {
    const parsed = JSON.parse(out[0]!) as {
      memories: { name: string; scope: string }[];
    };
    return parsed.memories.filter((m) => m.scope === 'auto').map((m) => m.name);
  };

  it('a lesson written in the main worktree is visible from a linked worktree of the same repo', async () => {
    const add = await run(mainWt, [
      'memory',
      'add',
      '--name',
      'build-lesson',
      '--description',
      'a hard-won build lesson',
      '--scope',
      'auto',
      'use pnpm, never npm',
    ]);
    expect(add.code, add.err.join('\n')).toBe(0);

    // The SIBLING worktree — a different path entirely — reads the same auto store.
    const fromLinked = await run(linkedWt, ['memory', 'list', '--json']);
    expect(fromLinked.code).toBe(0);
    expect(autoNames(fromLinked.out)).toContain('build-lesson');
  });

  it('an unrelated repository does NOT see it — sharing is scoped to the canonical repo, not the machine', async () => {
    await run(mainWt, [
      'memory',
      'add',
      '--name',
      'build-lesson',
      '--description',
      'a hard-won build lesson',
      '--scope',
      'auto',
      'use pnpm, never npm',
    ]);

    const fromOther = await run(otherRepo, ['memory', 'list', '--json']);
    expect(fromOther.code).toBe(0);
    expect(autoNames(fromOther.out)).not.toContain('build-lesson');
  });
});
