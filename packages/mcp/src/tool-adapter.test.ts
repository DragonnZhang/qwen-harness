import {
  NO_MANAGED_RESTRICTIONS,
  type ManagedPolicy,
  type PolicyContext,
} from '@qwen-harness/policy';
import type { ToolCallId } from '@qwen-harness/protocol';
import { USER_ACTOR, ManualClock } from '@qwen-harness/testkit';
import { describe, expect, it, vi } from 'vitest';

import type { McpCaller, McpCallOutput } from './tool-adapter.ts';
import { classifyAnnotations, invokeMcpTool, mcpToolDefinition } from './tool-adapter.ts';
import type { McpTool } from './protocol-types.ts';

const ECHO: McpTool = {
  name: 'echo',
  description: 'echo text',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  annotations: { readOnlyHint: true, openWorldHint: false },
};
const DELETE: McpTool = {
  name: 'delete_all',
  description: 'destroy',
  inputSchema: { type: 'object', properties: {} },
  annotations: { destructiveHint: true },
};

function ctx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    profile: 'ask',
    managedPolicy: NO_MANAGED_RESTRICTIONS,
    rules: [],
    grants: [],
    workspaceRoot: '/work',
    homeDir: '/home/u',
    now: 1_000,
    actor: USER_ACTOR,
    ...overrides,
  };
}

const okCaller = (text: string): McpCaller => ({
  callTool: () => Promise.resolve<McpCallOutput>({ text, isError: false, structured: null }),
});

describe('MCP tool adapter — no privileged bypass (MC-04)', () => {
  it('classifies server annotation HINTS into harness annotations', () => {
    expect(classifyAnnotations(ECHO)).toMatchObject({ readOnly: true, openWorld: false });
    // A tool with no read-only hint is treated as a side effect and open-world by default.
    expect(classifyAnnotations(DELETE)).toMatchObject({
      readOnly: false,
      destructive: true,
      openWorld: true,
    });
  });

  it('a mutating MCP tool is unavailable in plan; a read-only one is available', () => {
    expect(
      mcpToolDefinition({ server: 's', name: 'mcp__s__delete_all', mcpTool: DELETE }).availableIn,
    ).not.toContain('plan');
    expect(
      mcpToolDefinition({ server: 's', name: 'mcp__s__echo', mcpTool: ECHO }).availableIn,
    ).toContain('plan');
  });

  it('runs schema + policy before the call, and passes an allowed read', async () => {
    const def = mcpToolDefinition({ server: 's', name: 'mcp__s__echo', mcpTool: ECHO });
    const result = await invokeMcpTool({
      def,
      server: 's',
      mcpTool: ECHO,
      caller: okCaller('hello world'),
      rawArguments: { text: 'hello world' },
      callId: 'call_000001' as ToolCallId,
      policy: ctx(),
      clock: new ManualClock(0),
      approve: () => Promise.resolve(true),
    });
    expect(result.ok).toBe(true);
    expect(result.modelText).toBe('hello world');
    expect(result.provenance).toBe('mcp:s');
  });

  it('rejects invalid arguments at the schema stage WITHOUT calling the server', async () => {
    const def = mcpToolDefinition({ server: 's', name: 'mcp__s__echo', mcpTool: ECHO });
    const caller = { callTool: vi.fn(() => Promise.reject(new Error('should not run'))) };
    const result = await invokeMcpTool({
      def,
      server: 's',
      mcpTool: ECHO,
      caller,
      rawArguments: { notText: 1 },
      callId: 'call_000002' as ToolCallId,
      policy: ctx(),
      clock: new ManualClock(0),
    });
    expect(result.ok).toBe(false);
    expect(result.error?.category).toBe('invalid-input');
    expect(caller.callTool).not.toHaveBeenCalled();
  });

  it('a managed DENY blocks the call — no MCP bypass of policy', async () => {
    const managed: ManagedPolicy = {
      ...NO_MANAGED_RESTRICTIONS,
      rules: [
        {
          id: 'no-evil',
          effect: 'deny',
          match: { mcpServers: ['evil'] },
          reason: 'blocked server',
        },
      ],
    };
    const def = mcpToolDefinition({
      server: 'evil',
      name: 'mcp__evil__delete_all',
      mcpTool: DELETE,
    });
    const caller = {
      callTool: vi.fn(() =>
        Promise.resolve<McpCallOutput>({ text: 'done', isError: false, structured: null }),
      ),
    };
    const result = await invokeMcpTool({
      def,
      server: 'evil',
      mcpTool: DELETE,
      caller,
      rawArguments: {},
      callId: 'call_000003' as ToolCallId,
      policy: ctx({ profile: 'yolo', managedPolicy: managed }),
      clock: new ManualClock(0),
      approve: () => Promise.resolve(true),
    });
    expect(result.ok).toBe(false);
    expect(result.error?.category).toBe('policy-denied');
    // The server was NEVER reached: the deny happened before the call.
    expect(caller.callTool).not.toHaveBeenCalled();
  });
});
