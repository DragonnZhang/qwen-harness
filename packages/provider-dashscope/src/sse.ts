/**
 * A Server-Sent Events reader (WHATWG SSE, the subset the endpoint actually uses).
 *
 * Written by hand rather than pulled from a dependency for one reason: the failure mode we care
 * about is a stream that is CUT OFF, and a parser must not hand us a half-built frame as though it
 * were complete. Everything here is line-buffered, and a frame is only yielded on the blank line
 * that terminates it. A truncated tail is dropped, and the caller sees the stream end without a
 * terminal event — which is exactly the condition that becomes `provider.stream.truncated`.
 */
export interface SseFrame {
  /** The `event:` field, or null for an unnamed (data-only) frame — Chat Completions uses those. */
  readonly event: string | null;
  readonly data: string;
}

/** Chat Completions terminates its stream with this literal payload. */
export const SSE_DONE = '[DONE]';

export async function* readSseFrames(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event: string | null = null;
  let data: string[] = [];

  const flush = (): SseFrame | null => {
    if (data.length === 0 && event === null) return null;
    const frame: SseFrame = { event, data: data.join('\n') };
    event = null;
    data = [];
    return frame;
  };

  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Normalize CRLF/CR line endings once, then consume whole lines only.
      let newline = buffer.search(/\r\n|\r|\n/);
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        const matched = /\r\n|\r|\n/.exec(buffer.slice(newline));
        buffer = buffer.slice(newline + (matched?.[0].length ?? 1));

        if (line === '') {
          const frame = flush();
          if (frame !== null) yield frame;
        } else if (!line.startsWith(':')) {
          // `field: value`; a single leading space after the colon is part of the framing.
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          const rawValue = colon === -1 ? '' : line.slice(colon + 1);
          const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;
          if (field === 'event') event = value;
          else if (field === 'data') data.push(value);
          // `id` and `retry` are irrelevant here: we never resume an SSE stream. A resumed model
          // stream would concatenate onto partial visible output, which PV-11 forbids outright.
        }
        newline = buffer.search(/\r\n|\r|\n/);
      }
    }
  } finally {
    // Releasing the lock lets an aborted fetch actually tear the socket down.
    reader.releaseLock();
  }
}
