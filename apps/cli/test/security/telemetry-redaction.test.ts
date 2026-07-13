import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ModelProvider, ProviderStreamEvent } from '@qwen-harness/provider-core';
import { freezeCapabilities } from '@qwen-harness/provider-core';
import { EventStore } from '@qwen-harness/storage';
import { MemoryTraceSink } from '@qwen-harness/telemetry';
import { CANARY_API_KEY, SequentialIds } from '@qwen-harness/testkit';
import { ToolWorkerClient } from '@qwen-harness/tool-worker';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { authorityForProfile } from '../../src/policy-from-config.ts';
import { openTelemetry } from '../../src/telemetry.ts';
import { createHarnessRuntime } from '../../src/wiring.ts';
import type { CorrelationId, ThreadId } from '@qwen-harness/protocol';

/**
 * THE CANARY TEST (OB-01/OB-02, threat model: a secret never reaches a log).
 *
 * Telemetry is the newest place a secret could leak, and the most dangerous, because a trace is a
 * plaintext file that people paste into bug reports. This test therefore does not check that the
 * redactor works — `packages/storage` already proves that. It checks the thing that actually
 * matters: that a REAL turn, driven through the REAL composition root with tracing at its LOUDEST
 * setting (`debug`, which records model input items, tool arguments, and tool output), cannot emit
 * the credential.
 *
 * The canary is planted everywhere a value could plausibly travel:
 *
 *   - the USER's prompt              (a human pastes a key into a chat box; it happens constantly)
 *   - the MODEL's tool arguments     (the model echoes back what it was told)
 *   - the TOOL's stdout              (a command prints its environment)
 *   - the MODEL's final text         (the model quotes the tool output back)
 *
 * Every one of those crosses the tracer. If ANY of them reaches the JSONL, this fails.
 *
 * What this proves: no path through the traced turn writes the credential.
 * What it does NOT prove: that a secret this run never saw cannot leak (nothing can prove that), or
 * that a value the redactor was never told about is scrubbed. The redactor is seeded with the live
 * credential at the composition root; a secret the process does not know is not a secret it can hide.
 */

const client = new ToolWorkerClient();
const sandbox = client.detect();

function scripted(rounds: ProviderStreamEvent[][]): ModelProvider {
  let i = 0;
  return {
    capabilities: freezeCapabilities({
      textStreaming: true,
      reasoningSummary: true,
      reasoningEffortGranularity: 'graded',
      incrementalToolArgs: false,
      background: false,
      structuredOutput: false,
      toolStream: false,
    }),
    async *stream() {
      const round = rounds[i++] ?? [{ type: 'done', finishReason: 'stop' }];
      for (const e of round) yield e;
    },
  };
}

describe('a secret can never reach the trace', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'qh-canary-'));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('the sandbox is available (the tool below really runs)', () => {
    expect(sandbox.available, sandbox.detail).toBe(true);
  });

  it('CANARY_API_KEY appears NOWHERE in a debug-level trace of a real turn', async () => {
    // The tool the model calls prints the canary to stdout — so the credential is genuinely in the
    // tool's OUTPUT, not merely in a field we chose to trace.
    const shellArgs = {
      command: '/usr/bin/env',
      argv: ['node', '-e', 'console.log(process.argv[1])', CANARY_API_KEY],
      cwd: '.',
    };

    const provider = scripted([
      [
        {
          type: 'tool-call-complete',
          itemId: 'it_1',
          callId: 'call_1',
          toolName: 'run_shell',
          argumentsJson: JSON.stringify(shellArgs),
          arguments: shellArgs,
        },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        // The model quotes the key straight back at us.
        { type: 'text-done', itemId: 'it_2', text: `the key is ${CANARY_API_KEY}` },
        {
          type: 'usage',
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
            reasoningTokens: null,
            cachedInputTokens: null,
          },
        },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);

    const sink = new MemoryTraceSink();
    const telemetry = openTelemetry({
      enabled: true,
      // The LOUDEST setting. At `debug` the trace carries redacted content — items, arguments, and
      // output previews. Testing at `info` would prove far less: it omits most of the content by
      // design, so it could pass while `debug` leaked.
      level: 'debug',
      retentionDays: 7,
      dir: join(workspace, 'trace'),
      clock: { now: () => Date.now(), sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)) },
      // The credential the process knows about, exactly as `main.ts` seeds it.
      secrets: [CANARY_API_KEY],
      sink,
    });
    expect(telemetry.tracer).not.toBeNull();
    expect(telemetry.detailed).toBe(true);

    const store = new EventStore({
      path: join(workspace, 'sessions.sqlite'),
      clock: { now: () => Date.now(), sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)) },
      ids: new SequentialIds(),
      secrets: [CANARY_API_KEY],
    });

    try {
      const runtime = createHarnessRuntime({
        workspaceRoot: workspace,
        authority: authorityForProfile('yolo'),
        model: 'qwen3.7-max',
        // Even the system prompt carries it — a repository AGENTS.md could contain a pasted key.
        instructions: `You are a test agent. Ignore this: ${CANARY_API_KEY}`,
        homeDir: workspace,
        clock: { now: () => Date.now() },
        ids: new SequentialIds(),
        store,
        provider,
        client,
        tracer: telemetry.tracer!,
        detailedTrace: true,
      });

      const threadId = 'thr_000001' as ThreadId;
      store.append({
        threadId,
        correlationId: 'cor_000001' as CorrelationId,
        permissionProfile: 'yolo',
        actor: { kind: 'user', id: 'act_user01' as never },
        payload: { type: 'thread-created', cwd: workspace, canonicalRepo: workspace, name: null },
      });

      const result = await runtime.runTurn({
        threadId,
        correlationId: 'cor_000002' as CorrelationId,
        // The user pastes their key into the prompt.
        userText: `here is my key ${CANARY_API_KEY}, please echo it`,
      });

      // The turn must have actually HAPPENED. A test that proves "no secret leaked" because nothing
      // ran is the most common way this assertion becomes worthless.
      expect(result.state).toBe('completed');
      expect(sink.records.length).toBeGreaterThan(10);

      // The trace really did carry the material we planted — the tool ran and its output was traced.
      const serialized = JSON.stringify(sink.records);
      expect(serialized).toContain('run_shell');
      expect(serialized).toContain('provider.usage');
      expect(serialized).toContain('tool.execute');
      expect(serialized).toContain('[REDACTED]');

      // THE ASSERTION.
      expect(serialized).not.toContain(CANARY_API_KEY);
      for (const record of sink.records) {
        expect(record.message).not.toContain(CANARY_API_KEY);
        expect(JSON.stringify(record.fields)).not.toContain(CANARY_API_KEY);
      }
    } finally {
      store.close();
    }
  });

  it('the canary does not reach the JSONL file a FileTraceSink writes', async () => {
    // The in-memory assertion above could pass while the file sink serialized differently. This runs
    // the real production sink and greps the bytes on disk — which is what a user would paste.
    const traceDir = join(workspace, 'trace');
    const telemetry = openTelemetry({
      enabled: true,
      level: 'debug',
      retentionDays: 7,
      dir: traceDir,
      clock: { now: () => Date.now(), sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)) },
      secrets: [CANARY_API_KEY],
    });

    expect(telemetry.path).not.toBeNull();
    telemetry.tracer!.info('test', `a message with ${CANARY_API_KEY} in it`, {
      nested: { deep: [CANARY_API_KEY] },
      [`key_${CANARY_API_KEY}`]: 'a secret used as an object KEY',
    });

    const bytes = readFileSync(telemetry.path!, 'utf8');
    expect(bytes).toContain('[REDACTED]');
    expect(bytes).not.toContain(CANARY_API_KEY);
  });
});
