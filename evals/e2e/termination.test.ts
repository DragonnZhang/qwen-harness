import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main, type CliDeps } from '@qwen-harness/cli';
import { TerminationReasonSchema } from '@qwen-harness/protocol';
import { freezeCapabilities, type ModelProvider } from '@qwen-harness/provider-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * A real turn that loops terminates with a TYPED reason, surfaced end to end (RT-04).
 *
 * The engine never runs forever and never stops for a vague reason: a model that keeps issuing the
 * identical tool call is a distinct, named pathology (`repeated-identical-calls`), not merely "too
 * long". This golden task scripts exactly that loop through the real `main()`, and asserts the headless
 * JSON result carries a reason that is a member of the `TerminationReason` enum — the same typing the
 * compiler now enforces from the budget through to the durable `turn-ended` event.
 */

describe('a looping turn terminates with a typed reason (RT-04)', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'qh-terminate-'));
    writeFileSync(join(cwd, 'data.txt'), 'anything\n');
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  // A provider that NEVER concludes: every round issues the identical read_file call.
  const loopingProvider = (): ModelProvider => ({
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
      const args = { path: 'data.txt' };
      yield {
        type: 'tool-call-complete',
        itemId: 'it_1',
        callId: 'call_1',
        toolName: 'read_file',
        argumentsJson: JSON.stringify(args),
        arguments: args,
      };
      yield { type: 'done', finishReason: 'tool_calls' };
    },
  });

  it('stops the identical-call loop with repeated-identical-calls, not a vague timeout', async () => {
    const out: string[] = [];
    const deps: CliDeps = {
      argv: ['run', '--json', '--profile', 'yolo', 'keep reading'],
      env: {},
      cwd,
      now: () => 1_700_000_000_000,
      stdout: (l) => out.push(l),
      stderr: () => {},
      provider: loopingProvider(),
    };

    const code = await main(deps);

    const parsed = JSON.parse(out[0]!) as { state: string; reason: string };
    // The reason is a real member of the typed enum — never an untyped or off-enum string.
    expect(TerminationReasonSchema.safeParse(parsed.reason).success).toBe(true);
    // ...and it is the SPECIFIC pathology, so the user learns the loop is stuck, not just slow.
    expect(parsed.reason).toBe('repeated-identical-calls');
    expect(parsed.state).toBe('budget-exhausted');
    // A budget-exhausted run is a non-zero, non-approval exit.
    expect(code).toBe(2);
  });
});
