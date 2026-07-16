import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main, type CliDeps } from '@qwen-harness/cli';
import {
  freezeCapabilities,
  type ModelInputItem,
  type ModelProvider,
} from '@qwen-harness/provider-core';
import { EventStore } from '@qwen-harness/storage';
import { ManualClock, SequentialIds } from '@qwen-harness/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * TL-02 (E): a turn that OFFLOADS a large tool output and then RETRIEVES it, end to end through the
 * real `main()`.
 *
 * The model reads several big files; once the oldest results fall past the recent window, cheap
 * reduction offloads their full payload to the durable blob store and leaves an inline preview that
 * NAMES the reference (`ref=blb_…`). The scripted model then does exactly what a real model would:
 * it reads that ref out of its own context and calls the new `retrieve_output` tool — which runs
 * in-process, reads the blob store by digest, and hands the full content back. The golden assertion
 * is that the retrieval succeeded (ok, with the file's bytes) rather than missing.
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

const REF_MARKER = /\[full result offloaded — ref=(\S+?),/;

function extractOffloadedRef(input: readonly ModelInputItem[]): string | null {
  for (const item of input) {
    if (item.type === 'function-output' && typeof item.output === 'string') {
      const m = REF_MARKER.exec(item.output);
      if (m) return m[1] ?? null;
    }
  }
  return null;
}

describe('retrieve_output fetches an offloaded blob, end to end (TL-02 E)', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'qh-retrieve-'));
    for (let i = 0; i < 6; i++) {
      writeFileSync(join(cwd, `big${i}.txt`), `FILE-${i}-MARKER `.repeat(600));
    }
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it('offloads old large reads, then retrieves one by ref and gets its content back', async () => {
    let retrievedRef: string | null = null;

    const provider: ModelProvider = (() => {
      let n = 0;
      return {
        capabilities: CAPS,
        async *stream(request) {
          n += 1;
          if (n <= 6) {
            // Distinct big reads so nothing trips the repeated-call guard; the oldest get offloaded.
            const args = { path: `big${n - 1}.txt` };
            yield {
              type: 'tool-call-complete',
              itemId: `it_${n}`,
              callId: `call_read_${n}`,
              toolName: 'read_file',
              argumentsJson: JSON.stringify(args),
              arguments: args,
            };
            yield { type: 'done', finishReason: 'tool_calls' };
            return;
          }
          // Once reads are done, look for an offloaded reference in our own context and retrieve it.
          const ref = extractOffloadedRef(request.input);
          if (ref !== null && retrievedRef === null) {
            retrievedRef = ref;
            const args = { ref };
            yield {
              type: 'tool-call-complete',
              itemId: 'it_retrieve',
              callId: 'call_retrieve_1',
              toolName: 'retrieve_output',
              argumentsJson: JSON.stringify(args),
              arguments: args,
            };
            yield { type: 'done', finishReason: 'tool_calls' };
            return;
          }
          yield { type: 'text-done', itemId: 'done', text: 'done retrieving' };
          yield { type: 'done', finishReason: 'stop' };
        },
      };
    })();

    const deps: CliDeps = {
      argv: ['run', '--profile', 'yolo', 'read the big files then retrieve one'],
      env: {},
      cwd,
      now: () => 1_700_000_000_000,
      stdout: () => {},
      stderr: () => {},
      provider,
    };
    const code = await main(deps);
    expect(code).toBe(0);

    // A ref was actually offloaded and the model actually called retrieve_output on it.
    expect(retrievedRef).toMatch(/^blb_/);

    const store = new EventStore({
      path: join(cwd, '.qwen-harness', 'sessions.sqlite'),
      clock: new ManualClock(0),
      ids: new SequentialIds(),
    });
    try {
      const retrieveResult = store
        .readAll()
        .map((e) => e.payload)
        .find(
          (p) =>
            p.type === 'item-appended' &&
            p.item.type === 'tool-result' &&
            p.item.callId === 'call_retrieve_1',
        );
      expect(retrieveResult).toBeTruthy();
      if (retrieveResult && retrieveResult.type === 'item-appended') {
        const item = retrieveResult.item;
        // The retrieval SUCCEEDED — the blob was found and its content (the file's marker) returned.
        expect(item.type === 'tool-result' && item.ok).toBe(true);
        expect(item.type === 'tool-result' && item.errorCategory).toBeNull();
        expect(item.type === 'tool-result' ? item.preview : '').toMatch(/FILE-\d-MARKER/);
      }
    } finally {
      store.close();
    }
  });
});
