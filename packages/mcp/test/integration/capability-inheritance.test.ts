/**
 * Integration (MC-09, evidence I): a CHILD inherits only the MCP capabilities that were APPROVED for
 * its parent — never more.
 *
 * "Capability" here is concrete: the authority to invoke a side-effecting MCP tool (`delete_all` on
 * server `s`). Whether that call is permitted is decided, at call time, by the SAME `PolicyEngine`
 * inside `invokeMcpTool` that gates a built-in tool (MC-04). A subagent runs under a child Authority
 * derived by the real `intersect(requested, parent, managed)` (AG-03), and the application copies
 * that child Authority's rules/grants/profile straight into the `PolicyContext` an MCP call is
 * judged against (see apps/cli `background.ts` / `main.ts`). This test wires those real pieces
 * together and drives a REAL in-process MCP server round trip, so the assertions exercise the
 * genuine path rather than a mock of it:
 *
 *   - a parent that was NOT approved for the tool cannot pass an allow-rule for it down to a child
 *     (`intersect` drops an allow-rule the parent never held) → the child's call is refused and the
 *     server is NEVER reached;
 *   - a parent that WAS approved for the tool does pass it down → the child's call is permitted and
 *     the real server executes it.
 *
 * Non-vacuity: the only difference between the two cases is whether the PARENT held the capability.
 * If `intersect` ever let a child keep an allow-rule its parent lacked (a privilege escalation), the
 * "not approved" case would reach the server and its assertions would fail.
 */
import {
  intersect,
  isAtMost,
  policyContext,
  policyEngine,
  NO_MANAGED_RESTRICTIONS,
  type Authority,
  type PolicyContext,
  type PolicyRule,
} from '@qwen-harness/policy';
import type { ActorId, ToolCallId } from '@qwen-harness/protocol';
import { ManualClock, SequentialIds } from '@qwen-harness/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EchoMcpServer,
  InProcessTransport,
  McpClient,
  invokeMcpTool,
  mcpToolDefinition,
  type McpCaller,
  type McpCallOutput,
  type McpTool,
} from '../../src/index.ts';

// A subagent is NOT the user: the profile prompt gate applies to the agent, so a side-effecting MCP
// call under `ask` genuinely lands on `ask`. (A `user` actor would shortcut to allow/passthrough at
// the profile stage and make the test vacuous.)
const CHILD_ACTOR = { kind: 'subagent' as const, id: 'act_child01' as ActorId };

const DELETE_TOOL: McpTool = {
  name: 'delete_all',
  description: 'Delete everything (destructive).',
  inputSchema: { type: 'object', properties: {} },
  annotations: { destructiveHint: true },
};

// The one capability under test: permission to invoke `delete_all` on server `s`. `session` scope is
// a human-authored surface that MAY allow — a repository `project` rule could not.
const ALLOW_DELETE: PolicyRule = {
  id: 'allow-delete-all',
  scope: 'session',
  effect: 'allow',
  match: { mcpServers: ['s'], mcpTools: ['delete_all'] },
  reason: 'operator approved delete_all on server s',
};

function authority(rules: readonly PolicyRule[]): Authority {
  return {
    profile: 'ask',
    isolation: 'disabled',
    networkAllowed: true,
    workspaceRoots: ['/work'],
    rules,
    grants: [],
    maxChildDepth: 3,
  };
}

// Mirrors how the app builds a run's PolicyContext from its (already-clamped) Authority: the
// child's rules/grants/profile ARE the context the MCP call is judged against.
function childContext(child: Authority): PolicyContext {
  return policyContext({
    profile: child.profile,
    managedPolicy: NO_MANAGED_RESTRICTIONS,
    rules: child.rules,
    grants: child.grants,
    workspaceRoot: '/work',
    homeDir: '/home/u',
    now: 1_000,
    actor: CHILD_ACTOR,
  });
}

describe('child inherits only approved MCP capabilities (MC-09, integration)', () => {
  let server: EchoMcpServer;
  let client: McpClient;
  let calls: { tool: string; args: Record<string, unknown> }[];
  let caller: McpCaller;

  beforeEach(async () => {
    server = new EchoMcpServer();
    client = new McpClient({
      server: 's',
      transport: new InProcessTransport(server),
      clock: new ManualClock(0),
      ids: new SequentialIds(),
    });
    await client.connect();
    // A real in-process MCP round trip, wrapped so the test can observe whether the server was
    // reached at all — the security property is that a DENIED call never touches it.
    calls = [];
    caller = {
      callTool: (tool, args): Promise<McpCallOutput> => {
        calls.push({ tool, args });
        return client.callTool(tool, args);
      },
    };
  });

  afterEach(async () => {
    await client.disconnect();
  });

  function invokeAsChild(child: Authority): Promise<{ ok: boolean; modelText: string }> {
    const def = mcpToolDefinition({
      server: 's',
      name: 'mcp__s__delete_all',
      mcpTool: DELETE_TOOL,
    });
    return invokeMcpTool({
      def,
      server: 's',
      mcpTool: DELETE_TOOL,
      caller,
      rawArguments: {},
      callId: 'call_child01' as ToolCallId,
      policy: childContext(child),
      clock: new ManualClock(0),
      engine: policyEngine,
      // No approval channel: an `ask` verdict therefore means NOT granted. A child that only inherits
      // `ask` (because the capability was never approved for the parent) is refused right here.
    });
  }

  it('a capability NOT approved for the parent is unavailable to the child (server never reached)', async () => {
    // The parent holds NO allow-rule for delete_all: the capability is unapproved for it.
    const parent = authority([]);
    // The subagent spec REQUESTS the capability anyway (an over-eager or compromised parent turn).
    const requested = authority([ALLOW_DELETE]);

    const child = intersect(requested, parent, NO_MANAGED_RESTRICTIONS);

    // The real intersection dropped the allow-rule the parent never held.
    expect(child.rules.some((r) => r.id === ALLOW_DELETE.id)).toBe(false);
    expect(isAtMost(child, parent)).toBe(true);

    const result = await invokeAsChild(child);

    // The child's MCP call was refused, and the REAL server was never reached.
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('a capability APPROVED for the parent IS inherited by the child (real server executes it)', async () => {
    // The parent DID hold the allow-rule: the capability is approved for it.
    const parent = authority([ALLOW_DELETE]);
    const requested = authority([ALLOW_DELETE]);

    const child = intersect(requested, parent, NO_MANAGED_RESTRICTIONS);

    // The intersection kept it, because the parent held it — and never widened the child.
    expect(child.rules.some((r) => r.id === ALLOW_DELETE.id)).toBe(true);
    expect(isAtMost(child, parent)).toBe(true);

    const result = await invokeAsChild(child);

    // The child's call was permitted and the real in-process server executed it.
    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ tool: 'delete_all', args: {} }]);
    expect(result.modelText).toContain('deleted');
  });
});
