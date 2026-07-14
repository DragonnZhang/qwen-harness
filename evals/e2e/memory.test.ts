import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main, type CliDeps } from '@qwen-harness/cli';
import { freezeCapabilities, type ModelProvider } from '@qwen-harness/provider-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * MM-02 (E) — long-term memory retrieval, end to end through the REAL CLI run path.
 *
 * A golden scenario: two memories are stored through the real `memory add` command, then a turn runs
 * whose prompt matches ONE of them. The turn goes through the production path — memory load, budgeted
 * side-selection (5 files / 50 KiB), and system-prompt composition — and the model receives the
 * RELEVANT memory in its instructions and NOT the unrelated one. Only the model is replaced (a
 * capturing scripted provider that records the instructions it is sent); everything else — the store,
 * the memory surface, the prompt composer, the turn engine — is the real CLI.
 */

describe('memory retrieval end to end (MM-02)', () => {
  let cwd: string;
  let captured: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'qh-mem-e2e-'));
    captured = '';
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  const capturingProvider = (): ModelProvider => ({
    capabilities: freezeCapabilities({
      textStreaming: true,
      reasoningSummary: false,
      reasoningEffortGranularity: 'none',
      incrementalToolArgs: false,
      background: false,
      structuredOutput: false,
      toolStream: false,
    }),
    async *stream(request) {
      captured = request.instructions;
      yield { type: 'text-done', itemId: 'm', text: 'done' };
      yield { type: 'done', finishReason: 'stop' };
    },
  });

  const deps = (argv: string[], provider?: ModelProvider): CliDeps => ({
    argv,
    env: {},
    cwd,
    now: () => 1_700_000_000_000,
    stdout: () => {},
    stderr: () => {},
    ...(provider ? { provider } : {}),
  });

  it('stores memories, then a matching turn injects the RELEVANT one into the model prompt', async () => {
    // Seed two memories through the real `memory add` command.
    expect(
      await main(
        deps([
          'memory',
          'add',
          '--name',
          'pnpm-workflow',
          '--description',
          'Build and test with pnpm',
          'Run pnpm build then pnpm test before committing.',
        ]),
      ),
    ).toBe(0);
    expect(
      await main(
        deps([
          'memory',
          'add',
          '--name',
          'kube-deploy',
          '--description',
          'Kubernetes deployment manifests',
          'Apply k8s manifests with kubectl.',
        ]),
      ),
    ).toBe(0);

    // Run a turn whose prompt overlaps ONLY the pnpm memory on side-selection.
    const code = await main(
      deps(['run', 'how do I build and test this project'], capturingProvider()),
    );
    expect(code).toBe(0);

    // The relevant memory reached the model's instructions...
    expect(captured).toContain('pnpm-workflow');
    expect(captured).toContain('Build and test with pnpm');
    // ...and the unrelated memory was NOT selected (budgeted side-selection kept it out).
    expect(captured).not.toContain('kube-deploy');
    expect(captured).not.toContain('Kubernetes');
  });
});
