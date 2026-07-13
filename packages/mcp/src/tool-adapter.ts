import { createHash } from 'node:crypto';

import {
  actionDigest,
  canonicalJson,
  type McpAction,
  type PolicyContext,
  type PolicyEngine,
  policyEngine,
} from '@qwen-harness/policy';
import type { Clock, PermissionProfile, ToolCallId } from '@qwen-harness/protocol';
import {
  type ResourceFootprint,
  type ToolAnnotations,
  type ToolDefinition,
  type ToolErrorCategory,
  type ToolResult,
  validateCall,
} from '@qwen-harness/tools-core';
import { z } from 'zod';

import type { McpTool } from './protocol-types.ts';
import { offloadLargeOutput, type OutputSink } from './scale.ts';

/**
 * Adapt an MCP tool into a tools-core `ToolDefinition` and drive its invocation through the SAME
 * pipeline a built-in tool uses (MC-04). This is the no-bypass guarantee, made structural:
 *
 *   schema validation → semantic validation → policy decision → (hooks/sandbox, owned by the
 *   runtime) → the actual `tools/call`.
 *
 * There is no code path here that reaches the server's `tools/call` before the policy engine has
 * returned `allow`. An MCP tool gets no privileged path: a managed deny, a deny rule, or `plan`'s
 * seal stops it exactly as they stop a shell command. The server's own annotations are read as
 * HINTS but never trusted to relax anything — the harness re-derives its own classification.
 */

const ALL_PROFILES: readonly PermissionProfile[] = ['plan', 'ask', 'auto-accept-edits', 'yolo'];
const MUTATING_PROFILES: readonly PermissionProfile[] = ['ask', 'auto-accept-edits', 'yolo'];

export interface McpToolAdapterOptions {
  readonly server: string;
  /** Final namespaced name from `assignToolNames` (already collision- and built-in-safe). */
  readonly name: string;
  readonly mcpTool: McpTool;
  readonly timeoutMs?: number;
}

/**
 * Re-classify a server's annotation HINTS into the harness's own trusted annotations. Conservative
 * by default: a tool that does not explicitly declare itself read-only is treated as a side effect,
 * and MCP tools are open-world unless the server explicitly says otherwise.
 */
export function classifyAnnotations(mcpTool: McpTool): ToolAnnotations {
  const hint = mcpTool.annotations ?? {};
  const readOnly = hint.readOnlyHint === true;
  return {
    readOnly,
    destructive: hint.destructiveHint === true,
    idempotent: hint.idempotentHint === true,
    // Absent hint → assume it can reach outside the workspace; a server is untrusted about this.
    openWorld: hint.openWorldHint !== false,
  };
}

/**
 * Build a minimal, crash-proof zod schema from an untrusted MCP input schema. A full JSON-Schema
 * compiler is out of scope; what matters for safety is that (a) arguments are an object and (b)
 * declared required top-level fields are present. A hostile schema cannot crash this — anything it
 * does not understand degrades to "accept any object".
 */
export function mcpInputSchema(mcpTool: McpTool): z.ZodType<Record<string, unknown>> {
  const raw = mcpTool.inputSchema;
  const base = z.record(z.string(), z.unknown());
  if (raw === undefined) return base;
  const required = Array.isArray(raw['required'])
    ? raw['required'].filter((k): k is string => typeof k === 'string')
    : [];
  if (required.length === 0) return base;
  return base.refine((obj) => required.every((key) => obj[key] !== undefined), {
    message: `missing required field(s): ${required.join(', ')}`,
  }) as unknown as z.ZodType<Record<string, unknown>>;
}

/** Produce a tools-core `ToolDefinition` for an MCP tool. Definition only — no handler (that split is the point). */
export function mcpToolDefinition(
  opts: McpToolAdapterOptions,
): ToolDefinition<Record<string, unknown>, unknown> {
  const annotations = classifyAnnotations(opts.mcpTool);
  const inputSchema = mcpInputSchema(opts.mcpTool);
  // A mutating MCP tool is UNAVAILABLE in `plan`, exactly like a built-in mutation (PS-02).
  const availableIn = annotations.readOnly ? ALL_PROFILES : MUTATING_PROFILES;
  const footprint = (): ResourceFootprint => ({
    reads: [],
    writes: [],
    // An MCP tool's effects are not confined to workspace paths, so it is unbounded for scheduling.
    unbounded: true,
  });
  return {
    name: opts.name,
    description: opts.mcpTool.description ?? '',
    inputSchema,
    outputSchema: z.unknown(),
    annotations,
    timeoutMs: opts.timeoutMs ?? 60_000,
    availableIn,
    footprint,
    describe: (input) => `mcp ${opts.server}/${opts.mcpTool.name} ${canonicalJson(input)}`,
  };
}

/** The MCP `tools/call` surface the adapter needs. Implemented by `McpClient`. */
export interface McpCaller {
  callTool(tool: string, args: Record<string, unknown>): Promise<McpCallOutput>;
}
export interface McpCallOutput {
  /** Combined text content, already extracted from the content blocks. */
  readonly text: string;
  readonly isError: boolean;
  readonly structured: unknown;
}

/** Build the canonical MCP action the policy engine authorizes. */
export function mcpActionFor(
  server: string,
  tool: string,
  args: unknown,
  sideEffect: boolean,
): McpAction {
  return {
    kind: 'mcp',
    server,
    tool,
    sideEffect,
    argumentsDigest: createHash('sha256').update(canonicalJson(args)).digest('hex'),
  };
}

export interface InvokeOptions {
  readonly def: ToolDefinition<Record<string, unknown>, unknown>;
  readonly server: string;
  readonly mcpTool: McpTool;
  readonly caller: McpCaller;
  readonly rawArguments: unknown;
  readonly callId: ToolCallId;
  readonly policy: PolicyContext;
  readonly clock: Clock;
  readonly engine?: PolicyEngine;
  readonly sink?: OutputSink;
  /**
   * Approval channel for an `ask` verdict. Without it, `ask` is treated as NOT granted — a tool is
   * never silently auto-allowed. The runtime injects the real interactive approval here.
   */
  readonly approve?: (description: string, actionDigest: string) => Promise<boolean>;
}

/**
 * Invoke an MCP tool through the full validate→policy→call pipeline. Returns a stable `ToolResult`.
 * The ORDER is the security property: nothing calls the server until policy has said `allow`.
 */
export async function invokeMcpTool(opts: InvokeOptions): Promise<ToolResult> {
  const started = opts.clock.now();
  const engine = opts.engine ?? policyEngine;
  const provenance = `mcp:${opts.server}`;
  const fail = (category: ToolErrorCategory, message: string): ToolResult => ({
    callId: opts.callId,
    toolName: opts.def.name,
    ok: false,
    output: null,
    error: { category, message },
    userText: message,
    modelText: message,
    outputRef: null,
    truncated: false,
    durationMs: opts.clock.now() - started,
    provenance,
  });

  // 1. schema + semantic validation (the first pipeline stages, owned by tools-core).
  const validated = validateCall(opts.def as never, opts.rawArguments);
  if (!validated.ok) return fail(validated.failure.category, validated.failure.message);
  const args = validated.input as Record<string, unknown>;

  // 2. build the canonical action and ask the policy engine. A server's read-only hint does NOT
  //    decide this — the harness classification does.
  const sideEffect = !opts.def.annotations.readOnly;
  const action = mcpActionFor(opts.server, opts.mcpTool.name, args, sideEffect);
  const decision = engine.evaluate(action, opts.policy);

  if (decision.outcome === 'deny') {
    return fail('policy-denied', `policy denied ${decision.description}: ${decision.reason}`);
  }
  if (decision.outcome === 'ask') {
    const granted = opts.approve
      ? await opts.approve(decision.description, decision.actionDigest)
      : false;
    if (!granted) {
      return fail(
        'permission-denied',
        `approval required and not granted for ${decision.description}`,
      );
    }
  }
  // `allow` and `passthrough` proceed. (The runtime layers hooks/sandbox/audit around this call;
  // they can only further restrict — none of them is a way IN that skips the check above.)

  // 3. the actual server call, now that it is authorized.
  let output: McpCallOutput;
  try {
    output = await opts.caller.callTool(opts.mcpTool.name, args);
  } catch (err) {
    return fail('execution-failed', err instanceof Error ? err.message : 'mcp call failed');
  }

  const offloaded = await offloadLargeOutput(output.text, opts.sink ?? null);
  return {
    callId: opts.callId,
    toolName: opts.def.name,
    ok: !output.isError,
    output: output.structured ?? null,
    error: output.isError
      ? { category: 'execution-failed', message: 'the MCP tool reported an error' }
      : null,
    userText: offloaded.modelText,
    modelText: offloaded.modelText,
    outputRef: offloaded.outputRef,
    truncated: offloaded.truncated,
    durationMs: opts.clock.now() - started,
    provenance,
  };
}

/** The audit key for an MCP call — the same digest an approval binds to. */
export function mcpCallDigest(
  server: string,
  tool: string,
  args: unknown,
  sideEffect: boolean,
): string {
  return actionDigest(mcpActionFor(server, tool, args, sideEffect));
}
