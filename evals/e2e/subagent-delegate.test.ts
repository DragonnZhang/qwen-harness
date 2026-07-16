import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main, type CliDeps } from '@qwen-harness/cli';
import {
  freezeCapabilities,
  type ModelInputItem,
  type ModelProvider,
} from '@qwen-harness/provider-core';
import { EventStore } from '@qwen-harness/storage';
import { ManualClock, SequentialIds } from '@qwen-harness/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * AG-02 (E): a deterministic end-to-end `main()` turn where the model DELEGATES a subtask and then
 * uses the child's returned summary. Only the provider is scripted; everything else — the real
 * composition root, the closed in-process allowlist, the engine gating, the `SubagentSupervisor`, the
 * nested child `TurnEngine`, and the durable store — is production code.
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

const PARENT_MARKER = 'PARENT_PROMPT_MARKER';
const CHILD_MARKER = 'CHILD_TASK_XYZ';
const CHILD_RESULT = 'CHILD_RESULT_42';

function childUserText(input: readonly ModelInputItem[]): string | null {
  for (const i of input) {
    if (i.type === 'message' && i.role === 'user' && i.text.includes(CHILD_MARKER)) return i.text;
  }
  return null;
}

function parentHasChildResult(input: readonly ModelInputItem[]): boolean {
  return input.some((i) => i.type === 'function-output');
}

/**
 * Serves both the parent and the child. `context` picks whether the parent's delegate call is fresh
 * or forked. In the forked case the provider records whether the child actually SAW the parent's
 * prompt in its seed.
 */
function makeProvider(opts: {
  context: 'fresh' | 'forked';
  onChildSawParent?: (saw: boolean) => void;
}): ModelProvider {
  return {
    capabilities: CAPS,
    async *stream(request) {
      const childText = childUserText(request.input);
      if (childText !== null) {
        opts.onChildSawParent?.(
          request.input.some(
            (i) => i.type === 'message' && i.role === 'user' && i.text.includes(PARENT_MARKER),
          ),
        );
        yield { type: 'text-done', itemId: 'it_child', text: CHILD_RESULT };
        yield { type: 'done', finishReason: 'stop' };
        return;
      }
      if (parentHasChildResult(request.input)) {
        const out = request.input.find((i) => i.type === 'function-output');
        const text = out && out.type === 'function-output' ? String(out.output) : '';
        yield { type: 'text-done', itemId: 'it_parent2', text: `done. child said: ${text}` };
        yield { type: 'done', finishReason: 'stop' };
        return;
      }
      const args = {
        label: 'researcher',
        prompt: `${CHILD_MARKER}: investigate`,
        context: opts.context,
        timing: 'foreground',
      };
      yield {
        type: 'tool-call-complete',
        itemId: 'it_delegate',
        callId: 'call_delegate_e2e',
        toolName: 'delegate',
        argumentsJson: JSON.stringify(args),
        arguments: args,
      };
      yield { type: 'done', finishReason: 'tool_calls' };
    },
  };
}

describe('AG-02 (E) — main() delegates a subtask and uses the child conclusion', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'qh-delegate-e2e-'));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it('fresh+foreground: the parent turn completes using the child summary', async () => {
    const out: string[] = [];
    const deps: CliDeps = {
      argv: ['run', '--profile', 'yolo', `${PARENT_MARKER} please delegate`],
      env: {},
      cwd,
      now: () => 1_700_000_000_000,
      stdout: (l) => out.push(l),
      stderr: () => {},
      provider: makeProvider({ context: 'fresh' }),
    };
    const code = await main(deps);
    expect(code).toBe(0);
    // The parent's printed result carries the child's conclusion, end to end.
    expect(out.join('\n')).toContain(CHILD_RESULT);

    // Durably: the delegate ran a real child turn on a second thread, and the tool result is ok.
    const store = new EventStore({
      path: join(cwd, '.qwen-harness', 'sessions.sqlite'),
      clock: new ManualClock(0),
      ids: new SequentialIds(),
    });
    try {
      const all = store.readAll();
      const threads = new Set(all.map((e) => e.threadId));
      // A parent thread AND a child thread.
      expect(threads.size).toBeGreaterThanOrEqual(2);

      const delegateResult = all
        .map((e) => e.payload)
        .find(
          (p) =>
            p.type === 'item-appended' &&
            p.item.type === 'tool-result' &&
            p.item.callId === 'call_delegate_e2e',
        );
      expect(
        delegateResult &&
          delegateResult.type === 'item-appended' &&
          delegateResult.item.type === 'tool-result' &&
          delegateResult.item.ok,
      ).toBe(true);

      // The child really produced its assistant text somewhere in the store.
      expect(
        all.some(
          (e) =>
            e.payload.type === 'item-appended' &&
            e.payload.item.type === 'assistant-message' &&
            e.payload.item.text.includes(CHILD_RESULT),
        ),
      ).toBe(true);
    } finally {
      store.close();
    }
  });

  it('forked: the child sees the parent context seeded from the store', async () => {
    let childSawParent = false;
    const deps: CliDeps = {
      argv: ['run', '--profile', 'yolo', `${PARENT_MARKER} please delegate with context`],
      env: {},
      cwd,
      now: () => 1_700_000_000_000,
      stdout: () => {},
      stderr: () => {},
      provider: makeProvider({
        context: 'forked',
        onChildSawParent: (saw) => {
          childSawParent = saw;
        },
      }),
    };
    const code = await main(deps);
    expect(code).toBe(0);
    // Forked-via-store worked: the child's seed included the parent's prompt.
    expect(childSawParent).toBe(true);
  });
});
