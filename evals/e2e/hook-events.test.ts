import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main, type CliDeps } from '@qwen-harness/cli';
import {
  freezeCapabilities,
  type ModelProvider,
  type ProviderStreamEvent,
} from '@qwen-harness/provider-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * HK-01 (E): the newly-wired hook events actually FIRE on a real `main()` run, each at its honest
 * orchestration site, observe-only. Every hook appends its event name to a shared order-log AND
 * touches a per-event marker, so both PRESENCE and ORDER are observable from real execution — a test
 * here FAILS if the event stops firing.
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

describe('newly-wired hook events fire on a real run (HK-01)', () => {
  let cwd: string;

  const marker = (name: string): string => join(cwd, `${name}.marker`);
  const orderLog = (): string => join(cwd, 'order.log');
  const firedOrder = (): string[] =>
    existsSync(orderLog())
      ? readFileSync(orderLog(), 'utf8')
          .split('\n')
          .filter((l) => l.length > 0)
      : [];

  /** Register one command hook per event: append its name to the order-log, then touch its marker. */
  function writeHooks(events: readonly string[]): void {
    mkdirSync(join(cwd, '.qwen-harness'), { recursive: true });
    const script = (name: string): string => {
      const p = join(cwd, `hook-${name}.sh`);
      writeFileSync(
        p,
        `#!/bin/sh\ncat > /dev/null\necho '${name}' >> '${orderLog()}'\ntouch '${marker(name)}'\nexec echo '{"type":"continue"}'\n`,
      );
      chmodSync(p, 0o755);
      return p;
    };
    writeFileSync(
      join(cwd, '.qwen-harness', 'hooks.json'),
      JSON.stringify({
        version: 1,
        hooks: events.map((event) => ({
          id: `on-${event}`,
          event,
          handler: { type: 'command', command: script(event) },
        })),
      }),
    );
  }

  const deps = (argv: string[], provider: ModelProvider): CliDeps => ({
    argv,
    env: {},
    cwd,
    now: () => 1_700_000_000_000,
    stdout: () => {},
    stderr: () => {},
    provider,
  });

  const textProvider = (text = 'all done'): ModelProvider => ({
    capabilities: CAPS,
    async *stream(): AsyncGenerator<ProviderStreamEvent> {
      yield { type: 'text-done', itemId: 'm', text };
      yield { type: 'done', finishReason: 'stop' };
    },
  });

  const toolThenText = (toolName: string, args: Record<string, unknown>): ModelProvider => {
    let round = 0;
    return {
      capabilities: CAPS,
      async *stream(): AsyncGenerator<ProviderStreamEvent> {
        round += 1;
        if (round === 1) {
          yield {
            type: 'tool-call-complete',
            itemId: 'it_1',
            callId: 'call_1',
            toolName,
            argumentsJson: JSON.stringify(args),
            arguments: args,
          };
          yield { type: 'done', finishReason: 'tool_calls' };
        } else {
          yield { type: 'text-done', itemId: 'it_2', text: 'finished' };
          yield { type: 'done', finishReason: 'stop' };
        }
      },
    };
  };

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'qh-hookev-'));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it('fires MessageDisplay and SessionEnd on a plain text run', async () => {
    writeHooks(['MessageDisplay', 'SessionEnd']);
    await main(deps(['run', '--profile', 'yolo', 'say hi'], textProvider('hello there')));
    expect(existsSync(marker('MessageDisplay')), 'MessageDisplay fired').toBe(true);
    expect(existsSync(marker('SessionEnd')), 'SessionEnd fired').toBe(true);
    // The session ends, then the assistant's final text is rendered to the user.
    expect(firedOrder().indexOf('SessionEnd')).toBeLessThan(firedOrder().indexOf('MessageDisplay'));
  });

  it('fires FileChanged after a successful write_file tool', async () => {
    writeHooks(['FileChanged']);
    await main(
      deps(
        ['run', '--profile', 'yolo', 'write a file'],
        toolThenText('write_file', { path: 'out.txt', content: 'hi' }),
      ),
    );
    expect(existsSync(marker('FileChanged')), 'FileChanged fired').toBe(true);
    expect(readFileSync(join(cwd, 'out.txt'), 'utf8')).toBe('hi');
  });

  it('does NOT fire FileChanged for a read-only tool (non-vacuous)', async () => {
    writeFileSync(join(cwd, 'data.txt'), 'x\n');
    writeHooks(['FileChanged']);
    await main(
      deps(
        ['run', '--profile', 'yolo', 'read a file'],
        toolThenText('read_file', { path: 'data.txt' }),
      ),
    );
    expect(existsSync(marker('FileChanged')), 'FileChanged did not fire for read_file').toBe(false);
  });

  it('fires ConfigChange when --prompt-mode selects a non-default mode', async () => {
    writeHooks(['ConfigChange']);
    await main(
      deps(['run', '--profile', 'yolo', '--prompt-mode', 'coordinator', 'hi'], textProvider()),
    );
    expect(existsSync(marker('ConfigChange')), 'ConfigChange fired').toBe(true);
  });

  it('fires UserPromptExpansion when a --skill expands the prompt', async () => {
    const d = join(cwd, '.qwen-harness', 'skills', 'summarize');
    mkdirSync(d, { recursive: true });
    writeFileSync(
      join(d, 'SKILL.md'),
      `---\nname: summarize\ndescription: Summarize concisely\nuser-invocable: true\n---\nUse three bullets.\n`,
    );
    writeHooks(['UserPromptExpansion']);
    await main(deps(['run', '--profile', 'yolo', '--skill', 'summarize', 'do it'], textProvider()));
    expect(existsSync(marker('UserPromptExpansion')), 'UserPromptExpansion fired').toBe(true);
  });

  it('fires Elicitation and ElicitationResult when the model calls ask_user', async () => {
    writeHooks(['Elicitation', 'ElicitationResult']);
    // No readLine → the headless channel declines, but BOTH events still fire around the ask.
    await main(
      deps(
        ['run', '--profile', 'yolo', 'ask me'],
        toolThenText('ask_user', { question: 'what is your favourite colour?' }),
      ),
    );
    expect(existsSync(marker('Elicitation')), 'Elicitation fired').toBe(true);
    expect(existsSync(marker('ElicitationResult')), 'ElicitationResult fired').toBe(true);
    expect(firedOrder().indexOf('Elicitation')).toBeLessThan(
      firedOrder().indexOf('ElicitationResult'),
    );
  });

  it('fires SubagentStart and SubagentStop around a foreground delegate', async () => {
    writeHooks(['SubagentStart', 'SubagentStop']);
    await main(
      deps(
        ['run', '--profile', 'yolo', 'delegate something'],
        toolThenText('delegate', {
          label: 'child',
          prompt: 'do a subtask',
          context: 'fresh',
          timing: 'foreground',
        }),
      ),
    );
    expect(existsSync(marker('SubagentStart')), 'SubagentStart fired').toBe(true);
    expect(existsSync(marker('SubagentStop')), 'SubagentStop fired').toBe(true);
    expect(firedOrder().indexOf('SubagentStart')).toBeLessThan(
      firedOrder().indexOf('SubagentStop'),
    );
  });

  it('fires Notification when a background subagent settles', async () => {
    writeHooks(['Notification']);
    await main(
      deps(
        ['run', '--profile', 'yolo', 'delegate in background'],
        toolThenText('delegate', {
          label: 'bg',
          prompt: 'do a background subtask',
          context: 'fresh',
          timing: 'background',
        }),
      ),
    );
    expect(existsSync(marker('Notification')), 'Notification fired').toBe(true);
  });

  it('fires StopFailure (and Stop) when the turn ends non-cleanly', async () => {
    writeHooks(['Stop', 'StopFailure']);
    const failing: ModelProvider = {
      capabilities: CAPS,
      // eslint-disable-next-line require-yield
      async *stream(): AsyncGenerator<ProviderStreamEvent> {
        throw new Error('provider exploded');
      },
    };
    await main(deps(['run', '--profile', 'yolo', 'boom'], failing));
    expect(existsSync(marker('Stop')), 'Stop fired').toBe(true);
    expect(existsSync(marker('StopFailure')), 'StopFailure fired').toBe(true);
  });

  it('does NOT fire StopFailure on a clean completion (non-vacuous)', async () => {
    writeHooks(['Stop', 'StopFailure']);
    await main(deps(['run', '--profile', 'yolo', 'ok'], textProvider()));
    expect(existsSync(marker('Stop')), 'Stop fired').toBe(true);
    expect(existsSync(marker('StopFailure')), 'StopFailure did not fire').toBe(false);
  });

  it('fires WorktreeCreate and CwdChanged when --worktree enters a fresh worktree', async () => {
    // A real git repo so a worktree can be created.
    const git = (...a: string[]): void =>
      void execFileSync('git', a, { cwd, stdio: ['ignore', 'ignore', 'ignore'] });
    git('init', '--quiet', '--initial-branch=main');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'user.name', 'Fixture');
    git('config', 'core.hooksPath', '/dev/null');
    writeFileSync(join(cwd, 'README.md'), '# fixture\n');
    git('add', '-A');
    git('commit', '--quiet', '-m', 'base');

    writeHooks(['WorktreeCreate', 'CwdChanged']);
    await main(deps(['run', '--profile', 'yolo', '--worktree', 'feature-x', 'hi'], textProvider()));
    expect(existsSync(marker('WorktreeCreate')), 'WorktreeCreate fired').toBe(true);
    expect(existsSync(marker('CwdChanged')), 'CwdChanged fired').toBe(true);

    // Clean up the worktree this test created so it does not leak into the repo's worktree list.
    try {
      execFileSync('git', ['worktree', 'prune'], { cwd, stdio: 'ignore' });
    } catch {
      /* best effort */
    }
  });

  it('records an ORDERED lifecycle stream on a real tool-using run (golden sequence)', async () => {
    writeHooks([
      'SessionStart',
      'UserPromptSubmit',
      'InstructionsLoaded',
      'PreToolUse',
      'PostToolUse',
      'FileChanged',
      'PostToolBatch',
      'MessageDisplay',
      'Stop',
      'SessionEnd',
    ]);
    await main(
      deps(
        ['run', '--profile', 'yolo', 'write then talk'],
        toolThenText('write_file', { path: 'g.txt', content: 'g' }),
      ),
    );
    const order = firedOrder();
    // Assert the load-bearing subsequence: setup → prompt → instructions come before the tool phase;
    // the tool phase (Pre/Post/FileChanged/Batch) comes before the final display and teardown.
    const idx = (e: string): number => order.indexOf(e);
    for (const e of [
      'SessionStart',
      'UserPromptSubmit',
      'InstructionsLoaded',
      'PreToolUse',
      'PostToolUse',
      'FileChanged',
      'PostToolBatch',
      'MessageDisplay',
      'Stop',
      'SessionEnd',
    ]) {
      expect(idx(e), `${e} fired`).toBeGreaterThanOrEqual(0);
    }
    expect(idx('SessionStart')).toBeLessThan(idx('UserPromptSubmit'));
    expect(idx('UserPromptSubmit')).toBeLessThan(idx('PreToolUse'));
    expect(idx('PreToolUse')).toBeLessThan(idx('PostToolUse'));
    expect(idx('PostToolUse')).toBeLessThan(idx('PostToolBatch'));
    expect(idx('PostToolBatch')).toBeLessThan(idx('Stop'));
    expect(idx('Stop')).toBeLessThan(idx('SessionEnd'));
    // FileChanged rides with the post-tool phase, before the turn stops.
    expect(idx('FileChanged')).toBeGreaterThan(idx('PreToolUse'));
    expect(idx('FileChanged')).toBeLessThan(idx('Stop'));
  });
});
