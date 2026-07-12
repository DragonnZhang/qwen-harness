import type {
  Actor,
  CorrelationId,
  EventPayload,
  IdSource,
  ItemId,
  PermissionProfile,
  ThreadId,
  TurnId,
} from '@qwen-harness/protocol';
import type { ModelProvider, ModelInputItem } from '@qwen-harness/provider-core';

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

/** Executes one already-validated tool call. Implemented in an app by the sandbox pipeline. */
export interface ToolExecutor {
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
}

export interface TurnEngineDeps {
  readonly provider: ModelProvider;
  readonly tools: ToolExecutor;
  readonly sink: EventSink;
  readonly ids: IdSource;
  readonly clock: { now(): number };
  readonly budget?: BudgetLimits;
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

export interface TurnResult {
  readonly turnId: TurnId;
  readonly state: TurnMachine['state'];
  readonly terminationReason: string | null;
  readonly rounds: number;
  readonly finalText: string;
}

export class TurnEngine {
  readonly #deps: TurnEngineDeps;

  constructor(deps: TurnEngineDeps) {
    this.#deps = deps;
  }

  /**
   * Runs one complete turn: model round → tool calls → model round → … until the model stops
   * calling tools or a budget/limit terminates it. Every transition is persisted before it is
   * acted on.
   */
  async run(input: RunTurnInput): Promise<TurnResult> {
    const { provider, tools, sink, ids, clock } = this.#deps;
    const signal = input.signal ?? new AbortController().signal;
    const machine = new TurnMachine();
    const budget = new BudgetTracker(this.#deps.budget ?? DEFAULT_BUDGET, () => clock.now());

    const turnId = ids.next('trn') as TurnId;
    const base = {
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

    let rounds = 0;
    let finalText = '';
    let terminalReason: string | null = null;

    try {
      for (;;) {
        if (signal.aborted) {
          machine.transition('recovering');
          machine.terminate('cancelled', 'user-cancelled');
          terminalReason = 'user-cancelled';
          break;
        }

        const budgetCheck = budget.beforeModelCall();
        if (budgetCheck.stop) {
          this.#endTurn(base, machine, 'budget-exhausted', budgetCheck.reason);
          terminalReason = budgetCheck.reason;
          break;
        }

        if (machine.state === 'preparing') machine.transition('model-streaming');
        else if (machine.state === 'executing') machine.transition('model-streaming');
        this.#persistState(base, machine);

        sink.append({
          ...base,
          payload: {
            type: 'model-request-started',
            model: input.model,
            transport: 'responses',
            requestDigest: `round:${rounds}`,
          },
        });

        const round = await normalizeRound(
          provider.stream({
            model: input.model,
            instructions: input.instructions,
            input: conversation,
            tools: input.tools,
            reasoningEffort: 'medium',
            signal,
          }),
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

        // Execute tool calls in order, persisting intent before and result after each (SS-05).
        machine.transition('executing');
        this.#persistState(base, machine);

        const progressed = await this.#runToolCalls(
          base,
          round.toolCalls,
          tools,
          sink,
          budget,
          signal,
          conversation,
        );
        if (progressed.stop) {
          this.#endTurn(base, machine, progressed.terminal, progressed.reason);
          terminalReason = progressed.reason;
          break;
        }

        const health = budget.afterModelRound({ madeProgress: true });
        if (health.stop) {
          this.#endTurn(base, machine, 'budget-exhausted', health.reason);
          terminalReason = health.reason;
          break;
        }
      }
    } catch (e) {
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
    }

    return {
      turnId,
      state: machine.state,
      terminationReason: terminalReason,
      rounds,
      finalText,
    };
  }

  async #runToolCalls(
    base: PersistBase,
    calls: readonly NormalizedToolCall[],
    tools: ToolExecutor,
    sink: EventSink,
    budget: BudgetTracker,
    signal: AbortSignal,
    conversation: ModelInputItem[],
  ): Promise<{ stop: false } | { stop: true; terminal: 'budget-exhausted'; reason: string }> {
    for (const call of calls) {
      const budgetCheck = budget.beforeToolCall();
      if (budgetCheck.stop)
        return { stop: true, terminal: 'budget-exhausted', reason: budgetCheck.reason };

      const repeat = budget.observeToolCall(call.toolName, call.argumentsJson);
      if (repeat.stop) return { stop: true, terminal: 'budget-exhausted', reason: repeat.reason };

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
        continue;
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
    }

    return { stop: false };
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

  #endTurn(
    base: PersistBase,
    machine: TurnMachine,
    state: 'completed' | 'failed' | 'cancelled' | 'blocked' | 'budget-exhausted',
    reason: string,
  ): void {
    if (!machine.isTerminal) machine.terminate(state, reason as never);
    this.#deps.sink.append({
      ...base,
      payload: { type: 'turn-ended', state, reason: reason as never },
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
