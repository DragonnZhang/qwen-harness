import {
  DEFAULT_NETWORK_POLICY,
  NetworkError,
  type NetworkBroker,
  type NetworkPolicy,
} from '@qwen-harness/network';

/**
 * The HTTP seam for the MCP package.
 *
 * `mcp` owns `node:child_process` and `node:net` but NOT `node:http`/`undici` — the architecture
 * gate forbids it, because "outbound HTTP still goes through network" (scripts/graph.ts). So the
 * Streamable-HTTP transport, the SSE transport, and OAuth all talk to an injected `HttpGateway`
 * instead of opening a socket.
 *
 * The shipped `NetworkBroker` is GET-only, reads a bounded body, and sanitizes it (perfect for
 * OAuth metadata discovery, which this gateway routes straight through it). But JSON-RPC POSTs and
 * a never-ending SSE stream cannot be expressed by that GET-and-buffer surface, and the broker may
 * not be modified here. So the gateway takes TWO collaborators from the network layer: the broker
 * itself (used for discovery GETs, SSRF-guarded and sanitized) and a raw request/stream primitive
 * the composition root backs with the same undici the broker uses. Every URL the raw primitive is
 * asked to reach is first validated against the SAME `NetworkPolicy` the broker enforces, so a POST
 * to a loopback or metadata address is refused exactly as a GET would be.
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

/**
 * The raw request/stream primitive the composition root provides. It is where the ACTUAL socket
 * lives — in the app (or the network package), never in `mcp`. Kept intentionally tiny.
 */
export interface RawHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  text(): Promise<string>;
  /** A byte stream for SSE, or null for a non-streaming response. */
  stream(): AsyncIterable<Uint8Array> | null;
}
export type RawHttp = (
  request: HttpRequest,
  opts: { signal?: AbortSignal },
) => Promise<RawHttpResponse>;

// -----------------------------------------------------------------------------------------------
// URL policy guard — the same checks the broker makes, applied to POST/SSE the broker can't carry.
// -----------------------------------------------------------------------------------------------

const PRIVATE_HOST = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|::1|fc00:|fe80:)/i;
const PRIVATE_IPV4_172 = /^172\.(1[6-9]|2\d|3[01])\./;
const METADATA_HOSTS = new Set(['169.254.169.254', '100.100.100.100', 'metadata.google.internal']);

/**
 * Validate a URL against the network policy WITHOUT performing IO. This mirrors the broker's guard
 * so a POST/SSE reaches nowhere a GET could not; the broker owns the same rules for the GET path.
 */
export function assertUrlAllowed(url: string, policy: NetworkPolicy): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new NetworkError('request-failed', `invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new NetworkError('scheme-denied', `scheme ${parsed.protocol} is not allowed`);
  }
  const host = parsed.hostname.toLowerCase();
  if (METADATA_HOSTS.has(host)) {
    throw new NetworkError('private-address', `refusing to reach the metadata endpoint ${host}`);
  }
  if (policy.blockPrivateAddresses && (PRIVATE_HOST.test(host) || PRIVATE_IPV4_172.test(host))) {
    throw new NetworkError('private-address', `refusing to reach a private address: ${host}`);
  }
  for (const deny of policy.denyHosts) {
    if (host === deny || host.endsWith(`.${deny}`)) {
      throw new NetworkError('host-denied', `host ${host} is denied by policy`);
    }
  }
  if (policy.allowHosts.length > 0) {
    const ok = policy.allowHosts.some((h) => host === h || host.endsWith(`.${h}`));
    if (!ok) throw new NetworkError('host-denied', `host ${host} is not on the allowlist`);
  }
  return parsed;
}

export interface BrokeredGatewayOptions {
  readonly broker: NetworkBroker;
  readonly rawHttp: RawHttp;
  readonly policy?: NetworkPolicy;
}

/**
 * The production gateway: discovery GETs go through the real `NetworkBroker` (SSRF-guarded,
 * sanitized), POST/SSE go through the raw primitive after the identical policy guard.
 */
export function brokeredGateway(opts: BrokeredGatewayOptions): HttpGateway {
  const policy = opts.policy ?? DEFAULT_NETWORK_POLICY;
  return {
    async send(request, callOpts = {}): Promise<HttpResponse> {
      if (request.method === 'GET') {
        // A GET is exactly what the broker does well — let it enforce policy and read the body.
        const result = await opts.broker.fetch(request.url, callOpts);
        return { status: result.status, headers: {}, body: result.content };
      }
      assertUrlAllowed(request.url, policy);
      const response = await opts.rawHttp(request, callOpts);
      return { status: response.status, headers: response.headers, body: await response.text() };
    },
    async openSse(request, handlers, callOpts = {}): Promise<SseConnection> {
      assertUrlAllowed(request.url, policy);
      const response = await opts.rawHttp(
        {
          ...request,
          method: 'GET',
          headers: { Accept: 'text/event-stream', ...(request.headers ?? {}) },
        },
        callOpts,
      );
      const stream = response.stream();
      if (stream === null) {
        handlers.onClose(new Error('server did not return an event stream'));
        return { lastEventId: null, close: () => undefined };
      }
      const parser = new SseParser();
      let closed = false;
      let lastId: string | null = null;
      const controller = new AbortController();
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
