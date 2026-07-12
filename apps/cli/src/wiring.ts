import { NO_MANAGED_RESTRICTIONS, PolicyEngine, type PolicyContext } from '@qwen-harness/policy';
import type {
  Actor,
  ActorId,
  CorrelationId,
  PermissionProfile,
  ThreadId,
} from '@qwen-harness/protocol';
import { DashScopeProvider } from '@qwen-harness/provider-dashscope';
import type { EventStore } from '@qwen-harness/storage';
import {
  BUILTIN_TOOLS,
  ToolPipeline,
  registerBuiltins,
  toolParametersJsonSchema,
  type BuiltinTool,
} from '@qwen-harness/tools-builtin';
import { ToolRegistry } from '@qwen-harness/tools-core';
import { ToolWorkerClient, type WorkerGrant } from '@qwen-harness/tool-worker';
import { TurnEngine, type ToolExecutionResult, type ToolExecutor } from '@qwen-harness/runtime';

/**
 * The composition root. Apps are the ONLY place allowed to wire the concrete I/O owners together;
 * every package below reached this point through its own boundary. This file turns the injected
 * interfaces the runtime speaks into the real provider, real sandbox, and real storage.
 *
 * It builds a `ToolExecutor` that runs the built-in pipeline (schema → policy → sandbox worker) and
 * hands it to the `TurnEngine`, so a single `run()` drives the whole loop against real components.
 */

const MODEL_ACTOR: Actor = { kind: 'model', id: 'act_model1' as ActorId };

export interface HarnessRuntimeOptions {
  readonly workspaceRoot: string;
  readonly profile: PermissionProfile;
  readonly model: string;
  readonly instructions: string;
  readonly homeDir: string;
  readonly clock: { now(): number };
  readonly ids: { next(prefix: string): string };
  readonly store: EventStore;
  readonly provider?: DashScopeProvider;
  readonly client?: ToolWorkerClient;
  readonly builtins?: readonly BuiltinTool[];
}

const GRANT: WorkerGrant = {
  readable: ['workspace', 'scratch'],
  writable: ['workspace', 'scratch'],
  shell: true,
  network: false,
  limits: { wallMs: 120_000, maxOutputBytes: 2_000_000, maxFileBytes: 10_000_000 },
};

/**
 * A tool executor backed by the real pipeline. `execute` runs a call through
 * schema → policy → the sandboxed worker, and `intentFor` derives the idempotency identity the
 * engine persists before execution (SS-05).
 */
export function pipelineExecutor(opts: {
  pipeline: ToolPipeline;
  builtins: readonly BuiltinTool[];
  policyContext: PolicyContext;
  isolation: 'read-only' | 'workspace-write' | 'disabled';
}): ToolExecutor {
  const byName = new Map(opts.builtins.map((t) => [t.name, t]));

  return {
    intentFor: (call) => {
      // Derive the intent from the tool NAME and raw arguments only. It must NOT call `toAction`,
      // because the arguments here are unvalidated — a model can send a call missing its `path`,
      // and building the action from that would throw before the pipeline gets a chance to reject
      // it cleanly at the schema stage.
      void byName;
      const kind = call.toolName.includes('write')
        ? 'file-write'
        : call.toolName.includes('edit')
          ? 'file-edit'
          : call.toolName === 'run_shell'
            ? 'shell'
            : call.toolName.startsWith('git')
              ? 'git'
              : 'other';
      return {
        idempotencyKey: `${call.toolName}:${JSON.stringify(call.arguments)}`,
        destructive: kind === 'file-write' || kind === 'file-edit' || kind === 'shell',
        kind,
        normalizedAction: call.toolName,
      };
    },
    execute: async (call): Promise<ToolExecutionResult> => {
      const start = Date.now();
      const outcome = await opts.pipeline.execute({
        callId: call.callId,
        toolName: call.toolName,
        rawArguments: call.arguments,
        policyContext: opts.policyContext,
        grant: GRANT,
        isolation: opts.isolation,
        signal: call.signal,
      });
      const durationMs = Date.now() - start;

      if (outcome.status !== 'executed') {
        const message =
          outcome.status === 'denied'
            ? `denied: ${outcome.reason}`
            : outcome.status === 'needs-approval'
              ? `needs approval: ${outcome.description}`
              : `rejected (${outcome.stage}): ${outcome.message}`;
        return {
          ok: false,
          modelText: message,
          userText: message,
          errorCategory: outcome.status,
          resultDigest: null,
          outputRef: null,
          truncated: false,
          durationMs,
        };
      }

      const response = outcome.response;
      if (!response.ok) {
        const message = `${response.error.category}: ${response.error.message}`;
        return {
          ok: false,
          modelText: message,
          userText: message,
          errorCategory: response.error.category,
          resultDigest: null,
          outputRef: null,
          truncated: false,
          durationMs,
        };
      }

      const text = summarizeResult(call.toolName, response.result);
      return {
        ok: true,
        modelText: text,
        userText: text,
        errorCategory: null,
        resultDigest: outcome.actionDigest,
        outputRef: null,
        truncated: false,
        durationMs,
      };
    },
  };
}

function asText(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v);
}

function summarizeResult(toolName: string, result: unknown): string {
  // A bounded, model-facing rendering of a tool result. Deliberately compact — an unbounded tool
  // result is the fastest way to blow a context budget (TL-10 handles true offload).
  const r = result as Record<string, unknown>;
  if (toolName === 'read_file' && typeof r['content'] === 'string') {
    return String(r['content']).slice(0, 8000);
  }
  if (toolName === 'run_shell') {
    return `exit ${String(r['exitCode'])}\n${asText(r['stdout']).slice(0, 4000)}${r['stderr'] ? `\n[stderr] ${asText(r['stderr']).slice(0, 2000)}` : ''}`;
  }
  if (toolName === 'search' && Array.isArray(r['matches'])) {
    return (r['matches'] as { file: string; line: number; text: string }[])
      .slice(0, 100)
      .map((m) => `${m.file}:${m.line}: ${m.text}`)
      .join('\n');
  }
  return JSON.stringify(result).slice(0, 8000);
}

export interface HarnessRuntime {
  readonly store: EventStore;
  readonly engine: TurnEngine;
  readonly policyContext: PolicyContext;
  readonly tools: readonly BuiltinTool[];
  runTurn(input: {
    threadId: ThreadId;
    correlationId: CorrelationId;
    userText: string;
  }): Promise<{ finalText: string; state: string; reason: string | null }>;
}

/**
 * Assemble a working harness runtime from real components. The provider defaults to the live
 * DashScope adapter (reads the key at its own boundary); a test injects a fake one.
 */
export function createHarnessRuntime(opts: HarnessRuntimeOptions): HarnessRuntime {
  const provider = opts.provider ?? new DashScopeProvider();
  const client = opts.client ?? new ToolWorkerClient();
  const builtins = opts.builtins ?? BUILTIN_TOOLS;

  const registry = registerBuiltins(new ToolRegistry(), builtins);
  const pipeline = new ToolPipeline({ registry, policy: new PolicyEngine(), client, builtins });

  const isolation =
    opts.profile === 'plan'
      ? 'read-only'
      : opts.profile === 'yolo'
        ? 'disabled'
        : 'workspace-write';

  const policyContext: PolicyContext = {
    profile: opts.profile,
    managedPolicy: NO_MANAGED_RESTRICTIONS,
    rules: [],
    grants: [],
    workspaceRoot: opts.workspaceRoot,
    homeDir: opts.homeDir,
    now: opts.clock.now(),
    actor: MODEL_ACTOR,
  };

  const executor = pipelineExecutor({
    pipeline,
    builtins,
    policyContext,
    isolation: isolation === 'disabled' ? 'workspace-write' : isolation,
  });

  const engine = new TurnEngine({
    provider,
    tools: executor,
    sink: {
      append: (input) =>
        opts.store.append({ ...input, causationId: (input.causationId ?? null) as never }),
      mayExecute: (key) => opts.store.mayExecute(key),
    },
    ids: opts.ids,
    clock: opts.clock,
  });

  // The model-facing tool schemas.
  const modelTools = builtins
    .filter((t) => t.availableIn.includes(opts.profile))
    .map((t) => ({
      name: t.name,
      description: t.description,
      parameters: toolParametersJsonSchema(t),
    }));

  return {
    store: opts.store,
    engine,
    policyContext,
    tools: builtins,
    runTurn: async (input) => {
      const result = await engine.run({
        threadId: input.threadId,
        correlationId: input.correlationId,
        permissionProfile: opts.profile,
        model: opts.model,
        instructions: opts.instructions,
        history: [],
        userText: input.userText,
        tools: modelTools,
        actor: MODEL_ACTOR,
      });
      return { finalText: result.finalText, state: result.state, reason: result.terminationReason };
    },
  };
}
