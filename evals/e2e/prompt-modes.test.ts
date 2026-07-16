import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main, type CliDeps } from '@qwen-harness/cli';
import { freezeCapabilities, type ModelProvider } from '@qwen-harness/provider-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The `--prompt-mode` CLI contract, end to end (IN-09, E).
 *
 * A golden path over the real `main()`: every activatable mode runs a normal turn to a clean exit, an
 * unknown mode is rejected with a non-zero code, and `agent-defined` — which a direct run has no
 * definition to satisfy — is refused rather than silently degraded. This pins the operator-facing
 * surface: `qwen-harness run --prompt-mode <m>` behaves the same way every time.
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

/** A provider that concludes immediately with text — no tools, so every mode reaches a clean stop. */
const textProvider = (): ModelProvider => ({
  capabilities: CAPS,
  async *stream() {
    yield { type: 'text-done', itemId: 'it_1', text: 'acknowledged' };
    yield { type: 'done', finishReason: 'stop' };
  },
});

describe('the --prompt-mode CLI contract (IN-09, E)', () => {
  let cwd: string;
  let err: string[];
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'qh-mode-e2e-'));
    err = [];
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  const run = (extra: string[]): Promise<number> => {
    const deps: CliDeps = {
      argv: ['run', ...extra, 'say hello'],
      env: {},
      cwd,
      now: () => 1_700_000_000_000,
      stdout: () => {},
      stderr: (s) => err.push(s),
      provider: textProvider(),
    };
    return main(deps);
  };

  it('every activatable mode runs a normal turn to a clean exit', async () => {
    for (const mode of ['minimal', 'default', 'proactive', 'coordinator']) {
      expect(await run(['--prompt-mode', mode]), `mode ${mode} should exit 0`).toBe(0);
    }
  });

  it('an unknown mode is rejected with a non-zero code and a clear message', async () => {
    expect(await run(['--prompt-mode', 'turbo'])).toBe(1);
    expect(err.join('\n')).toContain('unknown prompt mode');
  });

  it('agent-defined is refused in a direct run (no agent definition to satisfy it)', async () => {
    expect(await run(['--prompt-mode', 'agent-defined'])).toBe(1);
    expect(err.join('\n')).toContain('agent-defined');
  });
});
