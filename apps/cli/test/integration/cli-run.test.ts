import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ModelProvider, ProviderStreamEvent } from '@qwen-harness/provider-core';
import { freezeCapabilities } from '@qwen-harness/provider-core';
import { EventStore } from '@qwen-harness/storage';
import { ToolWorkerClient } from '@qwen-harness/tool-worker';
import { CANARY_API_KEY, SequentialIds } from '@qwen-harness/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHarnessRuntime, runDoctor } from '../../src/index.ts';

/**
 * The CLI composition, driven by a SCRIPTED provider so the coding loop is deterministic, but with
 * the REAL sandbox, real policy, real storage, and real tool pipeline underneath. This is the
 * headless golden path: no terminal, stable result, reproducible every run (UI-15).
 */

const client = new ToolWorkerClient();
const available = client.detect().available;

function scriptedProvider(rounds: ProviderStreamEvent[][]): ModelProvider {
  let i = 0;
  return {
    capabilities: freezeCapabilities({
      textStreaming: true,
      reasoningSummary: true,
      reasoningEffortGranularity: 'graded',
      incrementalToolArgs: false,
      background: false,
      structuredOutput: false,
      toolStream: false,
    }),
    async *stream() {
      const round = rounds[i++] ?? [{ type: 'done', finishReason: 'stop' }];
      for (const e of round) yield e;
    },
  };
}

function toolCall(
  callId: string,
  name: string,
  args: Record<string, unknown>,
): ProviderStreamEvent {
  return {
    type: 'tool-call-complete',
    itemId: `it_${callId}`,
    callId,
    toolName: name,
    argumentsJson: JSON.stringify(args),
    arguments: args,
  };
}

describe('CLI headless coding loop (deterministic, real sandbox)', () => {
  it('the sandbox is available', () => {
    expect(available, client.detect().detail).toBe(true);
  });

  let workspace: string;
  let store: EventStore;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'qh-cli-'));
    writeFileSync(join(workspace, 'math.mjs'), 'export const multiply = (a, b) => a + b;\n');
    writeFileSync(
      join(workspace, 'math.test.mjs'),
      "import assert from 'node:assert';\nimport { multiply } from './math.mjs';\nassert.equal(multiply(6, 7), 42);\nconsole.log('PASS');\n",
    );
    execFileSync('git', ['init', '-q'], { cwd: workspace });
    execFileSync('git', ['add', '-A'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-qm', 'init'], {
      cwd: workspace,
    });

    const ids = new SequentialIds();
    store = new EventStore({
      path: ':memory:',
      clock: { now: () => 1_700_000_000_000, sleep: () => Promise.resolve() },
      ids,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it('runs a scripted fix loop end to end and the fix lands on disk', async () => {
    const ids = new SequentialIds();
    const threadId = 'thr_000001' as never;
    const correlationId = 'cor_000001' as never;
    store.append({
      threadId,
      correlationId,
      permissionProfile: 'yolo',
      actor: { kind: 'user', id: 'act_user01' as never },
      payload: { type: 'thread-created', cwd: workspace, canonicalRepo: workspace, name: null },
    });

    // The scripted model: read, edit, run the test, then conclude.
    const provider = scriptedProvider([
      [
        toolCall('call_read0001', 'read_file', { path: 'math.mjs' }),
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        toolCall('call_edit0001', 'edit_file', {
          path: 'math.mjs',
          oldText: 'a + b',
          newText: 'a * b',
        }),
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        toolCall('call_shel0001', 'run_shell', {
          command: '/usr/bin/env',
          argv: ['node', 'math.test.mjs'],
          cwd: '.',
        }),
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        {
          type: 'text-done',
          itemId: 'm',
          text: 'Fixed: multiply now multiplies, and the test passes.',
        },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);

    const runtime = createHarnessRuntime({
      workspaceRoot: workspace,
      profile: 'yolo',
      model: 'fake',
      instructions: 'fix it',
      homeDir: '/home/nonexistent',
      clock: { now: () => 1_700_000_000_000 },
      ids,
      store,
      provider: provider as never,
      client,
    });

    const result = await runtime.runTurn({ threadId, correlationId, userText: 'fix the bug' });

    expect(result.state).toBe('completed');
    expect(result.finalText).toContain('multiplies');

    // The fix really landed on disk, and the test really passes now.
    expect(readFileSync(join(workspace, 'math.mjs'), 'utf8')).toContain('a * b');
    const testOut = execFileSync('/usr/bin/env', ['node', 'math.test.mjs'], {
      cwd: workspace,
      encoding: 'utf8',
    });
    expect(testOut).toContain('PASS');

    // The durable log recorded the tool results.
    const toolResults = store
      .readThread(threadId)
      .map((e) => e.payload)
      .filter((p) => p.type === 'item-appended');
    expect(toolResults.length).toBeGreaterThan(0);
  });
});

describe('doctor', () => {
  it('reports platform, sandbox, and credential presence without the value', () => {
    const report = runDoctor({
      projectRoot: process.cwd(),
      env: { DASHSCOPE_API_KEY: CANARY_API_KEY },
    });
    const text = report.lines.join('\n');
    expect(text).toContain('sandbox:');
    expect(text).toContain('credential:');
    expect(text).toContain('present');
    // The value is NEVER printed.
    expect(text).not.toContain(CANARY_API_KEY);
  });
});
