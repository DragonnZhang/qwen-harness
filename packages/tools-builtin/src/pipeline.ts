import {
  actionDigest,
  describeAction,
  isSideEffect,
  type NormalizedAction,
  type PolicyContext,
  type PolicyEngine,
} from '@qwen-harness/policy';
import { validateCall, type ToolRegistry } from '@qwen-harness/tools-core';
import type { ToolWorkerClient, WorkerGrant, WorkerResponse } from '@qwen-harness/tool-worker';

import { BUILTIN_TOOLS, type BuiltinTool } from './tools.ts';

/**
 * The tool-execution pipeline (TL-07), as one function so there is exactly ONE path from a model
 * tool call to a host side effect:
 *
 *   schema  ->  semantic  ->  policy  ->  (approval, handled by the caller)  ->  sandbox worker
 *
 * There is deliberately no shortcut. Every tool call — built-in or MCP, foreground or background —
 * goes through here, which is what makes the security properties hold uniformly. A second, simpler
 * path would be a second place to forget a check.
 *
 * This module decides and executes; it does not itself prompt. When policy says `ask`, it returns a
 * `needs-approval` outcome and the caller (the runtime, which owns the interactive channel) obtains
 * the grant and calls back. That split keeps the pipeline pure of UI.
 */

export interface PipelineOptions {
  readonly registry: ToolRegistry;
  readonly builtins?: readonly BuiltinTool[];
  readonly policy: PolicyEngine;
  readonly client: ToolWorkerClient;
}

export interface ExecuteInput {
  readonly callId: string;
  readonly toolName: string;
  readonly rawArguments: unknown;
  readonly policyContext: PolicyContext;
  readonly grant: WorkerGrant;
  readonly isolation: 'read-only' | 'workspace-write' | 'disabled';
  readonly signal?: AbortSignal;
}

export type PipelineOutcome =
  | {
      readonly status: 'rejected';
      readonly stage: 'schema' | 'semantic' | 'unknown-tool';
      readonly message: string;
    }
  | { readonly status: 'denied'; readonly reason: string; readonly source: string }
  | {
      readonly status: 'needs-approval';
      readonly actionDigest: string;
      readonly description: string;
      readonly action: NormalizedAction;
    }
  | {
      readonly status: 'executed';
      readonly response: WorkerResponse;
      readonly action: NormalizedAction;
      readonly actionDigest: string;
      readonly isSideEffect: boolean;
    };

export class ToolPipeline {
  readonly #registry: ToolRegistry;
  readonly #byName: Map<string, BuiltinTool>;
  readonly #policy: PolicyEngine;
  readonly #client: ToolWorkerClient;

  constructor(opts: PipelineOptions) {
    this.#registry = opts.registry;
    this.#policy = opts.policy;
    this.#client = opts.client;
    this.#byName = new Map((opts.builtins ?? BUILTIN_TOOLS).map((t) => [t.name, t]));
  }

  /**
   * Runs one tool call as far as it can go without a UI:
   *  - `rejected` at schema/semantic — the arguments were malformed;
   *  - `denied` — hard policy said no;
   *  - `needs-approval` — policy said `ask`; the caller must obtain a grant and re-run;
   *  - `executed` — it ran in the sandbox and here is the typed result.
   */
  async execute(input: ExecuteInput): Promise<PipelineOutcome> {
    const tool = this.#byName.get(input.toolName);
    if (tool === undefined) {
      return {
        status: 'rejected',
        stage: 'unknown-tool',
        message: `no such tool: ${input.toolName}`,
      };
    }

    // 1-2. Schema then semantic validation, via the shared tools-core validator. Semantic runs
    // only after the shape is known good, so it can trust its input.
    const registered = this.#registry.get(input.toolName);
    const validated = validateCall(registered ?? (tool as never), input.rawArguments);
    if (!validated.ok) {
      return {
        status: 'rejected',
        stage: validated.failure.category === 'invalid-input' ? 'schema' : 'semantic',
        message: validated.failure.message,
      };
    }
    const args = validated.input;

    // 3. Policy. The action is derived from the SAME validated arguments the worker will run, so
    // the thing policy judged is exactly the thing that executes.
    const action = tool.toAction(args as never, {
      workspaceRoot: input.policyContext.workspaceRoot,
    });
    const decision = this.#policy.evaluate(action, input.policyContext);

    if (decision.outcome === 'deny') {
      return {
        status: 'denied',
        reason: decision.reason,
        source: `${decision.source.stage}:${decision.source.id}`,
      };
    }
    if (decision.outcome === 'ask') {
      return {
        status: 'needs-approval',
        actionDigest: decision.actionDigest,
        description: decision.description,
        action,
      };
    }

    // 4. Execute in the sandbox worker. `allow` and `passthrough` proceed. (A caller that already
    // obtained a grant passes a context whose grants make this resolve to `allow`.)
    const response = await this.#client.run({
      workspaceRoot: input.policyContext.workspaceRoot,
      isolation: input.isolation,
      grant: input.grant,
      request: tool.toWorkerRequest(args as never),
      ...(input.signal ? { signal: input.signal } : {}),
    });

    return {
      status: 'executed',
      response,
      action,
      actionDigest: actionDigest(action),
      isSideEffect: isSideEffect(action),
    };
  }
}

/** Register every built-in into a registry. Convenience for wiring the runtime. */
export function registerBuiltins(
  registry: ToolRegistry,
  builtins: readonly BuiltinTool[] = BUILTIN_TOOLS,
): ToolRegistry {
  for (const tool of builtins) registry.register(tool);
  return registry;
}

export { describeAction };
