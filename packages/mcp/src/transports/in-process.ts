import {
  JSONRPC_VERSION,
  isNotification,
  isRequest,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcSingleMessage,
} from '../jsonrpc.ts';
import { type Transport, TransportListeners } from './transport.ts';

/**
 * What a server the client can push back TO looks like from the server's side. An in-process (or
 * built-in) server uses this to send notifications (`tools/list_changed`) and reverse requests
 * (elicitation) to the connected client — the same directions a real socket server has.
 */
export interface ServerToClient {
  notify(method: string, params?: unknown): void;
  request(method: string, params: unknown): Promise<unknown>;
}

/**
 * An in-memory MCP server object. Pairs with an `InProcessTransport` so a client can talk to a
 * server that lives in the same process — for tests, and for the product's built-in servers, which
 * need no socket at all (MC-02). It is the SAME `McpClient` on the other side, so a round trip here
 * exercises the real initialize/list/call path, not a shortcut.
 */
export interface InProcessServer {
  handleRequest(method: string, params: unknown): Promise<unknown>;
  handleNotification?(method: string, params: unknown): void;
  /** The server is handed a sink to push notifications/requests to the client. */
  attachClient?(sink: ServerToClient): void;
}

/**
 * A zero-copy in-memory transport. `send` from the client is delivered synchronously (on a
 * microtask, to keep call stacks flat and ordering FIFO) to the server, and the server's replies
 * come back the same way. No framing, no serialization — but it goes through the identical
 * `JsonRpcPeer` correlation, so it validates the protocol logic, not a bypass of it.
 */
export class InProcessTransport implements Transport {
  readonly kind = 'in-process' as const;
  readonly #server: InProcessServer;
  readonly #listeners = new TransportListeners();
  #started = false;
  #serverRequestId = 0;
  readonly #serverPending = new Map<JsonRpcId, (r: JsonRpcSingleMessage) => void>();

  constructor(server: InProcessServer) {
    this.#server = server;
  }

  onMessage(handler: (m: JsonRpcMessage) => void): void {
    this.#listeners.onMessage(handler);
  }
  onClose(handler: (err?: Error) => void): void {
    this.#listeners.onClose(handler);
  }

  start(): Promise<void> {
    if (this.#started) return Promise.resolve();
    this.#started = true;
    // Give the server the sink it uses to talk back to us.
    this.#server.attachClient?.({
      notify: (method, params) =>
        this.#deliverToClient({ jsonrpc: JSONRPC_VERSION, method, ...paramsOf(params) }),
      request: (method, params) => this.#serverRequest(method, params),
    });
    return Promise.resolve();
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.#listeners.closed) throw new Error('transport is closed');
    const list = Array.isArray(message) ? message : [message];
    for (const m of list) await this.#routeToServer(m);
  }

  async #routeToServer(m: JsonRpcSingleMessage): Promise<void> {
    if (isRequest(m)) {
      // A client→server request. Run the handler, then hand the response back to the client.
      try {
        const result = await this.#server.handleRequest(m.method, m.params);
        this.#deliverToClient({ jsonrpc: JSONRPC_VERSION, id: m.id, result: result ?? null });
      } catch (err) {
        this.#deliverToClient({
          jsonrpc: JSONRPC_VERSION,
          id: m.id,
          error: { code: -32603, message: err instanceof Error ? err.message : 'server error' },
        });
      }
      return;
    }
    if (isNotification(m)) {
      this.#server.handleNotification?.(m.method, m.params);
      return;
    }
    // A response FROM the client to a server-initiated request (reverse channel).
    const waiter = this.#serverPending.get(m.id);
    if (waiter) {
      this.#serverPending.delete(m.id);
      waiter(m);
    }
  }

  #serverRequest(method: string, params: unknown): Promise<unknown> {
    const id = `srv-${++this.#serverRequestId}`;
    return new Promise<unknown>((resolve, reject) => {
      this.#serverPending.set(id, (response) => {
        if ('error' in response && response.error !== undefined) {
          reject(new Error(response.error.message));
        } else if ('result' in response) {
          resolve(response.result);
        }
      });
      this.#deliverToClient({ jsonrpc: JSONRPC_VERSION, id, method, ...paramsOf(params) });
    });
  }

  #deliverToClient(message: JsonRpcSingleMessage): void {
    // A microtask keeps delivery async (like a real socket) while preserving FIFO order.
    queueMicrotask(() => {
      if (!this.#listeners.closed) this.#listeners.emitMessage(message);
    });
  }

  close(): Promise<void> {
    this.#listeners.emitClose();
    this.#serverPending.clear();
    return Promise.resolve();
  }
}

function paramsOf(params: unknown): { params?: unknown } {
  return params === undefined ? {} : { params };
}
