import type { Clock } from '@qwen-harness/protocol';

import { McpError } from '../errors.ts';
import { decodeMessage, type JsonRpcMessage } from '../jsonrpc.ts';
import type { HttpGateway, SseConnection } from './http-gateway.ts';
import { type Transport, TransportListeners } from './transport.ts';

export interface HttpTransportOptions {
  /** The single Streamable-HTTP endpoint the client POSTs JSON-RPC to. */
  readonly url: string;
  /** Separate GET endpoint for the server→client SSE stream. Defaults to `url`. Used by ide-sse. */
  readonly sseUrl?: string;
  /** Which transport family this is, for `doctor`. Defaults to `http`; ide-sse sets `sse`. */
  readonly kind?: 'http' | 'sse' | 'ide-sse';
  readonly gateway: HttpGateway;
  readonly clock: Clock;
  readonly headers?: Readonly<Record<string, string>>;
  /** Whether to open a standalone GET SSE stream for server→client messages. Default true. */
  readonly openServerStream?: boolean;
  readonly reconnect?: Partial<ReconnectPolicy>;
  /** Injected [0,1) source for full-jitter backoff; deterministic in tests. Default Math.random. */
  readonly random01?: () => number;
}

export interface ReconnectPolicy {
  readonly baseMs: number;
  readonly capMs: number;
  readonly maxAttempts: number;
}

// defaults.md, "Runtime budgets": 500 ms base, 30 s cap, full jitter.
const DEFAULT_RECONNECT: ReconnectPolicy = { baseMs: 500, capMs: 30_000, maxAttempts: 10 };

/**
 * Streamable-HTTP + SSE transport (MC-02).
 *
 * Outgoing frames are POSTed to a single endpoint through the injected `HttpGateway` (never a raw
 * socket — `mcp` owns no HTTP capability). A POST response may carry the reply inline as JSON, and
 * a standalone SSE stream carries server-initiated messages.
 *
 * The reconnect behavior is the pinned part (MC-06, defaults.md): when the SSE stream DROPS, the
 * transport reconnects with bounded exponential backoff and full jitter, resuming from the last
 * event id — UNLIKE stdio, HTTP/SSE reconnects automatically. It stops after `maxAttempts` and
 * then closes the transport for real, so a permanently dead server does not retry forever.
 */
export class HttpTransport implements Transport {
  readonly kind: 'http' | 'sse' | 'ide-sse';
  readonly #opts: HttpTransportOptions;
  readonly #reconnect: ReconnectPolicy;
  readonly #listeners = new TransportListeners();
  readonly #random01: () => number;
  #sse: SseConnection | null = null;
  #lastEventId: string | null = null;
  #stopped = false;

  constructor(opts: HttpTransportOptions) {
    this.#opts = opts;
    this.kind = opts.kind ?? 'http';
    this.#reconnect = { ...DEFAULT_RECONNECT, ...opts.reconnect };
    this.#random01 = opts.random01 ?? Math.random;
  }

  onMessage(handler: (m: JsonRpcMessage) => void): void {
    this.#listeners.onMessage(handler);
  }
  onClose(handler: (err?: Error) => void): void {
    this.#listeners.onClose(handler);
  }

  async start(): Promise<void> {
    if (this.#opts.openServerStream === false) return;
    await this.#openStream(0);
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.#stopped) throw new McpError('connection', 'http transport is closed');
    const response = await this.#opts.gateway.send({
      method: 'POST',
      url: this.#opts.url,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(this.#opts.headers ?? {}),
      },
      body: JSON.stringify(message),
    });
    if (response.status === 401 || response.status === 403) {
      throw new McpError('auth', `server refused the request (HTTP ${response.status})`);
    }
    if (response.status >= 400) {
      throw new McpError('server', `server returned HTTP ${response.status}`);
    }
    // 202 Accepted (notification-only) has no body. A JSON body is the inline reply.
    const trimmed = response.body.trim();
    if (trimmed.length === 0) return;
    try {
      this.#listeners.emitMessage(decodeMessage(JSON.parse(trimmed)));
    } catch (err) {
      throw new McpError('protocol', 'malformed JSON-RPC response body', { cause: err });
    }
  }

  /** Open the server→client SSE stream; on a fault, reconnect with backoff from `attempt`. */
  async #openStream(attempt: number): Promise<void> {
    if (this.#stopped) return;
    try {
      this.#sse = await this.#opts.gateway.openSse(
        {
          method: 'GET',
          url: this.#opts.sseUrl ?? this.#opts.url,
          headers: {
            ...(this.#opts.headers ?? {}),
            ...(this.#lastEventId !== null ? { 'last-event-id': this.#lastEventId } : {}),
          },
        },
        {
          onEvent: (event) => {
            if (event.id !== null) this.#lastEventId = event.id;
            if (event.data.trim().length === 0) return;
            try {
              this.#listeners.emitMessage(decodeMessage(JSON.parse(event.data)));
            } catch {
              // A non-JSON SSE payload is dropped, never fatal to the stream.
            }
          },
          onClose: (err) => {
            this.#sse = null;
            if (err !== undefined) void this.#scheduleReconnect(attempt + 1);
          },
        },
      );
    } catch (err) {
      if (!this.#stopped) void this.#scheduleReconnect(attempt + 1, err);
    }
  }

  async #scheduleReconnect(attempt: number, cause?: unknown): Promise<void> {
    if (this.#stopped) return;
    if (attempt > this.#reconnect.maxAttempts) {
      // Give up: a permanently dead stream must close the transport, not spin forever.
      this.#listeners.emitClose(
        new McpError('connection', `SSE reconnect exhausted after ${attempt - 1} attempts`, {
          cause,
        }),
      );
      this.#stopped = true;
      return;
    }
    const ceiling = Math.min(this.#reconnect.capMs, this.#reconnect.baseMs * 2 ** (attempt - 1));
    const delay = Math.floor(this.#random01() * ceiling); // full jitter
    try {
      await this.#opts.clock.sleep(delay);
    } catch {
      return; // sleep aborted → we are shutting down.
    }
    await this.#openStream(attempt);
  }

  close(): Promise<void> {
    this.#stopped = true;
    this.#sse?.close();
    this.#sse = null;
    this.#listeners.emitClose();
    return Promise.resolve();
  }
}
