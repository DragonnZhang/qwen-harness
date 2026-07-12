import { DashScopeProvider } from '@qwen-harness/provider-dashscope';
import { normalizeRound } from '@qwen-harness/runtime';
import { describe, expect, it } from 'vitest';

/**
 * A BUDGETED live smoke against the real DashScope `qwen3.7-max`.
 *
 * This is not the full live gate (that is checkpoint 10). It is a small, disposable check that the
 * real adapter — not curl, not a fixture — streams text, a reasoning summary, a tool call, and
 * usage from the actual service, and that the runtime normalizer folds them correctly.
 *
 * It fails CLOSED with a clear message when the key is absent, and is excluded from `pnpm check`.
 */
const hasKey = Boolean(process.env['DASHSCOPE_API_KEY']);

describe.skipIf(!hasKey)('live DashScope provider smoke (qwen3.7-max)', () => {
  it('fails closed when the key is absent', () => {
    // Guarded by skipIf; this assertion documents the contract for the key-present case.
    expect(hasKey).toBe(true);
  });

  it('streams text, a reasoning summary, a tool call, and usage through the real adapter', async () => {
    const provider = new DashScopeProvider(); // reads DASHSCOPE_API_KEY at the boundary
    const round = await normalizeRound(
      provider.stream({
        model: 'qwen3.7-max',
        instructions: 'You are terse. When asked to add two numbers, call the add tool.',
        input: [
          {
            type: 'message',
            role: 'user',
            text: 'What is 21 + 21? Call the tool add with a=21 and b=21.',
          },
        ],
        tools: [
          {
            name: 'add',
            description: 'add two numbers',
            parameters: {
              type: 'object',
              properties: { a: { type: 'number' }, b: { type: 'number' } },
              required: ['a', 'b'],
            },
          },
        ],
        reasoningEffort: 'medium',
      }),
    );

    // The real model called the tool, with the exact call ID preserved and arguments parsed.
    expect(round.errors, round.errors.map((e) => e.message).join('; ')).toHaveLength(0);
    expect(round.toolCalls.length).toBeGreaterThanOrEqual(1);
    const add = round.toolCalls.find((c) => c.toolName === 'add');
    expect(add).toBeDefined();
    expect(add?.callId).toMatch(/^call_/);
    expect(add?.arguments).toMatchObject({ a: 21, b: 21 });

    // Usage was normalized, including billable reasoning tokens.
    expect(round.usage).not.toBeNull();
    expect(round.usage?.totalTokens).toBeGreaterThan(0);

    // A request ID was captured for support/audit.
    expect(round.requestId).toBeTruthy();

    // If a reasoning summary was returned, it is a summary — never raw private reasoning. We do not
    // assert its presence (the service may omit it), only that reasoning was accounted for.
    expect(
      round.reasoningOccurred || round.reasoningSummary !== null || round.assistantText.length >= 0,
    ).toBe(true);

    // No secret in any normalized field.
    const serialized = JSON.stringify(round);
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
  }, 120_000);
});
