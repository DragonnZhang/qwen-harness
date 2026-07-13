import {
  PolicyEngine,
  consumeGrant,
  type Grant,
  type NormalizedAction,
  type PolicyContext,
} from '@qwen-harness/policy';
import type {
  Actor,
  ActorId,
  CorrelationId,
  HarnessEvent,
  ThreadId,
  TurnId,
} from '@qwen-harness/protocol';
import type { ModelInputItem, ModelProvider } from '@qwen-harness/provider-core';
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
import {
  TurnEngine,
  type ApprovalGate,
  type ApprovalRequest,
  type ApprovalRisk,
  type ContextManager,
  type NormalizedToolCall,
  type ToolEvaluation,
  type ToolExecutionResult,
  type ToolExecutor,
  type TurnHooks,
} from '@qwen-harness/runtime';
import type { Tracer } from '@qwen-harness/telemetry';

import type { RunAuthority } from './policy-from-config.ts';
import {
  traceEvent,
  tracedApprovals,
  tracedExecutor,
  tracedHooks,
  tracedProvider,
} from './telemetry.ts';

/**
 * The composition root. Apps are the ONLY place allowed to wire the concrete I/O owners together;
 * every package below reached this point through its own boundary. This file turns the injected
 * interfaces the runtime speaks into the real provider, real sandbox, and real storage.
 *
 * It builds a `ToolExecutor` that runs the built-in pipeline (schema → policy → sandbox worker) and
 * hands it to the `TurnEngine`, so a single `run()` drives the whole loop against real components.
 *
 * The daemon uses this SAME function. There is one composition, not one per client — otherwise a
 * security property proved for the CLI would say nothing about the daemon.
 */

const MODEL_ACTOR: Actor = { kind: 'model', id: 'act_model1' as ActorId };

export interface HarnessRuntimeOptions {
  readonly workspaceRoot: string;
  /**
   * The ceiling and effective authority for this run, from `authorityFromConfig`. Required on
   * purpose: see the note in `createHarnessRuntime`. To run genuinely unrestricted you must say so
   * out loud (`NO_MANAGED_RESTRICTIONS`), which is greppable; a forgotten field is not.
   */
  readonly authority: RunAuthority;
  readonly model: string;
  readonly instructions: string;
  readonly homeDir: string;
  readonly clock: { now(): number };
  readonly ids: { next(prefix: string): string };
  readonly store: EventStore;
  readonly provider?: ModelProvider;
  readonly client?: ToolWorkerClient;
  readonly builtins?: readonly BuiltinTool[];
  /**
   * The policy engine. Injectable so the app can hand the SAME instance to the MCP executor — "MCP
   * is judged by the same policy engine as a built-in" should be literally true, not merely true of
   * two separately-constructed engines that happen to agree today.
   */
  readonly policy?: PolicyEngine;
  /**
   * The interactive approval channel. Absent means there is none: an `ask` action suspends the turn
   * in `awaiting-approval` and is never auto-approved.
   */
  readonly approvals?: ApprovalGate;
  /** Called with every event as it becomes durable. The daemon streams these to its clients. */
  readonly onEvent?: (event: HarnessEvent) => void;
  /**
   * Local, opt-in, redacted trace (OB-01/OB-02). Absent means telemetry is OFF: no decorator is
   * installed and nothing is traced. Present means every provider request, tool execution, policy
   * decision, approval, hook, and durable event is mirrored into the tracer's sink — already
   * redacted, because `Tracer` scrubs the message and every field before the sink sees them.
   */
  readonly tracer?: Tracer;
  /** At `telemetry.level: debug` the trace carries redacted CONTENT, not just shape. */
  readonly detailedTrace?: boolean;
  /**
   * The hook engine, adapted to the runtime's `TurnHooks` port. A PreToolUse hook may BLOCK a tool;
   * it can never allow one policy refused (that invariant lives in the hook engine itself, HK-04).
   */
  readonly hooks?: TurnHooks;
  /**
   * Connected MCP servers (MC-04). Their tools are offered to the model alongside the built-ins and
   * execute through `executor`, which runs the SAME policy engine, the same approval gate, the same
   * hooks, and the same audit trail. There is no privileged MCP path.
   */
  readonly mcp?: McpSurface;
  /** Extra system-prompt-independent tools (skills catalogs etc.) offered to the model. */
  readonly extraTools?: readonly ModelTool[];
  /**
   * Token budgeting and compaction (CX-01..CX-06). When present, the engine calls it before every
   * model round: large tool outputs offload to the durable blob store, the transcript prunes, and
   * proactive/reactive compaction fires on real growth. Absent means the full conversation is sent.
   */
  readonly context?: ContextManager;
}

/** A model-facing tool schema, as the provider wants it. */
export interface ModelTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface McpSurface {
  /** Namespaced `mcp__<server>__<tool>` schemas to offer the model. */
  readonly tools: readonly ModelTool[];
  /** Executes exactly those tools. Anything else must be refused, not guessed at. */
  readonly executor: ToolExecutor;
}

const GRANT: WorkerGrant = {
  readable: ['workspace', 'scratch'],
  writable: ['workspace', 'scratch'],
  shell: true,
  network: false,
  limits: { wallMs: 120_000, maxOutputBytes: 2_000_000, maxFileBytes: 10_000_000 },
};

/**
 * The live approval grants for one session.
 *
 * A grant is minted only when a human says yes, and it binds to `actionDigest` — the exact
 * canonical action, not the tool name (PS-03). A `once` grant is spent the moment it authorizes an
 * execution, so the next identical call asks again. Grants live for the process: a new process
 * re-asks, which keeps the failure direction safe (a lost grant costs a prompt; a resurrected one
 * would cost an unapproved side effect).
 */
export class GrantStore {
  #grants: readonly Grant[] = [];

  constructor(private readonly ids: { next(prefix: string): string }) {}

  get grants(): readonly Grant[] {
    return this.#grants;
  }

  add(actionDigest: string, scope: 'once' | 'session' | 'rule', now: number, by: string): Grant {
    // A `rule` grant is the only non-digest-bound scope and must be validated before it can be
    // stored (policy.validateRuleGrant). This channel mints exact, digest-bound grants only, so an
    // approval can never be broader than the action the human actually saw.
    const grant: Grant = {
      id: this.ids.next('grt'),
      scope: scope === 'rule' ? 'session' : scope,
      actionDigest,
      match: null,
      grantedAt: now,
      expiresAt: null,
      revokedAt: null,
      usedAt: null,
      grantedBy: by,
      reason: 'interactive approval',
    };
    this.#grants = [...this.#grants, grant];
    return grant;
  }

  /** Spend any `once` grant bound to this digest. */
  consume(actionDigest: string, now: number): void {
    for (const grant of this.#grants) {
      if (grant.scope === 'once' && grant.actionDigest === actionDigest && grant.usedAt === null) {
        this.#grants = consumeGrant(this.#grants, grant.id, now);
        return;
      }
    }
  }
}

/** How alarming is this action? Drives the risk shown in the prompt (PS-09). */
export function riskOf(action: NormalizedAction): ApprovalRisk {
  switch (action.kind) {
    case 'shell':
    case 'network':
      return 'high';
    case 'git-write':
      return action.destructive ? 'high' : 'medium';
    case 'file-write':
    case 'file-edit':
    case 'patch':
    case 'mcp':
      return 'medium';
    default:
      return 'low';
  }
}

/**
 * A tool executor backed by the real pipeline. `evaluate` asks policy what it thinks WITHOUT any
 * side effect, `execute` runs a call through schema → policy → the sandboxed worker, and
 * `intentFor` derives the idempotency identity the engine persists before execution (SS-05).
 */
export function pipelineExecutor(opts: {
  pipeline: ToolPipeline;
  builtins: readonly BuiltinTool[];
  /** Re-read per call, so a grant minted mid-turn — and the current time — are both visible. */
  policyContext: () => PolicyContext;
  isolation: 'read-only' | 'workspace-write' | 'disabled';
  grants?: GrantStore;
  clock?: { now(): number };
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

    evaluate: (call): Promise<ToolEvaluation> => {
      const decision = opts.pipeline.decide({
        callId: call.callId,
        toolName: call.toolName,
        rawArguments: call.arguments,
        policyContext: opts.policyContext(),
      });

      if (decision.status === 'rejected') {
        // Malformed arguments are not a permission question. Report `allow` so the engine proceeds
        // to `execute`, where the pipeline rejects the call again and the model gets a typed tool
        // error it can fix. Nothing runs: `execute` re-decides and stops at the same stage.
        return Promise.resolve({
          status: 'allow',
          actionDigest: '',
          description: `${call.toolName} (invalid arguments)`,
          risk: 'low',
          reason: decision.message,
          source: `pipeline:${decision.stage}`,
        });
      }
      if (decision.status === 'denied') {
        return Promise.resolve({
          status: 'deny',
          actionDigest: '',
          description: call.toolName,
          risk: 'high',
          reason: decision.reason,
          source: decision.source,
        });
      }
      if (decision.status === 'needs-approval') {
        return Promise.resolve({
          status: 'ask',
          actionDigest: decision.actionDigest,
          description: decision.description,
          risk: riskOf(decision.action),
          reason: decision.reason,
          source: decision.source,
        });
      }
      return Promise.resolve({
        status: 'allow',
        actionDigest: decision.actionDigest,
        description: decision.description,
        risk: riskOf(decision.action),
        reason: decision.reason,
        source: decision.source,
      });
    },

    execute: async (call): Promise<ToolExecutionResult> => {
      const start = opts.clock?.now() ?? Date.now();
      const outcome = await opts.pipeline.execute({
        callId: call.callId,
        toolName: call.toolName,
        rawArguments: call.arguments,
        policyContext: opts.policyContext(),
        grant: GRANT,
        isolation: opts.isolation,
        signal: call.signal,
      });
      const durationMs = (opts.clock?.now() ?? Date.now()) - start;

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

      // The approval is spent. A `once` grant authorizes exactly one execution of exactly this
      // action; an identical call afterwards prompts again.
      opts.grants?.consume(outcome.actionDigest, opts.clock?.now() ?? Date.now());

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

/** Every MCP tool the model can see is namespaced. This prefix is what routes a call (MC-03). */
const MCP_PREFIX = 'mcp__';

/**
 * Dispatch a tool call to the executor that owns it: the built-in sandbox pipeline, or MCP.
 *
 * The split is by NAME, and the name is not the model's to choose — `assignToolNames` produced the
 * `mcp__server__tool` form, and a built-in can never be shadowed by one (MC-03). An unknown name
 * reaches the built-in pipeline, which rejects it as an unknown tool; it is never silently routed
 * to a server.
 *
 * What this composite deliberately does NOT do is bypass anything. Both branches are ordinary
 * `ToolExecutor`s, so the engine wraps BOTH in the same order: hooks gate the call, policy decides
 * it, an `ask` suspends the turn for a real approval, and the intent/result pair is persisted around
 * the execution. MCP gets no shortcut because there is nowhere to put one.
 */
export function compositeExecutor(builtin: ToolExecutor, mcp: McpSurface): ToolExecutor {
  const isMcp = (toolName: string): boolean =>
    toolName.startsWith(MCP_PREFIX) && mcp.tools.some((t) => t.name === toolName);
  return {
    intentFor: (call) => (isMcp(call.toolName) ? mcp.executor : builtin).intentFor(call),
    evaluate: (call) => (isMcp(call.toolName) ? mcp.executor : builtin).evaluate(call),
    execute: (call) => (isMcp(call.toolName) ? mcp.executor : builtin).execute(call),
  };
}

export interface TurnOutcome {
  readonly turnId: TurnId;
  readonly finalText: string;
  readonly state: string;
  readonly reason: string | null;
  /** Present exactly when `state === 'awaiting-approval'`. */
  readonly pendingApproval: ApprovalRequest | null;
}

export interface HarnessRuntime {
  readonly store: EventStore;
  readonly engine: TurnEngine;
  readonly grants: GrantStore;
  readonly tools: readonly BuiltinTool[];
  runTurn(input: {
    threadId: ThreadId;
    correlationId: CorrelationId;
    userText: string;
    /** Prior durable history, reconstructed from the log on resume. Empty for a fresh session. */
    history?: readonly ModelInputItem[];
    signal?: AbortSignal;
  }): Promise<TurnOutcome>;
  /** Continue a turn the log left in `awaiting-approval`. Same turn ID; no new user message. */
  resumeTurn(input: {
    threadId: ThreadId;
    turnId: TurnId;
    correlationId: CorrelationId;
    history: readonly ModelInputItem[];
    pendingCalls: readonly NormalizedToolCall[];
    signal?: AbortSignal;
  }): Promise<TurnOutcome>;
}

/**
 * Assemble a working harness runtime from real components. The provider defaults to the live
 * DashScope adapter (reads the key at its own boundary); a test injects a scripted one.
 */
export function createHarnessRuntime(opts: HarnessRuntimeOptions): HarnessRuntime {
  const tracer = opts.tracer;
  const detailed = opts.detailedTrace === true;

  const baseProvider = opts.provider ?? new DashScopeProvider();
  // Telemetry decorates the REAL provider. When it is off, no decorator exists and the provider is
  // the one the composition built — "opt-in" means the code path does not run, not that its output
  // is thrown away.
  const provider = tracer
    ? tracedProvider(baseProvider, tracer, opts.clock, detailed)
    : baseProvider;
  const client = opts.client ?? new ToolWorkerClient();
  const builtins = opts.builtins ?? BUILTIN_TOOLS;

  const registry = registerBuiltins(new ToolRegistry(), builtins);
  const policy = opts.policy ?? new PolicyEngine();
  const pipeline = new ToolPipeline({ registry, policy, client, builtins });

  // The authority this run executes under. It is REQUIRED, not defaulted: a runtime that silently
  // fell back to "no managed restrictions" is precisely the bug this replaced, and a default is how
  // that bug gets reintroduced. `authorityFromConfig` has already applied precedence and clamped
  // profile/isolation/network to the ceiling — we pass those through and never re-derive them here,
  // because a second implementation of the clamping rule would eventually disagree with the first.
  const { managedPolicy, rules, profile, isolation } = opts.authority;

  const grants = new GrantStore(opts.ids);

  const policyContext = (): PolicyContext => ({
    profile,
    managedPolicy,
    rules,
    grants: grants.grants,
    workspaceRoot: opts.workspaceRoot,
    homeDir: opts.homeDir,
    now: opts.clock.now(),
    actor: MODEL_ACTOR,
  });

  const builtinExecutor = pipelineExecutor({
    pipeline,
    builtins,
    policyContext,
    // `disabled` is passed through honestly. It means what it says — no sandbox — and it is what
    // `yolo` resolves to. Quietly substituting `workspace-write` would have made the product safer
    // than it advertised, which sounds harmless but is still a lie about the security boundary, and
    // an operator who bounds `maxIsolation` in managed policy would never learn their ceiling was
    // the only thing holding. The ceiling above is what constrains this, not a hidden downgrade.
    isolation,
    grants,
    clock: opts.clock,
  });

  /**
   * The gate the ENGINE sees. It records the grant a human just gave BEFORE the engine re-enters
   * the pipeline, so the very next `execute` re-evaluates policy and finds the exact digest-bound
   * grant. The approval therefore flows through policy, not around it: there is no code path where
   * an approved call skips the engine's decision stages.
   */
  const userGate = opts.approvals;
  const grantingGate: ApprovalGate | undefined =
    userGate === undefined
      ? undefined
      : {
          request: async (request: ApprovalRequest, signal: AbortSignal) => {
            const decision = await userGate.request(request, signal);
            if (decision.kind === 'approved') {
              grants.add(request.actionDigest, decision.scope, opts.clock.now(), 'user');
            }
            return decision;
          },
        };
  const gate =
    grantingGate && tracer ? tracedApprovals(grantingGate, tracer, opts.clock) : grantingGate;

  // MCP tools execute through their own executor, but through the SAME engine — so the same hooks,
  // the same approvals, the same durable intent/result pair, and the same policy engine apply.
  const routed = opts.mcp ? compositeExecutor(builtinExecutor, opts.mcp) : builtinExecutor;
  const executor = tracer ? tracedExecutor(routed, tracer, opts.clock, detailed) : routed;

  const hooks = opts.hooks && tracer ? tracedHooks(opts.hooks, tracer, opts.clock) : opts.hooks;

  const engine = new TurnEngine({
    provider,
    tools: executor,
    sink: {
      append: (input) => {
        const event = opts.store.append({
          ...input,
          causationId: (input.causationId ?? null) as never,
        });
        // The durable log is the SPINE of the trace. Mirroring it here — rather than tracing from
        // inside the engine — means the trace cannot tell a story the event log contradicts: there
        // is exactly one source, and telemetry is a reader of it.
        if (tracer) traceEvent(tracer, event, detailed);
        opts.onEvent?.(event);
        return event;
      },
      mayExecute: (key) => opts.store.mayExecute(key),
    },
    ids: opts.ids,
    clock: opts.clock,
    ...(gate ? { approvals: gate } : {}),
    ...(hooks ? { hooks } : {}),
    ...(opts.context ? { context: opts.context } : {}),
  });

  // The model-facing tool schemas: built-ins available in this profile, plus every connected MCP
  // server's namespaced tools, plus anything the app added (a skill catalog, say).
  const modelTools: readonly ModelTool[] = [
    ...builtins
      .filter((t) => t.availableIn.includes(profile))
      .map((t) => ({
        name: t.name,
        description: t.description,
        parameters: toolParametersJsonSchema(t) as Readonly<Record<string, unknown>>,
      })),
    ...(opts.mcp?.tools ?? []),
    ...(opts.extraTools ?? []),
  ];

  return {
    store: opts.store,
    engine,
    grants,
    tools: builtins,
    runTurn: async (input) => {
      const result = await engine.run({
        threadId: input.threadId,
        correlationId: input.correlationId,
        permissionProfile: profile,
        model: opts.model,
        instructions: opts.instructions,
        history: input.history ?? [],
        userText: input.userText,
        tools: modelTools,
        actor: MODEL_ACTOR,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return {
        turnId: result.turnId,
        finalText: result.finalText,
        state: result.state,
        reason: result.terminationReason,
        pendingApproval: result.pendingApproval,
      };
    },
    resumeTurn: async (input) => {
      const result = await engine.resume({
        threadId: input.threadId,
        turnId: input.turnId,
        correlationId: input.correlationId,
        permissionProfile: profile,
        model: opts.model,
        instructions: opts.instructions,
        history: input.history,
        pendingCalls: input.pendingCalls,
        tools: modelTools,
        actor: MODEL_ACTOR,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return {
        turnId: result.turnId,
        finalText: result.finalText,
        state: result.state,
        reason: result.terminationReason,
        pendingApproval: result.pendingApproval,
      };
    },
  };
}
