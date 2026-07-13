import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  HttpTransport,
  McpClient,
  McpServerConfigSchema,
  NO_MANAGED_MCP,
  OAuthClient,
  StdioTransport,
  brokeredGateway,
  classifyAnnotations,
  connectAll,
  mcpActionFor,
  mcpCallDigest,
  mcpToolDefinition,
  invokeMcpTool,
  resolveMcpServers,
  type HttpGateway,
  type McpConfigLayer,
  type McpConfigSource,
  type ManagedMcpPolicy,
  type McpTool,
  type OAuthClientConfig,
  type ResolvedMcpServer,
  type StoredToken,
} from '@qwen-harness/mcp';
import {
  DEFAULT_NETWORK_POLICY,
  NetworkBroker,
  nodeFetchImpl,
  type NetworkPolicy,
} from '@qwen-harness/network';
import { SecretStore, selectBackend, type SelectBackendOptions } from '@qwen-harness/secret-store';
import type { PolicyContext, PolicyEngine } from '@qwen-harness/policy';
import type { Clock, IdSource, ToolCallId } from '@qwen-harness/protocol';
import type { ToolEvaluation, ToolExecutionResult, ToolExecutor } from '@qwen-harness/runtime';
import { z } from 'zod';

import { riskOf, type McpSurface, type ModelTool } from './wiring.ts';

/**
 * MCP servers, made configurable and reachable (MC-01..MC-06).
 *
 * `@qwen-harness/mcp` was complete and PROGRAMMATIC-ONLY: a caller could construct a client, but
 * there was no config file, so no user could name a server, and no application connected one. This
 * file gives MCP a file to be declared in and routes every call it produces through the same
 * pipeline a built-in tool uses.
 *
 * THE NO-BYPASS GUARANTEE (MC-04) is the reason to read this file carefully. An MCP tool call goes
 * through, in order:
 *
 *   1. the TurnEngine's hooks   — `PreToolUse` can block it, exactly as for a built-in;
 *   2. the TurnEngine's intent  — the side effect is persisted BEFORE it runs (SS-05);
 *   3. `evaluate` below         — the REAL `PolicyEngine`, over a real `NormalizedAction`;
 *   4. an approval, if `ask`    — the engine suspends the turn; nothing here can auto-approve;
 *   5. `invokeMcpTool`          — which re-decides policy internally before it touches the server;
 *   6. the TurnEngine's result  — persisted before the turn continues.
 *
 * Steps 1, 2, 4 and 6 are free: this module returns an ordinary `ToolExecutor`, so the engine wraps
 * it identically to the built-in one. There is no privileged path because there is nowhere to put
 * one — the engine does not know or care which executor it is talking to.
 *
 * TRANSPORTS: `stdio` launches a child process here; `http` (Streamable HTTP + SSE) connects
 * through the network broker. The broker now carries a guarded POST-with-body and streaming egress
 * (`broker.send`), so `mcp`'s `HttpTransport` reaches an HTTP MCP server WITHOUT `mcp` opening a
 * socket — every frame still crosses the SAME SSRF/host/scheme/redirect guard a web fetch does. An
 * HTTP server on a loopback/metadata/private address is refused by that guard exactly as a fetch
 * would be; a user who genuinely runs an HTTP MCP server on localhost must widen the network policy
 * for it, which is the secure default (stdio remains the normal local transport).
 */

/** The transports this app can launch: a child process, or an HTTP/SSE endpoint via the broker. */
const CliTransportSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    autoRestart: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal('http'),
    url: z.string().url(),
    /** Separate GET endpoint for the server→client SSE stream. Defaults to `url`. */
    sseUrl: z.string().url().optional(),
    /** Static headers to send on every request (e.g. a pre-provisioned bearer token). */
    headers: z.record(z.string(), z.string()).optional(),
    /** Whether to open a standalone SSE stream for server-initiated messages. Default true. */
    openServerStream: z.boolean().optional(),
  }),
]);

const CliServerSchema = z.strictObject({
  name: z.string().min(1),
  transport: CliTransportSchema,
  enabled: z.boolean().optional(),
});

export const McpFileSchema = z.strictObject({
  version: z.literal(1).optional(),
  servers: z.array(CliServerSchema),
  /**
   * Managed only. When `exclusive` is true, ONLY the servers an administrator listed may run, and
   * no lower-precedence file can add one (MC-05). A managed deny dominates everything.
   */
  exclusive: z.boolean().optional(),
  deniedServers: z.array(z.string()).optional(),
});

export type McpFile = z.infer<typeof McpFileSchema>;

export const MCP_FILENAME = 'mcp.json';
/** Names the user has explicitly trusted. A project server is inert until it appears here (MC-05). */
export const MCP_TRUST_FILENAME = 'trusted-mcp.json';

export class McpConfigError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = 'McpConfigError';
  }
}

interface FileSource {
  readonly path: string;
  readonly source: McpConfigSource;
  readonly managed: boolean;
}

function fileSources(opts: { workspaceRoot: string; homeDir: string }): FileSource[] {
  return [
    { path: join('/etc/qwen-harness', MCP_FILENAME), source: 'user', managed: true },
    { path: join(opts.homeDir, '.qwen-harness', MCP_FILENAME), source: 'user', managed: false },
    // A repository's own file. NOT trusted by merely being present — `resolveMcpServers` marks a
    // project server inactive until the user trusts it by name. Cloning a repo must not be enough
    // to make the harness launch a process that repo chose.
    {
      path: join(opts.workspaceRoot, '.qwen-harness', MCP_FILENAME),
      source: 'approved-project',
      managed: false,
    },
  ];
}

function readJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new McpConfigError(path, `not valid JSON (${(e as Error).message})`);
  }
}

export interface McpConfiguration {
  readonly resolved: readonly ResolvedMcpServer[];
  readonly sources: readonly { path: string; source: McpConfigSource; servers: number }[];
}

/**
 * Load and resolve every configured MCP server. Precedence and trust are decided by the package
 * (`resolveMcpServers`), not here: this function's only job is to turn files into layers.
 */
export function loadMcpConfiguration(opts: {
  workspaceRoot: string;
  homeDir: string;
}): McpConfiguration {
  const layers: McpConfigLayer[] = [];
  const sources: { path: string; source: McpConfigSource; servers: number }[] = [];
  let managed: ManagedMcpPolicy = NO_MANAGED_MCP;

  for (const file of fileSources(opts)) {
    const raw = readJson(file.path);
    if (raw === undefined) continue;

    const parsed = McpFileSchema.safeParse(raw);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new McpConfigError(file.path, detail);
    }

    // Validate each server against the PACKAGE's schema too, so what we hand `resolveMcpServers` is
    // exactly what it expects rather than a structurally-similar shape that happens to typecheck.
    const servers = parsed.data.servers.map((s) => McpServerConfigSchema.parse(s));

    if (file.managed) {
      managed = {
        exclusive: parsed.data.exclusive ?? false,
        allowedServers: servers.map((s) => s.name),
        deniedServers: parsed.data.deniedServers ?? [],
      };
    }

    layers.push({ source: file.source, servers });
    sources.push({ path: file.path, source: file.source, servers: servers.length });
  }

  const trusted = loadTrustedServers(opts);

  return {
    resolved: resolveMcpServers({ layers, managed, trustedServers: trusted }),
    sources,
  };
}

/** Where a user's MCP trust decisions live. In HOME — never in the repository. See below. */
export function trustFilePath(homeDir: string): string {
  return join(homeDir, '.qwen-harness', MCP_TRUST_FILENAME);
}

/**
 * The user's explicit trust decisions (MC-05).
 *
 * This file lives in the user's HOME, not in the workspace, and the distinction is the whole point.
 * A project MCP server is inactive until trusted; if the trust file lived at
 * `<workspace>/.qwen-harness/trusted-mcp.json`, then a repository could ship a `mcp.json` declaring
 * a server AND a `trusted-mcp.json` trusting it, and `git clone && qwen-harness run` would launch a
 * process the repository chose. The trust gate would authorize exactly the input it exists to
 * defend against.
 *
 * Trust is therefore keyed by workspace path inside a file only the USER can write.
 */
export function loadTrustedServers(opts: { workspaceRoot: string; homeDir: string }): Set<string> {
  const raw = readJson(trustFilePath(opts.homeDir));
  if (raw === undefined) return new Set();
  const parsed = z
    .strictObject({ trusted: z.record(z.string(), z.array(z.string())) })
    .safeParse(raw);
  if (!parsed.success) return new Set();
  return new Set(parsed.data.trusted[opts.workspaceRoot] ?? []);
}

/**
 * Record that the user trusts a named server in this workspace. Written to HOME (see above), so a
 * repository cannot grant itself trust by committing a file.
 */
export function trustServer(opts: {
  workspaceRoot: string;
  homeDir: string;
  server: string;
}): void {
  const path = trustFilePath(opts.homeDir);
  const raw = readJson(path);
  const parsed = z
    .strictObject({ trusted: z.record(z.string(), z.array(z.string())) })
    .safeParse(raw ?? { trusted: {} });
  const trusted: Record<string, string[]> = parsed.success
    ? Object.fromEntries(Object.entries(parsed.data.trusted).map(([k, v]) => [k, [...v]]))
    : {};

  const forWorkspace = new Set(trusted[opts.workspaceRoot] ?? []);
  forWorkspace.add(opts.server);
  trusted[opts.workspaceRoot] = [...forWorkspace].sort();

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ trusted }, null, 2) + '\n', { mode: 0o600 });
}

// -----------------------------------------------------------------------------------------------
// Connecting, and the executor
// -----------------------------------------------------------------------------------------------

export interface ConnectedMcp {
  readonly surface: McpSurface;
  readonly clients: readonly McpClient[];
  readonly connected: readonly { server: string; tools: number }[];
  readonly failed: readonly { server: string; error: string }[];
  close(): Promise<void>;
}

/**
 * Launch every ACTIVE server and adapt its tools. A server that fails to connect does not sink the
 * others (`connectAll` is bounded-parallel and captures each outcome independently, MC-06) — a
 * broken MCP server must degrade the run, not end it.
 */
export async function connectMcp(opts: {
  configuration: McpConfiguration;
  clock: Clock;
  ids: IdSource;
  policy: PolicyEngine;
  policyContext: () => PolicyContext;
  builtinNames: ReadonlySet<string>;
  onStderr?: (server: string, line: string) => void;
  /**
   * The HTTP seam for `http` servers. Injected so a test can point it at a loopback fixture (with a
   * policy that permits loopback) while production keeps the strict default. When omitted, a default
   * gateway is built over the real Node `fetch` with `networkPolicy` (SSRF-strict by default).
   */
  gateway?: HttpGateway;
  networkPolicy?: NetworkPolicy;
  /**
   * Per-server extra request headers, resolved at connect time — this is where an OAuth bearer token
   * (acquired via `acquireMcpToken` and loaded from the secret store) is attached. Merged on top of
   * the static `headers` in config.
   */
  authHeaderFor?: (server: string) => Record<string, string> | undefined;
}): Promise<ConnectedMcp | null> {
  const active = opts.configuration.resolved.filter((s) => s.active);
  if (active.length === 0) return null;

  // Build the HTTP gateway lazily, and only if an http server is actually configured — a stdio-only
  // run must not open a network broker it never uses.
  let gateway: HttpGateway | null = opts.gateway ?? null;
  const httpGateway = (): HttpGateway => {
    if (gateway === null) {
      const broker = new NetworkBroker(
        nodeFetchImpl(),
        opts.networkPolicy ?? DEFAULT_NETWORK_POLICY,
      );
      gateway = brokeredGateway({ broker });
    }
    return gateway;
  };

  const clients: McpClient[] = [];
  for (const server of active) {
    const transport = server.config.transport;
    // The CLI schema (`CliTransportSchema`) only admits stdio and http; the other package transport
    // variants can never appear in a loaded config. Narrow to the two we launch.
    let wire: StdioTransport | HttpTransport;
    if (transport.type === 'stdio') {
      wire = new StdioTransport({
        command: transport.command,
        ...(transport.args ? { args: transport.args } : {}),
        ...(transport.env ? { env: transport.env } : {}),
        onStderr: (line) => opts.onStderr?.(server.config.name, line),
      });
    } else if (transport.type === 'http') {
      // Static config headers, then the OAuth bearer (if any) on top — the token is resolved at
      // connect time from the secret store, never baked into the config file.
      const headers = {
        ...(transport.headers ?? {}),
        ...(opts.authHeaderFor?.(server.config.name) ?? {}),
      };
      wire = new HttpTransport({
        url: transport.url,
        gateway: httpGateway(),
        clock: opts.clock,
        ...(transport.sseUrl ? { sseUrl: transport.sseUrl } : {}),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(transport.openServerStream !== undefined
          ? { openServerStream: transport.openServerStream }
          : {}),
      });
    } else {
      continue;
    }
    clients.push(
      new McpClient({
        server: server.config.name,
        transport: wire,
        clock: opts.clock,
        ids: opts.ids,
        // A discovered MCP tool can never shadow a built-in (MC-03). Passing the real built-in names
        // is what makes that true — omitting them would let a hostile server register `run_shell`.
        builtinNames: opts.builtinNames,
      }),
    );
  }
  if (clients.length === 0) return null;

  const outcomes = await connectAll(clients);
  const failed = outcomes
    .filter((o) => !o.ok)
    .map((o) => ({ server: o.server, error: o.error?.message ?? 'connect failed' }));

  const byName = new Map<string, { client: McpClient; tool: McpTool; server: string }>();
  const tools: ModelTool[] = [];
  const connected: { server: string; tools: number }[] = [];

  for (const client of clients) {
    if (client.state !== 'ready') continue;
    let count = 0;
    for (const named of client.namedTools) {
      const tool = client.tools.find((t) => t.name === named.tool);
      if (tool === undefined) continue;
      const def = mcpToolDefinition({ server: named.server, name: named.name, mcpTool: tool });
      byName.set(named.name, { client, tool, server: named.server });
      tools.push({
        name: named.name,
        // The server's description is UNTRUSTED text. `mcpToolDefinition` has already sanitized it;
        // we pass its output through rather than re-reading the raw field.
        description: def.description,
        // The server's own JSON Schema, shown to the model so it can form a call. It is NOT what
        // validates the call: `invokeMcpTool` re-validates arguments against `mcpInputSchema`, a
        // crash-proof zod schema derived from this one. A hostile schema therefore misleads the
        // model at worst; it cannot smuggle an unvalidated argument past execution.
        parameters: (tool.inputSchema ?? { type: 'object' }) as Readonly<Record<string, unknown>>,
      });
      count += 1;
    }
    connected.push({ server: client.server, tools: count });
  }

  const executor = mcpExecutor({
    byName,
    policy: opts.policy,
    policyContext: opts.policyContext,
    clock: opts.clock,
  });

  return {
    surface: { tools, executor },
    clients,
    connected,
    failed,
    close: async () => {
      // Graded termination is the transport's job (MC-06); we just ask every client to stop, and we
      // do not let one hung server prevent the others from being closed.
      await Promise.allSettled(clients.map((c) => c.disconnect()));
    },
  };
}

/**
 * Select the secret store for MCP OAuth tokens (MC-07). It picks the strongest AVAILABLE backend —
 * the OS keyring, else an encrypted 0600 file, else in-memory which REFUSES to persist rather than
 * writing a token in the clear. A token is the same class of material as the model key, so it is
 * never logged and never written unencrypted; this store is the only place it lives.
 */
export function mcpSecretStore(opts: SelectBackendOptions = {}): SecretStore {
  return new SecretStore(selectBackend(opts));
}

/**
 * Construct the `OAuthClient` for one server, bound to the HTTP gateway (so every token/discovery
 * call crosses the broker's SSRF guard) and the secret store (so tokens are stored, never logged).
 */
export function createMcpOAuthClient(opts: {
  config: OAuthClientConfig;
  gateway: HttpGateway;
  secretStore: SecretStore;
  clock: Clock;
  randomBytes?: (size: number) => Buffer;
}): OAuthClient {
  return new OAuthClient(opts.config, {
    gateway: opts.gateway,
    secretStore: opts.secretStore,
    clock: opts.clock,
    ...(opts.randomBytes ? { randomBytes: opts.randomBytes } : {}),
  });
}

/**
 * Drive the OAuth 2.0 + PKCE flow to a stored token (MC-07). The crypto — the PKCE verifier, the
 * `state`/`nonce`, the token exchange, and persistence into the secret store — all live in the
 * package's `OAuthClient`; this composes them into one flow with the ONE interactive step injected.
 *
 * `authorize` is the user-agent hop: in production it opens the browser and captures the redirect on
 * a loopback listener; in a test it drives the fixture issuer over real HTTP. Isolating it here is
 * what keeps the flow headless-testable without faking any of the security-relevant steps.
 */
export async function acquireMcpToken(opts: {
  oauth: OAuthClient;
  authorize: (
    authorizationUrl: string,
  ) => Promise<{ code?: string; state?: string; error?: string }>;
}): Promise<StoredToken> {
  const metadata = await opts.oauth.discover();
  const pending = opts.oauth.beginAuthorization(metadata);
  const callback = await opts.authorize(pending.authorizationUrl);
  // `handleCallback` rejects a `state` mismatch as CSRF BEFORE any code is exchanged.
  const code = opts.oauth.handleCallback(callback, pending);
  return opts.oauth.exchangeCode(metadata, code, pending);
}

interface Bound {
  readonly client: McpClient;
  readonly tool: McpTool;
  readonly server: string;
}

/**
 * The `ToolExecutor` for MCP tools. Note what it does NOT contain: no allowlist of its own, no
 * "trusted server" shortcut, no way to skip `evaluate`. It answers the same three questions the
 * built-in executor answers, using the same `PolicyEngine` instance the built-ins are judged by.
 */
function mcpExecutor(opts: {
  byName: ReadonlyMap<string, Bound>;
  policy: PolicyEngine;
  policyContext: () => PolicyContext;
  clock: Clock;
}): ToolExecutor {
  const sideEffectOf = (bound: Bound): boolean => {
    // Conservative by the package's own classification: a tool that does not explicitly declare
    // itself read-only IS a side effect. An open-world tool we cannot classify is treated as one.
    const annotations = classifyAnnotations(bound.tool);
    return !annotations.readOnly;
  };

  return {
    intentFor: (call) => {
      const bound = opts.byName.get(call.toolName);
      const sideEffect = bound === undefined ? true : sideEffectOf(bound);
      return {
        // The idempotency key IS the call digest: server + tool + canonical arguments. Two identical
        // calls share it, so a crash between intent and result leaves ONE indeterminate row that
        // recovery can find — not two rows nobody can correlate.
        idempotencyKey: bound
          ? mcpCallDigest(bound.server, bound.tool.name, call.arguments, sideEffect)
          : `mcp-unknown:${call.toolName}`,
        destructive: sideEffect,
        kind: 'mcp',
        normalizedAction: call.toolName,
      };
    },

    evaluate: (call): Promise<ToolEvaluation> => {
      const bound = opts.byName.get(call.toolName);
      if (bound === undefined) {
        // A name we never registered. Deny — do not guess a server for it.
        return Promise.resolve({
          status: 'deny',
          actionDigest: '',
          description: call.toolName,
          risk: 'high',
          reason: `no connected MCP server exposes '${call.toolName}'`,
          source: 'mcp:unknown-tool',
        });
      }

      const action = mcpActionFor(
        bound.server,
        bound.tool.name,
        call.arguments,
        sideEffectOf(bound),
      );
      const decision = opts.policy.evaluate(action, opts.policyContext());

      const status =
        decision.outcome === 'deny' ? 'deny' : decision.outcome === 'ask' ? 'ask' : 'allow';

      return Promise.resolve({
        status,
        actionDigest: decision.actionDigest,
        description: decision.description,
        risk: riskOf(action),
        reason: decision.reason,
        source: `${decision.source.stage}:${decision.source.id}`,
      });
    },

    execute: async (call): Promise<ToolExecutionResult> => {
      const started = opts.clock.now();
      const bound = opts.byName.get(call.toolName);
      if (bound === undefined) {
        const message = `no connected MCP server exposes '${call.toolName}'`;
        return {
          ok: false,
          modelText: message,
          userText: message,
          errorCategory: 'denied',
          resultDigest: null,
          outputRef: null,
          truncated: false,
          durationMs: opts.clock.now() - started,
        };
      }

      const def = mcpToolDefinition({
        server: bound.server,
        name: call.toolName,
        mcpTool: bound.tool,
      });

      // `invokeMcpTool` re-decides policy internally before it touches the server — an earlier
      // `evaluate` is advisory, never a token. No `approve` callback is passed: by this point the
      // engine has already obtained any grant a human gave, so policy will find it. If policy still
      // says `ask` here, the absence of a callback means NOT granted, and the call is refused. That
      // is the only safe default — an executor that could approve its own call is not a gate.
      const result = await invokeMcpTool({
        def,
        server: bound.server,
        mcpTool: bound.tool,
        caller: bound.client,
        rawArguments: call.arguments,
        callId: call.callId as ToolCallId,
        policy: opts.policyContext(),
        clock: opts.clock,
        engine: opts.policy,
      });

      const durationMs = opts.clock.now() - started;
      return {
        ok: result.ok,
        modelText: result.modelText,
        userText: result.userText,
        errorCategory: result.error?.category ?? null,
        resultDigest: result.ok
          ? mcpCallDigest(bound.server, bound.tool.name, call.arguments, sideEffectOf(bound))
          : null,
        outputRef: result.outputRef,
        truncated: result.truncated,
        durationMs,
      };
    },
  };
}
