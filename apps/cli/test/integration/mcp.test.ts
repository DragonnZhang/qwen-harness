import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { PolicyEngine, type PolicyContext } from '@qwen-harness/policy';
import { BUILTIN_TOOLS } from '@qwen-harness/tools-builtin';
import { SequentialIds } from '@qwen-harness/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { authorityForProfile } from '../../src/policy-from-config.ts';
import { connectMcp, loadMcpConfiguration, trustServer, type ConnectedMcp } from '../../src/mcp.ts';

/**
 * MCP, connected to a REAL server in a REAL process (MC-01..MC-06).
 *
 * The package was complete and programmatic-only: no config file existed, so no user could name a
 * server and nothing ever connected one. These tests exercise the composition end to end against
 * `fixtures/echo-mcp-server.mjs` — a genuine second process speaking newline-delimited JSON-RPC over
 * stdio — because a transport tested only against an in-process fake has not been tested.
 *
 * The security properties are what matter here, and they are asserted, not asserted-about:
 *
 *   MC-05  a PROJECT server is inert until the user trusts it by name. Cloning a repository must not
 *          be enough to make the harness launch a process that repository chose.
 *   MC-04  every MCP call is judged by the SAME `PolicyEngine` instance as a built-in, over a real
 *          `NormalizedAction`. There is no privileged MCP path.
 *   MC-03  a server cannot shadow a built-in tool name.
 */

const SERVER = resolve(import.meta.dirname, '..', 'fixtures', 'echo-mcp-server.mjs');

const clock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
};

function writeMcpConfig(workspace: string, servers: unknown[]): void {
  mkdirSync(join(workspace, '.qwen-harness'), { recursive: true });
  writeFileSync(
    join(workspace, '.qwen-harness', 'mcp.json'),
    JSON.stringify({ version: 1, servers }),
  );
}

const echoServer = {
  name: 'echo',
  transport: { type: 'stdio', command: process.execPath, args: [SERVER] },
};

describe('MCP servers are configurable from a file, and trusted explicitly', () => {
  let workspace: string;
  let home: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'qh-mcp-'));
    home = mkdtempSync(join(tmpdir(), 'qh-mcphome-'));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('no config file means no servers', () => {
    const config = loadMcpConfiguration({ workspaceRoot: workspace, homeDir: home });
    expect(config.resolved).toEqual([]);
  });

  it('a PROJECT server is configured but INACTIVE until the user trusts it (MC-05)', () => {
    writeMcpConfig(workspace, [echoServer]);

    const before = loadMcpConfiguration({ workspaceRoot: workspace, homeDir: home });
    expect(before.resolved).toHaveLength(1);
    expect(before.resolved[0]!.trusted).toBe(false);
    // THE POINT. A repository that ships an `mcp.json` gets nothing until a human says yes.
    expect(before.resolved[0]!.active).toBe(false);
    expect(before.resolved[0]!.inactiveReason).toBeTruthy();

    trustServer({ workspaceRoot: workspace, homeDir: home, server: 'echo' });

    const after = loadMcpConfiguration({ workspaceRoot: workspace, homeDir: home });
    expect(after.resolved[0]!.trusted).toBe(true);
    expect(after.resolved[0]!.active).toBe(true);
  });

  it('trust lives in HOME, so a repository cannot trust its own server', () => {
    writeMcpConfig(workspace, [echoServer]);
    // Plant a trust file INSIDE the repository — the shape a hostile repo would commit.
    writeFileSync(
      join(workspace, '.qwen-harness', 'trusted-mcp.json'),
      JSON.stringify({ trusted: { [workspace]: ['echo'] } }),
    );

    const config = loadMcpConfiguration({ workspaceRoot: workspace, homeDir: home });
    // Still untrusted. The repository's file is not consulted; only the user's home is.
    expect(config.resolved[0]!.trusted).toBe(false);
    expect(config.resolved[0]!.active).toBe(false);
  });

  it('an `http` server is REJECTED at load, not accepted and silently never connected', () => {
    writeMcpConfig(workspace, [
      { name: 'remote', transport: { type: 'http', url: 'https://example.test/mcp' } },
    ]);
    expect(() => loadMcpConfiguration({ workspaceRoot: workspace, homeDir: home })).toThrow();
  });
});

describe('a real stdio MCP server, through the real policy pipeline', () => {
  let workspace: string;
  let home: string;
  let connected: ConnectedMcp | null = null;

  const authority = authorityForProfile('yolo');
  const policy = new PolicyEngine();
  const policyContext = (workspaceRoot: string): PolicyContext => ({
    profile: authority.profile,
    managedPolicy: authority.managedPolicy,
    rules: authority.rules,
    grants: [],
    workspaceRoot,
    homeDir: workspaceRoot,
    now: Date.now(),
    actor: { kind: 'model', id: 'act_model1' as never },
  });

  beforeEach(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'qh-mcprun-'));
    home = mkdtempSync(join(tmpdir(), 'qh-mcprunhome-'));
    writeMcpConfig(workspace, [echoServer]);
    trustServer({ workspaceRoot: workspace, homeDir: home, server: 'echo' });

    connected = await connectMcp({
      configuration: loadMcpConfiguration({ workspaceRoot: workspace, homeDir: home }),
      clock,
      ids: new SequentialIds(),
      policy,
      policyContext: () => policyContext(workspace),
      builtinNames: new Set(BUILTIN_TOOLS.map((t) => t.name)),
    });
  });

  afterEach(async () => {
    await connected?.close();
    connected = null;
    rmSync(workspace, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('connects, initializes, and namespaces its tools as mcp__server__tool (MC-01, MC-03)', () => {
    expect(connected).not.toBeNull();
    expect(connected!.failed).toEqual([]);
    expect(connected!.connected).toEqual([{ server: 'echo', tools: 2 }]);

    const names = connected!.surface.tools.map((t) => t.name).sort();
    expect(names).toEqual(['mcp__echo__destroy', 'mcp__echo__echo']);

    // The model is offered the server's own JSON Schema.
    const echo = connected!.surface.tools.find((t) => t.name === 'mcp__echo__echo')!;
    expect(echo.parameters).toMatchObject({ type: 'object' });

    // MC-03: nothing the server said can shadow a built-in.
    for (const builtin of BUILTIN_TOOLS) {
      expect(names).not.toContain(builtin.name);
    }
  });

  it('a call is judged by the SAME PolicyEngine as a built-in, then really executes (MC-04)', async () => {
    const executor = connected!.surface.executor;

    const call = {
      callId: 'call_000001',
      toolName: 'mcp__echo__echo',
      arguments: { message: 'hello' },
      argumentsJson: JSON.stringify({ message: 'hello' }),
      signal: new AbortController().signal,
    };

    // The verdict comes from the real policy engine over a real normalized MCP action.
    const evaluation = await executor.evaluate(call);
    expect(evaluation.status).toBe('allow');
    expect(evaluation.actionDigest).not.toBe('');
    expect(evaluation.description).toContain('echo');

    // The intent the engine will persist BEFORE execution (SS-05), derived from the call digest.
    const intent = executor.intentFor(call);
    expect(intent.kind).toBe('mcp');
    // `echo` declares itself read-only, so it is not a destructive side effect.
    expect(intent.destructive).toBe(false);

    const result = await executor.execute(call);
    expect(result.ok).toBe(true);
    // It really round-tripped through the second process.
    expect(result.modelText).toContain('echo: hello');
  });

  it('a server-declared DESTRUCTIVE tool is treated as a real side effect (MC-04)', () => {
    const intent = connected!.surface.executor.intentFor({
      toolName: 'mcp__echo__destroy',
      arguments: { target: 'prod' },
    });
    // The harness classifies from the server's annotations. `destroy` is not read-only, so its
    // intent is destructive — which is what makes the engine persist it before it runs and what
    // makes recovery treat it as un-replayable.
    expect(intent.destructive).toBe(true);
    expect(intent.kind).toBe('mcp');
  });

  it('an unregistered mcp__ name is DENIED, never guessed at', async () => {
    const evaluation = await connected!.surface.executor.evaluate({
      callId: 'call_000002',
      toolName: 'mcp__echo__not_a_tool',
      arguments: {},
    });
    expect(evaluation.status).toBe('deny');
    expect(evaluation.reason).toContain('no connected MCP server exposes');
  });

  it('two identical calls share an idempotency key; different arguments do not', () => {
    const executor = connected!.surface.executor;
    const a = executor.intentFor({ toolName: 'mcp__echo__echo', arguments: { message: 'x' } });
    const b = executor.intentFor({ toolName: 'mcp__echo__echo', arguments: { message: 'x' } });
    const c = executor.intentFor({ toolName: 'mcp__echo__echo', arguments: { message: 'y' } });

    expect(a.idempotencyKey).toBe(b.idempotencyKey);
    expect(a.idempotencyKey).not.toBe(c.idempotencyKey);
  });
});
