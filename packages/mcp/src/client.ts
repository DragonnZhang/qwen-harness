import type { Clock, IdSource } from '@qwen-harness/protocol';

import { McpError } from './errors.ts';
import { JsonRpcCallError, type JsonRpcId, JsonRpcPeer } from './jsonrpc.ts';
import { assignToolNames, type NamedMcpTool } from './naming.ts';
import {
  type CallToolResult,
  CallToolResultSchema,
  type ClientCapabilities,
  type GetPromptResult,
  GetPromptResultSchema,
  type InitializeResult,
  InitializeResultSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ListToolsResultSchema,
  MCP_METHODS,
  type McpTool,
  type Prompt,
  PROTOCOL_VERSION,
  type ReadResourceResult,
  ReadResourceResultSchema,
  type Resource,
  SUPPORTED_PROTOCOL_VERSIONS,
} from './protocol-types.ts';
import type { McpCallOutput } from './tool-adapter.ts';
import { ServerLog, type ServerHealth } from './scale.ts';
import type { Transport } from './transports/transport.ts';

export type ClientState = 'idle' | 'connecting' | 'ready' | 'disconnected' | 'failed';

export interface ReverseRequestHandler {
  (method: string, params: unknown): Promise<unknown>;
}

export interface McpClientOptions {
  readonly server: string;
  readonly transport: Transport;
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly capabilities?: ClientCapabilities;
  readonly clientInfo?: { name: string; version: string };
  /** Built-in tool names, so a discovered MCP tool never shadows one (MC-03). */
  readonly builtinNames?: ReadonlySet<string>;
  /** Per-request timeout for standard calls. */
  readonly requestTimeoutMs?: number;
  /** Server→client requests (elicitation/sampling/roots) route here, policy-checked (MC-08). */
  readonly onServerRequest?: ReverseRequestHandler;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The MCP client for ONE server (MC-01/MC-06).
 *
 * Lifecycle: connect → `initialize` handshake → discover (tools/resources/prompts) → invoke →
 * dynamic refresh on `list_changed` → disconnect. Every failure is a classified `McpError`, so the
 * lifecycle manager can tell a reconnectable connection drop from a fatal protocol violation.
 *
 * The client is deterministic under an injected `Clock`/`IdSource`, and it holds server-authored
 * data as untrusted: tool descriptions are kept raw and only sanitized when handed out for display.
 */
export class McpClient {
  readonly server: string;
  readonly #opts: McpClientOptions;
  readonly #peer: JsonRpcPeer;
  readonly #transport: Transport;
  readonly log = new ServerLog();

  #state: ClientState = 'idle';
  #serverInfo: InitializeResult | null = null;
  #tools: McpTool[] = [];
  #named: NamedMcpTool[] = [];
  #resources: Resource[] = [];
  #prompts: Prompt[] = [];
  #lastError: string | null = null;
  readonly #notificationHandlers = new Map<string, Set<(data: unknown) => void>>();

  constructor(opts: McpClientOptions) {
    this.server = opts.server;
    this.#opts = opts;
    this.#transport = opts.transport;
    this.#peer = new JsonRpcPeer(
      opts.transport,
      {
        onRequest: (method, params) => this.#handleServerRequest(method, params),
        onNotification: (method, params) => this.#handleNotification(method, params),
      },
      // Ids from the injected source keep a golden trace diffable (RT-08).
      () => this.#nextRpcId(),
    );
    opts.transport.onClose((err) => this.#onTransportClose(err));
  }

  get state(): ClientState {
    return this.#state;
  }
  get serverInfo(): InitializeResult | null {
    return this.#serverInfo;
  }
  get tools(): readonly McpTool[] {
    return this.#tools;
  }
  get namedTools(): readonly NamedMcpTool[] {
    return this.#named;
  }
  get resources(): readonly Resource[] {
    return this.#resources;
  }
  get prompts(): readonly Prompt[] {
    return this.#prompts;
  }
  get health(): ServerHealth {
    switch (this.#state) {
      case 'ready':
        return 'ready';
      case 'connecting':
        return 'connecting';
      case 'failed':
        return 'failed';
      default:
        return 'disconnected';
    }
  }
  get lastError(): string | null {
    return this.#lastError;
  }

  #idCounter = 0;
  #nextRpcId(): JsonRpcId {
    // A stable numeric id per client; the injected IdSource seeds a per-server namespace for logs.
    return ++this.#idCounter;
  }

  // --- lifecycle -------------------------------------------------------------------------------

  /** Connect, initialize, and discover. On any failure the state is `failed` and the error typed. */
  async connect(): Promise<void> {
    if (this.#state === 'ready') return;
    this.#state = 'connecting';
    try {
      await this.#transport.start();
      await this.#initialize();
      await this.discover();
      this.#state = 'ready';
      this.log.append('info', `connected to ${this.server}`, this.#opts.clock.now());
    } catch (err) {
      this.#state = 'failed';
      this.#lastError = err instanceof Error ? err.message : String(err);
      throw this.#classify(err);
    }
  }

  async #initialize(): Promise<void> {
    const result = await this.#request(MCP_METHODS.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: this.#opts.capabilities ?? {},
      clientInfo: this.#opts.clientInfo ?? { name: 'qwen-harness', version: '0.1.0' },
    });
    const parsed = InitializeResultSchema.safeParse(result);
    if (!parsed.success) {
      throw new McpError('protocol', `invalid initialize result: ${parsed.error.message}`, {
        server: this.server,
      });
    }
    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(parsed.data.protocolVersion as never)) {
      // A version we cannot negotiate is a hard protocol error, never a silent proceed.
      throw new McpError(
        'protocol',
        `server speaks unsupported protocol ${parsed.data.protocolVersion}`,
        { server: this.server },
      );
    }
    this.#serverInfo = parsed.data;
    // The spec requires the client acknowledge before making requests.
    await this.#peer.notify(MCP_METHODS.initialized);
  }

  /** (Re)discover tools, resources, and prompts. Paginated by cursor; a missing capability is skipped. */
  async discover(): Promise<void> {
    this.#tools = await this.#listAll(MCP_METHODS.listTools, ListToolsResultSchema, (r) => ({
      items: r.tools,
      cursor: r.nextCursor ?? null,
    }));
    this.#named = assignToolNames(
      this.#tools.map((t) => ({ server: this.server, tool: t.name })),
      this.#opts.builtinNames,
    );
    if (this.#serverInfo?.capabilities.resources !== undefined) {
      this.#resources = await this.#listAll(
        MCP_METHODS.listResources,
        ListResourcesResultSchema,
        (r) => ({ items: r.resources, cursor: r.nextCursor ?? null }),
      );
    }
    if (this.#serverInfo?.capabilities.prompts !== undefined) {
      this.#prompts = await this.#listAll(
        MCP_METHODS.listPrompts,
        ListPromptsResultSchema,
        (r) => ({
          items: r.prompts,
          cursor: r.nextCursor ?? null,
        }),
      );
    }
  }

  async #listAll<T, R>(
    method: string,
    schema: {
      safeParse(
        v: unknown,
      ): { success: true; data: R } | { success: false; error: { message: string } };
    },
    pick: (r: R) => { items: T[]; cursor: string | null },
  ): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | null = null;
    // Bounded so a server that keeps returning a cursor cannot make discovery loop forever.
    for (let page = 0; page < 1_000; page++) {
      const raw = await this.#request(method, cursor === null ? {} : { cursor });
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        throw new McpError('protocol', `invalid ${method} result: ${parsed.error.message}`, {
          server: this.server,
        });
      }
      const { items: pageItems, cursor: next } = pick(parsed.data);
      items.push(...pageItems);
      if (next === null || next === cursor) break;
      cursor = next;
    }
    return items;
  }

  // --- invocation ------------------------------------------------------------------------------

  /** Raw MCP `tools/call`. Returns the extracted text/structured output. Untrusted text is NOT yet sanitized here. */
  async callTool(tool: string, args: Record<string, unknown>): Promise<McpCallOutput> {
    const raw = await this.#request(MCP_METHODS.callTool, { name: tool, arguments: args });
    const parsed = CallToolResultSchema.safeParse(raw);
    if (!parsed.success) {
      throw new McpError('protocol', `invalid tools/call result: ${parsed.error.message}`, {
        server: this.server,
      });
    }
    return {
      text: extractText(parsed.data),
      isError: parsed.data.isError === true,
      structured: parsed.data.structuredContent ?? null,
    };
  }

  async readResource(uri: string): Promise<ReadResourceResult> {
    const raw = await this.#request(MCP_METHODS.readResource, { uri });
    const parsed = ReadResourceResultSchema.safeParse(raw);
    if (!parsed.success) {
      throw new McpError('protocol', `invalid resources/read result: ${parsed.error.message}`, {
        server: this.server,
      });
    }
    return parsed.data;
  }

  async getPrompt(name: string, args: Record<string, string> = {}): Promise<GetPromptResult> {
    const raw = await this.#request(MCP_METHODS.getPrompt, { name, arguments: args });
    const parsed = GetPromptResultSchema.safeParse(raw);
    if (!parsed.success) {
      throw new McpError('protocol', `invalid prompts/get result: ${parsed.error.message}`, {
        server: this.server,
      });
    }
    return parsed.data;
  }

  /** Liveness probe (MC-06 health). Returns false instead of throwing so a poll loop stays simple. */
  async ping(): Promise<boolean> {
    try {
      await this.#request(MCP_METHODS.ping, {});
      return true;
    } catch {
      return false;
    }
  }

  // --- notifications / reverse channel ---------------------------------------------------------

  /** Subscribe to a server notification method. Returns an unsubscribe function (used by monitors). */
  on(method: string, handler: (data: unknown) => void): () => void {
    let set = this.#notificationHandlers.get(method);
    if (set === undefined) {
      set = new Set();
      this.#notificationHandlers.set(method, set);
    }
    set.add(handler);
    return () => set?.delete(handler);
  }

  #handleNotification(method: string, params: unknown): void {
    this.log.append('info', `notification ${method}`, this.#opts.clock.now());
    // Dynamic discovery: a list_changed notification re-runs the affected discovery only (MC-06/09).
    if (method === MCP_METHODS.toolsListChanged) void this.#refreshTools();
    for (const handler of this.#notificationHandlers.get(method) ?? []) handler(params);
  }

  async #refreshTools(): Promise<void> {
    try {
      const tools = await this.#listAll(MCP_METHODS.listTools, ListToolsResultSchema, (r) => ({
        items: r.tools,
        cursor: r.nextCursor ?? null,
      }));
      this.#tools = tools;
      this.#named = assignToolNames(
        tools.map((t) => ({ server: this.server, tool: t.name })),
        this.#opts.builtinNames,
      );
      for (const handler of this.#notificationHandlers.get('tools/changed') ?? []) handler(tools);
    } catch (err) {
      this.log.append('warn', `tools refresh failed: ${String(err)}`, this.#opts.clock.now());
    }
  }

  async #handleServerRequest(method: string, params: unknown): Promise<unknown> {
    const handler = this.#opts.onServerRequest;
    if (handler === undefined) {
      throw new McpError('protocol', `no handler for server request ${method}`, {
        server: this.server,
      });
    }
    // A server request is attributed and MUST be policy-checked by the injected handler (MC-08).
    return handler(method, params);
  }

  // --- teardown --------------------------------------------------------------------------------

  /** Graded termination handled by the transport (request → signal → kill). */
  async disconnect(): Promise<void> {
    this.#state = 'disconnected';
    await this.#transport.close();
  }

  #onTransportClose(err?: Error): void {
    if (this.#state === 'disconnected') return;
    this.#state = err !== undefined ? 'failed' : 'disconnected';
    if (err !== undefined) this.#lastError = err.message;
  }

  #request(method: string, params: unknown): Promise<unknown> {
    return this.#peer.request(method, params, {
      timeoutMs: this.#opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  }

  /** Turn any thrown value into a classified `McpError`. */
  #classify(err: unknown): McpError {
    if (err instanceof McpError) return err;
    if (err instanceof JsonRpcCallError) {
      return new McpError('server', `server error ${err.code}: ${err.message}`, {
        server: this.server,
      });
    }
    return new McpError('connection', err instanceof Error ? err.message : String(err), {
      server: this.server,
    });
  }
}

/** Extract the text from a tool result's content blocks; non-text blocks are noted, not inlined. */
function extractText(result: CallToolResult): string {
  const parts: string[] = [];
  for (const block of result.content) {
    if (block.type === 'text') parts.push(block.text);
    else if (block.type === 'image' || block.type === 'audio')
      parts.push(`[${block.type} ${block.mimeType}]`);
    else parts.push('[resource]');
  }
  return parts.join('\n');
}
