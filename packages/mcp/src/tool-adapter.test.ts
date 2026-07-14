import {
  NO_MANAGED_RESTRICTIONS,
  type ManagedPolicy,
  type PolicyContext,
} from '@qwen-harness/policy';
import type { ToolCallId } from '@qwen-harness/protocol';
import { USER_ACTOR, ManualClock } from '@qwen-harness/testkit';
import fc from 'fast-check';
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

describe('MCP annotation → pipeline classification is total and conservative (MC-04, property)', () => {
  // A hint is one of {true, false, absent} — the three states a server can leave a field in.
  const optBool = fc.option(fc.boolean(), { nil: undefined });
  // The whole annotations block may itself be absent (unclassifiable tool) or present with any mix
  // of hints — including all-absent (garbage/empty), which is the conservative worst case.
  const annotationsArb: fc.Arbitrary<McpTool['annotations']> = fc.option(
    fc.record({
      readOnlyHint: optBool,
      destructiveHint: optBool,
      idempotentHint: optBool,
      openWorldHint: optBool,
    }),
    { nil: undefined },
  );
  const toolArb: fc.Arbitrary<McpTool> = annotationsArb.map((annotations) => ({
    name: 't',
    description: 'randomized tool',
    ...(annotations ? { annotations } : {}),
  }));

  it('maps every annotation combination to the correct side-effect classification', () => {
    // Non-vacuity ledger: prove the generator actually reaches each classification BRANCH, so the
    // property is not silently exercising only one corner.
    const seen = {
      readOnly: 0,
      notReadOnly: 0,
      destructive: 0,
      idempotent: 0,
      openWorld: 0,
      closedWorld: 0,
      sideEffect: 0,
      noSideEffect: 0,
      annotationsAbsent: 0,
    };

    fc.assert(
      fc.property(toolArb, (tool) => {
        const ann = classifyAnnotations(tool);
        const hint = tool.annotations ?? {};

        // Exact oracle for each derived flag (each hint is trusted ONLY when explicitly `true`,
        // except openWorld, which stays true unless the server explicitly says `false`).
        expect(ann.readOnly).toBe(hint.readOnlyHint === true);
        expect(ann.destructive).toBe(hint.destructiveHint === true);
        expect(ann.idempotent).toBe(hint.idempotentHint === true);
        expect(ann.openWorld).toBe(hint.openWorldHint !== false);

        // The SAME classification must flow into the real pipeline definition — not a re-derivation.
        const def = mcpToolDefinition({ server: 's', name: 'mcp__s__t', mcpTool: tool });
        expect(def.annotations).toEqual(ann);
        // `plan` may offer ONLY a read-only tool; a side-effecting one is withheld there (PS-02).
        expect(def.availableIn.includes('plan')).toBe(ann.readOnly);

        // The conservative invariant: a tool is a side effect UNLESS it explicitly declared itself
        // read-only. Missing/garbage/open-world annotations therefore ALWAYS count as a side effect.
        const sideEffect = !def.annotations.readOnly;
        expect(sideEffect).toBe(hint.readOnlyHint !== true);
        if (tool.annotations === undefined || hint.readOnlyHint !== true) {
          expect(sideEffect).toBe(true);
        }

        if (tool.annotations === undefined) seen.annotationsAbsent += 1;
        if (ann.readOnly) seen.readOnly += 1;
        else seen.notReadOnly += 1;
        if (ann.destructive) seen.destructive += 1;
        if (ann.idempotent) seen.idempotent += 1;
        if (ann.openWorld) seen.openWorld += 1;
        else seen.closedWorld += 1;
        if (sideEffect) seen.sideEffect += 1;
        else seen.noSideEffect += 1;
      }),
      { numRuns: 1_000, seed: 42 },
    );

    // Every classification branch was genuinely produced by the generator (property is non-vacuous).
    expect(seen.readOnly).toBeGreaterThan(0);
    expect(seen.notReadOnly).toBeGreaterThan(0);
    expect(seen.destructive).toBeGreaterThan(0);
    expect(seen.idempotent).toBeGreaterThan(0);
    expect(seen.openWorld).toBeGreaterThan(0);
    expect(seen.closedWorld).toBeGreaterThan(0); // an explicit openWorldHint:false was generated
    expect(seen.sideEffect).toBeGreaterThan(0);
    expect(seen.noSideEffect).toBeGreaterThan(0); // an explicit readOnlyHint:true was generated
    expect(seen.annotationsAbsent).toBeGreaterThan(0); // the unclassifiable (no-annotations) case
  });

  it('an unclassifiable / open-world tool is ALWAYS treated as a side effect', () => {
    // No annotations at all: the worst case a server can hand us.
    const bare: McpTool = { name: 'mystery' };
    const bareAnn = classifyAnnotations(bare);
    expect(bareAnn.readOnly).toBe(false); // never read-only by default
    expect(bareAnn.openWorld).toBe(true); // assumed to reach outside the workspace
    expect(!bareAnn.readOnly).toBe(true); // => side effect

    // Explicitly open-world but silent on read-only: still a side effect, still plan-withheld.
    const openWorld: McpTool = { name: 'reach_out', annotations: { openWorldHint: true } };
    const def = mcpToolDefinition({ server: 's', name: 'mcp__s__reach_out', mcpTool: openWorld });
    expect(def.annotations.readOnly).toBe(false);
    expect(def.availableIn).not.toContain('plan');
  });
});
