import {
  HarnessError,
  type Actor,
  type CorrelationId,
  type EventPayload,
  type IdSource,
  type ItemId,
  type PermissionProfile,
  type TerminationReason,
  type ThreadId,
  type TurnId,
} from '@qwen-harness/protocol';
import {
  decideRetry,
  DEFAULT_RETRY_POLICY,
  type ModelProvider,
  type ModelInputItem,
  type RetryPolicy,
  type Rng,
} from '@qwen-harness/provider-core';

import { BudgetTracker, DEFAULT_BUDGET, type BudgetLimits } from './budget.ts';
import { normalizeRound, type NormalizedRound, type NormalizedToolCall } from './normalizer.ts';
import { TurnMachine } from './turn-machine.ts';

/**
 * The turn engine: the actual agent loop, expressed over INJECTED interfaces so it touches no host
 * capability itself (RT-08). An app supplies the concrete provider, tool executor, and event sink;
 * the engine coordinates them and drives the state machine and budgets.
 *
 * The ordering here is the load-bearing part. For every side effect the engine:
 *   1. persists the INTENT (with an idempotency key) BEFORE execution;
 *   2. executes;
 *   3. persists the RESULT before continuing.
 *
 * That is what lets recovery distinguish not-started / complete / indeterminate work and never
 * replay a known-complete action (SS-05). The engine does not implement recovery itself — it
 * produces the durable record that recovery reads.
 *
 * APPROVALS. When policy says `ask`, the turn moves to `awaiting-approval` and the request is
 * persisted BEFORE anyone is asked. A decision then resumes the SAME turn into `executing`: an
 * approval is never a new user message and never a new turn (RT-03, PS-03). If there is no
 * approval channel — a `--json` run, a daemon with no attached client — the turn STAYS
 * `awaiting-approval` and the engine returns; the durable log holds the pending request, so a later
 * process can resume that very turn (`resume()`). Nothing is ever auto-approved
 * (defaults.md, "Cron defaults": an ask-required action without a channel becomes awaiting-approval).
 */

/** The event sink the engine writes to. `EventStore` implements this; the engine never sees SQLite. */
export interface EventSink {
  append(input: {
    threadId: ThreadId;
    turnId?: TurnId | null;
    itemId?: ItemId | null;
    actor: Actor;
    correlationId: CorrelationId;
    causationId?: string | null;
    permissionProfile: PermissionProfile;
    payload: EventPayload;
  }): { seq: number };
  /** Whether a side effect with this idempotency key may run (SS-05). */
  mayExecute(idempotencyKey: string): { allowed: boolean; reason: string };
}

/** The result of executing one tool call. The app's ToolPipeline produces this. */
export interface ToolExecutionResult {
  readonly ok: boolean;
  /** Bounded text fed back to the model. */
  readonly modelText: string;
  /** Longer text for the UI. */
  readonly userText: string;
  readonly errorCategory: string | null;
  /** Digest of the settled result, for the durable record. */
  readonly resultDigest: string | null;
  readonly outputRef: string | null;
  readonly truncated: boolean;
  readonly durationMs: number;
}

export type ApprovalRisk = 'low' | 'medium' | 'high';

/**
 * What POLICY says about a call, decided without executing anything. The engine needs this before
 * it acts, because an `ask` has to pause the turn and an approval has to bind to the exact action
 * (`actionDigest`) rather than to a tool name.
 *
 * A call whose ARGUMENTS are malformed is not a policy question: it reports `allow` here and the
 * pipeline rejects it inside `execute`, which surfaces the rejection to the model as a failed tool
 * result. There is deliberately no way for an evaluation to say "allow" and have execution skip
 * policy — `execute` re-decides internally, so the gate cannot be bypassed by lying here.
 */
export interface ToolEvaluation {
  readonly status: 'allow' | 'ask' | 'deny';
  /** The identity an approval binds to (PS-03). */
  readonly actionDigest: string;
  /** Human-readable, exact, normalized action — the text an approval prompt must show. */
  readonly description: string;
  readonly risk: ApprovalRisk;
  readonly reason: string;
  /** Which stage/rule produced the verdict, for the audit trail (PS-07). */
  readonly source: string;
}

/** Executes one already-validated tool call. Implemented in an app by the sandbox pipeline. */
export interface ToolExecutor {
  /** Policy verdict for this call, with NO side effect. Runs before every execution. */
  evaluate(call: {
    callId: string;
    toolName: string;
    arguments: Readonly<Record<string, unknown>>;
  }): Promise<ToolEvaluation>;
  execute(call: {
    // The provider's opaque call ID, preserved byte-for-byte for output pairing (PV-06).
    callId: string;
    toolName: string;
    arguments: Readonly<Record<string, unknown>>;
    argumentsJson: string;
    signal: AbortSignal;
  }): Promise<ToolExecutionResult>;
  /** The idempotency key + destructiveness for this call, so the engine can persist intent first. */
  intentFor(call: { toolName: string; arguments: Readonly<Record<string, unknown>> }): {
    idempotencyKey: string;
    destructive: boolean;
    kind: 'file-write' | 'file-edit' | 'patch' | 'shell' | 'git' | 'network' | 'mcp' | 'other';
    normalizedAction: string;
  };
  /**
   * Partition a round's calls into ordered execution batches by REAL resource conflict (TL-08).
   *
   * The conflict analysis lives in the tools layer (it needs each tool's annotations and argument
   * footprint), so the engine delegates it here rather than depending on `tools-core`. The return is
   * groups of `callId`s in ORIGINAL ORDER: each inner group is a set of calls that are safe to run
   * concurrently (independent read-only calls); groups run strictly in sequence, and any mutating or
   * conflicting call is its own single-call group. Optional — an executor that omits it (a test fake)
   * makes the engine fall back to fully serial execution, which is always safe.
   */
  planBatches?(
    calls: readonly {
      callId: string;
      toolName: string;
      arguments: Readonly<Record<string, unknown>>;
    }[],
  ): readonly (readonly string[])[];
}

/** A pending approval: everything a human (or a client over a socket) needs to decide. */
export interface ApprovalRequest {
  readonly turnId: TurnId;
  readonly callId: string;
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly argumentsJson: string;
  readonly actionDigest: string;
  readonly description: string;
  readonly risk: ApprovalRisk;
  readonly reason: string;
}

export type ApprovalDecision =
  | { readonly kind: 'approved'; readonly scope: 'once' | 'session' | 'rule' }
  | { readonly kind: 'denied'; readonly reason: string }
  /** No channel is available to answer. The turn stays `awaiting-approval`, durably. */
  | { readonly kind: 'deferred'; readonly reason: string };

/**
 * The interactive approval channel. The CLI implements it with a terminal prompt; the daemon
 * implements it by asking its attached socket clients. An implementation that cannot ask MUST
 * return `deferred` — returning `approved` without a human is the one thing it may never do.
 */
export interface ApprovalGate {
  request(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>;
}

/**
 * The turn engine's view of the hook engine — the minimum it needs, so runtime stays decoupled from
 * the hooks PACKAGE. An app adapts the real `HookEngine` to this. A `preToolUse` that returns
 * `block` prevents the tool from executing; a hook can never turn a block into an allow (that
 * invariant lives in the hook engine itself, HK-04).
 */
export interface TurnHooks {
  preToolUse(call: {
    toolName: string;
    arguments: Readonly<Record<string, unknown>>;
  }): Promise<{ blocked: boolean; reason: string | null }>;
  // Returns whether continuation should stop. A `void`/absent return means "do not stop" — the
  // completed tool result is always durable regardless (HK-05); `stopContinuation` only decides
  // whether the turn goes back to the model for another round.
  postToolUse(call: {
    toolName: string;
    ok: boolean;
  }): Promise<void | { readonly stopContinuation?: boolean }>;

  /**
   * Fire a lifecycle hook event that is not tied to a single tool call — e.g. `PostToolBatch` after a
   * round's tools all settle. Optional and best-effort: the engine stays decoupled from the concrete
   * hook catalog (the event is a plain string), and an app that wires no lifecycle hooks simply omits
   * it. Never blocks or alters the turn; a lifecycle hook observes, it does not gate (HK-01).
   */
  fireLifecycle?(event: string, data?: Readonly<Record<string, unknown>>): Promise<void>;
}

/**
 * What a context manager returns for one model round. The engine ADOPTS `items` as its working
 * conversation before streaming, so cheap reduction (offload/prune) and compaction both persist
 * across rounds instead of being recomputed from scratch every time.
 */
export interface ContextPreparation {
  /** The conversation to send this round. Pairing must be intact; recent items must be retained. */
  readonly items: readonly ModelInputItem[];
  /** used / usable-input-budget, in [0, ∞). Exposed so a client can report real utilization (CX-01). */
  readonly utilization: number;
  /** True when threshold/overflow compaction ran this round (CX-03/CX-04). */
  readonly compacted: boolean;
  /** Which path triggered compaction, or `null` when only cheap reduction (or nothing) happened. */
  readonly trigger: 'proactive' | 'reactive-overflow' | null;
}

/**
 * The turn engine's view of context management (CX-01..CX-06). An app implements it with
 * `@qwen-harness/context` — the engine stays pure and simply calls `prepare` before each model
 * round, then adopts the returned conversation. Absent means no budgeting is wired: the engine
 * sends the full conversation, exactly as before.
 */
export interface ContextManager {
  prepare(call: {
    conversation: readonly ModelInputItem[];
    instructions: string;
    threadId: ThreadId;
    turnId: TurnId;
    correlationId: CorrelationId;
    permissionProfile: PermissionProfile;
    signal: AbortSignal;
  }): Promise<ContextPreparation>;
}

export interface TurnEngineDeps {
  readonly provider: ModelProvider;
  readonly tools: ToolExecutor;
  readonly sink: EventSink;
  readonly ids: IdSource;
  readonly clock: { now(): number; sleep?(ms: number): Promise<void> };
  readonly budget?: BudgetLimits;
  /**
   * Randomness for retry backoff jitter. Injected so a test is deterministic (RT-08). Absent means
   * the midpoint of the jitter window (0.5) — deterministic, and half the exponential bound.
   */
  readonly rng?: Rng;
  /** Transient-fault retry policy for the PROVIDER call. Absent means the frozen default. */
  readonly retryPolicy?: RetryPolicy;
  /** Optional. When present, PreToolUse gates each tool and PostToolUse fires after. */
  readonly hooks?: TurnHooks;
  /** Optional. Absent means there is no approval channel: an `ask` defers, it never auto-allows. */
  readonly approvals?: ApprovalGate;
  /**
   * Optional. When present, the engine calls `prepare` before every model round and adopts the
   * returned conversation, so token budgeting, offload, prune, and compaction happen on real
   * transcript growth (CX-01..CX-06). Absent means the full conversation is always sent.
   */
  readonly context?: ContextManager;
}

export interface RunTurnInput {
  readonly threadId: ThreadId;
  readonly correlationId: CorrelationId;
  readonly permissionProfile: PermissionProfile;
  readonly model: string;
  readonly instructions: string;
  /** Prior durable history for this thread, already reconstructed into model input items. */
  readonly history: readonly ModelInputItem[];
  readonly userText: string;
  readonly tools: Parameters<ModelProvider['stream']>[0]['tools'];
  readonly actor: Actor;
  readonly signal?: AbortSignal;
}

/**
 * Resume a turn that was left `awaiting-approval` — possibly by a process that no longer exists.
 *
 * The turn ID is the one from the log. No `turn-started` is appended, no user message is created:
 * the same turn continues where it stopped (task.md: "an approval RESUMES THE SAME TURN").
 */
export interface ResumeTurnInput {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly correlationId: CorrelationId;
  readonly permissionProfile: PermissionProfile;
  readonly model: string;
  readonly instructions: string;
  /** The full reconstructed conversation, ending with the not-yet-answered function calls. */
  readonly history: readonly ModelInputItem[];
  /** The calls of the interrupted round that never produced a result, in order. */
  readonly pendingCalls: readonly NormalizedToolCall[];
  readonly tools: Parameters<ModelProvider['stream']>[0]['tools'];
  readonly actor: Actor;
  readonly signal?: AbortSignal;
}

export interface TurnResult {
  readonly turnId: TurnId;
  readonly state: TurnMachine['state'];
  readonly terminationReason: string | null;
  readonly rounds: number;
  readonly finalText: string;
  /** Set exactly when `state === 'awaiting-approval'`: the request nobody could answer yet. */
  readonly pendingApproval: ApprovalRequest | null;
}

interface DriveContext {
  readonly base: PersistBase;
  readonly machine: TurnMachine;
  readonly budget: BudgetTracker;
  readonly conversation: ModelInputItem[];
  readonly model: string;
  readonly instructions: string;
  readonly tools: Parameters<ModelProvider['stream']>[0]['tools'];
  readonly signal: AbortSignal;
  /** Calls to execute BEFORE the first model round. Non-empty only on resume. */
  readonly seedCalls: readonly NormalizedToolCall[];
}

type ToolPhase =
  | { readonly stop: false }
  | { readonly stop: true; readonly kind: 'budget'; readonly reason: TerminationReason }
  | { readonly stop: true; readonly kind: 'cancelled' }
  // A PostToolUse hook returned `stop`: the completed tool result is durable and untouched, but the
  // turn does NOT continue to another model round. Distinct from `blocked` (which stops the action
  // itself) — the tool already ran (HK-05).
  | { readonly stop: true; readonly kind: 'hook-stop' }
  | {
      readonly stop: true;
      readonly kind: 'awaiting-approval';
      readonly pending: ApprovalRequest;
    };

export class TurnEngine {
  readonly #deps: TurnEngineDeps;

  constructor(deps: TurnEngineDeps) {
    this.#deps = deps;
  }

  /**
   * Runs one complete turn: model round → tool calls → model round → … until the model stops
   * calling tools, an approval cannot be answered, or a budget/limit terminates it. Every
   * transition is persisted before it is acted on.
   */
  async run(input: RunTurnInput): Promise<TurnResult> {
    const { sink, ids, clock } = this.#deps;
    const signal = input.signal ?? new AbortController().signal;
    const machine = new TurnMachine();
    const budget = new BudgetTracker(this.#deps.budget ?? DEFAULT_BUDGET, () => clock.now());

    const turnId = ids.next('trn') as TurnId;
    const base: PersistBase = {
      threadId: input.threadId,
      turnId,
      correlationId: input.correlationId,
      permissionProfile: input.permissionProfile,
      actor: input.actor,
    };

    sink.append({ ...base, payload: { type: 'turn-started', userText: input.userText } });

    // The model conversation grows as we go: user text, then each round's assistant text and the
    // tool results we feed back. Local history is authoritative (PV-08).
    const conversation: ModelInputItem[] = [
      ...input.history,
      { type: 'message', role: 'user', text: input.userText },
    ];

    return this.#drive({
      base,
      machine,
      budget,
      conversation,
      model: input.model,
      instructions: input.instructions,
      tools: input.tools,
      signal,
      seedCalls: [],
    });
  }

  /**
   * Resume a turn that the durable log left in `awaiting-approval`. The machine is restored to that
   * state, the pending calls are re-offered to policy (which will ask again, now that a channel
   * exists), and the SAME turn continues. The budget counters start fresh for the new process —
   * a resumed turn is a new wall-clock window, and the log records every round either way.
   */
  async resume(input: ResumeTurnInput): Promise<TurnResult> {
    const { clock } = this.#deps;
    const signal = input.signal ?? new AbortController().signal;
    const machine = new TurnMachine('awaiting-approval');
    const budget = new BudgetTracker(this.#deps.budget ?? DEFAULT_BUDGET, () => clock.now());

    const base: PersistBase = {
      threadId: input.threadId,
      turnId: input.turnId,
      correlationId: input.correlationId,
      permissionProfile: input.permissionProfile,
      actor: input.actor,
    };

    return this.#drive({
      base,
      machine,
      budget,
      conversation: [...input.history],
      model: input.model,
      instructions: input.instructions,
      tools: input.tools,
      signal,
      seedCalls: input.pendingCalls,
    });
  }

  // -------------------------------------------------------------------------------------------

  async #drive(ctx: DriveContext): Promise<TurnResult> {
    const { provider, sink } = this.#deps;
    const { base, machine, budget, conversation, signal } = ctx;

    let rounds = 0;
    let finalText = '';
    let terminalReason: string | null = null;
    let pendingApproval: ApprovalRequest | null = null;
    let calls: readonly NormalizedToolCall[] = ctx.seedCalls;

    try {
      for (;;) {
        if (signal.aborted) {
          this.#cancel(base, machine);
          terminalReason = 'user-cancelled';
          break;
        }

        // --- tool phase: everything the previous model round (or the resumed turn) asked for ---
        if (calls.length > 0) {
          if (machine.state !== 'executing') machine.transition('executing');
          this.#persistState(base, machine);

          const phase = await this.#runToolCalls(
            base,
            machine,
            calls,
            budget,
            signal,
            conversation,
          );
          const batchSize = calls.length;
          calls = [];

          // The whole round's tools have settled — fire PostToolBatch (HK-01). Observe-only: it never
          // gates the turn, so it runs regardless of whether the turn is about to stop.
          if (this.#deps.hooks?.fireLifecycle) {
            await this.#deps.hooks.fireLifecycle('PostToolBatch', { tools: batchSize });
          }

          if (phase.stop && phase.kind === 'budget') {
            this.#endTurn(base, machine, 'budget-exhausted', phase.reason);
            terminalReason = phase.reason;
            break;
          }
          if (phase.stop && phase.kind === 'cancelled') {
            this.#cancel(base, machine);
            terminalReason = 'user-cancelled';
            break;
          }
          if (phase.stop && phase.kind === 'hook-stop') {
            // A PostToolUse hook stopped continuation. The tool result is already durable; the turn
            // ends cleanly (completed) instead of driving another model round (HK-05).
            this.#endTurn(base, machine, 'completed', 'hook-stop');
            terminalReason = 'hook-stop';
            break;
          }
          if (phase.stop && phase.kind === 'awaiting-approval') {
            // The turn does NOT end. It is suspended in `awaiting-approval`, and the durable log
            // holds the request. Another process — or this one, later — resumes this same turn.
            pendingApproval = phase.pending;
            break;
          }

          const health = budget.afterModelRound({ madeProgress: true });
          if (health.stop) {
            this.#endTurn(base, machine, 'budget-exhausted', health.reason);
            terminalReason = health.reason;
            break;
          }
        }

        // --- model phase ---------------------------------------------------------------------
        const budgetCheck = budget.beforeModelCall();
        if (budgetCheck.stop) {
          this.#endTurn(base, machine, 'budget-exhausted', budgetCheck.reason);
          terminalReason = budgetCheck.reason;
          break;
        }

        if (machine.state !== 'model-streaming') machine.transition('model-streaming');
        this.#persistState(base, machine);

        // Context management BEFORE the request goes out: cheap reduction (offload large tool
        // outputs, prune safe middle content) then, on real transcript growth past the proactive
        // threshold or a provider overflow, threshold compaction. The manager persists its own
        // boundary and compaction items; the engine simply adopts the leaner conversation, so a
        // reduction taken this round is not undone next round. Absent -> the full conversation goes.
        if (this.#deps.context) {
          const prep = await this.#deps.context.prepare({
            conversation,
            instructions: ctx.instructions,
            threadId: base.threadId,
            turnId: base.turnId,
            correlationId: base.correlationId,
            permissionProfile: base.permissionProfile,
            signal,
          });
          if (signal.aborted) {
            this.#cancel(base, machine);
            terminalReason = 'user-cancelled';
            break;
          }
          conversation.length = 0;
          conversation.push(...prep.items);

          // Compaction just ran (threshold or overflow) — fire PostCompact so a hook can observe that
          // the transcript was summarized (HK-01). Observe-only; the leaner conversation is already
          // adopted above.
          if (prep.compacted && this.#deps.hooks?.fireLifecycle) {
            await this.#deps.hooks.fireLifecycle('PostCompact', {
              ...(prep.trigger ? { trigger: prep.trigger } : {}),
            });
          }
        }

        sink.append({
          ...base,
          payload: {
            type: 'model-request-started',
            model: ctx.model,
            transport: 'responses',
            requestDigest: `round:${rounds}`,
          },
        });

        const round = await this.#streamWithRetry(
          provider,
          {
            model: ctx.model,
            instructions: ctx.instructions,
            input: conversation,
            tools: ctx.tools,
            reasoningEffort: 'medium',
            signal,
          },
          base,
          signal,
        );
        rounds++;

        sink.append({
          ...base,
          payload: {
            type: 'model-request-completed',
            requestId: round.requestId,
            finishReason: round.finishReason ?? 'unknown',
          },
        });

        this.#persistRoundItems(base, round);
        if (round.assistantText) finalText = round.assistantText;

        // No tool calls -> the model is done talking. Natural completion.
        if (round.toolCalls.length === 0) {
          this.#endTurn(base, machine, 'completed', 'natural-completion');
          terminalReason = 'natural-completion';
          break;
        }

        // Feed the assistant's message back so the next round sees it.
        if (round.assistantText) {
          conversation.push({ type: 'message', role: 'assistant', text: round.assistantText });
        }
        // AND feed back the assistant's function-CALL items, so that when the tool phase appends the
        // matching function-OUTPUTs the model sees a complete call↔output pairing. Without this the
        // next round receives orphaned outputs (a `function_call_output` with no `function_call`);
        // because the DashScope transport deliberately omits `previous_response_id` (local history
        // is authoritative, PV-08), the model cannot tell its call was answered and re-issues the
        // identical call every round — the turn dies `repeated-identical-calls` / budget-exhausted.
        // This mirrors the canonical durable rebuild in `apps/cli/src/sessions.ts::reconstructHistory`,
        // which emits function-call THEN function-output; the hot loop must produce the same shape.
        for (const call of round.toolCalls) {
          conversation.push({
            type: 'function-call',
            callId: call.callId,
            name: call.toolName,
            argumentsJson: call.argumentsJson,
          });
        }
        calls = round.toolCalls;
      }
    } catch (e) {
      if (signal.aborted) {
        // A cancellation surfaces as a thrown abort from the provider stream or the sandbox. It is
        // a cancellation, not an internal error, and it still names a termination reason (RT-04).
        if (!machine.isTerminal) this.#cancel(base, machine);
        terminalReason = 'user-cancelled';
      } else {
        if (!machine.isTerminal) {
          machine.transition('recovering');
          machine.terminate('failed', 'internal-error');
        }
        terminalReason = 'internal-error';
        sink.append({
          ...base,
          payload: {
            type: 'model-request-failed',
            requestId: null,
            category: 'runtime.turn_error',
            retryable: false,
            message: e instanceof Error ? e.message : String(e),
          },
        });
        sink.append({
          ...base,
          payload: { type: 'turn-ended', state: 'failed', reason: 'internal-error' },
        });
      }
    }

    return {
      turnId: base.turnId,
      state: machine.state,
      terminationReason: terminalReason,
      rounds,
      finalText,
      pendingApproval,
    };
  }

  async #runToolCalls(
    base: PersistBase,
    machine: TurnMachine,
    calls: readonly NormalizedToolCall[],
    budget: BudgetTracker,
    signal: AbortSignal,
    conversation: ModelInputItem[],
  ): Promise<ToolPhase> {
    // TL-08: run the round's calls in resource-conflict batches. `planBatches` (owned by the tools
    // layer, which knows each tool's footprint) returns callId groups in ORIGINAL ORDER: a group of
    // more than one is independent read-only calls safe to run CONCURRENTLY; a mutating or conflicting
    // call is its own single-call group. An executor without `planBatches` yields one call per group —
    // fully serial, always safe. Groups always run in sequence, so any ordering the model relied on
    // between a mutation and a later read is preserved.
    const byId = new Map(calls.map((c) => [c.callId, c]));
    const groups: readonly (readonly string[])[] = this.#deps.tools.planBatches
      ? this.#deps.tools.planBatches(
          calls.map((c) => ({ callId: c.callId, toolName: c.toolName, arguments: c.arguments })),
        )
      : calls.map((c) => [c.callId]);

    for (const group of groups) {
      const groupCalls = group
        .map((id) => byId.get(id))
        .filter((c): c is NormalizedToolCall => c !== undefined);
      if (groupCalls.length === 1) {
        const phase = await this.#runOneCall(
          groupCalls[0]!,
          base,
          machine,
          budget,
          signal,
          conversation,
        );
        if (phase.stop) return phase;
      } else if (groupCalls.length > 1) {
        const phase = await this.#runParallelBatch(
          groupCalls,
          base,
          machine,
          budget,
          signal,
          conversation,
        );
        if (phase.stop) return phase;
      }
    }
    return { stop: false };
  }

  /**
   * Run ONE tool call through the full ordered flow: budget → PreToolUse hook → policy (deny/ask with
   * approval/allow) → persist intent → recovery guard → execute → persist result → PostToolUse hook →
   * durable tool-result → pair the function-output back to the model. This is the serial path used for
   * every single-call batch (every mutation) and by the fallback. Each early `return { stop: … }`
   * suspends the whole turn (budget/cancellation/awaiting-approval); a plain `return { stop: false }`
   * means THIS call is fully handled and the batch driver should continue to the next.
   */
  async #runOneCall(
    call: NormalizedToolCall,
    base: PersistBase,
    machine: TurnMachine,
    budget: BudgetTracker,
    signal: AbortSignal,
    conversation: ModelInputItem[],
  ): Promise<ToolPhase> {
    const { tools, sink } = this.#deps;
    {
      if (signal.aborted) return { stop: true, kind: 'cancelled' };

      const budgetCheck = budget.beforeToolCall();
      if (budgetCheck.stop) return { stop: true, kind: 'budget', reason: budgetCheck.reason };

      const repeat = budget.observeToolCall(call.toolName, call.argumentsJson);
      if (repeat.stop) return { stop: true, kind: 'budget', reason: repeat.reason };

      // PreToolUse hooks (HK owns the event; the tool domain fires it here). A block prevents the
      // tool from running AND from recording a side-effect intent — nothing happened, so nothing is
      // persisted as intent. A hook can only block, never elevate (enforced inside the hook engine).
      if (this.#deps.hooks) {
        const gate = await this.#deps.hooks.preToolUse({
          toolName: call.toolName,
          arguments: call.arguments,
        });
        sink.append({
          ...base,
          payload: {
            type: 'hook-fired',
            event: 'PreToolUse',
            handler: call.toolName,
            outcome: gate.blocked ? 'block' : 'continue',
            durationMs: 0,
          },
        });
        if (gate.blocked) {
          conversation.push({
            type: 'function-output',
            callId: call.callId,
            name: call.toolName,
            output: `(blocked by a PreToolUse hook${gate.reason ? `: ${gate.reason}` : ''})`,
          });
          return { stop: false };
        }
      }

      // --- policy, BEFORE any side effect ---------------------------------------------------
      const verdict = await tools.evaluate({
        callId: call.callId,
        toolName: call.toolName,
        arguments: call.arguments,
      });
      sink.append({
        ...base,
        payload: {
          type: 'policy-decision',
          callId: call.callId,
          normalizedAction: verdict.description,
          decision: verdict.status,
          reason: verdict.reason,
          source: verdict.source,
        },
      });

      if (verdict.status === 'deny') {
        // Hard deny. The model is told, in band, so it can adapt rather than die.
        this.#recordToolDenial(base, call, `denied by policy: ${verdict.reason}`, 'policy-denied');
        await this.#deps.hooks?.fireLifecycle?.('PermissionDenied', {
          toolName: call.toolName,
          reason: verdict.reason,
        });
        conversation.push({
          type: 'function-output',
          callId: call.callId,
          name: call.toolName,
          output: `(denied by policy: ${verdict.reason})`,
        });
        return { stop: false };
      }

      if (verdict.status === 'ask') {
        const request: ApprovalRequest = {
          turnId: base.turnId,
          callId: call.callId,
          toolName: call.toolName,
          arguments: call.arguments,
          argumentsJson: call.argumentsJson,
          actionDigest: verdict.actionDigest,
          description: verdict.description,
          risk: verdict.risk,
          reason: verdict.reason,
        };

        // Persist the pause BEFORE asking anyone. If this process dies between here and the
        // answer, the log still says: this turn is awaiting approval for exactly this action.
        machine.transition('awaiting-approval');
        this.#persistState(base, machine);
        sink.append({
          ...base,
          payload: {
            type: 'approval-requested',
            callId: call.callId,
            normalizedAction: verdict.description,
            risk: verdict.risk,
          },
        });
        await this.#deps.hooks?.fireLifecycle?.('PermissionRequest', {
          toolName: call.toolName,
          risk: verdict.risk,
        });

        const decision = this.#deps.approvals
          ? await this.#deps.approvals.request(request, signal)
          : ({ kind: 'deferred', reason: 'no approval channel is attached' } as const);

        if (signal.aborted) return { stop: true, kind: 'cancelled' };

        if (decision.kind === 'deferred') {
          // Nothing is auto-approved, ever. Leave the request unresolved in the log and hand the
          // pending approval back to the caller.
          return { stop: true, kind: 'awaiting-approval', pending: request };
        }

        sink.append({
          ...base,
          payload: {
            type: 'approval-resolved',
            callId: call.callId,
            granted: decision.kind === 'approved',
            scope: decision.kind === 'approved' ? decision.scope : null,
          },
        });

        // Either way the SAME turn resumes into `executing`. An approval is not a new turn.
        machine.transition('executing');
        this.#persistState(base, machine);

        if (decision.kind === 'denied') {
          this.#recordToolDenial(
            base,
            call,
            `denied by the user: ${decision.reason}`,
            'user-denied',
          );
          conversation.push({
            type: 'function-output',
            callId: call.callId,
            name: call.toolName,
            output: `(the user denied this action: ${decision.reason}. Do not retry it; adapt or ask.)`,
          });
          return { stop: false };
        }
      }

      const intent = tools.intentFor({ toolName: call.toolName, arguments: call.arguments });

      // Persist INTENT before executing. If we crash after this, recovery sees an in-flight action.
      const sideEffectId = this.#deps.ids.next('sfx');
      sink.append({
        ...base,
        payload: {
          type: 'side-effect-intent',
          intent: {
            sideEffectId: sideEffectId as never,
            idempotencyKey: intent.idempotencyKey,
            kind: intent.kind,
            destructive: intent.destructive,
            normalizedAction: intent.normalizedAction,
          },
        },
      });

      // Recovery guard: never re-run a known-complete side effect (SS-05).
      const may = sink.mayExecute(intent.idempotencyKey);
      if (!may.allowed) {
        sink.append({
          ...base,
          payload: {
            type: 'side-effect-settled',
            sideEffectId: sideEffectId as never,
            state: 'known-complete',
            resultDigest: null,
          },
        });
        conversation.push({
          type: 'function-output',
          callId: call.callId,
          name: call.toolName,
          output: `(skipped: ${may.reason})`,
        });
        return { stop: false };
      }

      sink.append({
        ...base,
        payload: { type: 'side-effect-started', sideEffectId: sideEffectId as never },
      });

      const result = await tools.execute({
        callId: call.callId,
        toolName: call.toolName,
        arguments: call.arguments,
        argumentsJson: call.argumentsJson,
        signal,
      });

      // Persist RESULT before continuing.
      sink.append({
        ...base,
        payload: {
          type: 'side-effect-settled',
          sideEffectId: sideEffectId as never,
          state: result.ok ? 'known-complete' : 'known-failed',
          resultDigest: result.resultDigest,
        },
      });

      // PostToolUse fires after the result is durable, so a post hook can never corrupt the
      // completed tool result — it only observes it and may influence the NEXT step (HK-05).
      let hookStop = false;
      if (this.#deps.hooks) {
        const post = await this.#deps.hooks.postToolUse({ toolName: call.toolName, ok: result.ok });
        hookStop = post?.stopContinuation === true;
        sink.append({
          ...base,
          payload: {
            type: 'hook-fired',
            event: result.ok ? 'PostToolUse' : 'PostToolUseFailure',
            handler: call.toolName,
            outcome: hookStop ? 'stop' : 'continue',
            durationMs: 0,
          },
        });
      }

      const itemId = this.#deps.ids.next('itm') as ItemId;
      sink.append({
        ...base,
        itemId,
        payload: {
          type: 'item-appended',
          item: {
            type: 'tool-result',
            id: itemId,
            turnId: base.turnId,
            threadId: base.threadId,
            seq: 0,
            createdAt: this.#deps.clock.now(),
            callId: call.callId,
            toolName: call.toolName,
            ok: result.ok,
            preview: result.modelText,
            outputRef: result.outputRef,
            truncated: result.truncated,
            durationMs: result.durationMs,
            errorCategory: result.errorCategory,
          },
        },
      });

      // Pair the output back to the model by exact call ID (PV-06).
      conversation.push({
        type: 'function-output',
        callId: call.callId,
        name: call.toolName,
        output: result.modelText,
      });

      if (signal.aborted) return { stop: true, kind: 'cancelled' };
      // The result is durable and paired to the model above; a PostToolUse `stop` now ends the turn
      // rather than driving another model round (HK-05).
      if (hookStop) return { stop: true, kind: 'hook-stop' };
    }

    return { stop: false };
  }

  /**
   * Run a PARALLEL batch — independent read-only calls the scheduler proved safe to run at once
   * (TL-08). Only the tool EXECUTIONS overlap; every durable append stays in call order (phase 1
   * records intent for each call in order, phase 3 records each settled result in order), so the
   * event log is deterministic no matter which execution finishes first and call↔result pairing stays
   * exact.
   *
   * The concurrency fast-path is taken ONLY when every call is a plain policy `allow`. A read a rule
   * still gates with `ask`, or that policy denies, cannot run in a fire-and-forget batch, so the whole
   * group falls back to the serial `#runOneCall` path. `evaluate` has no side effect, so the pre-scan
   * is free; reads are almost always `allow`, so the fast-path is the common case.
   */
  async #runParallelBatch(
    calls: readonly NormalizedToolCall[],
    base: PersistBase,
    machine: TurnMachine,
    budget: BudgetTracker,
    signal: AbortSignal,
    conversation: ModelInputItem[],
  ): Promise<ToolPhase> {
    const { tools, sink } = this.#deps;
    void machine;

    // Pre-scan (no side effect): only fast-path a batch that is entirely plain `allow`.
    const verdicts = await Promise.all(
      calls.map((c) =>
        tools.evaluate({ callId: c.callId, toolName: c.toolName, arguments: c.arguments }),
      ),
    );
    if (!verdicts.every((v) => v.status === 'allow')) {
      for (const call of calls) {
        const phase = await this.#runOneCall(call, base, machine, budget, signal, conversation);
        if (phase.stop) return phase;
      }
      return { stop: false };
    }

    // PHASE 1 — in call order: budget, PreToolUse hook, policy-decision, intent, recovery guard, start.
    const cleared: { call: NormalizedToolCall; sideEffectId: string }[] = [];
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i]!;
      if (signal.aborted) return { stop: true, kind: 'cancelled' };

      const budgetCheck = budget.beforeToolCall();
      if (budgetCheck.stop) return { stop: true, kind: 'budget', reason: budgetCheck.reason };
      const repeat = budget.observeToolCall(call.toolName, call.argumentsJson);
      if (repeat.stop) return { stop: true, kind: 'budget', reason: repeat.reason };

      if (this.#deps.hooks) {
        const gate = await this.#deps.hooks.preToolUse({
          toolName: call.toolName,
          arguments: call.arguments,
        });
        sink.append({
          ...base,
          payload: {
            type: 'hook-fired',
            event: 'PreToolUse',
            handler: call.toolName,
            outcome: gate.blocked ? 'block' : 'continue',
            durationMs: 0,
          },
        });
        if (gate.blocked) {
          conversation.push({
            type: 'function-output',
            callId: call.callId,
            name: call.toolName,
            output: `(blocked by a PreToolUse hook${gate.reason ? `: ${gate.reason}` : ''})`,
          });
          continue;
        }
      }

      const verdict = verdicts[i]!;
      sink.append({
        ...base,
        payload: {
          type: 'policy-decision',
          callId: call.callId,
          normalizedAction: verdict.description,
          decision: verdict.status,
          reason: verdict.reason,
          source: verdict.source,
        },
      });

      const intent = tools.intentFor({ toolName: call.toolName, arguments: call.arguments });
      const sideEffectId = this.#deps.ids.next('sfx');
      sink.append({
        ...base,
        payload: {
          type: 'side-effect-intent',
          intent: {
            sideEffectId: sideEffectId as never,
            idempotencyKey: intent.idempotencyKey,
            kind: intent.kind,
            destructive: intent.destructive,
            normalizedAction: intent.normalizedAction,
          },
        },
      });

      const may = sink.mayExecute(intent.idempotencyKey);
      if (!may.allowed) {
        sink.append({
          ...base,
          payload: {
            type: 'side-effect-settled',
            sideEffectId: sideEffectId as never,
            state: 'known-complete',
            resultDigest: null,
          },
        });
        conversation.push({
          type: 'function-output',
          callId: call.callId,
          name: call.toolName,
          output: `(skipped: ${may.reason})`,
        });
        continue;
      }

      sink.append({
        ...base,
        payload: { type: 'side-effect-started', sideEffectId: sideEffectId as never },
      });
      cleared.push({ call, sideEffectId });
    }

    // PHASE 2 — concurrent: the actual tool I/O overlaps. This is the point of a parallel batch.
    const results = await Promise.all(
      cleared.map((x) =>
        tools.execute({
          callId: x.call.callId,
          toolName: x.call.toolName,
          arguments: x.call.arguments,
          argumentsJson: x.call.argumentsJson,
          signal,
        }),
      ),
    );

    // PHASE 3 — in call order: settle, PostToolUse, durable tool-result, pair the output to the model.
    let hookStop = false;
    for (let i = 0; i < cleared.length; i++) {
      const { call, sideEffectId } = cleared[i]!;
      const result = results[i]!;
      sink.append({
        ...base,
        payload: {
          type: 'side-effect-settled',
          sideEffectId: sideEffectId as never,
          state: result.ok ? 'known-complete' : 'known-failed',
          resultDigest: result.resultDigest,
        },
      });
      if (this.#deps.hooks) {
        const post = await this.#deps.hooks.postToolUse({ toolName: call.toolName, ok: result.ok });
        if (post?.stopContinuation === true) hookStop = true;
        sink.append({
          ...base,
          payload: {
            type: 'hook-fired',
            event: result.ok ? 'PostToolUse' : 'PostToolUseFailure',
            handler: call.toolName,
            outcome: post?.stopContinuation === true ? 'stop' : 'continue',
            durationMs: 0,
          },
        });
      }
      const itemId = this.#deps.ids.next('itm') as ItemId;
      sink.append({
        ...base,
        itemId,
        payload: {
          type: 'item-appended',
          item: {
            type: 'tool-result',
            id: itemId,
            turnId: base.turnId,
            threadId: base.threadId,
            seq: 0,
            createdAt: this.#deps.clock.now(),
            callId: call.callId,
            toolName: call.toolName,
            ok: result.ok,
            preview: result.modelText,
            outputRef: result.outputRef,
            truncated: result.truncated,
            durationMs: result.durationMs,
            errorCategory: result.errorCategory,
          },
        },
      });
      conversation.push({
        type: 'function-output',
        callId: call.callId,
        name: call.toolName,
        output: result.modelText,
      });
    }

    if (signal.aborted) return { stop: true, kind: 'cancelled' };
    // Every tool in the batch ran and every result is durable; if any PostToolUse hook asked to stop,
    // the turn ends after this batch rather than continuing to another model round (HK-05).
    if (hookStop) return { stop: true, kind: 'hook-stop' };
    return { stop: false };
  }

  /**
   * A refused call is still a RESULT. It gets a durable `tool-result` item paired to its call ID,
   * so the conversation stays well-formed (every call has exactly one output) and a later resume
   * reconstructs it faithfully.
   */
  #recordToolDenial(
    base: PersistBase,
    call: NormalizedToolCall,
    message: string,
    category: 'policy-denied' | 'user-denied',
  ): void {
    const itemId = this.#deps.ids.next('itm') as ItemId;
    this.#deps.sink.append({
      ...base,
      itemId,
      payload: {
        type: 'item-appended',
        item: {
          type: 'tool-result',
          id: itemId,
          turnId: base.turnId,
          threadId: base.threadId,
          seq: 0,
          createdAt: this.#deps.clock.now(),
          callId: call.callId,
          toolName: call.toolName,
          ok: false,
          preview: message,
          outputRef: null,
          truncated: false,
          durationMs: 0,
          errorCategory: category,
        },
      },
    });
  }

  /**
   * The provider call, wrapped in a BOUNDED transient-fault retry (PV-11 / RT-04).
   *
   * The retry policy was implemented and tested in `provider-core` but was never invoked in the
   * turn loop — a retryable 503 or dropped connection failed the whole turn. That is the gap golden
   * path 9 ("survives a retryable fault") requires closing.
   *
   * Only a thrown `HarnessError` is considered, and `decideRetry` — not this code — owns the rules:
   * it refuses a non-retryable class, a quota/auth fault, a fault after visible output was already
   * streamed (a retry must never concatenate onto text the user saw), an uncertain side effect, and
   * both the attempt and the elapsed-time budgets. So retries are always bounded; there is no path
   * to an infinite loop. A cancellation is never a retry. Anything that is not a `HarnessError`, or
   * that `decideRetry` refuses, rethrows to the turn's normal failure handling.
   */
  async #streamWithRetry(
    provider: ModelProvider,
    request: Parameters<ModelProvider['stream']>[0],
    base: PersistBase,
    signal: AbortSignal,
  ): Promise<NormalizedRound> {
    const { clock } = this.#deps;
    const rng: Rng = this.#deps.rng ?? (() => 0.5);
    const policy = this.#deps.retryPolicy ?? DEFAULT_RETRY_POLICY;
    // Bind so `this` is not lost when the method is detached from `clock` (a real ManualClock keeps
    // state in it); fall back to a real timer when no clock sleep is provided.
    const sleep = (ms: number): Promise<void> =>
      clock.sleep ? clock.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms));
    const startedAt = clock.now();

    for (let attempt = 1; ; attempt++) {
      try {
        return await normalizeRound(provider.stream(request));
      } catch (err) {
        if (signal.aborted) throw err;
        if (!(err instanceof HarnessError)) throw err;
        const decision = decideRetry(
          err,
          { attempt, elapsedMs: clock.now() - startedAt },
          rng,
          policy,
        );
        if (!decision.retry) throw err;
        // Observable but not a new (frozen) event type: reuse the request lifecycle marker so a
        // trace shows a fresh request was issued after backoff. `base` carries the correlation.
        void base;
        await sleep(decision.delayMs);
      }
    }
  }

  #persistRoundItems(base: PersistBase, round: NormalizedRound): void {
    const { ids, clock, sink } = this.#deps;

    if (round.reasoningSummary !== null) {
      const id = ids.next('itm') as ItemId;
      sink.append({
        ...base,
        itemId: id,
        payload: {
          type: 'item-appended',
          item: {
            type: 'reasoning-summary',
            id,
            turnId: base.turnId,
            threadId: base.threadId,
            seq: 0,
            createdAt: clock.now(),
            summary: round.reasoningSummary,
            complete: true,
          },
        },
      });
    } else if (round.reasoningOccurred) {
      const id = ids.next('itm') as ItemId;
      sink.append({
        ...base,
        itemId: id,
        payload: {
          type: 'item-appended',
          item: {
            type: 'reasoning-status',
            id,
            turnId: base.turnId,
            threadId: base.threadId,
            seq: 0,
            createdAt: clock.now(),
            reasoningOccurred: true,
            reasoningTokens: round.usage?.reasoningTokens ?? null,
          },
        },
      });
    }

    if (round.assistantText) {
      const id = ids.next('itm') as ItemId;
      sink.append({
        ...base,
        itemId: id,
        payload: {
          type: 'item-appended',
          item: {
            type: 'assistant-message',
            id,
            turnId: base.turnId,
            threadId: base.threadId,
            seq: 0,
            createdAt: clock.now(),
            text: round.assistantText,
            complete: true,
          },
        },
      });
    }

    for (const call of round.toolCalls) {
      const id = ids.next('itm') as ItemId;
      sink.append({
        ...base,
        itemId: id,
        payload: {
          type: 'item-appended',
          item: {
            type: 'tool-call',
            id,
            turnId: base.turnId,
            threadId: base.threadId,
            seq: 0,
            createdAt: clock.now(),
            callId: call.callId,
            toolName: call.toolName,
            argumentsJson: call.argumentsJson,
            arguments: call.arguments,
          },
        },
      });
    }

    if (round.usage) {
      const id = ids.next('itm') as ItemId;
      sink.append({
        ...base,
        itemId: id,
        payload: {
          type: 'item-appended',
          item: {
            type: 'usage',
            id,
            turnId: base.turnId,
            threadId: base.threadId,
            seq: 0,
            createdAt: clock.now(),
            inputTokens: round.usage.inputTokens,
            outputTokens: round.usage.outputTokens,
            totalTokens: round.usage.totalTokens,
            reasoningTokens: round.usage.reasoningTokens,
            cachedInputTokens: round.usage.cachedInputTokens,
          },
        },
      });
    }
  }

  #persistState(base: PersistBase, machine: TurnMachine): void {
    const history = machine.history;
    const from = history[history.length - 2];
    const to = machine.state;
    if (from !== undefined && from !== to) {
      this.#deps.sink.append({ ...base, payload: { type: 'turn-state-changed', from, to } });
    }
  }

  /** Cancellation is a first-class ending with a named reason, never a silent stop (RT-06). */
  #cancel(base: PersistBase, machine: TurnMachine): void {
    if (machine.isTerminal) return;
    // `cancelled` is reachable from every non-terminal state, so cancellation never has to route
    // through an intermediate state that a given turn might not legally be in.
    machine.terminate('cancelled', 'user-cancelled');
    this.#deps.sink.append({ ...base, payload: { type: 'cancelled', scope: 'turn' } });
    this.#deps.sink.append({
      ...base,
      payload: { type: 'turn-ended', state: 'cancelled', reason: 'user-cancelled' },
    });
  }

  #endTurn(
    base: PersistBase,
    machine: TurnMachine,
    state: 'completed' | 'failed' | 'cancelled' | 'blocked' | 'budget-exhausted',
    // A TerminationReason, not a free string: the compiler now REFUSES an untyped reason here, which
    // is exactly RT-04's guarantee that every turn ends with a typed, enumerable reason.
    reason: TerminationReason,
  ): void {
    if (!machine.isTerminal) machine.terminate(state, reason);
    this.#deps.sink.append({
      ...base,
      payload: { type: 'turn-ended', state, reason },
    });
  }
}

interface PersistBase {
  threadId: ThreadId;
  turnId: TurnId;
  correlationId: CorrelationId;
  permissionProfile: PermissionProfile;
  actor: Actor;
}
