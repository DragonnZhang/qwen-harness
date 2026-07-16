import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main, type CliDeps } from '@qwen-harness/cli';
import { TerminationReasonSchema } from '@qwen-harness/protocol';
import { freezeCapabilities, type ModelProvider } from '@qwen-harness/provider-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * A turn that OSCILLATES terminates with the typed `oscillation` reason (ER-06, I).
 *
 * The model alternates between two DISTINCT tool calls forever — `read a`, `read b`, `read a`, ... —
 * so it never trips the consecutive-identical detector (each call differs from the one before) and
 * never trips no-progress (each round makes a call). It is still hopelessly stuck, and the runtime
 * names that pathology exactly, end to end, in the headless JSON result.
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

const oscillatingProvider = (): ModelProvider => {
  let n = 0;
  return {
    capabilities: CAPS,
    async *stream() {
      const path = n % 2 === 0 ? 'a.txt' : 'b.txt';
      n += 1;
      const args = { path };
      yield {
        type: 'tool-call-complete',
        itemId: `it_${n}`,
        callId: `call_${n}`,
        toolName: 'read_file',
        argumentsJson: JSON.stringify(args),
        arguments: args,
      };
      yield { type: 'done', finishReason: 'tool_calls' };
    },
  };
};

describe('an oscillating turn terminates with a typed reason (ER-06, I)', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'qh-oscillate-'));
    writeFileSync(join(cwd, 'a.txt'), 'a\n');
    writeFileSync(join(cwd, 'b.txt'), 'b\n');
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it('stops the A-B-A-B loop with oscillation, distinct from repeated-identical-calls', async () => {
    const out: string[] = [];
    const deps: CliDeps = {
      argv: ['run', '--json', '--profile', 'yolo', 'keep flip-flopping'],
      env: {},
      cwd,
      now: () => 1_700_000_000_000,
      stdout: (l) => out.push(l),
      stderr: () => {},
      provider: oscillatingProvider(),
    };

    await main(deps);

    const parsed = JSON.parse(out[0]!) as { state: string; reason: string };
    expect(TerminationReasonSchema.safeParse(parsed.reason).success).toBe(true);
    expect(parsed.reason).toBe('oscillation');
  });
});
