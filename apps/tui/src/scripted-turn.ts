/**
 * A REAL turn, driven deterministically — golden path 8 (TUI).
 *
 * This wires an actual {@link TurnEngine} (the production agent loop: turn state machine, budgets,
 * stream normalization, the persist-before-execute ordering, and the approval pause/resume) to the
 * Ink app through the same {@link RuntimeSource} port the runtime uses. Only the EDGES are scripted:
 * a deterministic {@link ModelProvider} that streams a fixed round, and a {@link ToolExecutor} whose
 * `apply_patch` requires approval and returns a unified diff. That is exactly the RT-08 design
 * intent — inject fakes at the boundary, run the real loop — and it is how `evals/e2e` drives a
 * coding task without a live model.
 *
 * What is genuinely exercised here (not mocked): the engine loop across multiple model rounds; the
 * `ask` verdict pausing the turn into `awaiting-approval` and a decision resuming the SAME turn into
 * `executing`; real cancellation via an `AbortSignal` when the user interrupts; and every item the
 * loop persists projected through `tui-kit`'s view models behind the `SafeText` boundary. The model
 * text streams token-by-token into the live active row as the engine consumes the same deltas.
 *
 * It is `.ts` (not `.tsx`): it holds no JSX. The stateful bridge to `<App>` lives in `live.tsx`.
 */

import {
  ItemSchema,
  PermissionProfileSchema,
  sanitize,
  type Actor,
  type ActorId,
  type CorrelationId,
  type IdSource,
  type Item,
  type PermissionProfile,
  type ThreadId,
} from '@qwen-harness/protocol';
import type {
  FinishReason,
  ModelProvider,
  ModelRequest,
  NormalizedUsage,
  ProviderStreamEvent,
  ToolDefinition,
} from '@qwen-harness/provider-core';
import {
  TurnEngine,
  type ApprovalDecision as EngineApprovalDecision,
  type ApprovalGate,
  type ApprovalRequest,
  type EventSink,
  type ToolEvaluation,
  type ToolExecutionResult,
  type ToolExecutor,
} from '@qwen-harness/runtime';

import type { RuntimeSource } from './source.ts';
import { emitterSource } from './source.ts';
import type { ApprovalDecision, ApprovalPrompt, StatusModel } from './types.ts';

// ---------------------------------------------------------------------------------------------
// The scripted edges (deterministic provider + tools)
// ---------------------------------------------------------------------------------------------

/** One scripted model round: streamed assistant text, optional tool calls, usage, finish reason. */
interface RoundScript {
  readonly text: string;
  readonly toolCalls: readonly {
    readonly callId: string;
    readonly toolName: string;
    readonly argumentsJson: string;
    readonly arguments: Readonly<Record<string, unknown>>;
  }[];
  readonly usage: NormalizedUsage | null;
  readonly finish: FinishReason;
  /** When true, the stream never completes on its own; it blocks until the turn is aborted. */
  readonly block?: boolean;
}

/** A change to the streamed active row: the accumulated assistant text so far, complete or not. */
type StreamSink = (streamId: string, text: string, complete: boolean) => void;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const CAPABILITIES = Object.freeze({
  textStreaming: true,
  reasoningSummary: false,
  reasoningEffortGranularity: 'graded',
  incrementalToolArgs: false,
  background: false,
  structuredOutput: false,
  toolStream: false,
} as const);

/**
 * A provider that replays fixed rounds. Each `stream()` call returns the next round. Its text is
 * emitted as real deltas over time — the engine folds them via the normalizer, and `onStream`
 * mirrors the SAME growing text into the UI's live row, so the on-screen streaming is the model
 * stream, not a re-enactment. An abort rejects with the signal's reason, per the provider contract.
 */
function scriptedProvider(rounds: readonly RoundScript[], onStream: StreamSink): ModelProvider {
  let roundIndex = 0;
  return {
    capabilities: CAPABILITIES,
    stream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      const round = rounds[Math.min(roundIndex, rounds.length - 1)];
      if (round === undefined) throw new Error('scripted provider: no round to stream');
      const streamId = `itm_stream${roundIndex + 1}x`;
      roundIndex += 1;
      return (async function* stream(): AsyncGenerator<ProviderStreamEvent> {
        const signal = request.signal;
        const abortError = (): Error =>
          signal?.reason instanceof Error ? signal.reason : new Error('aborted');
        const throwIfAborted = (): void => {
          if (signal?.aborted) throw abortError();
        };
        yield { type: 'request-id', requestId: `req_${roundIndex}` };

        // Stream the assistant text word by word. Each delta both feeds the engine's normalizer
        // (yield) and updates the UI's live row (onStream) — one stream, two consumers.
        let accumulated = '';
        for (const word of round.text.match(/\S+\s*/gu) ?? []) {
          throwIfAborted();
          accumulated += word;
          onStream(streamId, accumulated, false);
          yield { type: 'text-delta', itemId: streamId, delta: word };
          await sleep(15);
        }

        if (round.block === true) {
          // Long work: never completes on its own. The user's interrupt aborts the signal, which
          // rejects here — the engine then cancels the turn (a real cancellation, not a timeout).
          await new Promise<never>((_, reject) => {
            if (signal?.aborted) {
              reject(abortError());
              return;
            }
            signal?.addEventListener('abort', () => reject(abortError()), { once: true });
          });
        }

        onStream(streamId, round.text, true);
        yield { type: 'text-done', itemId: streamId, text: round.text };

        for (const call of round.toolCalls) {
          yield {
            type: 'tool-call-complete',
            itemId: `${streamId}c`,
            callId: call.callId,
            toolName: call.toolName,
            argumentsJson: call.argumentsJson,
            arguments: call.arguments,
          };
        }
        if (round.usage !== null) yield { type: 'usage', usage: round.usage };
        yield { type: 'done', finishReason: round.finish };
      })();
    },
  };
}

/**
 * A scripted tool executor. `apply_patch` is `ask` (so the approval dialog is real), destructive,
 * and returns a unified diff as its result — which `tui-kit` renders as a coloured diff row. Every
 * other tool allows and echoes. No host I/O happens: this stands in for the sandbox pipeline.
 */
function scriptedTools(diff: string): ToolExecutor {
  return {
    evaluate(call): Promise<ToolEvaluation> {
      const ask = call.toolName === 'apply_patch';
      return Promise.resolve({
        status: ask ? 'ask' : 'allow',
        actionDigest: `dig_${call.toolName}`,
        description: `${call.toolName} greeting.ts`,
        risk: ask ? 'medium' : 'low',
        reason: ask ? 'writes a file in the workspace' : 'read-only',
        source: 'scripted-policy',
      });
    },
    execute(call): Promise<ToolExecutionResult> {
      const isPatch = call.toolName === 'apply_patch';
      return Promise.resolve({
        ok: true,
        modelText: isPatch ? diff : `${call.toolName} ok`,
        userText: isPatch ? diff : `${call.toolName} ok`,
        errorCategory: null,
        resultDigest: `res_${call.callId}`,
        outputRef: null,
        truncated: false,
        durationMs: 7,
      });
    },
    intentFor(call) {
      return {
        idempotencyKey: `idem_${call.toolName}_${Date.now()}`,
        destructive: call.toolName === 'apply_patch',
        kind: call.toolName === 'apply_patch' ? 'patch' : 'other',
        normalizedAction: `${call.toolName} greeting.ts`,
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Deterministic host stand-ins (ids, clock, event sink)
// ---------------------------------------------------------------------------------------------

function counterIds(): IdSource {
  let n = 0;
  return {
    next(prefix: string): string {
      n += 1;
      return `${prefix}_${String(n).padStart(6, '0')}`;
    },
  };
}

function counterClock(): { now(): number } {
  let t = 1_700_000_000_000;
  return {
    now(): number {
      t += 1;
      return t;
    },
  };
}

/**
 * The engine's durable log, in memory. It projects each appended `item` two ways: it keeps the
 * authoritative durable list (what a resume re-reads), and it forwards the item to the live UI
 * source — EXCEPT `assistant-message`, which the UI already shows via the streamed live row, so
 * forwarding it too would double it. Every item crosses `ItemSchema.parse` first: zod at the
 * boundary, exactly as the standalone binary validates its demo transcript.
 */
interface DurableSink extends EventSink {
  readonly durable: readonly Item[];
}

function durableSink(source: ReturnType<typeof emitterSource>): DurableSink {
  let seq = 0;
  const durable: Item[] = [];
  return {
    get durable(): readonly Item[] {
      return durable;
    },
    append(input): { seq: number } {
      seq += 1;
      if (input.payload.type === 'item-appended') {
        const item = ItemSchema.parse(input.payload.item);
        durable.push(item);
        if (item.type !== 'assistant-message') source.push(item);
      }
      return { seq };
    },
    mayExecute(): { allowed: boolean; reason: string } {
      return { allowed: true, reason: 'first run' };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The controller the Ink app binds to
// ---------------------------------------------------------------------------------------------

/**
 * Advance the approval mode one step around the fixed cycle plan→ask→auto-accept-edits→yolo→plan.
 *
 * The order is `PermissionProfileSchema.options` — the single source of truth for the four canonical
 * profiles — so this can never drift from the enum. This is a REQUEST: a caller with a real managed
 * ceiling (see {@link LiveController.cycleMode}) re-derives authority from the returned profile, which
 * the ceiling then clamps. Callers with no real authority (the scripted controller) just display it.
 */
export function nextProfile(current: PermissionProfile): PermissionProfile {
  const cycle = PermissionProfileSchema.options;
  const index = cycle.indexOf(current);
  return cycle[(index + 1) % cycle.length] ?? current;
}

/** What `live.tsx` renders. `status` and `approval` are React state; `source` drives the transcript. */
export interface LiveView {
  readonly status: StatusModel;
  readonly approval: ApprovalPrompt | null;
}

/** The imperative surface the Ink app calls. A turn is a real `TurnEngine.run`. */
export interface LiveController {
  readonly source: RuntimeSource;
  getView(): LiveView;
  subscribeView(listener: () => void): () => void;
  /** Submit user text — starts the next scripted turn as a genuine engine run. */
  submit(text: string): void;
  /**
   * Run a `!<command>` DIRECT USER SHELL ACTION (UI-04): the real sandboxed pipeline with the user as
   * actor, NO model turn. Optional — only the live controller drives a real runtime; the scripted
   * demo omits it. The result is a durable, redacted `user-shell` item mirrored into the transcript.
   */
  runShell?(command: string): void;
  /**
   * Cycle the approval mode one step (plan→ask→auto-accept-edits→yolo→plan), effective on the NEXT
   * turn. The live controller re-derives authority through `loadRunAuthority` and rebuilds the real
   * runtime, so the ceiling clamps the result and the status line shows the CLAMPED profile.
   */
  cycleMode(): void;
  /** Interrupt in-flight work: aborts the current turn's signal (cancellation, not a kill). */
  interrupt(): void;
  /** Answer the pending approval dialog. Resolves the engine's awaited `ApprovalGate.request`. */
  decide(decision: ApprovalDecision): void;
  /** Emit the durable transcript so a fresh process can resume and re-render it. Idempotent. */
  dumpDurable(write: (line: string) => void): void;
}

const ACTOR: Actor = { kind: 'model', id: 'act_model1' as ActorId };
const THREAD_ID = 'thr_live01' as ThreadId;
const CORRELATION_ID = 'cor_live01' as CorrelationId;
const MODEL = 'qwen3.7-max';
const INSTRUCTIONS = 'You are a coding assistant.';

const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'apply_patch',
    description: 'Apply a unified diff to a file in the workspace.',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
  },
];

const DIFF = [
  'diff --git a/greeting.ts b/greeting.ts',
  '--- a/greeting.ts',
  '+++ b/greeting.ts',
  '@@ -1,2 +1,2 @@',
  ' export function greet() {',
  '-  return "hi";',
  '+  return "hello, world";',
  '}',
].join('\n');

/** The two scripted turns: (1) fix-with-approval, (2) a long run that gets interrupted. */
function scriptFor(turn: number): readonly RoundScript[] {
  if (turn <= 1) {
    return [
      {
        text: 'I will inspect the greeting and apply a fix.',
        toolCalls: [
          {
            callId: 'call_patch1',
            toolName: 'apply_patch',
            argumentsJson: '{"path":"greeting.ts"}',
            arguments: { path: 'greeting.ts' },
          },
        ],
        usage: {
          inputTokens: 320,
          outputTokens: 40,
          totalTokens: 360,
          reasoningTokens: 8,
          cachedInputTokens: 64,
        },
        finish: 'tool-calls',
      },
      {
        text: 'All tests pass. greet() now returns the fuller message.',
        toolCalls: [],
        usage: {
          inputTokens: 400,
          outputTokens: 24,
          totalTokens: 424,
          reasoningTokens: 4,
          cachedInputTokens: 128,
        },
        finish: 'stop',
      },
    ];
  }
  return [
    {
      text: 'Running the full test suite, this may take a while...',
      toolCalls: [],
      usage: null,
      finish: 'stop',
      block: true,
    },
  ];
}

/**
 * Build the controller. It owns the emitter source, the view state, one shared id source / clock /
 * durable sink across turns, and — per turn — a fresh `TurnEngine` over a scripted provider for that
 * turn's rounds. The approval gate and the abort signal are the live bridges to the UI.
 */
export function createScriptedTurn(mode: StatusModel['mode']): LiveController {
  const source = emitterSource();
  const sink = durableSink(source);
  const ids = counterIds();
  const clock = counterClock();
  const tools = scriptedTools(DIFF);

  // The scripted controller has no real authority to clamp, so the mode is purely cosmetic here —
  // cycling just advances the displayed profile so the status line re-renders (UI-06).
  let currentMode = mode;
  const baseStatus = (activity: StatusModel['activity']): StatusModel => ({
    cwd: sanitize(process.cwd(), { origin: 'user', multiline: false, maxLength: 80 }).text,
    model: sanitize(MODEL, { origin: 'user', multiline: false }).text,
    mode: currentMode,
    activity,
    contextTokens: null,
  });

  let view: LiveView = { status: baseStatus('idle'), approval: null };
  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const listener of listeners) listener();
  };
  const setView = (next: LiveView): void => {
    view = next;
    emit();
  };

  let turnCounter = 0;
  let userSeq = 0;
  let abort: AbortController | null = null;
  let resolveApproval: ((decision: EngineApprovalDecision) => void) | null = null;
  let running = false;

  const approvalGate: ApprovalGate = {
    request(request: ApprovalRequest): Promise<EngineApprovalDecision> {
      const prompt: ApprovalPrompt = {
        actor: sanitize('model', { origin: 'user', multiline: false }).text,
        action: sanitize(request.description, { origin: 'tool', multiline: false, maxLength: 200 })
          .text,
        risk: request.risk,
        isolation: sanitize('workspace-write', { origin: 'user', multiline: false }).text,
      };
      setView({ status: view.status, approval: prompt });
      return new Promise<EngineApprovalDecision>((resolve) => {
        resolveApproval = resolve;
      });
    },
  };

  const pushUser = (text: string): void => {
    userSeq += 1;
    const item = ItemSchema.parse({
      id: `itm_user${String(userSeq).padStart(4, '0')}`,
      turnId: THREAD_ID.replace('thr', 'trn'),
      threadId: THREAD_ID,
      seq: userSeq,
      createdAt: clock.now(),
      type: 'user-message',
      text,
    });
    // The engine records the user text on `turn-started`, not as an item; the UI owns the row.
    source.push(item);
    (sink.durable as Item[]).push(item);
  };

  const submit = (text: string): void => {
    if (running) return;
    running = true;
    turnCounter += 1;
    pushUser(text);
    setView({ status: baseStatus('busy'), approval: null });

    const controller = new AbortController();
    abort = controller;
    const provider = scriptedProvider(scriptFor(turnCounter), (streamId, streamText, complete) => {
      const item = ItemSchema.parse({
        id: streamId,
        turnId: THREAD_ID.replace('thr', 'trn'),
        threadId: THREAD_ID,
        seq: 0,
        createdAt: clock.now(),
        type: 'assistant-message',
        text: streamText,
        complete,
      });
      source.push(item);
    });

    const engine = new TurnEngine({ provider, tools, sink, ids, clock, approvals: approvalGate });
    void engine
      .run({
        threadId: THREAD_ID,
        correlationId: CORRELATION_ID,
        permissionProfile: currentMode,
        model: MODEL,
        instructions: INSTRUCTIONS,
        history: [],
        userText: text,
        tools: TOOLS,
        actor: ACTOR,
        signal: controller.signal,
      })
      .catch(() => undefined)
      .finally(() => {
        running = false;
        abort = null;
        resolveApproval = null;
        setView({ status: baseStatus('idle'), approval: null });
      });
  };

  return {
    source,
    getView: () => view,
    subscribeView(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    submit,
    cycleMode() {
      currentMode = nextProfile(currentMode);
      setView({ status: baseStatus(view.status.activity), approval: view.approval });
    },
    interrupt() {
      abort?.abort(new Error('user-interrupt'));
    },
    decide(decision) {
      const resolve = resolveApproval;
      resolveApproval = null;
      setView({ status: view.status, approval: null });
      if (resolve === null) return;
      resolve(
        decision === 'deny'
          ? { kind: 'denied', reason: 'the user denied this action' }
          : { kind: 'approved', scope: decision },
      );
    },
    dumpDurable(write) {
      const payload = Buffer.from(JSON.stringify(sink.durable), 'utf8').toString('base64');
      write(`<<<QWEN_DURABLE>>>${payload}<<<END_QWEN_DURABLE>>>`);
    },
  };
}
