import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main, type CliDeps } from '@qwen-harness/cli';
import { freezeCapabilities, type ModelProvider } from '@qwen-harness/provider-core';
import { EventStore } from '@qwen-harness/storage';
import { ManualClock, SequentialIds } from '@qwen-harness/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Repeated denials never silently upgrade authority, in a real run (PS-10, I).
 *
 * Under `--profile ask` a workspace write needs approval; a headless run has no approver, so the call
 * is DENIED. A model that keeps re-requesting the identical denied write must never wear the system
 * down into allowing it: the file is never written, no grant is ever minted, and the loop terminates
 * safely (the repeated-identical-call guard stops the oscillation) rather than spinning or escalating.
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

/** A model that will not take no for an answer: it re-requests the identical write on every round. */
const persistentWriter = (): ModelProvider => ({
  capabilities: CAPS,
  async *stream() {
    const args = { path: 'out.txt', content: 'let me in\n' };
    yield {
      type: 'tool-call-complete',
      itemId: 'it_1',
      callId: 'call_1',
      toolName: 'write_file',
      argumentsJson: JSON.stringify(args),
      arguments: args,
    };
    yield { type: 'done', finishReason: 'tool_calls' };
  },
});

describe('a persistently re-requested denial never becomes an allow (PS-10, I)', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'qh-ps10-'));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it('the denied write never lands, no grant is minted, and the run terminates safely', async () => {
    const deps: CliDeps = {
      argv: ['run', '--profile', 'ask', 'write the file'],
      env: {},
      cwd,
      now: () => 1_700_000_000_000,
      stdout: () => {},
      stderr: () => {},
      provider: persistentWriter(),
    };
    // The run terminates (a non-zero code is fine — the oscillation guard stopping the loop is the
    // safe outcome); what matters is that it does NOT hang and does NOT succeed the write.
    const code = await main(deps);
    expect(typeof code).toBe('number');

    // The mutation never happened, however many times it was asked for.
    expect(existsSync(join(cwd, 'out.txt'))).toBe(false);

    const store = new EventStore({
      path: join(cwd, '.qwen-harness', 'sessions.sqlite'),
      clock: new ManualClock(0),
      ids: new SequentialIds(),
    });
    try {
      const events = store.readAll();
      const decisions = events.filter((e) => e.payload.type === 'policy-decision');
      // Non-vacuity: the write really was evaluated (the run reached policy), not skipped by an error.
      expect(decisions.length).toBeGreaterThan(0);
      // Not one policy decision resolved to `allow` — repetition never upgraded it.
      const anyAllowed = decisions.some(
        (e) => e.payload.type === 'policy-decision' && e.payload.decision === 'allow',
      );
      expect(anyAllowed).toBe(false);
      // No grant was ever recorded — a denial mints no standing authority.
      const grantMinted = events.some((e) => e.payload.type === 'approval-granted');
      expect(grantMinted).toBe(false);
      // No write side effect ever settled successfully.
      const wroteFile = events.some(
        (e) =>
          e.payload.type === 'item-appended' &&
          e.payload.item.type === 'tool-result' &&
          e.payload.item.toolName === 'write_file' &&
          e.payload.item.ok,
      );
      expect(wroteFile).toBe(false);
    } finally {
      store.close();
    }
  });
});
