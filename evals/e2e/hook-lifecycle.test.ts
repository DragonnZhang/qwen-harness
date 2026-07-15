import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main, type CliDeps } from '@qwen-harness/cli';
import { freezeCapabilities, type ModelProvider } from '@qwen-harness/provider-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Lifecycle hook events fire end to end (HK-01, partial).
 *
 * Historically only PreToolUse/PostToolUse and a few session events fired; most of the 30 events were
 * defined but never dispatched. This proves two newly-wired ones actually FIRE on a real run:
 * `SessionStart` at the start of a fresh session, and `PostToolBatch` after a round's tools settle.
 * Each hook writes a marker so its firing is observable without parsing the durable log.
 */

describe('SessionStart and PostToolBatch fire on a real run (HK-01)', () => {
  let cwd: string;

  const marker = (name: string): string => join(cwd, `${name}.marker`);

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'qh-hooklc-'));
    writeFileSync(join(cwd, 'data.txt'), 'hello\n');
    mkdirSync(join(cwd, '.qwen-harness'), { recursive: true });

    // A distinct hook script per event: write its marker, then emit a no-op `continue` outcome.
    const script = (name: string): string => {
      const p = join(cwd, `hook-${name}.sh`);
      writeFileSync(
        p,
        `#!/bin/sh\ncat > /dev/null\ntouch '${marker(name)}'\nexec echo '{"type":"continue"}'\n`,
      );
      chmodSync(p, 0o755);
      return p;
    };

    writeFileSync(
      join(cwd, '.qwen-harness', 'hooks.json'),
      JSON.stringify({
        version: 1,
        hooks: [
          {
            id: 'on-start',
            event: 'SessionStart',
            handler: { type: 'command', command: script('start') },
          },
          {
            id: 'on-batch',
            event: 'PostToolBatch',
            handler: { type: 'command', command: script('batch') },
          },
          {
            id: 'on-request',
            event: 'PermissionRequest',
            handler: { type: 'command', command: script('request') },
          },
          {
            id: 'on-denied',
            event: 'PermissionDenied',
            handler: { type: 'command', command: script('denied') },
          },
          {
            id: 'on-setup',
            event: 'Setup',
            handler: { type: 'command', command: script('setup') },
          },
        ],
      }),
    );
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  const CAPS = freezeCapabilities({
    textStreaming: true,
    reasoningSummary: false,
    reasoningEffortGranularity: 'none',
    incrementalToolArgs: false,
    background: false,
    structuredOutput: false,
    toolStream: false,
  });

  it('writes both the SessionStart and PostToolBatch markers', async () => {
    // Round 1 runs a read-only tool (a real batch → PostToolBatch); round 2 concludes the turn.
    let round = 0;
    const p: ModelProvider = {
      capabilities: CAPS,
      async *stream() {
        round += 1;
        if (round === 1) {
          yield {
            type: 'tool-call-complete',
            itemId: 'it_1',
            callId: 'call_1',
            toolName: 'read_file',
            argumentsJson: JSON.stringify({ path: 'data.txt' }),
            arguments: { path: 'data.txt' },
          };
          yield { type: 'done', finishReason: 'tool_calls' };
        } else {
          yield { type: 'text-done', itemId: 'it_2', text: 'done' };
          yield { type: 'done', finishReason: 'stop' };
        }
      },
    };

    const deps: CliDeps = {
      argv: ['run', '--profile', 'yolo', 'read the file'],
      env: {},
      cwd,
      now: () => 1_700_000_000_000,
      stdout: () => {},
      stderr: () => {},
      provider: p,
    };
    await main(deps);

    expect(existsSync(marker('start')), 'SessionStart hook fired').toBe(true);
    expect(existsSync(marker('batch')), 'PostToolBatch hook fired').toBe(true);
  });

  const shellProvider = (): ModelProvider => ({
    capabilities: CAPS,
    async *stream() {
      const args = { command: '/usr/bin/env', argv: ['node', '-e', '0'], cwd: '.' };
      yield {
        type: 'tool-call-complete',
        itemId: 'it_1',
        callId: 'call_1',
        toolName: 'run_shell',
        argumentsJson: JSON.stringify(args),
        arguments: args,
      };
      yield { type: 'done', finishReason: 'tool_calls' };
    },
  });

  const runShell = (profile: string): CliDeps => ({
    argv: ['run', '--json', '--profile', profile, 'run a shell'],
    env: {},
    cwd,
    now: () => 1_700_000_000_000,
    stdout: () => {},
    stderr: () => {},
    provider: shellProvider(),
  });

  it('fires PermissionRequest when an ask-profile tool needs approval', async () => {
    await main(runShell('ask')); // shell under `ask` → approval requested (then suspends)
    expect(existsSync(marker('request')), 'PermissionRequest hook fired').toBe(true);
  });

  it('fires PermissionDenied when a plan-profile tool is refused', async () => {
    await main(runShell('plan')); // shell under `plan` → hard policy deny
    expect(existsSync(marker('denied')), 'PermissionDenied hook fired').toBe(true);
  });

  it('fires Setup only on the FIRST run in a workspace', async () => {
    const textDeps = (): CliDeps => ({
      argv: ['run', '--profile', 'yolo', 'hello'],
      env: {},
      cwd,
      now: () => 1_700_000_000_000,
      stdout: () => {},
      stderr: () => {},
      provider: {
        capabilities: CAPS,
        async *stream() {
          yield { type: 'text-done', itemId: 'it_1', text: 'ok' };
          yield { type: 'done', finishReason: 'stop' };
        },
      },
    });

    // First run: no session store yet → Setup fires.
    await main(textDeps());
    expect(existsSync(marker('setup')), 'Setup fired on first run').toBe(true);

    // Delete the marker and run again: the store now exists, so Setup does NOT fire a second time.
    rmSync(marker('setup'));
    await main(textDeps());
    expect(existsSync(marker('setup')), 'Setup did not re-fire on the second run').toBe(false);
  });
});
