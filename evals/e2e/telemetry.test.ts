import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main, type CliDeps } from '@qwen-harness/cli';
import { freezeCapabilities, type ModelProvider } from '@qwen-harness/provider-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * OB-01 (E) — the local structured trace, end to end through the REAL CLI run path.
 *
 * A golden scenario: telemetry is opted in via config, then a turn runs. The production path writes a
 * redacted JSONL trace, and we read it back and prove it recorded the real run — the turn lifecycle,
 * the model parameters (model, tools offered), the user's items, and usage. Only the model is replaced
 * (a scripted provider); the tracer, sink, and every decorator are the real ones.
 */

interface TraceRecord {
  ts: number;
  level: string;
  category: string;
  message: string;
  fields: Record<string, unknown>;
}

describe('local structured trace end to end (OB-01)', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'qh-trace-e2e-'));
    mkdirSync(join(cwd, '.qwen-harness'), { recursive: true });
    // Opt in at debug verbosity so the trace carries the model parameters and items.
    writeFileSync(
      join(cwd, '.qwen-harness', 'config.json'),
      JSON.stringify({ telemetry: { enabled: true, level: 'debug' } }),
    );
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
      yield {
        type: 'usage',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          reasoningTokens: 0,
          cachedInputTokens: 0,
        },
      };
      yield { type: 'done', finishReason: 'stop' };
    },
  });

  const deps = (argv: string[], p?: ModelProvider): CliDeps => ({
    argv,
    env: {},
    cwd,
    now: () => 1_700_000_000_000,
    stdout: () => {},
    stderr: () => {},
    ...(p ? { provider: p } : {}),
  });

  function readTrace(): TraceRecord[] {
    const dir = join(cwd, '.qwen-harness', 'trace');
    return readdirSync(dir)
      .flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n'))
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as TraceRecord);
  }

  it('records the turn lifecycle, model parameters, items, and usage', async () => {
    const code = await main(deps(['run', 'hello there'], provider()));
    expect(code).toBe(0);

    const records = readTrace();
    const categories = new Set(records.map((r) => r.category));
    // Turn lifecycle is traced start to finish.
    expect(categories).toContain('turn.started');
    expect(categories).toContain('turn.ended');
    // Model request is traced with its real parameters.
    expect(categories).toContain('model.request');
    const providerReq = records.find((r) => r.category === 'provider.request');
    expect(providerReq?.fields['model']).toBe('qwen3.7-max');
    expect(providerReq?.fields['toolNames']).toContain('read_file');
    // The user's item is captured at debug verbosity.
    expect(JSON.stringify(providerReq?.fields['items'])).toContain('hello there');
    // Usage is recorded.
    const usage = records.find((r) => r.category === 'provider.usage');
    expect(usage).toBeDefined();
  });
});
