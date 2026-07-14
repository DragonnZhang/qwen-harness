import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { NormalizedUsage, ProviderStreamEvent } from '@qwen-harness/provider-core';

import { normalizeRound } from '../../src/index.ts';

/**
 * RT-02 (property): multiple tool calls stay ORDERED and PAIRED by identity across ARBITRARY call
 * counts and interleavings.
 *
 * The fixture suite proves the two-call example. This proves the invariant over the whole space:
 * for any number of tool calls, in any order, with any noise events (text, reasoning, begins,
 * usage, request-id) interspersed between the `tool-call-complete` events, the normalizer's
 * `toolCalls` list is exactly the sequence of completed calls in emission order, with each entry's
 * identity fields (callId, itemId, toolName, argumentsJson, arguments) paired to the exact call it
 * came from.
 *
 * Why this would FAIL if the behavior regressed: the assertion compares the output list positionally
 * against the input spec list. Any reorder, drop, duplicate-collapse, cross-pairing of arguments to
 * the wrong callId, or a `tool-call-begin` leaking into the durable list would make the positional
 * tuples diverge and the property would shrink to a minimal counterexample.
 */

interface ToolCallSpec {
  readonly itemId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly argumentsJson: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

const USAGE: NormalizedUsage = {
  inputTokens: 10,
  outputTokens: 20,
  totalTokens: 30,
  reasoningTokens: 5,
  cachedInputTokens: 0,
};

/** Events that must NOT change the tool-call list in any way. */
const noiseEventArb: fc.Arbitrary<ProviderStreamEvent> = fc.oneof(
  fc.record({
    type: fc.constant('request-id' as const),
    requestId: fc.string(),
  }),
  fc.record({
    type: fc.constant('text-delta' as const),
    itemId: fc.string(),
    delta: fc.string(),
  }),
  fc.record({
    type: fc.constant('text-done' as const),
    itemId: fc.string(),
    text: fc.string(),
  }),
  fc.record({
    type: fc.constant('reasoning-summary-delta' as const),
    itemId: fc.string(),
    delta: fc.string(),
  }),
  fc.record({
    type: fc.constant('reasoning-status' as const),
    reasoningOccurred: fc.constant(true as const),
    reasoningTokens: fc.option(fc.nat(), { nil: null }),
  }),
  // A `begin` for some call must never create a durable entry — only `complete` does (PV-05).
  fc.record({
    type: fc.constant('tool-call-begin' as const),
    itemId: fc.string(),
    callId: fc.string(),
    toolName: fc.string(),
  }),
  fc.constant({ type: 'usage' as const, usage: USAGE }),
);

const toolCallSpecArb: fc.Arbitrary<ToolCallSpec> = fc.record({
  itemId: fc.string(),
  callId: fc.string(),
  toolName: fc.string(),
  argumentsJson: fc.string(),
  arguments: fc.dictionary(fc.string(), fc.jsonValue()) as fc.Arbitrary<
    Readonly<Record<string, unknown>>
  >,
});

async function* stream(events: readonly ProviderStreamEvent[]): AsyncIterable<ProviderStreamEvent> {
  for (const e of events) yield e;
}

describe('RoundNormalizer tool-call ordering & pairing (RT-02, property)', () => {
  it('preserves order and pairs each result to its exact call across arbitrary streams', async () => {
    await fc.assert(
      fc.asyncProperty(
        // A sequence of tool calls, and for each one a burst of noise that precedes it, plus a
        // trailing burst. Concatenating in spec order keeps the completes in spec order while
        // scattering unrelated events between them.
        fc.array(
          fc.record({
            call: toolCallSpecArb,
            lead: fc.array(noiseEventArb, { maxLength: 4 }),
          }),
          { maxLength: 12 },
        ),
        fc.array(noiseEventArb, { maxLength: 4 }),
        fc.array(noiseEventArb, { maxLength: 4 }),
        async (calls, prefixNoise, trailingNoise) => {
          const events: ProviderStreamEvent[] = [...prefixNoise];
          for (const { call, lead } of calls) {
            events.push(...lead);
            events.push({
              type: 'tool-call-complete',
              itemId: call.itemId,
              callId: call.callId,
              toolName: call.toolName,
              argumentsJson: call.argumentsJson,
              arguments: call.arguments,
            });
          }
          events.push(...trailingNoise);
          events.push({ type: 'done', finishReason: 'tool-calls' });

          const round = await normalizeRound(stream(events));

          const expected = calls.map(({ call }) => call);

          // Same length: no drops, no phantom entries from `begin` noise.
          expect(round.toolCalls).toHaveLength(expected.length);
          // Order preserved, byte-for-byte call-id sequence.
          expect(round.toolCalls.map((c) => c.callId)).toEqual(expected.map((c) => c.callId));
          // Full positional pairing: arguments/name/itemId belong to the same call as the id.
          round.toolCalls.forEach((got, i) => {
            const want = expected[i];
            expect(got).toEqual({
              itemId: want?.itemId,
              callId: want?.callId,
              toolName: want?.toolName,
              argumentsJson: want?.argumentsJson,
              arguments: want?.arguments,
            });
          });
        },
      ),
      { numRuns: 300 },
    );
  });
});
