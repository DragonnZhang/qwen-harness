import { dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  authorityForProfile,
  connectMcp,
  createHarnessRuntime,
  loadMcpConfiguration,
  type ConnectedMcp,
} from '@qwen-harness/cli';
import { PolicyEngine, type PolicyContext } from '@qwen-harness/policy';
import type { CorrelationId, Item, ThreadId } from '@qwen-harness/protocol';
import { EventStore } from '@qwen-harness/storage';
import { SequentialIds } from '@qwen-harness/testkit';
import { BUILTIN_TOOLS } from '@qwen-harness/tools-builtin';
import { ToolWorkerClient } from '@qwen-harness/tool-worker';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * MC-01 (Live model) — the credentialed acceptance path for MCP.
 *
 * This drives the REAL `qwen3.7-max`, through the REAL composition (`createHarnessRuntime`), with a
 * REAL local stdio MCP server (`mcp-stdio-server.mjs`, a genuine second process speaking JSON-RPC
 * over stdio) wired in through the CLI's production MCP path (`loadMcpConfiguration` → `connectMcp` →
 * `surface`). The server offers one read-only tool, `fetch_project_codeword`, whose answer the model
 * cannot know on its own — so the ONLY way to satisfy the prompt is to actually call the tool.
 *
 * The deterministic stdio proof (`apps/cli/test/integration/mcp.test.ts`) proves the connect →
 * initialize → discover → invoke path against the same kind of server without a model. This is the
 * live end of it: that the actual model CHOOSES to invoke `mcp__demo__fetch_project_codeword`, the
 * call round-trips through the real second process, and the result flows back into the turn — the
 * whole client path exercised end to end with the live model. It fails CLOSED (skipped) with no key
 * and is excluded from `pnpm check`. No secret leaks into the durable trace.
 */

const hasKey = Boolean(process.env['DASHSCOPE_API_KEY']);

const SERVER = join(dirname(fileURLToPath(import.meta.url)), 'mcp-stdio-server.mjs');
const MCP_TOOL = 'mcp__demo__fetch_project_codeword';
// Two projects (distinct tool arguments) are requested on purpose: the model must invoke the MCP
// tool once per project and USE each result, which both proves the result flowed back and avoids the
// repeated-identical-calls loop guard a single trivial lookup can trip on a live model.
const CODEWORD_ATLAS = 'marmalade-quokka-1987';
const CODEWORD_ORION = 'clockwork-tangerine-2043';

/** Auto-approve exactly what a human would say yes to at the prompt. A headless run has no terminal. */
const autoApprove = {
  request: () => Promise.resolve({ kind: 'approved' as const, scope: 'session' as const }),
};

const clock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
};

describe.skipIf(!hasKey)('live MCP tool call (qwen3.7-max, real stdio MCP server)', () => {
  let home: string;
  let workspace: string;
  let store: EventStore;
  let ids: SequentialIds;
  let connected: ConnectedMcp | null = null;

  beforeEach(() => {
    // A USER (home) server is trusted by the user who configured it — no per-repo trust prompt.
    home = mkdtempSync(join(tmpdir(), 'qh-mcp-live-home-'));
    workspace = mkdtempSync(join(tmpdir(), 'qh-mcp-live-ws-'));
    mkdirSync(join(home, '.qwen-harness'), { recursive: true });
    writeFileSync(
      join(home, '.qwen-harness', 'mcp.json'),
      JSON.stringify({
        version: 1,
        servers: [
          { name: 'demo', transport: { type: 'stdio', command: process.execPath, args: [SERVER] } },
        ],
      }),
    );
    ids = new SequentialIds();
    store = new EventStore({ path: ':memory:', clock, ids });
  });

  afterEach(async () => {
    await connected?.close();
    connected = null;
    store.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  it('the live model chooses to call the MCP tool and the result flows back', async () => {
    const authority = authorityForProfile('ask');
    // ONE PolicyEngine, shared between the MCP executor and the runtime: "MCP is judged by the same
    // policy engine as a built-in" is literally true here, not true of two engines that agree today.
    const policy = new PolicyEngine();
    const policyContext = (): PolicyContext => ({
      profile: authority.profile,
      managedPolicy: authority.managedPolicy,
      rules: authority.rules,
      grants: [],
      workspaceRoot: workspace,
      homeDir: home,
      now: clock.now(),
      actor: { kind: 'model', id: 'act_model1' as never },
    });

    // The production MCP composition: resolve config, connect the real second process, discover its
    // tools. Nothing is scripted — the server is spawned and speaks the protocol for real.
    const conn = await connectMcp({
      configuration: loadMcpConfiguration({ workspaceRoot: workspace, homeDir: home }),
      clock,
      ids,
      policy,
      policyContext,
      builtinNames: new Set(BUILTIN_TOOLS.map((t) => t.name)),
    });
    connected = conn; // retained for afterEach cleanup
    expect(conn.failed).toEqual([]);
    expect(conn.surface.tools.map((t) => t.name)).toContain(MCP_TOOL);

    const threadId = ids.next('thr') as ThreadId;
    const correlationId = ids.next('cor') as CorrelationId;
    store.append({
      threadId,
      correlationId,
      permissionProfile: 'ask',
      actor: { kind: 'user', id: 'act_user01' as never },
      payload: { type: 'thread-created', cwd: workspace, canonicalRepo: workspace, name: null },
    });

    const runtime = createHarnessRuntime({
      workspaceRoot: workspace,
      authority,
      model: 'qwen3.7-max',
      instructions:
        'You are a terse assistant. You do not know project codewords and must never guess them: ' +
        'the only way to learn one is to call the fetch_project_codeword tool, once per project. ' +
        'Once you have a codeword from the tool, use that result directly and do not look the same ' +
        'project up again. When you have every codeword asked for, reply with them.',
      homeDir: home,
      clock,
      ids,
      store,
      client: new ToolWorkerClient(),
      policy,
      approvals: autoApprove,
      mcp: conn.surface,
    });

    const result = await runtime.runTurn({
      threadId,
      correlationId,
      userText:
        'Look up the secret codewords for the projects "atlas" and "orion" using the tool (one ' +
        'lookup per project), then reply with both codewords.',
    });

    const items = store
      .readThread(threadId)
      .map((e) => e.payload)
      .filter((p): p is Extract<typeof p, { type: 'item-appended' }> => p.type === 'item-appended')
      .map((p) => p.item);

    // The turn completed (not blocked, not failed).
    expect(result.state, `terminated ${result.state}: ${result.finalText}`).toBe('completed');

    // The LIVE model actually invoked the MCP tool (a durable tool-call to mcp__demo__<tool>).
    const toolCalls = items.filter((i) => i.type === 'tool-call' && i.toolName === MCP_TOOL);
    expect(toolCalls.length, 'the live model did not call the MCP tool').toBeGreaterThanOrEqual(1);

    // The call round-tripped through the real second process: results came back OK, carrying the
    // codewords only the server could supply.
    const toolResults = items.filter(
      (i): i is Extract<Item, { type: 'tool-result' }> =>
        i.type === 'tool-result' && i.toolName === MCP_TOOL,
    );
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
    expect(toolResults.every((r) => r.ok)).toBe(true);
    const previews = toolResults.map((r) => r.preview).join('\n');
    expect(previews).toContain(CODEWORD_ATLAS);
    expect(previews).toContain(CODEWORD_ORION);

    // The results reached the model: it answered with codewords it could only have gotten by calling
    // the tool for each project.
    expect(result.finalText).toContain(CODEWORD_ATLAS);
    expect(result.finalText).toContain(CODEWORD_ORION);

    // No secret anywhere in the durable log.
    const dump = JSON.stringify(store.readThread(threadId));
    expect(dump).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
  }, 300_000);
});
