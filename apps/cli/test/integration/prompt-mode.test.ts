import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main, type CliDeps } from '@qwen-harness/cli';
import { modeChangesAuthority } from '@qwen-harness/instructions';
import { freezeCapabilities, type ModelProvider } from '@qwen-harness/provider-core';
import { EventStore } from '@qwen-harness/storage';
import { ManualClock, SequentialIds } from '@qwen-harness/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * A prompt mode's tool restriction is REAL, not cosmetic (IN-09, I).
 *
 * `coordinator` is `no-mutation`: the lead delegates change and reviews it, and must not mutate the
 * workspace directly. This drives the actual `main()` run and proves the restriction is enforced by
 * the executable pipeline — a coordinator that tries to `write_file` is refused and no file appears —
 * while an otherwise identical `default` run performs the same write. Crucially, the mode changes only
 * what tools are visible: it never touches authority (the profile the run resolves under is unchanged).
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

/** A provider that asks to write a file on its first round, then finishes. */
const writeProvider = (): ModelProvider => {
  let n = 0;
  return {
    capabilities: CAPS,
    async *stream() {
      n += 1;
      if (n === 1) {
        const args = { path: 'out.txt', content: 'mutated\n' };
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

describe('prompt-mode tool restriction is enforced by the pipeline (IN-09, I)', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'qh-mode-'));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  const events = (dir: string) => {
    const store = new EventStore({
      path: join(dir, '.qwen-harness', 'sessions.sqlite'),
      clock: new ManualClock(0),
      ids: new SequentialIds(),
    });
    try {
      return store.readAll();
    } finally {
      store.close();
    }
  };
  const writeResult = (evs: ReturnType<typeof events>) =>
    evs.find(
      (e) =>
        e.payload.type === 'item-appended' &&
        e.payload.item.type === 'tool-result' &&
        e.payload.item.toolName === 'write_file',
    )?.payload;

  it('coordinator (no-mutation) refuses a write; the file never appears', async () => {
    const deps: CliDeps = {
      argv: ['run', '--profile', 'yolo', '--prompt-mode', 'coordinator', 'edit the file'],
      env: {},
      cwd,
      now: () => 1_700_000_000_000,
      stdout: () => {},
      stderr: () => {},
      provider: writeProvider(),
    };
    expect(await main(deps)).toBe(0);

    // The mutation did NOT happen: coordinator handed the pipeline no write tool.
    expect(existsSync(join(cwd, 'out.txt'))).toBe(false);
    // ...and the refusal is RECORDED: the write_file call resolved to a failed tool-result, so the
    // model was told "no" by the pipeline rather than the call silently vanishing.
    const wr = writeResult(events(cwd));
    expect(wr, 'the write_file call is audited').toBeDefined();
    expect(wr?.type === 'item-appended' && wr.item.type === 'tool-result' && wr.item.ok).toBe(
      false,
    );
  });

  it('default mode performs the same write (the restriction is the mode, not the harness)', async () => {
    const deps: CliDeps = {
      argv: ['run', '--profile', 'yolo', 'edit the file'],
      env: {},
      cwd,
      now: () => 1_700_000_000_000,
      stdout: () => {},
      stderr: () => {},
      provider: writeProvider(),
    };
    expect(await main(deps)).toBe(0);
    expect(existsSync(join(cwd, 'out.txt'))).toBe(true);
    const wr = writeResult(events(cwd));
    expect(wr?.type === 'item-appended' && wr.item.type === 'tool-result' && wr.item.ok).toBe(true);
  });

  it('the mode never changes authority (policy inheritance is frozen at inherit-unchanged)', () => {
    // The whole table asserts this as data; the run above relies on it. No mode elevates or lowers
    // permission — a `coordinator` run under `yolo` is still a `yolo` run, only with fewer tools.
    for (const mode of [
      'minimal',
      'default',
      'proactive',
      'coordinator',
      'agent-defined',
    ] as const) {
      expect(modeChangesAuthority(mode)).toBe(false);
    }
  });
});
