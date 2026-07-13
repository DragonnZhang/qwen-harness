/**
 * @qwen-harness/mcp
 *
 * The MCP client: connect to external tool servers over standards-conformant JSON-RPC, discover
 * their tools/resources/prompts, and feed every invocation through the SAME policy/hook/sandbox/
 * audit/timeout pipeline a built-in tool uses. There is NO privileged MCP path (MC-04).
 *
 * Transports (MC-02): stdio (`node:child_process`) and in-process are owned here; HTTP/SSE and
 * OAuth go through an injected `HttpGateway` backed by the network broker, because `mcp` opens no
 * HTTP socket of its own. `ide-sse` is ordinary SSE plus a documented handshake, not a proprietary
 * protocol. OAuth 2.0 + PKCE tokens are stored via the injected `SecretStore`, never in the clear.
 */

// JSON-RPC core (MC-01)
export {
  JSONRPC_VERSION,
  JSON_RPC_ERROR,
  JsonRpcPeer,
  JsonRpcCallError,
  decodeMessage,
  isRequest,
  isResponse,
  isNotification,
} from './jsonrpc.ts';
export type {
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  JsonRpcErrorObject,
  PeerChannel,
  PeerHandlers,
  RequestOptions,
} from './jsonrpc.ts';

export { McpError, isMcpError } from './errors.ts';
export type { McpErrorClass } from './errors.ts';

export { SystemClock, RandomIds } from './clock.ts';

// Protocol schemas
export * from './protocol-types.ts';

// Transports (MC-02)
export type { Transport, TransportKind } from './transports/transport.ts';
export { TransportListeners } from './transports/transport.ts';
export { InProcessTransport } from './transports/in-process.ts';
export type { InProcessServer, ServerToClient } from './transports/in-process.ts';
export { StdioTransport } from './transports/stdio.ts';
export type { StdioTransportOptions } from './transports/stdio.ts';
export { HttpTransport } from './transports/http.ts';
export type { HttpTransportOptions, ReconnectPolicy } from './transports/http.ts';
export { brokeredGateway, SseParser } from './transports/http-gateway.ts';
export type {
  HttpGateway,
  HttpRequest,
  HttpResponse,
  SseEvent,
  SseHandlers,
  SseConnection,
  BrokeredGatewayOptions,
} from './transports/http-gateway.ts';
export { validateIdeSseProfile, connectIdeSse, IdeSseProfileSchema } from './transports/ide-sse.ts';
export type { IdeSseProfile, IdeSseContext, ValidatedIdeSse } from './transports/ide-sse.ts';

// Client + lifecycle (MC-01/MC-06)
export { McpClient } from './client.ts';
export type { McpClientOptions, ClientState, ReverseRequestHandler } from './client.ts';
export { connectAll } from './connect.ts';
export type { ConnectOutcome } from './connect.ts';

// Naming + trust (MC-03)
export {
  toolName,
  normalizeSegment,
  assignToolNames,
  sanitizeMcpText,
  MCP_NAME_PREFIX,
} from './naming.ts';
export type { RawMcpToolRef, NamedMcpTool } from './naming.ts';

// Tool adapter — the no-bypass guarantee (MC-04)
export {
  mcpToolDefinition,
  invokeMcpTool,
  classifyAnnotations,
  mcpInputSchema,
  mcpActionFor,
  mcpCallDigest,
} from './tool-adapter.ts';
export type {
  McpToolAdapterOptions,
  McpCaller,
  McpCallOutput,
  InvokeOptions,
} from './tool-adapter.ts';

// Config precedence (MC-05)
export {
  resolveMcpServers,
  MCP_CONFIG_SOURCES,
  MCP_SOURCE_RANK,
  NO_MANAGED_MCP,
  McpServerConfigSchema,
  TransportConfigSchema,
} from './config.ts';
export type {
  McpConfigSource,
  McpServerConfig,
  TransportConfig,
  McpConfigLayer,
  ManagedMcpPolicy,
  ResolvedMcpServer,
  ResolveMcpOptions,
} from './config.ts';

// OAuth 2.0 + PKCE (MC-07)
export {
  OAuthClient,
  computeCodeChallenge,
  AuthServerMetadataSchema,
  TokenResponseSchema,
} from './oauth.ts';
export type {
  OAuthClientConfig,
  OAuthClientDeps,
  AuthServerMetadata,
  TokenResponse,
  StoredToken,
  PendingAuthorization,
  RandomBytes,
} from './oauth.ts';

// Reverse channel + deferred schema cache (MC-08/MC-09)
export { ServerRequestRouter, DeferredSchemaCache, schemaDigest } from './server-requests.ts';
export type {
  ElicitationRequest,
  ElicitationResponse,
  ElicitationChannel,
  ElicitationAction,
  Root,
  RootsProvider,
  ServerRequestRouterOptions,
  ToolSchemaState,
  ReconcileResult,
} from './server-requests.ts';

// Scale (MC-10)
export {
  offloadLargeOutput,
  searchTools,
  monitorNotifications,
  ServerLog,
  MCP_DURABLE_LIMIT_CHARS,
  MCP_INLINE_LIMIT_CHARS,
} from './scale.ts';
export type {
  OutputSink,
  OffloadResult,
  ToolSearchHit,
  ServerLogEntry,
  ServerHealth,
  ServerDoctorRow,
  MonitorTask,
} from './scale.ts';

// Fixtures (shipped for tests + reference servers)
export { EchoMcpServer } from './fixtures/echo-server.ts';
export { FixtureIssuer } from './fixtures/issuer.ts';
