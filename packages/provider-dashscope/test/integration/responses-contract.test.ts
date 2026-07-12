import { describe, expect, it } from 'vitest';

import {
  DashScopeProvider,
  RESPONSES_CAPABILITIES,
  type CredentialSource,
} from '../../src/index.ts';
import { drain, fakeFetch, responsesFixtureSse } from './replay.ts';

/**
 * Contract test: the REAL captured Responses stream from checkpoint 0, replayed byte-for-byte
 * through the real SSE parser and the real normalizer.
 */

const key: CredentialSource = { description: 'test', read: () => 'sk-test-key-value' };

const request = {
  model: 'qwen3.7-max',
  instructions: 'You are terse.',
  input: [{ type: 'message' as const, role: 'user' as const, text: 'what is 21 * 2?' }],
  tools: [
    {
      name: 'add',
      description: 'add numbers',
      parameters: { type: 'object', properties: { a: { type: 'number' } } },
    },
  ],
};

async function replay() {
  const fetchImpl = fakeFetch({
    sse: responsesFixtureSse(),
    headers: { 'x-request-id': 'req-abc-123' },
  });
  const provider = new DashScopeProvider({ credentials: key, fetchImpl });
  const { events, thrown } = await drain(provider.stream(request));
  return { events, thrown, fetchImpl };
}

describe('Responses transport — captured contract fixture', () => {
  it('completes without error', async () => {
    const { thrown } = await replay();
    expect(thrown).toBeNull();
  });

  it('preserves the request ID from the x-request-id header', async () => {
    const { events } = await replay();
    expect(events[0]).toEqual({ type: 'request-id', requestId: 'req-abc-123' });
  });

  it('normalizes the reasoning summary from the completed reasoning item', async () => {
    const { events } = await replay();
    const deltas = events.filter((e) => e.type === 'reasoning-summary-delta');
    const done = events.filter((e) => e.type === 'reasoning-summary-done');

    expect(deltas.length).toBeGreaterThan(30);
    expect(done).toHaveLength(1);
    expect(done[0]?.summary).toContain('The user is asking two things');
    // The completed item is authoritative; the deltas must reconstruct exactly the same string.
    expect(deltas.map((d) => d.delta).join('')).toBe(done[0]?.summary);
    expect(done[0]?.itemId).toBe('msg_5d71fc11-e6df-410f-b02b-2247b3f3800a');
  });

  it('normalizes streamed text', async () => {
    const { events } = await replay();
    const deltas = events.filter((e) => e.type === 'text-delta');
    const done = events.filter((e) => e.type === 'text-done');
    expect(deltas.map((d) => d.delta).join('')).toBe('21 × 2 = **42**\n\n');
    expect(done).toHaveLength(1);
    expect(done[0]?.text).toBe('21 × 2 = **42**\n\n');
    expect(done[0]?.itemId).toBe('msg_abe6d38d-dea5-4229-b0f1-78a7a968abc1');
  });

  it('preserves the exact call_id, which is DISTINCT from the item id (PV-06)', async () => {
    const { events } = await replay();
    const complete = events.find((e) => e.type === 'tool-call-complete');
    const begin = events.find((e) => e.type === 'tool-call-begin');

    expect(complete?.callId).toBe('call_e0f2efaa4f7944dca038e669');
    expect(complete?.itemId).toBe('msg_72fcdc2a-2810-4f60-95a3-085865f67e26');
    expect(complete?.callId).not.toBe(complete?.itemId);
    expect(begin?.callId).toBe('call_e0f2efaa4f7944dca038e669');
  });

  it('takes complete tool arguments from the completed item, not from the deltas', async () => {
    const { events } = await replay();
    const complete = events.find((e) => e.type === 'tool-call-complete');
    expect(complete?.toolName).toBe('add');
    expect(complete?.argumentsJson).toBe('{"a": 21, "b": 21}');
    expect(complete?.arguments).toEqual({ a: 21, b: 21 });
  });

  it('maps usage from response.completed including reasoning and cached tokens', async () => {
    const { events } = await replay();
    const usage = events.find((e) => e.type === 'usage');
    expect(usage?.usage).toEqual({
      inputTokens: 335,
      outputTokens: 177,
      totalTokens: 512,
      reasoningTokens: 125,
      cachedInputTokens: 0,
    });
  });

  it('ends with a single done event reporting tool-calls', async () => {
    const { events } = await replay();
    const done = events.filter((e) => e.type === 'done');
    expect(done).toHaveLength(1);
    expect(done[0]?.finishReason).toBe('tool-calls');
    expect(events.at(-1)?.type).toBe('done');
  });

  it('emits tool-call-complete AFTER the arguments stream closed (PV-05 ordering)', async () => {
    const { events } = await replay();
    const beginIndex = events.findIndex((e) => e.type === 'tool-call-begin');
    const completeIndex = events.findIndex((e) => e.type === 'tool-call-complete');
    const doneIndex = events.findIndex((e) => e.type === 'done');
    expect(beginIndex).toBeGreaterThanOrEqual(0);
    expect(completeIndex).toBeGreaterThan(beginIndex);
    expect(completeIndex).toBeLessThan(doneIndex);
  });

  it('never puts background, previous_response_id, or extra_body on the wire', async () => {
    const { fetchImpl } = await replay();
    const call = fetchImpl.calls[0];
    expect(fetchImpl.calls).toHaveLength(1);
    expect(call?.url).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/responses');
    expect(call?.body).not.toHaveProperty('background');
    expect(call?.body).not.toHaveProperty('previous_response_id');
    expect(JSON.stringify(call?.body)).not.toContain('extra_body');
    expect(call?.body['reasoning']).toEqual({ effort: 'medium', summary: 'auto' });
    expect(call?.body['stream']).toBe(true);
  });

  it('freezes background and structuredOutput false (PV-07)', () => {
    expect(RESPONSES_CAPABILITIES.background).toBe(false);
    expect(RESPONSES_CAPABILITIES.structuredOutput).toBe(false);
    expect(RESPONSES_CAPABILITIES.reasoningSummary).toBe(true);
    expect(RESPONSES_CAPABILITIES.reasoningEffortGranularity).toBe('graded');
    expect(RESPONSES_CAPABILITIES.incrementalToolArgs).toBe(false);
    expect(Object.isFrozen(RESPONSES_CAPABILITIES)).toBe(true);
  });
});
