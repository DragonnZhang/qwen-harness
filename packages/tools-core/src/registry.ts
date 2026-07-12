import { harnessError, type PermissionProfile, type ToolCallId } from '@qwen-harness/protocol';

import type { ToolDefinition, ToolErrorCategory } from './contract.ts';

/**
 * The tool registry.
 *
 * Binds a stable name to schema, annotations, concurrency metadata, timeout, and availability
 * (TL-01). It holds DEFINITIONS only — never handlers. Handlers live in the sandboxed worker,
 * which is why the runtime process cannot execute a tool even by accident.
 */
export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition<never, unknown>>();

  register<TIn, TOut>(tool: ToolDefinition<TIn, TOut>): this {
    if (this.#tools.has(tool.name)) {
      throw harnessError({
        origin: 'internal',
        category: 'tools.duplicate_name',
        message: `tool "${tool.name}" is already registered`,
      });
    }
    this.#tools.set(tool.name, tool as unknown as ToolDefinition<never, unknown>);
    return this;
  }

  get(name: string): ToolDefinition<never, unknown> | undefined {
    return this.#tools.get(name);
  }

  /**
   * The tools a given profile may even SEE.
   *
   * `plan` must not merely be denied a mutation at approval time — the tool must be *absent from
   * the model's tool list entirely* (PS-02). A tool the model was never offered cannot be
   * smuggled through shell indirection, a hook, an MCP call, or a subagent, because the model has
   * no name to call.
   */
  availableFor(profile: PermissionProfile): ToolDefinition<never, unknown>[] {
    return [...this.#tools.values()].filter((t) => t.availableIn.includes(profile));
  }

  get names(): string[] {
    return [...this.#tools.keys()].sort();
  }
}

export interface ValidationFailure {
  readonly category: ToolErrorCategory;
  readonly message: string;
}

/**
 * The FIRST two stages of the pipeline mandated by TL-07:
 *
 *   schema -> semantic -> hard policy -> pre hooks -> permission -> sandbox -> execution
 *
 * This function owns `schema` and `semantic`. The remaining stages are owned by policy, hooks,
 * and the sandbox worker respectively, and the runtime composes them in exactly this order.
 * There is deliberately no function anywhere that "just runs a tool" — every path goes through
 * the whole chain.
 */
export function validateCall(
  tool: ToolDefinition<never, unknown>,
  rawArguments: unknown,
): { ok: true; input: unknown } | { ok: false; failure: ValidationFailure } {
  const parsed = tool.inputSchema.safeParse(rawArguments);
  if (!parsed.success) {
    return {
      ok: false,
      failure: {
        category: 'invalid-input',
        message: parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; '),
      },
    };
  }

  // Semantic validation runs only AFTER the shape is known good, so it can trust its input.
  const semantic = tool.validate?.(parsed.data) ?? null;
  if (semantic !== null) {
    return { ok: false, failure: { category: 'semantic-invalid', message: semantic } };
  }

  return { ok: true, input: parsed.data };
}

/** Model-emitted tool call, after the provider has produced complete, parsed arguments. */
export interface ToolCall {
  readonly callId: ToolCallId;
  readonly toolName: string;
  readonly arguments: unknown;
}
