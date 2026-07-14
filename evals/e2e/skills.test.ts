import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main, type CliDeps } from '@qwen-harness/cli';
import {
  freezeCapabilities,
  type ModelInputItem,
  type ModelProvider,
} from '@qwen-harness/provider-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Skills, end to end through the REAL CLI (IN-01 two-level loading, IN-04 strict validation).
 *
 * Two-level loading is the whole point: the CATALOG is built from frontmatter alone (no body read),
 * and a skill's BODY is loaded only when it is INVOKED. This golden task proves both halves in a real
 * run: `skills` lists a valid skill by its metadata and reports an invalid one, then `run --skill`
 * loads that skill's body and feeds it to the model. Only the model is replaced (a capturing scripted
 * provider); the discovery, registry, precedence, and invocation are the real CLI.
 */

const BODY_MARKER = 'SKILLBODYMARKER-summarize-in-three-bullets';

function writeSkill(cwd: string, dir: string, frontmatter: string, body: string): void {
  const d = join(cwd, '.qwen-harness', 'skills', dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}\n`);
}

describe('skills end to end (IN-01, IN-04)', () => {
  let cwd: string;
  let out: string[];
  let err: string[];
  let capturedInput: readonly ModelInputItem[];

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'qh-skills-e2e-'));
    out = [];
    err = [];
    capturedInput = [];
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
      capturedInput = request.input;
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
    stderr: (l) => err.push(l),
    ...(provider ? { provider } : {}),
  });

  it('catalogs by metadata, reports an invalid skill, and loads a body only on invocation', async () => {
    writeSkill(
      cwd,
      'summarize',
      'name: summarize\ndescription: Summarize the work concisely\nuser-invocable: true',
      `${BODY_MARKER}: when summarizing, use exactly three bullets.`,
    );
    writeSkill(cwd, 'broken', 'name: broken', 'no description — invalid frontmatter');

    // 1. The catalog is built from frontmatter: the valid skill is listed, the invalid one reported.
    expect(await main(deps(['skills']))).toBe(0);
    expect(out.join('\n')).toContain('summarize');
    expect(err.join('\n')).toMatch(/broken/);

    // 2. Invoking the skill loads its BODY and feeds it to the model — the second level of loading.
    out.length = 0;
    const code = await main(
      deps(['run', '--skill', 'summarize', 'do the task'], capturingProvider()),
    );
    expect(code).toBe(0);
    const inputText = JSON.stringify(capturedInput);
    expect(inputText).toContain(BODY_MARKER); // the body reached the model
    expect(inputText).toContain('do the task'); // alongside the user's own prompt
  });
});
