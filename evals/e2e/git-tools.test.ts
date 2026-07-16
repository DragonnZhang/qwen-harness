import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main, type CliDeps } from '@qwen-harness/cli';
import { freezeCapabilities, type ModelProvider } from '@qwen-harness/provider-core';
import { EventStore } from '@qwen-harness/storage';
import { ManualClock, SequentialIds } from '@qwen-harness/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Read-safe git tooling reports dirty state, end to end (TL-06).
 *
 * A real run asks `git_status` on a real repository with an uncommitted change. The tool is read-only
 * (a `git-read` action), so it runs without discarding anything, and it reports the dirty file
 * precisely. Nothing here can reset or rewrite history — there is no tool for it.
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

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-c', 'user.email=t@t.t', '-c', 'user.name=t', ...args], {
    cwd,
    stdio: 'ignore',
  });
};

describe('read-safe git status reports dirty state (TL-06)', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'qh-git-'));
    execFileSync('git', ['init', '-q', '-b', 'main', cwd], { stdio: 'ignore' });
    writeFileSync(join(cwd, 'app.mjs'), 'export const x = 1;\n');
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-m', 'init');
    // Dirty the tree: an uncommitted modification git_status must report.
    writeFileSync(join(cwd, 'app.mjs'), 'export const x = 2; // changed\n');
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  const statusProvider = (): ModelProvider => {
    let n = 0;
    return {
      capabilities: CAPS,
      async *stream() {
        n += 1;
        if (n === 1) {
          const args = { path: '.' };
          yield {
            type: 'tool-call-complete',
            itemId: 'it_1',
            callId: 'call_1',
            toolName: 'git_status',
            argumentsJson: JSON.stringify(args),
            arguments: args,
          };
          yield { type: 'done', finishReason: 'tool_calls' };
        } else {
          yield { type: 'text-done', itemId: 'it_2', text: 'the tree is dirty' };
          yield { type: 'done', finishReason: 'stop' };
        }
      },
    };
  };

  it('runs git_status read-safely and reports the modified file', async () => {
    const deps: CliDeps = {
      argv: ['run', '--profile', 'yolo', 'what changed?'],
      env: {},
      cwd,
      now: () => 1_700_000_000_000,
      stdout: () => {},
      stderr: () => {},
      provider: statusProvider(),
    };
    const code = await main(deps);
    expect(code).toBe(0);

    const store = new EventStore({
      path: join(cwd, '.qwen-harness', 'sessions.sqlite'),
      clock: new ManualClock(0),
      ids: new SequentialIds(),
    });
    try {
      const gitResult = store
        .readAll()
        .map((e) => e.payload)
        .find(
          (p) =>
            p.type === 'item-appended' &&
            p.item.type === 'tool-result' &&
            p.item.toolName === 'git_status',
        );
      expect(gitResult).toBeDefined();
      const preview =
        gitResult && gitResult.type === 'item-appended' && gitResult.item.type === 'tool-result'
          ? gitResult.item.preview
          : '';
      // The dirty file is reported precisely (porcelain shows the modified path).
      expect(preview).toContain('app.mjs');
      // ...and it succeeded (read-safe: no mutation, no error).
      expect(
        gitResult?.type === 'item-appended' && gitResult.item.type === 'tool-result'
          ? gitResult.item.ok
          : false,
      ).toBe(true);
    } finally {
      store.close();
    }
  });
});
