import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main, type CliDeps } from '@qwen-harness/cli';
import { freezeCapabilities, type ModelProvider } from '@qwen-harness/provider-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * IN-06 (E) — repository instructions, end to end through the REAL CLI run path.
 *
 * A golden scenario: a repo-root `AGENTS.md` is authored, then a turn runs. The instructions are
 * discovered, resolved by precedence, and composed into the system prompt — all the production path —
 * and the model receives the repo's convention in its instructions. The same file is visible with its
 * provenance through the `instructions` inspect command. Only the model is replaced (a capturing
 * scripted provider); everything else is the real CLI.
 */

const CONVENTION = 'PROJECT CONVENTION: prefer tabs over spaces in this repository.';

describe('repository instructions end to end (IN-06)', () => {
  let cwd: string;
  let captured: string;
  let out: string[];

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'qh-instr-e2e-'));
    captured = '';
    out = [];
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
    stdout: (l) => out.push(l),
    stderr: () => {},
    ...(provider ? { provider } : {}),
  });

  it('composes the repo AGENTS.md into the model prompt and shows it with provenance', async () => {
    writeFileSync(join(cwd, 'AGENTS.md'), `# Repo rules\n\n${CONVENTION}\n`);

    // A real turn: the repo convention must reach the model's instructions.
    const code = await main(deps(['run', 'write a function'], capturingProvider()));
    expect(code).toBe(0);
    expect(captured).toContain(CONVENTION);

    // The same file is inspectable with its provenance (scope + path).
    out.length = 0;
    expect(await main(deps(['instructions']))).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('AGENTS.md');
    expect(text).toContain('repo-root');
  });
});
