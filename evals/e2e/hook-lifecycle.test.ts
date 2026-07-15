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
});
