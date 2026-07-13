import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HttpTransport,
  McpClient,
  RandomIds,
  SystemClock,
  brokeredGateway,
} from '@qwen-harness/mcp';
import {
  DEFAULT_NETWORK_POLICY,
  NetworkBroker,
  nodeFetchImpl,
  type NetworkPolicy,
} from '@qwen-harness/network';
import { NO_MANAGED_RESTRICTIONS, PolicyEngine, type PolicyContext } from '@qwen-harness/policy';
import type { PermissionProfile } from '@qwen-harness/protocol';
import { createRedactor } from '@qwen-harness/storage';
import { BUILTIN_TOOLS } from '@qwen-harness/tools-builtin';
import {
  acquireMcpToken,
  connectMcp,
  createMcpOAuthClient,
  loadMcpConfiguration,
  mcpSecretStore,
  type ConnectedMcp,
} from '@qwen-harness/cli';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * CHECKPOINT GOLDEN PATH 7 — MCP, end to end.
 *
 * "connect local stdio and HTTP reference servers, complete OAuth against a fixture issuer, receive
 *  dynamic tools and reverse notification, and reject a malicious tool/server."
 *
 * The stdio half is proved by `apps/cli/test/integration/mcp.test.ts` against a real child process.
 * This file proves the HTTP half against a REAL second-process HTTP server (`mcp-http-server.mjs`)
 * speaking real JSON-RPC over real sockets — nothing here is an in-process fake:
 *
 *   * OAuth: the fixture issuer runs in that second process. The token is obtained by the real
 *     `OAuthClient` (real PKCE S256, real `state`), exchanged over a guarded POST through the
 *     `NetworkBroker`, and STORED in the secret store — then proven scrubbed from a redacted trace.
 *   * HTTP transport: `connectMcp` (the CLI's production MCP composition) dials the server through
 *     the broker's guarded egress, initializes, discovers tools, and INVOKES one — a real round trip.
 *   * Reverse channel: the server pushes a notification and a `tools/list_changed` over the SSE
 *     stream; the client observes both (a dynamic tool appears).
 *   * Auth gate: the /mcp endpoint 401s without a valid bearer, so an invalid/unissued token is
 *     refused by the same transport.
 *   * Malicious server: a server advertising a destructive `wipe_all` is DENIED by the same
 *     `PolicyEngine` that judges built-ins (under `plan`, a mutation is unavailable), and its attempt
 *     to shadow the built-in `run_shell` is namespaced away.
 *
 * The network policy here permits loopback (`blockPrivateAddresses: false`) so the test can reach a
 * 127.0.0.1 fixture. The SSRF default (loopback/metadata BLOCKED, on GET and POST alike) is proven
 * separately and unrelaxed in `packages/network/test/security/ssrf.test.ts`.
 */

const SERVER = fileURLToPath(new URL('./mcp-http-server.mjs', import.meta.url));

/** A network policy that permits the loopback fixture. Production keeps the SSRF-strict default. */
const LOOPBACK_POLICY: NetworkPolicy = { ...DEFAULT_NETWORK_POLICY, blockPrivateAddresses: false };

function startServer(): Promise<{ child: ChildProcess; baseUrl: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER, '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const onData = (d: Buffer): void => {
      buf += d.toString();
      const line = buf.split('\n').find((l) => l.trim().startsWith('{'));
      if (line !== undefined) {
        const { port } = JSON.parse(line) as { port: number };
        child.stdout?.off('data', onData);
        resolve({ child, baseUrl: `http://127.0.0.1:${port}` });
      }
    };
    child.stdout?.on('data', onData);
    child.on('error', reject);
    setTimeout(() => reject(new Error('fixture server did not start')), 10_000);
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

describe('golden path 7: MCP over HTTP with OAuth, dynamic tools, and a malicious server', () => {
  let child: ChildProcess;
  let baseUrl: string;
  let home: string;
  let workspace: string;
  let connected: ConnectedMcp | null = null;
  let accessToken = '';

  const clock = new SystemClock();
  const policy = new PolicyEngine();
  let currentProfile: PermissionProfile = 'yolo';
  const ctxFor = (): PolicyContext => ({
    profile: currentProfile,
    managedPolicy: NO_MANAGED_RESTRICTIONS,
    rules: [],
    grants: [],
    workspaceRoot: workspace,
    homeDir: home,
    now: clock.now(),
    actor: { kind: 'model', id: 'act_model1' as never },
  });

  beforeAll(async () => {
    ({ child, baseUrl } = await startServer());
    // Home and workspace MUST differ: the same mcp.json seen as both a user file and a project file
    // would be resolved as the (untrusted) project source and never activate.
    home = mkdtempSync(join(tmpdir(), 'qh-mcphttp-'));
    workspace = mkdtempSync(join(tmpdir(), 'qh-mcpwork-'));

    // The real production HTTP seam: the broker (guarded egress over Node fetch) + brokered gateway.
    const broker = new NetworkBroker(nodeFetchImpl(), LOOPBACK_POLICY);
    const gateway = brokeredGateway({ broker });
    const secretStore = mcpSecretStore({ prefer: 'memory' });

    // --- OAuth 2.0 + PKCE against the fixture issuer (real crypto, real HTTP) --------------------
    const oauth = createMcpOAuthClient({
      config: {
        server: 'remote',
        issuer: baseUrl,
        clientId: 'client-1',
        redirectUri: 'http://127.0.0.1:1/callback',
        scopes: ['mcp'],
      },
      gateway,
      secretStore,
      clock,
    });
    // The injected user-agent hop: drive the issuer's /authorize over real HTTP and read the 302.
    const token = await acquireMcpToken({
      oauth,
      authorize: async (authorizationUrl) => {
        const resp = await fetch(authorizationUrl, { redirect: 'manual' });
        const location = resp.headers.get('location');
        if (location === null) throw new Error('issuer did not redirect');
        const cb = new URL(location);
        const code = cb.searchParams.get('code');
        const state = cb.searchParams.get('state');
        return { ...(code !== null ? { code } : {}), ...(state !== null ? { state } : {}) };
      },
    });
    accessToken = token.accessToken;

    // Prove the token really landed in the secret store (never a log line, never a plaintext file).
    const stored = await secretStore.get('mcp.oauth.remote');
    expect(stored).not.toBeNull();
    expect(stored).toContain(accessToken);

    // --- config: an HTTP MCP server (bearer via OAuth) and a malicious one (no auth) -------------
    mkdirSync(join(home, '.qwen-harness'), { recursive: true });
    writeFileSync(
      join(home, '.qwen-harness', 'mcp.json'),
      JSON.stringify({
        version: 1,
        servers: [
          { name: 'remote', transport: { type: 'http', url: `${baseUrl}/mcp` } },
          {
            name: 'evil',
            transport: { type: 'http', url: `${baseUrl}/evil`, openServerStream: false },
          },
        ],
      }),
    );

    connected = await connectMcp({
      configuration: loadMcpConfiguration({ workspaceRoot: workspace, homeDir: home }),
      clock,
      ids: new RandomIds(),
      policy,
      policyContext: ctxFor,
      builtinNames: new Set(BUILTIN_TOOLS.map((t) => t.name)),
      gateway,
      // The OAuth bearer is attached at connect time, from the token acquired above.
      authHeaderFor: (server) =>
        server === 'remote' ? { Authorization: `Bearer ${accessToken}` } : undefined,
    });
  }, 30_000);

  afterAll(async () => {
    await connected?.close();
    child.kill('SIGTERM');
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
    if (workspace !== undefined) rmSync(workspace, { recursive: true, force: true });
  });

  it('completes OAuth against the fixture issuer and scrubs the token from a trace', () => {
    expect(accessToken).toMatch(/^access_/);
    // A redacted trace never carries the token in the clear — this is what telemetry wires in.
    const redactor = createRedactor([accessToken]);
    const line = `GET /mcp Authorization: Bearer ${accessToken}`;
    const redacted = redactor.redact(line);
    expect(redacted).not.toContain(accessToken);
    expect(redacted).toContain('[REDACTED]');
    // The deep redactor scrubs a token in a structured field too.
    const fields = redactor.redactValue({ headers: { authorization: `Bearer ${accessToken}` } });
    expect(JSON.stringify(fields)).not.toContain(accessToken);
  });

  it('connects to the HTTP MCP server and invokes a tool over a real round trip (MC-01/MC-04)', async () => {
    expect(connected).not.toBeNull();
    expect(connected!.failed).toEqual([]);
    // The remote server connected. Its tool COUNT is deliberately not asserted here: the server
    // pushes a `list_changed` shortly after connect (proved by the dynamic-tools test), so the count
    // races between 2 and 3 depending on scheduling. Presence + a working invocation is the point.
    const remote = connected!.connected.find((c) => c.server === 'remote');
    expect(remote).toBeDefined();
    expect(remote!.tools).toBeGreaterThanOrEqual(2);

    const echo = connected!.surface.tools.find((t) => t.name.endsWith('__echo'));
    expect(echo).toBeDefined();
    // MC-03: nothing the server said can shadow a built-in.
    const names = connected!.surface.tools.map((t) => t.name);
    for (const builtin of BUILTIN_TOOLS) expect(names).not.toContain(builtin.name);

    currentProfile = 'yolo';
    const call = {
      callId: 'call_000001',
      toolName: echo!.name,
      arguments: { text: 'hello over http' },
      argumentsJson: JSON.stringify({ text: 'hello over http' }),
      signal: new AbortController().signal,
    };
    const evaluation = await connected!.surface.executor.evaluate(call);
    expect(evaluation.status).toBe('allow');

    const result = await connected!.surface.executor.execute(call);
    expect(result.ok).toBe(true);
    expect(result.modelText).toContain('hello over http'); // it really round-tripped
  });

  it('receives a reverse notification and a dynamically-added tool over the SSE stream (MC-06)', async () => {
    const client = connected!.clients.find((c) => c.server === 'remote');
    expect(client).toBeDefined();

    let sawNotification = false;
    client!.on('notifications/message', () => {
      sawNotification = true;
    });
    expect(await waitFor(() => sawNotification)).toBe(true);

    // The server advertised a new tool after a list_changed; the client re-discovered it (with the
    // bearer attached to the refresh POST, proving the auth header rides every request).
    expect(await waitFor(() => client!.tools.some((t) => t.name === 'live_status'))).toBe(true);
  });

  it('refuses an invalid/unissued bearer token at the HTTP transport (MC-07 auth gate)', async () => {
    const broker = new NetworkBroker(nodeFetchImpl(), LOOPBACK_POLICY);
    const gateway = brokeredGateway({ broker });
    const badClient = new McpClient({
      server: 'remote',
      transport: new HttpTransport({
        url: `${baseUrl}/mcp`,
        gateway,
        clock,
        headers: { Authorization: 'Bearer not-a-real-token' },
      }),
      clock,
      ids: new RandomIds(),
    });
    await expect(badClient.connect()).rejects.toThrow(/auth|401|refused/i);
    await badClient.disconnect();
  });

  it('rejects a malicious server: a destructive tool is DENIED by the same policy path (MC-04)', async () => {
    // The evil server connected and advertised its hostile tools...
    const evil = connected!.clients.find((c) => c.server === 'evil');
    expect(evil).toBeDefined();
    const wipe = connected!.surface.tools.find((t) => t.name.endsWith('__wipe_all'));
    expect(wipe).toBeDefined();

    // Its attempt to shadow the built-in `run_shell` was namespaced — no bare `run_shell` exists.
    const evilNames = evil!.namedTools.map((n) => n.name);
    expect(evilNames).not.toContain('run_shell');
    expect(evilNames.some((n) => n.endsWith('__run_shell'))).toBe(true);

    // Under `plan`, a mutation is UNAVAILABLE — the destructive MCP tool is denied exactly as a
    // destructive built-in would be, by the SAME PolicyEngine instance.
    currentProfile = 'plan';
    const call = {
      callId: 'call_000002',
      toolName: wipe!.name,
      arguments: { path: '/' },
      argumentsJson: JSON.stringify({ path: '/' }),
      signal: new AbortController().signal,
    };
    const evaluation = await connected!.surface.executor.evaluate(call);
    expect(evaluation.status).toBe('deny');

    // And execution refuses too — the server is never reached (no "EXECUTED" leaks back).
    const result = await connected!.surface.executor.execute(call);
    expect(result.ok).toBe(false);
    expect(result.modelText).not.toContain('EXECUTED');
  });
});
