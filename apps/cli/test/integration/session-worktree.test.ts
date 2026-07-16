import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { main, type CliDeps } from '@qwen-harness/cli';
import { freezeCapabilities, type ModelProvider } from '@qwen-harness/provider-core';
import { FixtureRepo } from '@qwen-harness/testkit';
import { listWorktrees } from '@qwen-harness/worktrees';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * A session can ENTER a worktree, and every tool then resolves against THAT worktree (GT-02).
 *
 * `run --worktree <slug>` makes the session work in a fresh git worktree of the repo: a file the model
 * writes lands in the worktree, never in the main checkout. This is distinct from a teammate's cwd
 * override (`team teammate --worktree`, exercised in evals/e2e/team.test.ts) — here the SESSION itself
 * enters the worktree. Without the flag, the same write lands in the main checkout, proving the flag —
 * not the harness — is what redirected tool resolution.
 */

const CAPS = freezeCapabilities({
  textStreaming: true,
  reasoningSummary: false,
  reasoningEffortGranularity: 'none',
  incrementalToolArgs: false,
  background: false,
  structuredOutput: false,
  toolStream: false,
});

const writeProvider = (): ModelProvider => {
  let n = 0;
  return {
    capabilities: CAPS,
    async *stream() {
      n += 1;
      if (n === 1) {
        const args = { path: 'from-model.txt', content: 'in the worktree\n' };
        yield {
          type: 'tool-call-complete',
          itemId: 'it_1',
          callId: 'call_1',
          toolName: 'write_file',
          argumentsJson: JSON.stringify(args),
          arguments: args,
        };
        yield { type: 'done', finishReason: 'tool_calls' };
      } else {
        yield { type: 'text-done', itemId: 'it_2', text: 'done' };
        yield { type: 'done', finishReason: 'stop' };
      }
    },
  };
};

describe('a session enters a worktree and tools resolve against it (GT-02)', () => {
  let repo: FixtureRepo;
  beforeEach(() => {
    repo = FixtureRepo.create({ 'a.txt': 'x\n' });
  });
  afterEach(() => repo.dispose());

  const run = (extra: string[]): Promise<number> =>
    main({
      argv: ['run', '--profile', 'yolo', ...extra, 'write a file'],
      env: {},
      cwd: repo.root,
      now: () => 1_700_000_000_000,
      stdout: () => {},
      stderr: () => {},
      provider: writeProvider(),
    } satisfies CliDeps);

  it('with --worktree, the write lands in the WORKTREE, not the main checkout', async () => {
    expect(await run(['--worktree', 'feature-x'])).toBe(0);

    // Find the worktree git created and assert the model's file is inside it.
    const worktrees = listWorktrees(repo.root).filter((w) => w.path !== repo.root);
    expect(worktrees.length).toBeGreaterThanOrEqual(1);
    const wt = worktrees.find((w) => w.branch.includes('feature-x'))!;
    expect(existsSync(join(wt.path, 'from-model.txt'))).toBe(true);
    // ...and NOT in the main checkout — tool resolution was redirected to the worktree.
    expect(existsSync(join(repo.root, 'from-model.txt'))).toBe(false);
  });

  it('without --worktree, the same write lands in the main checkout (the flag is the difference)', async () => {
    expect(await run([])).toBe(0);
    expect(existsSync(join(repo.root, 'from-model.txt'))).toBe(true);
  });
});
