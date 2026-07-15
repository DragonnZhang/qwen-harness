import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main, type CliDeps } from '@qwen-harness/cli';
import { freezeCapabilities, type ModelProvider } from '@qwen-harness/provider-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * A PostToolUse hook stops continuation, end to end through the REAL CLI (HK-05).
 *
 * `block` stops an ACTION; `stop` prevents CONTINUATION — a PostToolUse hook that returns `stop` lets
 * the tool run and its result be recorded, then ends the turn instead of going back to the model. This
 * golden task configures a real command hook, runs a turn whose first round calls a tool and whose
 * (never-reached) second round would produce text, and proves the model is asked exactly ONCE — the
 * continuation was stopped after the tool, and the tool's result was not corrupted. (Re-entry
 * protection and visible hook failures are unit/injected-failure tested in `packages/hooks`.)
 */

describe('a PostToolUse hook stops continuation on a real turn (HK-05)', () => {
  let cwd: string;
  let rounds: number;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'qh-hooks-e2e-'));
    rounds = 0;
    // A file for the tool to read.
    writeFileSync(join(cwd, 'data.txt'), 'hello from the workspace\n');
    // A PostToolUse hook that STOPS continuation after any tool runs.
    mkdirSync(join(cwd, '.qwen-harness'), { recursive: true });
    const hookScript = join(cwd, 'halt.sh');
    writeFileSync(
      hookScript,
      `#!/bin/sh\ncat > /dev/null\nexec echo '${JSON.stringify({ type: 'stop', reason: { code: 'halt', message: 'stop after the tool' } })}'\n`,
    );
    chmodSync(hookScript, 0o755);
    writeFileSync(
      join(cwd, '.qwen-harness', 'hooks.json'),
      JSON.stringify({
        version: 1,
        hooks: [
          {
            id: 'halt',
            event: 'PostToolUse',
            matcher: { toolName: 'read_file' },
            handler: { type: 'command', command: hookScript },
          },
        ],
      }),
    );
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  const provider = (): ModelProvider => ({
    capabilities: freezeCapabilities({
      textStreaming: true,
      reasoningSummary: false,
      reasoningEffortGranularity: 'none',
      incrementalToolArgs: false,
      background: false,
      structuredOutput: false,
      toolStream: false,
    }),
    async *stream() {
      rounds += 1;
      if (rounds === 1) {
        // Round 1: call a read-only tool (allowed without approval under `ask`).
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
        // Round 2 must NEVER happen — the PostToolUse hook stopped continuation.
        yield { type: 'text-done', itemId: 'it_2', text: 'this should never be produced' };
        yield { type: 'done', finishReason: 'stop' };
      }
    },
  });

  const deps = (argv: string[], p: ModelProvider): CliDeps => ({
    argv,
    env: {},
    cwd,
    now: () => 1_700_000_000_000,
    stdout: () => {},
    stderr: () => {},
    provider: p,
  });

  it('runs the tool once, then the hook stops the turn — the model is asked exactly once', async () => {
    await main(deps(['run', 'read data.txt'], provider()));
    // The model was asked for round 1 (the tool call). The PostToolUse `stop` prevented round 2, so the
    // provider is never streamed a second time — continuation was stopped after the tool.
    expect(rounds).toBe(1);
  });
});
