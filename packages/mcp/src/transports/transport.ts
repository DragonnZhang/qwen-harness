import type { JsonRpcMessage, PeerChannel } from '../jsonrpc.ts';

/** The transport families MCP defines (MC-02). `ide-sse` is `sse` plus a documented handshake. */
export type TransportKind = 'stdio' | 'http' | 'sse' | 'ide-sse' | 'websocket' | 'in-process';

/**
 * A `Transport` moves opaque JSON-RPC frames between the client and one server, and knows how it
 * is framed (newline-delimited over a pipe, an HTTP POST body, an in-memory hand-off). It is a
 * `PeerChannel`, so a `JsonRpcPeer` sits directly on top of any transport without caring which one
 * it is — the correlation logic is written once (MC-01).
 *
 * `start()` establishes the underlying connection; `close()` tears it down and MUST cause every
 * registered close handler to fire so in-flight requests reject instead of hanging (MC-06).
 */
export interface Transport extends PeerChannel {
  readonly kind: TransportKind;
  start(): Promise<void>;
  send(message: JsonRpcMessage): Promise<void>;
  close(): Promise<void>;
}

/**
 * Small shared bookkeeping for the message/close listeners every transport needs, so each concrete
 * transport only implements its own framing.
 */
export class TransportListeners {
  #onMessage: ((m: JsonRpcMessage) => void) | null = null;
  readonly #onClose = new Set<(err?: Error) => void>();
  #closed = false;

  onMessage(handler: (m: JsonRpcMessage) => void): void {
    this.#onMessage = handler;
  }
  onClose(handler: (err?: Error) => void): void {
    this.#onClose.add(handler);
  }

  emitMessage(message: JsonRpcMessage): void {
    this.#onMessage?.(message);
  }

  /** Idempotent: closing twice fires the close handlers exactly once. */
  emitClose(err?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const handler of this.#onClose) handler(err);
  }

  get closed(): boolean {
    return this.#closed;
  }
}
