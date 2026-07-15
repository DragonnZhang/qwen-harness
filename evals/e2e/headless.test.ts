import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main, type CliDeps } from '@qwen-harness/cli';
import { freezeCapabilities, type ModelProvider } from '@qwen-harness/provider-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The headless CLI contract, driven deterministically through the real `main()` (UI-15).
 *
 * A machine caller gets: a one-shot prompt, a single structured JSON result on stdout, an exit code
 * that means the same thing every run (0 completed / 3 awaiting-approval / 2 failed), an approval
 * surfaced structurally instead of blocking on a prompt, `--quiet` that strips human status chrome,
 * plain (ANSI-free) output, and resume-by-id that continues the same session. Everything here is
 * deterministic — a scripted provider, no terminal, reproducible byte-for-byte.
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

function textProvider(text: string): ModelProvider {
  return {
    capabilities: CAPS,
    async *stream() {
      yield { type: 'text-done', itemId: 'it_1', text };
      yield { type: 'done', finishReason: 'stop' };
    },
  };
}

function shellToolProvider(): ModelProvider {
  const args = { command: '/usr/bin/env', argv: ['node', '-e', '0'], cwd: '.' };
  return {
    capabilities: CAPS,
    async *stream() {
      yield {
        type: 'tool-call-complete',
        itemId: 'it_1',
        callId: 'call_1',
        toolName: 'run_shell',
        argumentsJson: JSON.stringify(args),
        arguments: args,
      };
      yield { type: 'done', finishReason: 'tool_calls' };
    },
  };
}

const ESC = '';

describe('headless CLI contract (UI-15)', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'qh-headless-'));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  async function run(
    argv: string[],
    provider: ModelProvider,
  ): Promise<{ code: number; out: string[]; err: string[] }> {
    const out: string[] = [];
    const err: string[] = [];
    const deps: CliDeps = {
      argv,
      env: {},
      cwd,
      now: () => 1_700_000_000_000,
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
      provider,
      // No readLine on purpose: this is a machine caller with nobody to prompt.
    };
    const code = await main(deps);
    return { code, out, err };
  }

  it('`run --json` emits ONE structured result on stdout and exits 0 on completion', async () => {
    const { code, out } = await run(['run', '--json', 'say hello'], textProvider('hello there'));
    expect(code).toBe(0);
    // Exactly one machine-readable line, and it parses.
    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0]!) as Record<string, unknown>;
    expect(parsed['state']).toBe('completed');
    expect(parsed['finalText']).toBe('hello there');
    expect(typeof parsed['threadId']).toBe('string');
    expect(typeof parsed['turnId']).toBe('string');
    expect(parsed['pendingApproval']).toBeNull();
  });

  it('output is plain: no ANSI escape sequences reach a headless stream (the --no-color guarantee)', async () => {
    const { out, err } = await run(['run', 'say hello'], textProvider('a plain answer'));
    // The CLI adds no color chrome of its own — every emitted line is free of ESC control sequences.
    for (const line of [...out, ...err]) expect(line.includes(ESC)).toBe(false);
  });

  it('an approval-requiring tool suspends and is surfaced in JSON with exit code 3, never blocking', async () => {
    const { code, out } = await run(
      ['run', '--json', '--profile', 'ask', 'run a shell'],
      shellToolProvider(),
    );
    // 3 is the stable "still alive, resumable" code — not a failure, not a silent allow.
    expect(code).toBe(3);
    const parsed = JSON.parse(out[0]!) as {
      state: string;
      pendingApproval: { toolName: string } | null;
    };
    expect(parsed.state).toBe('awaiting-approval');
    expect(parsed.pendingApproval?.toolName).toBe('run_shell');
  });

  it('`--quiet` strips the human status chrome from stderr but keeps the result on stdout', async () => {
    const loud = await run(['run', 'say hello'], textProvider('the answer'));
    const quiet = await run(['run', '--quiet', 'say hello'], textProvider('the answer'));

    // The result is unaffected — quiet is not silence.
    expect(quiet.out).toContain('the answer');
    // The trailing `[completed: ...] session <id>` status line is chrome; quiet drops it, loud keeps it.
    const statusLine = (l: string) => /\[completed:/.test(l);
    expect(loud.err.some(statusLine)).toBe(true);
    expect(quiet.err.some(statusLine)).toBe(false);
  });

  it('`resume <id> <prompt>` continues the SAME session as a fresh turn and exits 0', async () => {
    const first = await run(['run', '--json', 'first turn'], textProvider('one'));
    const threadId = (JSON.parse(first.out[0]!) as { threadId: string }).threadId;

    const second = await run(['resume', threadId, '--json', 'second turn'], textProvider('two'));
    expect(second.code).toBe(0);
    const parsed = JSON.parse(second.out[0]!) as { threadId: string; finalText: string };
    // Same durable session, advanced by a new turn.
    expect(parsed.threadId).toBe(threadId);
    expect(parsed.finalText).toBe('two');
  });
});
