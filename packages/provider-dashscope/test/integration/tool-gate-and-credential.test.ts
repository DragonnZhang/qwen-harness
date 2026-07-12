import { describe, expect, it } from 'vitest';

import { HarnessError } from '@qwen-harness/protocol';
import { decideRetry } from '@qwen-harness/provider-core';

import { DashScopeProvider, NoCredentialSource, type CredentialSource } from '../../src/index.ts';
import { drain, fakeFetch } from './replay.ts';

const key: CredentialSource = { description: 'test', read: () => 'sk-test-key-value' };

const request = {
  model: 'qwen3.7-max',
  instructions: '',
  input: [{ type: 'message' as const, role: 'user' as const, text: 'hi' }],
  tools: [],
};

function sse(frames: { event?: string; data: unknown }[]): string {
  return frames
    .map((f) =>
      f.event === undefined
        ? `data: ${JSON.stringify(f.data)}\n\n`
        : `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`,
    )
    .join('');
}

describe('tool execution gate (PV-05)', () => {
  it('Responses: malformed arguments produce a typed error and NO tool-call-complete', async () => {
    const fetchImpl = fakeFetch({
      sse: sse([
        {
          event: 'response.output_item.added',
          data: {
            item: { id: 'msg_1', type: 'function_call', call_id: 'call_1', name: 'add' },
          },
        },
        {
          event: 'response.output_item.done',
          data: {
            item: {
              id: 'msg_1',
              type: 'function_call',
              call_id: 'call_1',
              name: 'add',
              // Truncated JSON: a partial parse here is exactly the bug PV-05 exists to prevent.
              arguments: '{"a": 21, "b":',
            },
          },
        },
        { event: 'response.completed', data: { response: { id: 'resp_1', status: 'completed' } } },
      ]),
    });
    const provider = new DashScopeProvider({ credentials: key, fetchImpl });
    const { events, thrown } = await drain(provider.stream(request));

    const error = thrown as HarnessError;
    expect(error).toBeInstanceOf(HarnessError);
    expect(error.category).toBe('provider.tool_call.malformed_arguments');
    expect(error.retryable).toBe(false);
    expect(error.sideEffectCertainty).toBe('not-started');

    expect(events.some((e) => e.type === 'tool-call-complete')).toBe(false);
    expect(events.some((e) => e.type === 'done')).toBe(false);
    // The call was announced, so the UI can say what failed — but it was never executable.
    expect(events.some((e) => e.type === 'tool-call-begin')).toBe(true);
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);

    // The malformed JSON itself is never handed on as an "argument".
    expect(JSON.stringify(events)).not.toContain('"arguments":{');
  });

  it('Chat: fragments that never form valid JSON produce a typed error, no complete', async () => {
    const chunk = (delta: unknown, finish: string | null = null) => ({
      data: {
        id: 'chatcmpl-1',
        choices: [{ index: 0, delta, finish_reason: finish }],
        usage: null,
      },
    });
    const fetchImpl = fakeFetch({
      sse: sse([
        chunk({
          tool_calls: [
            { index: 0, id: 'call_9', type: 'function', function: { name: 'add', arguments: '' } },
          ],
        }),
        chunk({ tool_calls: [{ index: 0, id: '', function: { arguments: '{"a": 2, ' } }] }),
        chunk({}, 'tool_calls'),
      ]),
    });
    const provider = new DashScopeProvider({ transport: 'chat', credentials: key, fetchImpl });
    const { events, thrown } = await drain(provider.stream(request));

    const error = thrown as HarnessError;
    expect(error.category).toBe('provider.tool_call.malformed_arguments');
    expect(events.some((e) => e.type === 'tool-call-complete')).toBe(false);
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });

  it('a non-object JSON payload is malformed too — "42" is valid JSON and invalid arguments', async () => {
    const fetchImpl = fakeFetch({
      sse: sse([
        {
          event: 'response.output_item.done',
          data: {
            item: {
              id: 'msg_1',
              type: 'function_call',
              call_id: 'call_1',
              name: 'add',
              arguments: '42',
            },
          },
        },
      ]),
    });
    const provider = new DashScopeProvider({ credentials: key, fetchImpl });
    const { events, thrown } = await drain(provider.stream(request));
    expect((thrown as HarnessError).category).toBe('provider.tool_call.malformed_arguments');
    expect(events.some((e) => e.type === 'tool-call-complete')).toBe(false);
  });
});

describe('partial visible output forbids a transparent retry (PV-11)', () => {
  it('a stream that dies after emitting text is retryable but NOT transparently retryable', async () => {
    const fetchImpl = fakeFetch({
      sse: sse([
        {
          event: 'response.output_text.delta',
          data: { item_id: 'msg_1', delta: 'The answer is ' },
        },
        // ...and then the connection dies. No response.completed ever arrives.
      ]),
    });
    const provider = new DashScopeProvider({ credentials: key, fetchImpl });
    const { events, thrown } = await drain(provider.stream(request));

    const error = thrown as HarnessError;
    expect(error.category).toBe('provider.stream.truncated');
    expect(error.retryable).toBe(true);
    expect(error.visibleOutputEmitted).toBe(true);
    // Retryable in the abstract, forbidden in this turn: a second stream would be concatenated
    // onto "The answer is ".
    expect(error.canRetryTransparently()).toBe(false);
    expect(decideRetry(error, { attempt: 1, elapsedMs: 0 }, () => 0.5)).toEqual({
      retry: false,
      reason: 'visible-output-emitted',
    });
    expect(events.some((e) => e.type === 'text-delta')).toBe(true);
  });

  it('a stream that dies before any text IS transparently retryable', async () => {
    const fetchImpl = fakeFetch({
      sse: sse([{ event: 'response.created', data: { response: { id: 'resp_1' } } }]),
    });
    const provider = new DashScopeProvider({ credentials: key, fetchImpl });
    const { thrown } = await drain(provider.stream(request));
    const error = thrown as HarnessError;
    expect(error.category).toBe('provider.stream.truncated');
    expect(error.visibleOutputEmitted).toBe(false);
    expect(error.canRetryTransparently()).toBe(true);
    expect(error.requestId).toBe('resp_1');
  });
});

describe('credential discovery (requirement 13 / PV-12)', () => {
  it('fails BEFORE any network call when the key is absent', async () => {
    const fetchImpl = fakeFetch({ sse: '' });
    const provider = new DashScopeProvider({
      credentials: new NoCredentialSource(),
      fetchImpl,
    });
    const { events, thrown } = await drain(provider.stream(request));

    // The assertion that matters: no request was ever made.
    expect(fetchImpl.calls).toHaveLength(0);

    const error = thrown as HarnessError;
    expect(error).toBeInstanceOf(HarnessError);
    expect(error.category).toBe('provider.credential.missing');
    expect(error.retryable).toBe(false);
    expect(error.userActionRequired).toBe(true);
    expect(error.sideEffectCertainty).toBe('not-started');
    expect(events).toEqual([{ type: 'error', error }]);
  });

  it('never puts the key anywhere except the Authorization header', async () => {
    const fetchImpl = fakeFetch({
      sse: sse([
        { event: 'response.completed', data: { response: { id: 'r', status: 'completed' } } },
      ]),
    });
    const provider = new DashScopeProvider({ credentials: key, fetchImpl });
    await drain(provider.stream(request));

    const call = fetchImpl.calls[0];
    expect(call?.headers['authorization']).toBe('Bearer sk-test-key-value');
    expect(JSON.stringify(call?.body)).not.toContain('sk-test-key-value');
    expect(call?.url).not.toContain('sk-test-key-value');
  });
});

describe('reasoning granularity (PV-13)', () => {
  it("Chat + reasoningEffort 'low' is a typed error, not a silent degradation", async () => {
    const fetchImpl = fakeFetch({ sse: '' });
    const provider = new DashScopeProvider({ transport: 'chat', credentials: key, fetchImpl });
    const { events, thrown } = await drain(provider.stream({ ...request, reasoningEffort: 'low' }));

    const error = thrown as HarnessError;
    expect(error).toBeInstanceOf(HarnessError);
    expect(error.category).toBe('provider.unsupported.reasoning_granularity');
    expect(error.userActionRequired).toBe(true);
    expect(error.retryable).toBe(false);
    // It failed BEFORE the request: a degraded call was never made on the user's behalf.
    expect(fetchImpl.calls).toHaveLength(0);
    expect(events).toEqual([{ type: 'error', error }]);
  });

  it.each(['minimal', 'high'] as const)("Chat rejects '%s' the same way", async (effort) => {
    const fetchImpl = fakeFetch({ sse: '' });
    const provider = new DashScopeProvider({ transport: 'chat', credentials: key, fetchImpl });
    const { thrown } = await drain(provider.stream({ ...request, reasoningEffort: effort }));
    expect((thrown as HarnessError).category).toBe('provider.unsupported.reasoning_granularity');
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it("Responses accepts 'high' and sends it through unchanged", async () => {
    const fetchImpl = fakeFetch({
      sse: sse([
        { event: 'response.completed', data: { response: { id: 'r', status: 'completed' } } },
      ]),
    });
    const provider = new DashScopeProvider({ credentials: key, fetchImpl });
    await drain(provider.stream({ ...request, reasoningEffort: 'high' }));
    expect(fetchImpl.calls[0]?.body['reasoning']).toEqual({ effort: 'high', summary: 'auto' });
  });
});
