import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import type { TelemetryLevel } from '@qwen-harness/config';
import type { Clock, HarnessEvent } from '@qwen-harness/protocol';
import type { ModelProvider, ModelRequest, ProviderStreamEvent } from '@qwen-harness/provider-core';
import type {
  ApprovalDecision,
  ApprovalGate,
  ApprovalRequest,
  ToolEvaluation,
  ToolExecutionResult,
  ToolExecutor,
  TurnHooks,
} from '@qwen-harness/runtime';
import { createRedactor } from '@qwen-harness/storage';
import {
  FileTraceSink,
  NULL_SINK,
  Tracer,
  type TraceRecord,
  type TraceSink,
} from '@qwen-harness/telemetry';

/**
 * Telemetry composition (OB-01, OB-02).
 *
 * `@qwen-harness/telemetry` had zero call sites: the `telemetry.enabled` config key was read by
 * `doctor` and consumed by nothing, so the product advertised an observability control it did not
 * have. This file is the missing half — it builds the tracer from resolved config, decorates the
 * interfaces the turn actually flows through, and reads the result back for the `trace` command.
 *
 * Three properties are load-bearing, and every choice below serves one of them:
 *
 *   1. OPT-IN. Nothing is constructed and no file is opened unless a config source says
 *      `telemetry.enabled: true`. `openTelemetry` returns a disabled handle otherwise, and
 *      `createHarnessRuntime` receives no tracer, so the decorators below are never installed.
 *      "Opt-in" means the code path does not run, not that the output is discarded.
 *
 *   2. NO SECRET CAN REACH A TRACE. The tracer is constructed with a redactor built from the live
 *      credential value, and `Tracer.emit` redacts the message AND every field before the sink sees
 *      them. Redaction is therefore not a discipline each call site must remember — a caller that
 *      forgot would still be scrubbed. `test/security/telemetry-redaction.test.ts` drives a real
 *      turn with `CANARY_API_KEY` in the prompt, the tool output, and the model's reply, and asserts
 *      the canary appears nowhere in the resulting JSONL.
 *
 *   3. THE TRACE IS THE TURN, not a parallel story about it. Rather than sprinkling `tracer.info`
 *      calls through the engine (which would drift from what actually happened), the durable event
 *      stream IS the spine of the trace: every event the engine persists is mirrored by
 *      `traceEvent`. The decorators add only what the event log genuinely does not carry — model
 *      request parameters, token usage, and wall-clock timings.
 *
 * VERBOSITY (`telemetry.level`) changes how much is written, never whether it is safe. At `debug`
 * the trace additionally carries redacted CONTENT — model input items, tool arguments, tool output
 * previews. At `info` and above it carries the same events' shape: counts, names, digests, and
 * decisions. Both are redacted; `debug` is simply louder.
 */

/**
 * The decorators need only the current time. They take the narrow shape the composition root
 * already has (`{ now() }`) rather than the full `Clock`, so instrumenting a component never
 * requires inventing a `sleep` the tracer would not call.
 */
export type NowClock = { now(): number };

/** Trace files older than this are deleted when a trace is opened. Configured, not assumed. */
const MS_PER_DAY = 24 * 60 * 60 * 1_000;

const TRACE_PREFIX = 'trace-';
const TRACE_SUFFIX = '.jsonl';

export interface TelemetryHandle {
  /** Absent exactly when telemetry is disabled. The runtime is not instrumented without it. */
  readonly tracer: Tracer | null;
  readonly enabled: boolean;
  /** The JSONL file being written, or `null` when disabled or when a sink was injected. */
  readonly path: string | null;
  /** True at `level: debug` — the trace carries redacted content, not just shape. */
  readonly detailed: boolean;
  /** Trace files deleted by retention when this handle was opened. */
  readonly pruned: readonly string[];
}

export interface OpenTelemetryOptions {
  readonly enabled: boolean;
  readonly level: TelemetryLevel;
  readonly retentionDays: number;
  /** Directory the JSONL files live in — `<workspace>/.qwen-harness/trace`. */
  readonly dir: string;
  readonly clock: Clock;
  /**
   * Live secret VALUES to scrub. The CLI sources these from the provider's `EnvCredentialSource`,
   * which is the one boundary permitted to read the credential.
   */
  readonly secrets: readonly (string | undefined)[];
  /** Tests inject a `MemoryTraceSink`. Production leaves it undefined and a real file is opened. */
  readonly sink?: TraceSink;
}

/** The trace file for a given day. One file per UTC day is what makes retention a simple sweep. */
export function traceFileName(now: number): string {
  return `${TRACE_PREFIX}${new Date(now).toISOString().slice(0, 10)}${TRACE_SUFFIX}`;
}

/**
 * Delete trace files whose day is older than the retention window (OB-02). Retention is applied
 * when a trace is OPENED rather than on a timer: a CLI process is short-lived, and a sweep that
 * only runs while the harness happens to be alive is not a retention policy.
 *
 * A file we cannot parse a date out of is left alone. Deleting a file merely because its name is
 * unfamiliar is the kind of helpfulness that eats an operator's evidence.
 */
export function pruneTraces(dir: string, retentionDays: number, now: number): string[] {
  const cutoff = now - retentionDays * MS_PER_DAY;
  const pruned: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return pruned;
  }
  for (const entry of entries) {
    if (!entry.startsWith(TRACE_PREFIX) || !entry.endsWith(TRACE_SUFFIX)) continue;
    const day = entry.slice(TRACE_PREFIX.length, -TRACE_SUFFIX.length);
    const stamp = Date.parse(`${day}T00:00:00.000Z`);
    if (Number.isNaN(stamp)) continue;
    // The file covers the whole day, so it only expires once the END of that day is past the cutoff.
    if (stamp + MS_PER_DAY <= cutoff) {
      rmSync(join(dir, entry), { force: true });
      pruned.push(entry);
    }
  }
  return pruned;
}

/**
 * Build the tracer for this run. Returns a disabled handle when telemetry is off — no directory is
 * created, no file is opened, no redactor is built.
 */
export function openTelemetry(opts: OpenTelemetryOptions): TelemetryHandle {
  if (!opts.enabled) {
    return { tracer: null, enabled: false, path: null, detailed: false, pruned: [] };
  }

  const redactor = createRedactor([...opts.secrets]);

  let sink: TraceSink;
  let path: string | null = null;
  let pruned: string[] = [];

  if (opts.sink !== undefined) {
    sink = opts.sink;
  } else {
    mkdirSync(opts.dir, { recursive: true });
    pruned = pruneTraces(opts.dir, opts.retentionDays, opts.clock.now());
    path = join(opts.dir, traceFileName(opts.clock.now()));
    sink = new FileTraceSink(path);
  }

  const tracer = new Tracer({
    clock: opts.clock,
    sink,
    // Deep redaction of every value AND every key. The tracer applies this to the message and the
    // whole field object, so no call site below can leak by forgetting.
    redact: (value) => redactor.redactValue(value),
    minLevel: opts.level,
  });

  return { tracer, enabled: true, path, detailed: opts.level === 'debug', pruned };
}

/** A disabled handle, for callers that never enable telemetry (`sessions`, `fork`, `export`). */
export const TELEMETRY_OFF: TelemetryHandle = {
  tracer: null,
  enabled: false,
  path: null,
  detailed: false,
  pruned: [],
};

// -----------------------------------------------------------------------------------------------
// Reading a trace back (OB-02: "readable by humans and implementing agents through CLI/JSON")
// -----------------------------------------------------------------------------------------------

/**
 * Parse a trace file. A malformed line is REPORTED, not skipped silently: a trace with a hole in it
 * that nobody mentions is worse than no trace, because it is trusted.
 */
export function readTraceFile(path: string): { records: TraceRecord[]; malformed: number } {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { records: [], malformed: 0 };
  }
  const records: TraceRecord[] = [];
  let malformed = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      records.push(JSON.parse(line) as TraceRecord);
    } catch {
      malformed += 1;
    }
  }
  return { records, malformed };
}

/** Every trace file in the directory, oldest day first. */
export function listTraceFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((e) => e.startsWith(TRACE_PREFIX) && e.endsWith(TRACE_SUFFIX))
      .sort();
  } catch {
    return [];
  }
}

// -----------------------------------------------------------------------------------------------
// Instrumentation
// -----------------------------------------------------------------------------------------------

/** Stable, order-independent digest of a value. Lets the trace identify content it does not carry. */
function digest(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  // FNV-1a: a short, dependency-free content identity. It is an audit correlator, never a security
  // primitive — nothing below depends on it being hard to invert.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Mirror one durable event into the trace. This is what gives OB-01 its items, policy decisions,
 * approvals, hooks, side-effect intents, budget warnings, and cancellation: the engine already
 * persists all of them, so the trace reports what the log records rather than a second account that
 * could disagree with it.
 */
export function traceEvent(tracer: Tracer, event: HarnessEvent, detailed: boolean): void {
  const p = event.payload;
  const base = { seq: event.seq, turnId: event.turnId, actor: event.actor.kind };

  switch (p.type) {
    case 'turn-started':
      tracer.info('turn.started', 'turn started', {
        ...base,
        ...(detailed ? { userText: p.userText } : { userTextChars: p.userText.length }),
      });
      return;
    case 'turn-state-changed':
      tracer.info('turn.state', `${p.from} -> ${p.to}`, { ...base, from: p.from, to: p.to });
      return;
    case 'turn-ended':
      tracer.info('turn.ended', `turn ended: ${p.state}`, {
        ...base,
        state: p.state,
        reason: p.reason,
      });
      return;

    case 'item-appended':
    case 'item-updated':
      tracer.debug('item', `${p.type}: ${p.item.type}`, {
        ...base,
        itemType: p.item.type,
        ...(detailed ? { item: p.item } : { itemDigest: digest(p.item) }),
      });
      return;

    case 'model-request-started':
      tracer.info('model.request', `request to ${p.model}`, {
        ...base,
        model: p.model,
        transport: p.transport,
        requestDigest: p.requestDigest,
      });
      return;
    case 'model-request-completed':
      tracer.info('model.completed', `finished: ${p.finishReason}`, {
        ...base,
        requestId: p.requestId,
        finishReason: p.finishReason,
      });
      return;
    case 'model-request-failed':
      // `retryable` is the field a reader needs to understand a retry (or the absence of one).
      tracer.error('model.failed', `request failed: ${p.category}`, {
        ...base,
        requestId: p.requestId,
        category: p.category,
        retryable: p.retryable,
        message: p.message,
      });
      return;

    case 'side-effect-intent':
      tracer.info('side-effect.intent', `intent: ${p.intent.normalizedAction}`, {
        ...base,
        sideEffectId: p.intent.sideEffectId,
        kind: p.intent.kind,
        destructive: p.intent.destructive,
        idempotencyKey: p.intent.idempotencyKey,
      });
      return;
    case 'side-effect-started':
      tracer.info('side-effect.started', 'side effect started', {
        ...base,
        sideEffectId: p.sideEffectId,
      });
      return;
    case 'side-effect-settled':
      tracer.info('side-effect.settled', `settled: ${p.state}`, {
        ...base,
        sideEffectId: p.sideEffectId,
        state: p.state,
        resultDigest: p.resultDigest,
      });
      return;

    case 'policy-decision':
      tracer.info('policy.decision', `${p.decision}: ${p.normalizedAction}`, {
        ...base,
        callId: p.callId,
        decision: p.decision,
        reason: p.reason,
        source: p.source,
      });
      return;
    case 'approval-requested':
      tracer.info('approval.requested', `approval requested: ${p.normalizedAction}`, {
        ...base,
        callId: p.callId,
        risk: p.risk,
      });
      return;
    case 'approval-resolved':
      tracer.info('approval.resolved', p.granted ? 'approved' : 'denied', {
        ...base,
        callId: p.callId,
        granted: p.granted,
        scope: p.scope,
      });
      return;

    case 'hook-fired':
      tracer.info('hook.fired', `${p.event} -> ${p.outcome}`, {
        ...base,
        event: p.event,
        handler: p.handler,
        outcome: p.outcome,
        durationMs: p.durationMs,
      });
      return;

    case 'budget-warning':
      tracer.warn('budget.warning', `budget ${p.budget}: ${p.used}/${p.limit}`, {
        ...base,
        budget: p.budget,
        used: p.used,
        limit: p.limit,
      });
      return;
    case 'cancelled':
      tracer.warn('cancelled', `cancelled: ${p.scope}`, { ...base, scope: p.scope });
      return;

    default:
      tracer.debug('event', p.type, { ...base, type: p.type });
      return;
  }
}

/**
 * Trace the model request itself: its REDACTED parameters, and the usage the provider reports back.
 * Neither is in the durable log — `model-request-started` carries only a digest of the request, and
 * usage is never persisted at all — so this decorator is the only place OB-01's "model parameters"
 * and "usage" can come from.
 *
 * A cancellation is recorded here too, because an aborted stream is exactly the case where the turn
 * ends without the engine getting to write a completion event.
 */
export function tracedProvider(
  provider: ModelProvider,
  tracer: Tracer,
  clock: NowClock,
  detailed: boolean,
): ModelProvider {
  return {
    capabilities: provider.capabilities,
    async *stream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      const started = clock.now();
      tracer.info('provider.request', `stream ${request.model}`, {
        model: request.model,
        reasoningEffort: request.reasoningEffort ?? null,
        maxOutputTokens: request.maxOutputTokens ?? null,
        toolCount: request.tools.length,
        toolNames: request.tools.map((t) => t.name),
        itemCount: request.input.length,
        instructionsChars: request.instructions.length,
        // The prompt is what a cache key is computed over, so its identity belongs in the trace even
        // at `info`, where the text itself does not.
        instructionsDigest: digest(request.instructions),
        ...(detailed ? { instructions: request.instructions, items: request.input } : {}),
      });

      let usageSeen = false;
      try {
        for await (const event of provider.stream(request)) {
          if (event.type === 'usage') {
            usageSeen = true;
            tracer.info('provider.usage', 'token usage', {
              usage: event.usage,
              durationMs: clock.now() - started,
            });
          } else if (event.type === 'error') {
            tracer.error('provider.error', `stream error: ${event.error.category}`, {
              category: event.error.category,
              retryable: event.error.retryable,
              message: event.error.message,
              durationMs: clock.now() - started,
            });
          } else if (event.type === 'done') {
            tracer.info('provider.done', `stream done: ${event.finishReason}`, {
              finishReason: event.finishReason,
              usageReported: usageSeen,
              durationMs: clock.now() - started,
            });
          } else if (event.type === 'request-id') {
            tracer.debug('provider.request-id', 'provider request id', {
              requestId: event.requestId,
            });
          }
          yield event;
        }
      } catch (e) {
        // An abort surfaces here as a throw. Distinguish it from a genuine failure: the reader needs
        // to know whether the model broke or the user pressed Ctrl-C.
        const aborted = request.signal?.aborted === true;
        tracer.warn(aborted ? 'provider.cancelled' : 'provider.failed', 'stream ended early', {
          aborted,
          error: e instanceof Error ? e.message : String(e),
          durationMs: clock.now() - started,
        });
        throw e;
      }
    },
  };
}

/**
 * Trace tool evaluation and execution. The policy VERDICT is already mirrored from the durable
 * `policy-decision` event; what this adds is the wall-clock timing of the real sandboxed execution
 * and, at `debug`, the redacted arguments and a bounded output preview.
 */
export function tracedExecutor(
  executor: ToolExecutor,
  tracer: Tracer,
  clock: NowClock,
  detailed: boolean,
): ToolExecutor {
  return {
    intentFor: (call) => executor.intentFor(call),

    evaluate: async (call): Promise<ToolEvaluation> => {
      const evaluation = await executor.evaluate(call);
      tracer.debug('tool.evaluate', `${call.toolName}: ${evaluation.status}`, {
        callId: call.callId,
        toolName: call.toolName,
        status: evaluation.status,
        risk: evaluation.risk,
        source: evaluation.source,
        reason: evaluation.reason,
        ...(detailed ? { arguments: call.arguments } : { argumentsDigest: digest(call.arguments) }),
      });
      return evaluation;
    },

    execute: async (call): Promise<ToolExecutionResult> => {
      const started = clock.now();
      try {
        const result = await executor.execute(call);
        tracer.info('tool.execute', `${call.toolName}: ${result.ok ? 'ok' : 'failed'}`, {
          callId: call.callId,
          toolName: call.toolName,
          ok: result.ok,
          errorCategory: result.errorCategory,
          truncated: result.truncated,
          // The engine reports the pipeline's own measurement; we report the observed wall clock.
          // They differ when the worker queues, and that difference is worth being able to see.
          durationMs: result.durationMs,
          observedMs: clock.now() - started,
          ...(detailed
            ? { arguments: call.arguments, output: result.modelText.slice(0, 2_000) }
            : { outputChars: result.modelText.length, outputDigest: digest(result.modelText) }),
        });
        return result;
      } catch (e) {
        tracer.error('tool.execute', `${call.toolName}: threw`, {
          callId: call.callId,
          toolName: call.toolName,
          error: e instanceof Error ? e.message : String(e),
          observedMs: clock.now() - started,
        });
        throw e;
      }
    },
  };
}

/** Trace what the human was asked and what they answered. Both are also durable events. */
export function tracedApprovals(gate: ApprovalGate, tracer: Tracer, clock: NowClock): ApprovalGate {
  return {
    request: async (request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> => {
      const started = clock.now();
      const decision = await gate.request(request, signal);
      tracer.info('approval.decision', `${request.toolName}: ${decision.kind}`, {
        callId: request.callId,
        toolName: request.toolName,
        actionDigest: request.actionDigest,
        risk: request.risk,
        kind: decision.kind,
        scope: decision.kind === 'approved' ? decision.scope : null,
        waitedMs: clock.now() - started,
      });
      return decision;
    },
  };
}

/** Trace hook gating around a tool. The engine also persists `hook-fired` for each handler. */
export function tracedHooks(hooks: TurnHooks, tracer: Tracer, clock: NowClock): TurnHooks {
  return {
    preToolUse: async (call) => {
      const started = clock.now();
      const outcome = await hooks.preToolUse(call);
      tracer.info('hook.pre-tool-use', `${call.toolName}: ${outcome.blocked ? 'blocked' : 'ok'}`, {
        toolName: call.toolName,
        blocked: outcome.blocked,
        reason: outcome.reason,
        durationMs: clock.now() - started,
      });
      return outcome;
    },
    postToolUse: async (call) => {
      const started = clock.now();
      await hooks.postToolUse(call);
      tracer.info('hook.post-tool-use', `${call.toolName}: ${call.ok ? 'ok' : 'failed'}`, {
        toolName: call.toolName,
        ok: call.ok,
        durationMs: clock.now() - started,
      });
    },
  };
}

export { NULL_SINK };
export type { TraceRecord, TraceSink, Tracer };
