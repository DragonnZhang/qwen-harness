import { HarnessError } from '@qwen-harness/protocol';
import { describe, expect, it } from 'vitest';

import { CHAT_CAPABILITIES, buildChatBody, toChatMessages } from './chat-transport.ts';
import type { ModelInputItem, ModelRequest } from '@qwen-harness/provider-core';

const request: ModelRequest = {
  model: 'qwen3.7-max',
  instructions: 'be terse',
  input: [{ type: 'message', role: 'user', text: 'add 2 and 3' }],
  tools: [{ name: 'add', description: 'add', parameters: { type: 'object' } }],
};

describe('toChatMessages', () => {
  it('maps the system prompt, user and assistant turns', () => {
    expect(
      toChatMessages('sys', [
        { type: 'message', role: 'user', text: 'hi' },
        { type: 'message', role: 'assistant', text: 'hello' },
      ]),
    ).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
  });

  it('collapses consecutive tool calls into ONE assistant message', () => {
    const input: ModelInputItem[] = [
      { type: 'function-call', callId: 'call_a', name: 'add', argumentsJson: '{"a":1}' },
      { type: 'function-call', callId: 'call_b', name: 'sub', argumentsJson: '{"b":2}' },
      { type: 'function-output', callId: 'call_a', name: 'add', output: '3' },
      { type: 'function-output', callId: 'call_b', name: 'sub', output: '1' },
    ];
    expect(toChatMessages('', input)).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_a', type: 'function', function: { name: 'add', arguments: '{"a":1}' } },
          { id: 'call_b', type: 'function', function: { name: 'sub', arguments: '{"b":2}' } },
        ],
      },
      { role: 'tool', content: '3', tool_call_id: 'call_a' },
      { role: 'tool', content: '1', tool_call_id: 'call_b' },
    ]);
  });

  it('pairs each output against its exact call ID (PV-06)', () => {
    const messages = toChatMessages('', [
      { type: 'function-call', callId: 'call_zzz', name: 'add', argumentsJson: '{}' },
      { type: 'function-output', callId: 'call_zzz', name: 'add', output: 'ok' },
    ]);
    expect(messages[1]).toEqual({ role: 'tool', content: 'ok', tool_call_id: 'call_zzz' });
  });
});

describe('buildChatBody', () => {
  it('always asks for the final usage chunk (PV-09)', () => {
    expect(buildChatBody(request, 'medium')['stream_options']).toEqual({ include_usage: true });
  });

  it('puts enable_thinking at the TOP level and never emits extra_body (PV-13)', () => {
    const on = buildChatBody(request, 'medium');
    const off = buildChatBody(request, 'none');
    expect(on['enable_thinking']).toBe(true);
    expect(off['enable_thinking']).toBe(false);
    expect(JSON.stringify(on)).not.toContain('extra_body');
    expect(JSON.stringify(on)).not.toContain('generationConfig');
    expect(on).not.toHaveProperty('reasoning');
  });

  it('never sends background', () => {
    expect(buildChatBody(request, 'medium')).not.toHaveProperty('background');
  });

  it('throws before building anything for an inexpressible effort', () => {
    let thrown: unknown;
    try {
      buildChatBody(request, 'high');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HarnessError);
    expect((thrown as HarnessError).category).toBe('provider.unsupported.reasoning_granularity');
  });

  it('omits max_tokens when the caller did not ask for a cap', () => {
    expect(buildChatBody(request, 'none')).not.toHaveProperty('max_tokens');
    expect(buildChatBody({ ...request, maxOutputTokens: 128 }, 'none')['max_tokens']).toBe(128);
  });
});

describe('CHAT_CAPABILITIES', () => {
  it('declares no reasoning summary — reasoning_content is not one', () => {
    expect(CHAT_CAPABILITIES.reasoningSummary).toBe(false);
  });

  it('declares binary thinking, and background/structuredOutput frozen false', () => {
    expect(CHAT_CAPABILITIES.reasoningEffortGranularity).toBe('binary');
    expect(CHAT_CAPABILITIES.background).toBe(false);
    expect(CHAT_CAPABILITIES.structuredOutput).toBe(false);
    expect(CHAT_CAPABILITIES.incrementalToolArgs).toBe(true);
    expect(Object.isFrozen(CHAT_CAPABILITIES)).toBe(true);
  });
});
