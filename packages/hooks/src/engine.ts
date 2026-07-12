/**
 * The hook engine: the fold and the security invariants (HK-04, HK-05).
 *
 * `run(event, input, context)` executes every matching hook in deterministic order and folds their
 * outcomes into one attributed result. The fold is where the non-bypassable invariants live:
 *
 *   NO ELEVATION (HK-04, threat-model invariant #1). The engine is HANDED the current policy
 *     decision and may only return one that is equally or MORE restrictive. A hook's `allow` /
 *     `passthrough` is recorded in `ignoredElevations` and has zero effect. There is no code path
 *     from a hook to a looser decision — allow-ness simply is not on the restrictiveness ladder the
 *     fold walks upward.
 *
 *   REVALIDATION (HK-04). A `modify` outcome becomes a `ModifiedInputProposal` flagged
 *     `needsRevalidation: true`. The engine never applies it; the caller must re-run schema + policy.
 *
 *   SANITIZED, ATTRIBUTED OUTPUT (HK-04). `context` text crosses protocol's `sanitize()` before it
 *     appears in the result, and every piece of output names the hook that produced it.
 *
 *   STOP RE-ENTRY PROTECTION (HK-05). While a Stop is being handled, a re-entrant `run('Stop')` is
 *     refused, and a Stop handler that itself returns `stop` is recorded as a refused re-entry
 *     rather than looping. Post-tool hooks may stop continuation without corrupting the durable
 *     tool result.
 *
 *   VISIBLE FAILURE (HK-05). Timeouts, non-zero exits, transport errors, and malformed output are
 *     surfaced and attributed. A failing hook never becomes a silent allow.
 */
import type { Clock } from '@qwen-harness/protocol';
import { sanitize, untrusted } from '@qwen-harness/protocol';
import type { DecisionOutcome } from '@qwen-harness/policy';

import type { HookEvent } from './events.ts';
import { isPostToolEvent } from './events.ts';
import type { CommandExecutor } from './executor.ts';
import { executeHttpHook } from './executor.ts';
import type { HookOutcome } from './outcome.ts';
import { parseHookOutcome } from './outcome.ts';
import type { AgentRunner, NetworkBroker, PromptRunner } from './ports.ts';
import type { HookInvocation, HookRegistration, HookRegistry } from './registry.ts';
import type {
  AttributedAnnotations,
  AttributedReason,
  FoldedHookResult,
  HookFailure,
  HookFailureKind,
  HookInvocationRecord,
  IgnoredElevation,
  InjectedContext,
  ModifiedInputProposal,
} from './result.ts';

/** The event payload passed to `run`. */
export interface HookInput {
  readonly toolName?: string;
  readonly toolInput?: Readonly<Record<string, unknown>>;
  readonly paths?: readonly string[];
  readonly data?: Readonly<Record<string, unknown>>;
}

/** Ambient context for a run: the decision to fold against, correlation, cancellation. */
export interface HookRunContext {
  /** The policy decision already reached. The fold may only make it MORE restrictive. */
  readonly currentDecision?: DecisionOutcome;
  readonly correlationId?: string;
  readonly signal?: AbortSignal;
}

export interface HookEngineDeps {
  readonly registry: HookRegistry;
  readonly clock: Clock;
  /** Owns `node:child_process`. Absent means command hooks are a visible misconfiguration, not silent. */
  readonly commandExecutor?: CommandExecutor;
  readonly network?: NetworkBroker;
  readonly prompt?: PromptRunner;
  readonly agent?: AgentRunner;
  /** Per-handler deadline when a handler does not specify its own. */
  readonly defaultTimeoutMs?: number;
}

/**
 * Restrictiveness ladder for decisions. `allow`/`passthrough` sit at the bottom; the fold only ever
 * moves UP. This single ordering is what makes "a hook cannot loosen a decision" a property of the
 * arithmetic rather than of scattered conditionals.
 */
const RESTRICTIVENESS: Record<DecisionOutcome, number> = {
  passthrough: 0,
  allow: 0,
  ask: 1,
  deny: 2,
};

const DEFAULT_TIMEOUT_MS = 30_000;

type DeadlineResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly reason: 'timeout' | 'cancelled' | 'error';
      readonly error?: string;
    };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A handler either produced a typed outcome or failed visibly. */
type HandlerResult =
  | { readonly kind: 'outcome'; readonly outcome: HookOutcome; readonly note?: string }
  | { readonly kind: 'failure'; readonly failure: Omit<HookFailure, 'hookId'> };

export class HookEngine {
  readonly #deps: HookEngineDeps;
  /** True while a Stop is being handled, so a re-entrant Stop can be refused (HK-05). */
  #stopInProgress = false;

  constructor(deps: HookEngineDeps) {
    this.#deps = deps;
  }

  async run(
    event: HookEvent,
    input: HookInput,
    context: HookRunContext = {},
  ): Promise<FoldedHookResult> {
    const base: DecisionOutcome = context.currentDecision ?? 'allow';

    // --- Stop re-entry guard (HK-05) ---------------------------------------------------------
    // A Stop already in flight refuses another Stop before any handler runs, so a Stop hook that
    // recursively calls run('Stop') cannot re-enter and loop.
    if (event === 'Stop' && this.#stopInProgress) {
      return this.#refusedStopResult(event, base);
    }
    const entered = event === 'Stop';
    if (entered) this.#stopInProgress = true;

    try {
      return await this.#runInner(event, input, context, base);
    } finally {
      if (entered) this.#stopInProgress = false;
    }
  }

  async #runInner(
    event: HookEvent,
    input: HookInput,
    context: HookRunContext,
    base: DecisionOutcome,
  ): Promise<FoldedHookResult> {
    const signal = context.signal ?? new AbortController().signal;
    const invocation: HookInvocation = {
      event,
      data: input.data ?? {},
      signal,
      ...(input.toolName !== undefined ? { toolName: input.toolName } : {}),
      ...(input.toolInput !== undefined ? { toolInput: input.toolInput } : {}),
      ...(input.paths !== undefined ? { paths: input.paths } : {}),
      ...(context.currentDecision !== undefined
        ? { currentDecision: context.currentDecision }
        : {}),
      ...(context.correlationId !== undefined ? { correlationId: context.correlationId } : {}),
    };

    const post = isPostToolEvent(event);
    const registrations = this.#deps.registry.matching(invocation);

    // Accumulators.
    let blocked = false;
    let blockReason: AttributedReason | undefined;
    let stopped = false;
    let stopReason: AttributedReason | undefined;
    let stopReentryRefused = false;
    let restriction = base;
    const modifications: ModifiedInputProposal[] = [];
    const injectedContext: InjectedContext[] = [];
    const annotations: AttributedAnnotations[] = [];
    const ignoredElevations: IgnoredElevation[] = [];
    const failures: HookFailure[] = [];
    const audit: HookInvocationRecord[] = [];
    let ranHandlers = 0;

    for (const registration of registrations) {
      // A block on a pre-action event short-circuits: nothing after a stopped action should run.
      if (blocked) {
        audit.push({
          hookId: registration.id,
          form: registration.handler.kind,
          outcome: 'skipped',
          note: 'skipped: a prior hook blocked the action',
        });
        continue;
      }

      ranHandlers += 1;
      const result = await this.#invoke(registration, invocation);

      if (result.kind === 'failure') {
        const failure: HookFailure = { hookId: registration.id, ...result.failure };
        failures.push(failure);
        audit.push({
          hookId: registration.id,
          form: registration.handler.kind,
          outcome: 'failure',
          note: `${failure.kind}: ${failure.message}`,
        });
        continue;
      }

      const outcome = result.outcome;
      const note = result.note ? ` (${result.note})` : '';
      audit.push({
        hookId: registration.id,
        form: registration.handler.kind,
        outcome: outcome.type,
        note: `${outcome.type}${note}`,
      });

      switch (outcome.type) {
        case 'continue':
          break;

        case 'block':
          if (post) {
            // You cannot block an action that already completed. Interpret it as preventing the
            // next step; the durable result is untouched (HK-05).
            stopped = true;
            if (stopReason === undefined) {
              stopReason = { hookId: registration.id, reason: outcome.reason };
            }
          } else {
            blocked = true;
            blockReason = { hookId: registration.id, reason: outcome.reason };
            // A blocked action is, in decision terms, denied.
            restriction = mostRestrictive(restriction, 'deny');
          }
          break;

        case 'context': {
          const clean = sanitize(untrusted(outcome.text), {
            origin: 'hook',
            multiline: true,
            maxLength: 100_000,
          });
          injectedContext.push({
            hookId: registration.id,
            text: clean.text,
            sanitized: clean.modified,
          });
          break;
        }

        case 'modify':
          modifications.push({
            hookId: registration.id,
            toolInput: outcome.toolInput,
            needsRevalidation: true,
          });
          break;

        case 'allow':
        case 'passthrough':
          ignoredElevations.push({
            hookId: registration.id,
            requested: outcome.type,
            reason: outcome.reason,
            note: 'a hook may not loosen a permission decision; recorded and ignored (HK-04)',
          });
          break;

        case 'deny':
          restriction = mostRestrictive(restriction, 'deny');
          break;

        case 'ask':
          restriction = mostRestrictive(restriction, 'ask');
          break;

        case 'stop':
          if (event === 'Stop') {
            // A Stop hook asking to Stop again is a re-entry attempt. Record it; do not re-enter.
            stopReentryRefused = true;
          } else {
            stopped = true;
            if (stopReason === undefined) {
              stopReason = { hookId: registration.id, reason: outcome.reason };
            }
          }
          break;

        case 'annotate':
          annotations.push({ hookId: registration.id, annotations: outcome.annotations });
          break;
      }
    }

    const decision = restriction;
    const lastModification = modifications[modifications.length - 1];

    return {
      event,
      ranHandlers,
      blocked,
      decision,
      decisionChanged: decision !== base,
      modifications,
      injectedContext,
      stopped,
      resultDurable: post,
      annotations,
      ignoredElevations,
      failures,
      stopReentryRefused,
      audit,
      ...(blockReason !== undefined ? { blockReason } : {}),
      ...(stopReason !== undefined ? { stopReason } : {}),
      ...(lastModification !== undefined ? { modifiedInput: lastModification } : {}),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Dispatch: run ONE handler under a deadline, translating each form to a HandlerResult.
  // -------------------------------------------------------------------------------------------

  async #invoke(
    registration: HookRegistration,
    invocation: HookInvocation,
  ): Promise<HandlerResult> {
    const timeoutMs = handlerTimeout(registration, this.#deps.defaultTimeoutMs);
    const outcome = await this.#withDeadline(timeoutMs, invocation.signal, (signal) =>
      this.#dispatch(registration, invocation, signal),
    );

    if (outcome.ok) return outcome.value;
    if (outcome.reason === 'timeout') {
      return failure('timeout', `hook exceeded its ${timeoutMs}ms deadline and was cancelled`);
    }
    if (outcome.reason === 'cancelled') {
      return failure('cancelled', 'hook run was cancelled');
    }
    return failure('exception', outcome.error ?? 'hook threw');
  }

  async #dispatch(
    registration: HookRegistration,
    invocation: HookInvocation,
    signal: AbortSignal,
  ): Promise<HandlerResult> {
    const handler = registration.handler;
    const scoped: HookInvocation = { ...invocation, signal };

    switch (handler.kind) {
      case 'function': {
        const outcome = await handler.run(scoped);
        return { kind: 'outcome', outcome };
      }

      case 'command': {
        const executor = this.#deps.commandExecutor;
        if (executor === undefined) {
          return failure(
            'misconfigured',
            'command hook registered but no command executor injected',
          );
        }
        const result = await executor.run(handler, payloadJson(scoped), signal, {
          QWEN_HOOK_EVENT: scoped.event,
          ...(scoped.correlationId !== undefined
            ? { QWEN_HOOK_CORRELATION: scoped.correlationId }
            : {}),
        });
        if (result.spawnError !== undefined) {
          return failure('spawn-error', result.spawnError, result.stderr || undefined);
        }
        if (result.aborted) {
          // The deadline/cancellation path already classifies this; surface generically otherwise.
          return failure('cancelled', 'command hook was cancelled', result.stderr || undefined);
        }
        if (result.exitCode !== 0) {
          return failure(
            'nonzero-exit',
            `command hook exited with code ${result.exitCode ?? 'null'}${
              result.termSignal ? ` (signal ${result.termSignal})` : ''
            }`,
            result.stderr || undefined,
          );
        }
        return interpretStdout(result.stdout, result.stderr);
      }

      case 'http': {
        const broker = this.#deps.network;
        if (broker === undefined) {
          return failure('misconfigured', 'http hook registered but no network broker injected');
        }
        const response = await executeHttpHook(
          broker,
          {
            url: handler.url,
            method: handler.method ?? 'POST',
            headers: { 'content-type': 'application/json', ...(handler.headers ?? {}) },
            body: payloadJson(scoped),
            timeoutMs: handlerTimeout(registration, this.#deps.defaultTimeoutMs),
          },
          signal,
        );
        if (response.status < 200 || response.status >= 300) {
          return failure(
            'transport',
            `http hook returned status ${response.status}`,
            response.body,
          );
        }
        return interpretBody(response.body);
      }

      case 'prompt': {
        const runner = this.#deps.prompt;
        if (runner === undefined) {
          return failure('misconfigured', 'prompt hook registered but no prompt runner injected');
        }
        const outcome = await runner.run({ prompt: handler.prompt, invocation: scoped }, signal);
        return { kind: 'outcome', outcome };
      }

      case 'agent': {
        const runner = this.#deps.agent;
        if (runner === undefined) {
          return failure('misconfigured', 'agent hook registered but no agent runner injected');
        }
        const outcome = await runner.run(
          { agent: handler.agent, input: handler.input ?? {}, invocation: scoped },
          signal,
        );
        return { kind: 'outcome', outcome };
      }
    }
  }

  /**
   * Run `fn` bounded by a deadline drawn from the injected clock, cancellable by `outer`. Whichever
   * of {handler settles, deadline fires, outer aborts} happens first wins; the losers are cancelled
   * so no timer or child process leaks.
   */
  #withDeadline<T>(
    timeoutMs: number,
    outer: AbortSignal,
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<DeadlineResult<T>> {
    const controller = new AbortController();
    const timerCtl = new AbortController();
    let settle!: (value: DeadlineResult<T>) => void;
    const done = new Promise<DeadlineResult<T>>((resolve) => {
      settle = resolve;
    });

    if (outer.aborted) {
      return Promise.resolve({ ok: false, reason: 'cancelled' } as const);
    }
    const onOuterAbort = (): void => {
      controller.abort();
      settle({ ok: false, reason: 'cancelled' });
    };
    outer.addEventListener('abort', onOuterAbort, { once: true });

    void this.#deps.clock.sleep(timeoutMs, timerCtl.signal).then(
      () => {
        controller.abort();
        settle({ ok: false, reason: 'timeout' });
      },
      () => {
        // Timer cancelled because the handler already settled; nothing to do.
      },
    );

    void Promise.resolve()
      .then(() => fn(controller.signal))
      .then(
        (value) => settle({ ok: true, value }),
        (err: unknown) => settle({ ok: false, reason: 'error', error: errorMessage(err) }),
      );

    return done.finally(() => {
      timerCtl.abort();
      outer.removeEventListener('abort', onOuterAbort);
    });
  }

  #refusedStopResult(event: HookEvent, base: DecisionOutcome): FoldedHookResult {
    return {
      event,
      ranHandlers: 0,
      blocked: false,
      decision: base,
      decisionChanged: false,
      modifications: [],
      injectedContext: [],
      stopped: false,
      resultDurable: false,
      annotations: [],
      ignoredElevations: [],
      failures: [],
      stopReentryRefused: true,
      audit: [
        {
          hookId: '<engine>',
          form: 'engine',
          outcome: 'skipped',
          note: 'Stop is already in progress; re-entrant Stop refused (HK-05)',
        },
      ],
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

function mostRestrictive(current: DecisionOutcome, candidate: DecisionOutcome): DecisionOutcome {
  return RESTRICTIVENESS[candidate] > RESTRICTIVENESS[current] ? candidate : current;
}

function handlerTimeout(registration: HookRegistration, fallback: number | undefined): number {
  const handler = registration.handler;
  const own =
    handler.kind === 'command' ||
    handler.kind === 'http' ||
    handler.kind === 'prompt' ||
    handler.kind === 'agent'
      ? handler.timeoutMs
      : undefined;
  return own ?? fallback ?? DEFAULT_TIMEOUT_MS;
}

function failure(
  kind: HookFailureKind,
  message: string,
  detail?: string,
): { kind: 'failure'; failure: Omit<HookFailure, 'hookId'> } {
  return {
    kind: 'failure',
    failure: { kind, message, ...(detail !== undefined ? { detail } : {}) },
  };
}

/** The JSON a command/HTTP hook receives on stdin / as its body. The AbortSignal is not serialised. */
function payloadJson(invocation: HookInvocation): string {
  return JSON.stringify({
    event: invocation.event,
    toolName: invocation.toolName ?? null,
    toolInput: invocation.toolInput ?? null,
    paths: invocation.paths ?? [],
    currentDecision: invocation.currentDecision ?? null,
    correlationId: invocation.correlationId ?? null,
    data: invocation.data,
  });
}

function interpretStdout(stdout: string, stderr: string): HandlerResult {
  const trimmed = stdout.trim();
  // A hook that exits 0 and says nothing is expressing "no opinion".
  if (trimmed.length === 0) {
    return {
      kind: 'outcome',
      outcome: { type: 'continue' },
      ...(stderr ? { note: 'stderr present' } : {}),
    };
  }
  return parseJsonOutcome(trimmed, stderr ? 'stderr present' : undefined);
}

function interpretBody(body: string): HandlerResult {
  const trimmed = body.trim();
  if (trimmed.length === 0) return { kind: 'outcome', outcome: { type: 'continue' } };
  return parseJsonOutcome(trimmed, undefined);
}

function parseJsonOutcome(text: string, note: string | undefined): HandlerResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return failure('malformed-output', `hook output was not valid JSON: ${errorMessage(err)}`);
  }
  const parsed = parseHookOutcome(raw);
  if (!parsed.ok) {
    return failure('malformed-output', `hook output was not a valid outcome: ${parsed.error}`);
  }
  return { kind: 'outcome', outcome: parsed.outcome, ...(note !== undefined ? { note } : {}) };
}
