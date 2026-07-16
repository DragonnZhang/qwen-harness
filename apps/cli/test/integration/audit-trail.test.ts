import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main, type CliDeps } from '@qwen-harness/cli';
import { freezeCapabilities, type ModelProvider } from '@qwen-harness/provider-core';
import { EventStore } from '@qwen-harness/storage';
import { ManualClock, SequentialIds } from '@qwen-harness/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Every side effect leaves a complete, attributed audit record (SC-03, I).
 *
 * A real run performs a real, sandboxed file write. The durable log must then carry the full audit
 * trail for that side effect: WHO did it (actor), WHAT normalized action it was and the policy DECISION
 * over it, the durable RESULT IDENTITY (a content digest), and an attributed tool-result — enough to
 * reconstruct exactly what happened and under what authority.
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

describe('side-effect audit trail (SC-03)', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'qh-audit-'));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  const writeProvider = (): ModelProvider => {
    let n = 0;
    return {
      capabilities: CAPS,
      async *stream() {
        n += 1;
        if (n === 1) {
          const args = { path: 'out.txt', content: 'audited content\n' };
          yield {
            type: 'tool-call-complete',
            itemId: 'it_1',
            callId: 'call_1',
            toolName: 'write_file',
            argumentsJson: JSON.stringify(args),
            arguments: args,
          };
          yield { type: 'done', finishReason: 'tool_calls' };
        } else {
          yield { type: 'text-done', itemId: 'it_2', text: 'written' };
          yield { type: 'done', finishReason: 'stop' };
        }
      },
    };
  };

  it('records actor, normalized action, decision, result identity, and an attributed tool-result', async () => {
    const deps: CliDeps = {
      argv: ['run', '--profile', 'yolo', 'write a file'],
      env: {},
      cwd,
      now: () => 1_700_000_000_000,
      stdout: () => {},
      stderr: () => {},
      provider: writeProvider(),
    };
    expect(await main(deps)).toBe(0);
    expect(existsSync(join(cwd, 'out.txt'))).toBe(true); // the side effect really happened

    const store = new EventStore({
      path: join(cwd, '.qwen-harness', 'sessions.sqlite'),
      clock: new ManualClock(0),
      ids: new SequentialIds(),
    });
    try {
      const events = store.readAll();

      // WHO + WHAT + DECISION: the policy decision for the write, attributed to an actor.
      const decision = events.find((e) => e.payload.type === 'policy-decision');
      expect(decision, 'a policy decision is audited').toBeDefined();
      expect(decision?.actor).toBeDefined();
      const dp = decision?.payload;
      expect(dp?.type === 'policy-decision' && dp.normalizedAction.length > 0).toBe(true);
      expect(dp?.type === 'policy-decision' && ['allow', 'ask', 'deny'].includes(dp.decision)).toBe(
        true,
      );

      // RESULT IDENTITY: the settled side effect carries a durable result digest.
      const settled = events.find((e) => e.payload.type === 'side-effect-settled');
      expect(settled, 'the side effect settlement is audited').toBeDefined();
      const sp = settled?.payload;
      expect(sp?.type === 'side-effect-settled' && typeof sp.resultDigest === 'string').toBe(true);

      // An attributed, durable tool-result for the write.
      const toolResult = events.find(
        (e) =>
          e.payload.type === 'item-appended' &&
          e.payload.item.type === 'tool-result' &&
          e.payload.item.toolName === 'write_file',
      );
      expect(toolResult, 'the tool-result is audited').toBeDefined();
      expect(toolResult?.actor).toBeDefined();
    } finally {
      store.close();
    }
  });
});
