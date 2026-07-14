import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main, type CliDeps } from '@qwen-harness/cli';
import { freezeCapabilities, type ModelProvider } from '@qwen-harness/provider-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Fork and export, end to end through the REAL CLI (SS-03).
 *
 * A turn creates a session; `fork` makes a NEW session that records its lineage while the original is
 * untouched; `export` emits the stable public JSONL schema. Only the model is a scripted provider;
 * the store, fork, and export are the real CLI.
 */

describe('session fork + export end to end (SS-03)', () => {
  let cwd: string;
  let out: string[];

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'qh-sessions-e2e-'));
    out = [];
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
      yield { type: 'text-done', itemId: 'm', text: 'done' };
      yield { type: 'done', finishReason: 'stop' };
    },
  });

  const deps = (argv: string[], p?: ModelProvider): CliDeps => ({
    argv,
    env: {},
    cwd,
    now: () => 1_700_000_000_000,
    stdout: (l) => out.push(l),
    stderr: () => {},
    ...(p ? { provider: p } : {}),
  });

  it('run → fork (new identity + lineage, original untouched) → export (stable JSONL)', async () => {
    // A real turn creates a session.
    expect(await main(deps(['run', 'hello'], provider()))).toBe(0);

    // Find the session id.
    out.length = 0;
    await main(deps(['sessions']));
    const original = out.join('\n').match(/thr_\w+/)?.[0];
    expect(original).toBeDefined();

    // Fork it: the command reports a NEW id.
    out.length = 0;
    expect(await main(deps(['fork', original!]))).toBe(0);
    const forkLine = out.join('\n');
    expect(forkLine).toMatch(/forked thr_\w+ -> thr_\w+ \(\d+ events copied\)/);
    const forkId = forkLine.match(/-> (thr_\w+)/)?.[1];
    expect(forkId).toBeDefined();
    expect(forkId).not.toBe(original);

    // The listing now shows two sessions, and the fork records its lineage; the original does not.
    out.length = 0;
    await main(deps(['sessions']));
    const listing = out.join('\n');
    expect(listing).toContain(original!);
    expect(listing).toContain(forkId!);
    expect(listing).toMatch(new RegExp(`${forkId}\\b.*\\(forked from ${original}\\)`));
    expect(listing).not.toMatch(new RegExp(`${original}\\b[^\\n]*forked from`));

    // Export the original as the stable public JSONL schema.
    out.length = 0;
    expect(await main(deps(['export', original!]))).toBe(0);
    const lines = out
      .join('\n')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    const header = JSON.parse(lines[0]!) as { format: string; threadId: string };
    expect(header.format).toBe('qwen-harness/jsonl');
    expect(header.threadId).toBe(original);
  });
});
