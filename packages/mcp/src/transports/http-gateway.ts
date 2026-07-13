import type { NetworkBroker } from '@qwen-harness/network';

/**
 * The HTTP seam for the MCP package.
 *
 * `mcp` owns `node:child_process` and `node:net` but NOT `node:http`/`undici` — the architecture
 * gate forbids it, because "outbound HTTP still goes through network" (scripts/graph.ts). So the
 * Streamable-HTTP transport, the SSE transport, and OAuth all talk to an injected `HttpGateway`
 * instead of opening a socket.
 *
 * The gateway routes EVERYTHING through the one `NetworkBroker`, which now carries a POST-with-body
 * and streaming egress (`broker.send`) alongside its sanitizing GET (`broker.fetch`). There is no
 * second, separately-guarded HTTP primitive to keep in sync — the SSRF/host/scheme/redirect guard
 * lives once, in the broker, and applies to a JSON-RPC POST and an SSE GET exactly as it does to a
 * fetched page. Discovery GETs go through `broker.fetch` (sanitized, since OAuth metadata is
 * untrusted text); JSON-RPC POSTs and the SSE stream go through `broker.send` (raw, because a frame
 * must be byte-exact and `text/event-stream` is not a page content-type).
 */

export interface HttpRequest {
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** RAW body. JSON-RPC needs the exact bytes to parse; display-time sanitization happens later. */
  readonly body: string;
}

/** One decoded Server-Sent Event. `data` is still untrusted and is sanitized before display. */
export interface SseEvent {
  readonly event: string;
  readonly data: string;
  readonly id: string | null;
}

export interface SseHandlers {
  onEvent(event: SseEvent): void;
  /** The stream ended or dropped. `err` distinguishes a fault (reconnect) from a clean close. */
  onClose(err?: Error): void;
}

export interface SseConnection {
  /** Server-supplied last event id, so a reconnect can resume with `Last-Event-ID` (MC-06). */
  readonly lastEventId: string | null;
  close(): void;
}

export interface HttpGateway {
  /** A single request/response. POST is the Streamable-HTTP and OAuth token path. */
  send(request: HttpRequest, opts?: { signal?: AbortSignal }): Promise<HttpResponse>;
  /** Open a long-lived SSE stream and feed decoded events to the handlers until it closes. */
  openSse(
    request: HttpRequest,
    handlers: SseHandlers,
    opts?: { signal?: AbortSignal },
  ): Promise<SseConnection>;
}

export interface BrokeredGatewayOptions {
  readonly broker: NetworkBroker;
}

/**
 * The production gateway. Discovery GETs go through `broker.fetch` (SSRF-guarded AND sanitized,
 * because OAuth metadata is untrusted text). JSON-RPC POSTs and the SSE stream go through
 * `broker.send` — the SAME guard, raw body. There is no second guarded primitive here: the broker
 * is the single authority, so a POST is refused for a loopback/metadata/denied host exactly as a
 * GET is, with no duplicated regex to drift out of sync.
 */
export function brokeredGateway(opts: BrokeredGatewayOptions): HttpGateway {
  return {
    async send(request, callOpts = {}): Promise<HttpResponse> {
      if (request.method === 'GET') {
        // A GET is exactly what the broker's sanitizing path does well — let it enforce policy and
        // read the (bounded, sanitized) body. Used for OAuth metadata discovery.
        const result = await opts.broker.fetch(request.url, callOpts);
        return { status: result.status, headers: {}, body: result.content };
      }
      // POST/DELETE: the broker's guarded raw egress. It applies the identical SSRF/host/scheme/
      // redirect guard and throws before any socket if the URL is refused.
      const response = await opts.broker.send(request, callOpts);
      return { status: response.status, headers: response.headers, body: await response.text() };
    },
    async openSse(request, handlers, callOpts = {}): Promise<SseConnection> {
      // `close()` must actually tear the socket down, so the abort signal is threaded into the
      // guarded GET rather than merely flipping a flag the loop notices on the next event.
      const controller = new AbortController();
      if (callOpts.signal) {
        callOpts.signal.addEventListener('abort', () => controller.abort(), { once: true });
      }
      // The server→client stream is a guarded GET through the raw egress (streaming, not buffered).
      const response = await opts.broker.send(
        {
          method: 'GET',
          url: request.url,
          headers: { Accept: 'text/event-stream', ...(request.headers ?? {}) },
        },
        { signal: controller.signal },
      );
      const stream = response.stream();
      if (stream === null) {
        handlers.onClose(new Error('server did not return an event stream'));
        return { lastEventId: null, close: () => undefined };
      }
      const parser = new SseParser();
      let closed = false;
      let lastId: string | null = null;
      void (async () => {
        try {
          for await (const chunk of stream) {
            if (closed) break;
            for (const event of parser.push(Buffer.from(chunk).toString('utf8'))) {
              if (event.id !== null) lastId = event.id;
              handlers.onEvent(event);
            }
          }
          handlers.onClose();
        } catch (err) {
          if (!closed) handlers.onClose(err instanceof Error ? err : new Error(String(err)));
        }
      })();
      return {
        get lastEventId() {
          return lastId;
        },
        close: () => {
          closed = true;
          controller.abort();
        },
      };
    },
  };
}

/**
 * A streaming Server-Sent Events parser. Buffers across chunk boundaries and yields one `SseEvent`
 * per blank-line-terminated record, per the SSE spec's field grammar.
 */
export class SseParser {
  #buffer = '';

  push(chunk: string): SseEvent[] {
    this.#buffer += chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const events: SseEvent[] = [];
    let boundary = this.#buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const record = this.#buffer.slice(0, boundary);
      this.#buffer = this.#buffer.slice(boundary + 2);
      const event = this.#parseRecord(record);
      if (event !== null) events.push(event);
      boundary = this.#buffer.indexOf('\n\n');
    }
    return events;
  }

  #parseRecord(record: string): SseEvent | null {
    let eventName = 'message';
    let id: string | null = null;
    const dataLines: string[] = [];
    for (const rawLine of record.split('\n')) {
      if (rawLine.startsWith(':')) continue; // comment/heartbeat
      const colon = rawLine.indexOf(':');
      const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
      const value = colon === -1 ? '' : rawLine.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') eventName = value;
      else if (field === 'data') dataLines.push(value);
      else if (field === 'id') id = value;
    }
    if (dataLines.length === 0) return null;
    return { event: eventName, data: dataLines.join('\n'), id };
  }
}
