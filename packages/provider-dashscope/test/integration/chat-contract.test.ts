import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CHAT_CAPABILITIES, DashScopeProvider, type CredentialSource } from '../../src/index.ts';
import { chatFixtureSse, drain, fakeFetch } from './replay.ts';

/**
 * Contract test: the REAL captured Chat Completions stream from checkpoint 0.
 *
 * The fixture is the interesting one, because the model in it emitted eleven chunks of raw
 * `reasoning_content` and NO visible text — so if the adapter leaked private reasoning, this is the
 * stream in which the leak would be the entire output.
 */

const key: CredentialSource = { description: 'test', read: () => 'sk-test-key-value' };

const request = {
  model: 'qwen3.7-max',
  instructions: 'You are terse.',
  input: [{ type: 'message' as const, role: 'user' as const, text: 'add 2 and 3' }],
  tools: [
    {
      name: 'add',
      description: 'add numbers',
      parameters: { type: 'object', properties: { a: { type: 'number' } } },
    },
  ],
};

async function replay() {
  const fetchImpl = fakeFetch({ sse: chatFixtureSse() });
  const provider = new DashScopeProvider({ transport: 'chat', credentials: key, fetchImpl });
  const { events, thrown } = await drain(provider.stream(request));
  return { events, thrown, fetchImpl };
}

/** Every `reasoning_content` string the captured stream actually contained. */
function capturedReasoningStrings(): string[] {
  const path = join(
    import.meta.dirname,
    '..',
    '..',
    '..',
    '..',
    'fixtures/provider/dashscope/chat-stream-text-reasoning-tool.jsonl',
  );
  const chunks = readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as { choices?: { delta?: { reasoning_content?: string } }[] });
  return chunks
    .flatMap((c) => c.choices ?? [])
    .map((c) => c.delta?.reasoning_content ?? '')
    .filter((s) => s.trim() !== '');
}

describe('Chat transport — captured contract fixture', () => {
  it('completes without error', async () => {
    const { thrown } = await replay();
    expect(thrown).toBeNull();
  });

  it('assembles the fragmented tool_calls by index into one complete call', async () => {
    const { events } = await replay();
    const complete = events.filter((e) => e.type === 'tool-call-complete');
    expect(complete).toHaveLength(1);
    // id and name came from fragment 1 only; the arguments were spread over five later fragments
    // ('{"a": 2', ', "b": ', '3', '}', '') that each carried an EMPTY id.
    expect(complete[0]?.callId).toBe('call_0f080eb8223f42b4a48bdf33');
    expect(complete[0]?.toolName).toBe('add');
    expect(complete[0]?.argumentsJson).toBe('{"a": 2, "b": 3}');
    expect(complete[0]?.arguments).toEqual({ a: 2, b: 3 });
  });

  it('announces the call once, on the first fragment that carries id and name', async () => {
    const { events } = await replay();
    const begin = events.filter((e) => e.type === 'tool-call-begin');
    expect(begin).toHaveLength(1);
    expect(begin[0]?.callId).toBe('call_0f080eb8223f42b4a48bdf33');
    expect(events.findIndex((e) => e.type === 'tool-call-begin')).toBeLessThan(
      events.findIndex((e) => e.type === 'tool-call-complete'),
    );
  });

  // -------------------------------------------------------------------------------------------
  // PV-04. This is the security-critical assertion of the whole package.
  // -------------------------------------------------------------------------------------------
  it('NEVER emits reasoning_content text in any event', async () => {
    const { events } = await replay();
    const serialized = JSON.stringify(events);

    const reasoning = capturedReasoningStrings();
    expect(reasoning.length).toBeGreaterThanOrEqual(11);
    for (const fragment of reasoning) {
      expect(serialized).not.toContain(fragment);
    }
    // The joined reasoning is what a naive "just relabel it as a summary" adapter would emit.
    expect(serialized).not.toContain(reasoning.join(''));
    expect(serialized).not.toContain('reasoning_content');

    // And it is not relabeled as a summary either: this transport emits no summary events at all.
    expect(events.some((e) => e.type === 'reasoning-summary-delta')).toBe(false);
    expect(events.some((e) => e.type === 'reasoning-summary-done')).toBe(false);
    expect(CHAT_CAPABILITIES.reasoningSummary).toBe(false);
  });

  it('reduces the discarded reasoning to a content-free status with a token count', async () => {
    const { events } = await replay();
    const status = events.filter((e) => e.type === 'reasoning-status');
    // One live flag while thinking, one final one once the usage chunk supplied the count.
    expect(status).toHaveLength(2);
    expect(status[0]).toEqual({
      type: 'reasoning-status',
      reasoningOccurred: true,
      reasoningTokens: null,
    });
    expect(status[1]).toEqual({
      type: 'reasoning-status',
      reasoningOccurred: true,
      reasoningTokens: 35,
    });
  });

  it('reads usage from the final empty-choices chunk (PV-09)', async () => {
    const { events } = await replay();
    const usage = events.find((e) => e.type === 'usage');
    expect(usage?.usage).toEqual({
      inputTokens: 290,
      outputTokens: 74,
      totalTokens: 364,
      reasoningTokens: 35,
      cachedInputTokens: 0,
    });
  });

  it('requests the usage chunk and sends binary thinking, never extra_body', async () => {
    const { fetchImpl } = await replay();
    const call = fetchImpl.calls[0];
    expect(call?.url).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
    expect(call?.body['stream_options']).toEqual({ include_usage: true });
    expect(call?.body['enable_thinking']).toBe(true);
    expect(JSON.stringify(call?.body)).not.toContain('extra_body');
    expect(call?.body).not.toHaveProperty('reasoning');
  });

  it('finishes as tool-calls', async () => {
    const { events } = await replay();
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'tool-calls' });
  });
});
