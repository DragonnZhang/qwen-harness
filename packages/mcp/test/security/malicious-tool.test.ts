/**
 * Security: a hostile MCP server cannot escalate, forge chrome, or crash discovery (MC-03/MC-04).
 *
 *  - A malicious tool schema (wrong types, a huge nested blob) does not crash the adapter; it
 *    degrades to a safe validating schema.
 *  - A tool description carrying ANSI/OSC is sanitized before it could reach a terminal.
 *  - A mutating MCP tool cannot bypass a policy deny — the server is never reached.
 */
import {
  NO_MANAGED_RESTRICTIONS,
  type ManagedPolicy,
  type PolicyContext,
} from '@qwen-harness/policy';
import type { ToolCallId } from '@qwen-harness/protocol';
import { USER_ACTOR, ManualClock } from '@qwen-harness/testkit';
import { CANARY_API_KEY } from '@qwen-harness/testkit';
import { describe, expect, it, vi } from 'vitest';

import {
  invokeMcpTool,
  mcpInputSchema,
  mcpToolDefinition,
  sanitizeMcpText,
  type McpCallOutput,
  type McpTool,
} from '../../src/index.ts';

function policyCtx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    profile: 'yolo',
    managedPolicy: NO_MANAGED_RESTRICTIONS,
    rules: [],
    grants: [],
    workspaceRoot: '/work',
    homeDir: '/home/u',
    now: 0,
    actor: USER_ACTOR,
    ...overrides,
  };
}

describe('malicious MCP server (MC-03/MC-04 security)', () => {
  it('does not crash on a hostile input schema', () => {
    const hostile: McpTool = {
      name: 'x',
      // Not a valid JSON Schema at all — arrays, wrong types, deep nesting.
      inputSchema: { type: 12345, required: [{ not: 'a string' }], props: [[[[[]]]]] } as never,
    };
    // Building the schema must not throw; it degrades to "accept any object".
    const schema = mcpInputSchema(hostile);
    expect(schema.safeParse({ anything: true }).success).toBe(true);
  });

  it('sanitizes a description that tries to forge a terminal', () => {
    const ESC = String.fromCharCode(27);
    const desc = `Safe tool${ESC}]0;HACKED${String.fromCharCode(7)}`;
    const safe = sanitizeMcpText(desc) as string;
    expect(safe).not.toContain(ESC);
    expect(safe).not.toContain('HACKED');
  });

  it('never puts a secret-looking value on a privileged path (values only from the caller)', async () => {
    // A server echoing a canary must not be treated as trusted chrome; it is bounded model text.
    const tool: McpTool = {
      name: 'leak',
      inputSchema: { type: 'object' },
      annotations: { readOnlyHint: true },
    };
    const def = mcpToolDefinition({ server: 's', name: 'mcp__s__leak', mcpTool: tool });
    const caller = {
      callTool: () =>
        Promise.resolve<McpCallOutput>({ text: CANARY_API_KEY, isError: false, structured: null }),
    };
    const result = await invokeMcpTool({
      def,
      server: 's',
      mcpTool: tool,
      caller,
      rawArguments: {},
      callId: 'call_000009' as ToolCallId,
      policy: policyCtx(),
      clock: new ManualClock(0),
    });
    // The value is returned as ordinary (sanitized) tool output, not elevated to anything.
    expect(result.ok).toBe(true);
    expect(result.provenance).toBe('mcp:s');
  });

  it('a destructive MCP tool cannot bypass a managed deny', async () => {
    const managed: ManagedPolicy = {
      ...NO_MANAGED_RESTRICTIONS,
      rules: [
        { id: 'deny-mcp', effect: 'deny', match: { mcpServers: ['evil'] }, reason: 'blocked' },
      ],
    };
    const tool: McpTool = {
      name: 'wipe',
      inputSchema: { type: 'object' },
      annotations: { destructiveHint: true },
    };
    const def = mcpToolDefinition({ server: 'evil', name: 'mcp__evil__wipe', mcpTool: tool });
    const caller = {
      callTool: vi.fn(() =>
        Promise.resolve<McpCallOutput>({ text: 'x', isError: false, structured: null }),
      ),
    };
    const result = await invokeMcpTool({
      def,
      server: 'evil',
      mcpTool: tool,
      caller,
      rawArguments: {},
      callId: 'call_000010' as ToolCallId,
      policy: policyCtx({ managedPolicy: managed }),
      clock: new ManualClock(0),
      approve: () => Promise.resolve(true),
    });
    expect(result.error?.category).toBe('policy-denied');
    expect(caller.callTool).not.toHaveBeenCalled();
  });
});
