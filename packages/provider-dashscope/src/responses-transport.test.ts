import { describe, expect, it } from 'vitest';

import type { ModelRequest } from '@qwen-harness/provider-core';

import { buildResponsesBody, parseToolArguments } from './responses-transport.ts';

const request: ModelRequest = {
  model: 'qwen3.7-max',
  instructions: 'be terse',
  input: [{ type: 'message', role: 'user', text: 'hi' }],
  tools: [{ name: 'add', description: 'add', parameters: { type: 'object' } }],
};

describe('buildResponsesBody', () => {
  it('never sends background — the live server answers 400 for it (PV-07)', () => {
    expect(buildResponsesBody(request, 'medium')).not.toHaveProperty('background');
  });

  it('never sends previous_response_id — local history is authoritative (PV-08)', () => {
    expect(buildResponsesBody(request, 'medium')).not.toHaveProperty('previous_response_id');
  });

  it('never emits a Python-style extra_body key (PV-13)', () => {
    expect(JSON.stringify(buildResponsesBody(request, 'medium'))).not.toContain('extra_body');
  });

  it('sends the graded effort and asks for a summary', () => {
    expect(buildResponsesBody(request, 'high')['reasoning']).toEqual({
      effort: 'high',
      summary: 'auto',
    });
    expect(buildResponsesBody(request, 'none')['reasoning']).toEqual({ effort: 'none' });
  });

  it('maps input items to Responses item shapes, preserving call IDs', () => {
    const body = buildResponsesBody(
      {
        ...request,
        input: [
          { type: 'message', role: 'user', text: 'add 1 and 2' },
          { type: 'function-call', callId: 'call_x', name: 'add', argumentsJson: '{"a":1}' },
          { type: 'function-output', callId: 'call_x', name: 'add', output: '3' },
        ],
      },
      'medium',
    );
    expect(body['input']).toEqual([
      { type: 'message', role: 'user', content: 'add 1 and 2' },
      { type: 'function_call', call_id: 'call_x', name: 'add', arguments: '{"a":1}' },
      { type: 'function_call_output', call_id: 'call_x', output: '3' },
    ]);
  });

  it('omits tools entirely when there are none', () => {
    expect(buildResponsesBody({ ...request, tools: [] }, 'medium')).not.toHaveProperty('tools');
  });
});

describe('parseToolArguments (PV-05)', () => {
  it('accepts a complete JSON object', () => {
    const result = parseToolArguments('{"a": 21, "b": 21}');
    expect(result).toEqual({ ok: true, value: { a: 21, b: 21 } });
  });

  it('treats an empty argument string as an empty object', () => {
    expect(parseToolArguments('')).toEqual({ ok: true, value: {} });
    expect(parseToolArguments('   ')).toEqual({ ok: true, value: {} });
  });

  it('refuses truncated JSON rather than salvaging what parsed', () => {
    expect(parseToolArguments('{"a": 21, "b":').ok).toBe(false);
    expect(parseToolArguments('{"a"').ok).toBe(false);
  });

  it('refuses valid JSON that is not an object — a tool takes named arguments', () => {
    expect(parseToolArguments('42').ok).toBe(false);
    expect(parseToolArguments('"a string"').ok).toBe(false);
    expect(parseToolArguments('[1, 2]').ok).toBe(false);
    expect(parseToolArguments('null').ok).toBe(false);
  });
});
