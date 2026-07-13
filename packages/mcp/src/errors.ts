import { harnessError, type HarnessError } from '@qwen-harness/protocol';

/**
 * MCP failures are classified, never a bare `Error`. The runtime branches on the class to decide
 * whether a reconnect is even legal (`connection` yes, `protocol` no), whether the user must act
 * (`auth`), and how a `doctor` surface should describe the server (MC-06).
 *
 * These are the transport/lifecycle classes plus the `ide-sse` profile classes frozen in
 * defaults.md ("MCP transport and cache defaults"). They are separate from JSON-RPC wire error
 * OBJECTS, which live in `jsonrpc.ts`: a JSON-RPC error is a well-formed response the server chose
 * to send; an `McpError` is something wrong with the connection or the peer itself.
 */
export type McpErrorClass =
  | 'connection'
  | 'auth'
  | 'protocol'
  | 'server'
  | 'timeout'
  | 'cancelled'
  | 'invalid-profile'
  | 'unauthorized-peer'
  | 'expired-profile'
  | 'workspace-mismatch'
  | 'unsafe-url'
  | 'config'
  | 'not-trusted';

/** Which classes may be recovered by reconnecting, subject to the transport's own policy (MC-06). */
const RECONNECTABLE: ReadonlySet<McpErrorClass> = new Set<McpErrorClass>([
  'connection',
  'timeout',
  'server',
]);

export class McpError extends Error {
  readonly class: McpErrorClass;
  /** The server this failure is attributed to, when known. Part of the audit identity (SC-03). */
  readonly server: string | null;

  constructor(
    cls: McpErrorClass,
    message: string,
    opts: { server?: string; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'McpError';
    this.class = cls;
    this.server = opts.server ?? null;
  }

  /** Whether a lifecycle manager may attempt reconnect for this failure. */
  get reconnectable(): boolean {
    return RECONNECTABLE.has(this.class);
  }

  /** Bridge to the runtime-wide typed error so an MCP failure joins the same recovery machinery. */
  toHarnessError(): HarnessError {
    return harnessError({
      origin: 'mcp',
      category: `mcp.${this.class}`,
      message: this.message,
      retryable: this.reconnectable,
      userActionRequired: this.class === 'auth' || this.class === 'not-trusted',
      // A connection failure did not necessarily complete the call it was carrying.
      sideEffectCertainty: this.class === 'connection' ? 'indeterminate' : 'none',
    });
  }
}

export function isMcpError(value: unknown): value is McpError {
  return value instanceof McpError;
}
