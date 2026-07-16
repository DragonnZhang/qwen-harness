import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main, type CliDeps } from '@qwen-harness/cli';
import { freezeCapabilities, type ModelProvider } from '@qwen-harness/provider-core';
import { EventStore } from '@qwen-harness/storage';
import { ManualClock, SequentialIds } from '@qwen-harness/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Large tool output is durably offloaded, end to end (TL-10).
 *
 * A real run reads a large file over several rounds. Once a big result is no longer among the recent
 * few, cheap reduction offloads its full payload to the durable blob store (keyed by a content digest)
 * and leaves a bounded preview inline — so the model conversation stays small while nothing is lost.
 * The golden assertion: after the run, the blob store actually holds offloaded payloads, and the
 * durable tool-results are still intact.
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

describe('durable tool-output offload (TL-10)', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'qh-offload-'));
    // Distinct files, each exceeding the 4096-char offload threshold. Distinct so the reads are not
    // identical calls (which would trip the repeated-call loop guard before any offload).
    for (let i = 0; i < 6; i++) {
      writeFileSync(join(cwd, `big${i}.txt`), `file ${i} `.repeat(600));
    }
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  // Reads the big file for the first N rounds (each a large tool result), then concludes.
  const readingProvider = (rounds: number): ModelProvider => {
    let n = 0;
    return {
      capabilities: CAPS,
      async *stream() {
        n += 1;
        if (n <= rounds) {
          const args = { path: `big${n - 1}.txt` }; // a DIFFERENT file each round
          yield {
            type: 'tool-call-complete',
            itemId: `it_${n}`,
            callId: `call_${n}`,
            toolName: 'read_file',
            argumentsJson: JSON.stringify(args),
            arguments: args,
          };
          yield { type: 'done', finishReason: 'tool_calls' };
        } else {
          yield { type: 'text-done', itemId: 'done', text: 'read enough' };
          yield { type: 'done', finishReason: 'stop' };
        }
      },
    };
  };

  it('offloads old large tool results to the durable blob store, keeping tool-results intact', async () => {
    const deps: CliDeps = {
      argv: ['run', '--profile', 'yolo', 'keep reading the big file'],
      env: {},
      cwd,
      now: () => 1_700_000_000_000,
      stdout: () => {},
      stderr: () => {},
      provider: readingProvider(6), // 6 large reads → the oldest fall past the recent window
    };
    const code = await main(deps);
    expect(code).toBe(0);

    // Reopen the durable store the run wrote and inspect it.
    const store = new EventStore({
      path: join(cwd, '.qwen-harness', 'sessions.sqlite'),
      clock: new ManualClock(0),
      ids: new SequentialIds(),
    });
    try {
      // Offloaded payloads were persisted to the blob store (keyed by content digest, `blb_…`).
      const blobs = store.db.prepare('SELECT COUNT(*) AS n FROM blobs').get() as { n: number };
      expect(blobs.n).toBeGreaterThan(0);

      // The durable tool-results themselves are intact — offload trims the MODEL conversation, it does
      // not delete history.
      const toolResults = store
        .readAll()
        .map((e) => e.payload)
        .filter((p) => p.type === 'item-appended' && p.item.type === 'tool-result');
      expect(toolResults.length).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });
});
