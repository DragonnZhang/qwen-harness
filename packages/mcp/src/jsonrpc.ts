import { z } from 'zod';

import { McpError } from './errors.ts';

/**
 * JSON-RPC 2.0 — the wire protocol both transports speak (MC-01).
 *
 * This module owns framing-independent concerns: the message shapes, id correlation, error
 * objects, and batch handling. It knows nothing about stdio, sockets, or HTTP — a `Transport`
 * carries opaque `JsonRpcMessage`s, and `JsonRpcPeer` turns them into request/response promises
 * and dispatched notifications. That split is deliberate: the correlation logic is subtle and is
 * tested once here, not re-implemented per transport.
 *
 * Everything arriving from a peer is UNTRUSTED. Incoming frames are parsed with zod at the
 * boundary, so a malformed or hostile message becomes a typed rejection, never a thrown-through
 * crash that could take down discovery (MC-03).
 */

export const JSONRPC_VERSION = '2.0';

/** A JSON-RPC id is a string or an integer. We mint integers; a server may echo either. */
export const JsonRpcIdSchema = z.union([z.string(), z.number().int()]);
export type JsonRpcId = z.infer<typeof JsonRpcIdSchema>;

/** Standard JSON-RPC 2.0 error codes plus the reserved server range. */
export const JSON_RPC_ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

export const JsonRpcErrorObjectSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type JsonRpcErrorObject = z.infer<typeof JsonRpcErrorObjectSchema>;

export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal(JSONRPC_VERSION),
  id: JsonRpcIdSchema,
  method: z.string(),
  params: z.unknown().optional(),
});
export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;

export const JsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal(JSONRPC_VERSION),
  method: z.string(),
  params: z.unknown().optional(),
});
export type JsonRpcNotification = z.infer<typeof JsonRpcNotificationSchema>;

// A response is EITHER a result or an error, never both. A `.strict()`-ish refinement enforces that
// because a server that sends both is ambiguous about whether the call succeeded.
export const JsonRpcResponseSchema = z
  .object({
    jsonrpc: z.literal(JSONRPC_VERSION),
    id: JsonRpcIdSchema,
    result: z.unknown().optional(),
    error: JsonRpcErrorObjectSchema.optional(),
  })
  .refine((r) => (r.result === undefined) !== (r.error === undefined), {
    message: 'a JSON-RPC response must carry exactly one of result or error',
  });
export type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>;

export type JsonRpcSingleMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;
/** A frame is a single message or a batch of them (JSON-RPC 2.0 §6). */
export type JsonRpcMessage = JsonRpcSingleMessage | JsonRpcSingleMessage[];

/**
 * Classify one already-JSON-parsed value into a typed message, or throw a protocol error. The
 * incoming value is untrusted, so every branch validates before returning.
 */
export function decodeMessage(value: unknown): JsonRpcMessage {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      throw new McpError('protocol', 'received an empty JSON-RPC batch');
    }
    return value.map((entry) => decodeSingle(entry));
  }
  return decodeSingle(value);
}

function decodeSingle(value: unknown): JsonRpcSingleMessage {
  if (value === null || typeof value !== 'object') {
    throw new McpError('protocol', 'JSON-RPC message is not an object');
  }
  const obj = value as Record<string, unknown>;
  // A response has an id AND (result | error) but no method. A request has id AND method. A
  // notification has method and NO id. Discriminate on those, then validate the winner.
  const hasMethod = typeof obj['method'] === 'string';
  const hasId = 'id' in obj && obj['id'] !== undefined;
  if (hasMethod && hasId) return JsonRpcRequestSchema.parse(value);
  if (hasMethod) return JsonRpcNotificationSchema.parse(value);
  return JsonRpcResponseSchema.parse(value);
}

export function isRequest(m: JsonRpcSingleMessage): m is JsonRpcRequest {
  return 'method' in m && 'id' in m && m.id !== undefined;
}
export function isNotification(m: JsonRpcSingleMessage): m is JsonRpcNotification {
  return 'method' in m && !('id' in m);
}
export function isResponse(m: JsonRpcSingleMessage): m is JsonRpcResponse {
  return !('method' in m);
}

/** A raised JSON-RPC error response, surfaced to the caller of `request()`. */
export class JsonRpcCallError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data: unknown,
  ) {
    super(message);
    this.name = 'JsonRpcCallError';
  }
}

interface Pending {
  readonly method: string;
  resolve(result: unknown): void;
  reject(err: unknown): void;
  timer: ReturnType<typeof setTimeout> | null;
}

/** What a peer needs from the layer below it: send a frame, and be told when frames arrive. */
export interface PeerChannel {
  send(message: JsonRpcMessage): Promise<void>;
  onMessage(handler: (m: JsonRpcMessage) => void): void;
  onClose(handler: (err?: Error) => void): void;
}

export interface RequestOptions {
  /** Hard cap; on expiry the pending request rejects with a `timeout` McpError (MC-06). */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface PeerHandlers {
  /** A server→client request (reverse channel: elicitation, sampling, roots). Return the result. */
  readonly onRequest?: (method: string, params: unknown, id: JsonRpcId) => Promise<unknown>;
  readonly onNotification?: (method: string, params: unknown) => void;
}

/**
 * A bidirectional JSON-RPC endpoint over a `PeerChannel`.
 *
 * It correlates responses to outstanding requests by id, times out a request that never answers,
 * dispatches server-initiated requests and notifications to injected handlers, and fails every
 * in-flight request when the channel closes — an in-flight call whose transport dropped must
 * reject, not hang forever.
 */
export class JsonRpcPeer {
  readonly #channel: PeerChannel;
  readonly #handlers: PeerHandlers;
  readonly #nextId: () => JsonRpcId;
  readonly #pending = new Map<JsonRpcId, Pending>();
  #closed = false;
  #closeError: Error | null = null;

  constructor(
    channel: PeerChannel,
    handlers: PeerHandlers = {},
    // Injected so a test can make ids deterministic; defaults to a monotonic counter, which is
    // already deterministic per-peer.
    nextId?: () => JsonRpcId,
  ) {
    this.#channel = channel;
    this.#handlers = handlers;
    let counter = 0;
    this.#nextId = nextId ?? (() => ++counter);
    channel.onMessage((m) => this.#receive(m));
    channel.onClose((err) => this.#onClose(err));
  }

  /** Issue a request and await its correlated result, or reject on error/timeout/close. */
  request(method: string, params?: unknown, opts: RequestOptions = {}): Promise<unknown> {
    if (this.#closed) {
      const err: Error = this.#closeError ?? new McpError('connection', 'peer is closed');
      return Promise.reject(err);
    }
    const id = this.#nextId();
    return new Promise<unknown>((resolve, reject) => {
      const pending: Pending = { method, resolve, reject, timer: null };
      if (opts.timeoutMs !== undefined) {
        pending.timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(
            new McpError('timeout', `request "${method}" timed out after ${opts.timeoutMs}ms`),
          );
        }, opts.timeoutMs);
        // A bounded wait must never keep the event loop alive on its own.
        pending.timer.unref?.();
      }
      opts.signal?.addEventListener(
        'abort',
        () => {
          if (this.#pending.delete(id)) {
            if (pending.timer) clearTimeout(pending.timer);
            reject(new McpError('cancelled', `request "${method}" was cancelled`));
          }
        },
        { once: true },
      );
      this.#pending.set(id, pending);
      const frame: JsonRpcRequest = {
        jsonrpc: JSONRPC_VERSION,
        id,
        method,
        ...paramsField(params),
      };
      this.#channel.send(frame).catch((err: unknown) => {
        if (this.#pending.delete(id)) {
          if (pending.timer) clearTimeout(pending.timer);
          const error: Error = err instanceof Error ? err : new McpError('connection', String(err));
          reject(error);
        }
      });
    });
  }

  /** Fire-and-forget: a notification has no id and expects no response. */
  async notify(method: string, params?: unknown): Promise<void> {
    if (this.#closed) throw this.#closeError ?? new McpError('connection', 'peer is closed');
    const frame: JsonRpcNotification = { jsonrpc: JSONRPC_VERSION, method, ...paramsField(params) };
    await this.#channel.send(frame);
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  #receive(message: JsonRpcMessage): void {
    // A batch is handled member by member; ordering within the batch is preserved.
    const list = Array.isArray(message) ? message : [message];
    for (const m of list) {
      if (isResponse(m)) this.#settle(m);
      else if (isRequest(m)) void this.#dispatchRequest(m);
      else this.#dispatchNotification(m);
    }
  }

  #settle(response: JsonRpcResponse): void {
    const pending = this.#pending.get(response.id);
    if (pending === undefined) return; // A late or duplicate response for an unknown id is dropped.
    this.#pending.delete(response.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (response.error !== undefined) {
      pending.reject(
        new JsonRpcCallError(response.error.code, response.error.message, response.error.data),
      );
    } else {
      pending.resolve(response.result);
    }
  }

  async #dispatchRequest(request: JsonRpcRequest): Promise<void> {
    const handler = this.#handlers.onRequest;
    if (handler === undefined) {
      await this.#channel
        .send({
          jsonrpc: JSONRPC_VERSION,
          id: request.id,
          error: {
            code: JSON_RPC_ERROR.methodNotFound,
            message: `method not found: ${request.method}`,
          },
        })
        .catch(() => undefined);
      return;
    }
    try {
      const result = await handler(request.method, request.params, request.id);
      await this.#channel.send({
        jsonrpc: JSONRPC_VERSION,
        id: request.id,
        result: result ?? null,
      });
    } catch (err) {
      await this.#channel
        .send({
          jsonrpc: JSONRPC_VERSION,
          id: request.id,
          error: {
            code: JSON_RPC_ERROR.internal,
            message: err instanceof Error ? err.message : 'handler failed',
          },
        })
        .catch(() => undefined);
    }
  }

  #dispatchNotification(notification: JsonRpcNotification): void {
    this.#handlers.onNotification?.(notification.method, notification.params);
  }

  #onClose(err?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeError = err ?? new McpError('connection', 'peer channel closed');
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(this.#closeError);
    }
  }
}

/** Only attach a `params` key when there are params — an explicit `undefined` is not valid JSON. */
function paramsField(params: unknown): { params?: unknown } {
  return params === undefined ? {} : { params };
}
