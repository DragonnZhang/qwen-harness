import { describe, expect, it } from 'vitest';

import type { NormalizedUsage, ProviderStreamEvent } from '@qwen-harness/provider-core';
import { harnessError } from '@qwen-harness/protocol';

import { RoundNormalizer, normalizeRound } from '../../src/index.ts';

/**
 * The normalizer is a fold over provider events. These tests feed it event sequences shaped
 * exactly like the ones `provider-dashscope` produces from the REAL captured fixtures (checkpoint
 * 00), so the runtime's view of a round is verified against the actual service's behavior, not an
 * invented one.
 */

async function* stream(events: ProviderStreamEvent[]): AsyncIterable<ProviderStreamEvent> {
  for (const e of events) yield e;
}

const USAGE: NormalizedUsage = {
  inputTokens: 335,
  outputTokens: 177,
  totalTokens: 512,
  reasoningTokens: 125,
  cachedInputTokens: 0,
};

describe('RoundNormalizer against Responses-shaped events', () => {
  it('normalizes text + reasoning summary + a tool call, preserving the call ID', async () => {
    // Mirrors the checkpoint-00 Responses fixture: reasoning summary, a bit of text, one tool call.
    const round = await normalizeRound(
      stream([
        { type: 'request-id', requestId: 'resp_7d2ac330' },
        { type: 'reasoning-summary-delta', itemId: 'msg_r', delta: 'The user asks two things' },
        { type: 'reasoning-summary-done', itemId: 'msg_r', summary: 'The user asks two things.' },
        { type: 'text-delta', itemId: 'msg_a', delta: '21 × 2 = ' },
        { type: 'text-done', itemId: 'msg_a', text: '21 × 2 = **42**\n\n' },
        { type: 'tool-call-begin', itemId: 'msg_t', callId: 'call_e0f2efaa4f', toolName: 'add' },
        {
          type: 'tool-call-complete',
          itemId: 'msg_t',
          callId: 'call_e0f2efaa4f',
          toolName: 'add',
          argumentsJson: '{"a": 21, "b": 21}',
          arguments: { a: 21, b: 21 },
        },
        { type: 'usage', usage: USAGE },
        { type: 'done', finishReason: 'tool_calls' },
      ]),
    );

    expect(round.assistantText).toBe('21 × 2 = **42**\n\n');
    expect(round.reasoningSummary).toBe('The user asks two things.');
    expect(round.reasoningOccurred).toBe(true);
    expect(round.toolCalls).toHaveLength(1);
    // The call ID is preserved byte-for-byte so the function output pairs correctly (PV-06).
    expect(round.toolCalls[0]).toMatchObject({
      callId: 'call_e0f2efaa4f',
      toolName: 'add',
      arguments: { a: 21, b: 21 },
    });
    expect(round.usage?.reasoningTokens).toBe(125);
    expect(round.requestId).toBe('resp_7d2ac330');
    expect(round.finishReason).toBe('tool_calls');
    expect(round.errors).toHaveLength(0);
  });
});

describe('RoundNormalizer against Chat-shaped events', () => {
  it('records that reasoning occurred WITHOUT ever holding reasoning text (PV-04)', async () => {
    // Chat transport emits a reasoning-status, never a summary. The normalizer must reflect that
    // the model reasoned, but there must be no reasoning text anywhere in the result.
    const round = await normalizeRound(
      stream([
        { type: 'reasoning-status', reasoningOccurred: true, reasoningTokens: 35 },
        { type: 'text-done', itemId: 'm', text: 'done' },
        { type: 'usage', usage: { ...USAGE, reasoningTokens: 35 } },
        { type: 'done', finishReason: 'stop' },
      ]),
    );

    expect(round.reasoningOccurred).toBe(true);
    // The crucial assertion: there is no summary, because Chat never gives us one to keep.
    expect(round.reasoningSummary).toBeNull();
  });

  it('collects multiple tool calls in order', async () => {
    const round = await normalizeRound(
      stream([
        {
          type: 'tool-call-complete',
          itemId: 'a',
          callId: 'call_1',
          toolName: 'read',
          argumentsJson: '{"p":"a"}',
          arguments: { p: 'a' },
        },
        {
          type: 'tool-call-complete',
          itemId: 'b',
          callId: 'call_2',
          toolName: 'read',
          argumentsJson: '{"p":"b"}',
          arguments: { p: 'b' },
        },
        { type: 'done', finishReason: 'tool_calls' },
      ]),
    );
    expect(round.toolCalls.map((c) => c.callId)).toEqual(['call_1', 'call_2']);
  });
});

describe('RoundNormalizer error handling', () => {
  it('surfaces a stream error without discarding the partial text before it', async () => {
    const n = new RoundNormalizer();
    n.accept({ type: 'text-done', itemId: 'm', text: 'partial answer' });
    n.accept({
      type: 'error',
      error: harnessError({
        origin: 'network',
        category: 'network.disconnect',
        message: 'reset',
        retryable: true,
      }),
    });
    const round = n.finish();

    // Recovery must not drop partial evidence (ER-07). The text is kept; the error is visible.
    expect(round.assistantText).toBe('partial answer');
    expect(round.errors).toHaveLength(1);
    expect(round.errors[0]?.message).toBe('reset');
  });
});
