import { describe, expect, it } from 'vitest';

import { readSseFrames, type SseFrame } from './sse.ts';

function stream(text: string, chunkSize = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

async function frames(text: string, chunkSize?: number): Promise<SseFrame[]> {
  const out: SseFrame[] = [];
  for await (const frame of readSseFrames(stream(text, chunkSize))) out.push(frame);
  return out;
}

describe('readSseFrames', () => {
  it('reads named frames', async () => {
    expect(await frames('event: a\ndata: 1\n\nevent: b\ndata: 2\n\n')).toEqual([
      { event: 'a', data: '1' },
      { event: 'b', data: '2' },
    ]);
  });

  it('reads unnamed data-only frames (the Chat Completions shape)', async () => {
    expect(await frames('data: {"x":1}\n\ndata: [DONE]\n\n')).toEqual([
      { event: null, data: '{"x":1}' },
      { event: null, data: '[DONE]' },
    ]);
  });

  it('reassembles a frame split across arbitrary byte boundaries', async () => {
    const text = 'event: response.output_text.delta\ndata: {"delta":"héllo ☃"}\n\n';
    for (const chunkSize of [1, 2, 3, 5, 13, 64]) {
      expect(await frames(text, chunkSize)).toEqual([
        { event: 'response.output_text.delta', data: '{"delta":"héllo ☃"}' },
      ]);
    }
  });

  it('joins multi-line data with newlines, per the SSE spec', async () => {
    expect(await frames('data: a\ndata: b\n\n')).toEqual([{ event: null, data: 'a\nb' }]);
  });

  it('ignores comments and unknown fields', async () => {
    expect(await frames(': keepalive\nid: 9\nretry: 5\nevent: a\ndata: 1\n\n')).toEqual([
      { event: 'a', data: '1' },
    ]);
  });

  it('handles CRLF line endings', async () => {
    expect(await frames('event: a\r\ndata: 1\r\n\r\n')).toEqual([{ event: 'a', data: '1' }]);
  });

  // The one that matters: a truncated tail must never surface as a complete frame, because a
  // half-parsed model event is how a partial tool call escapes the gate.
  it('drops a frame that was never terminated by a blank line', async () => {
    expect(await frames('event: a\ndata: 1\n\nevent: b\ndata: {"trunc')).toEqual([
      { event: 'a', data: '1' },
    ]);
  });

  it('treats an absent value as the empty string', async () => {
    expect(await frames('event: a\ndata:\n\n')).toEqual([{ event: 'a', data: '' }]);
  });
});
