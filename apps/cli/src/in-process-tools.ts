import { createHash } from 'node:crypto';

import type { NormalizedAction, PolicyContext, PolicyEngine } from '@qwen-harness/policy';
import type { ToolEvaluation, ToolExecutionResult, ToolExecutor } from '@qwen-harness/runtime';
import { z } from 'zod';

import type { FireHook } from './hooks.ts';
import type { InProcessSurface, ModelTool } from './wiring.ts';

/**
 * The THIRD tool-execution path (TL-02).
 *
 * Every other built-in runs in the sandbox worker. These two cannot:
 *   - `retrieve_output` needs the durable blob store (offloaded tool output, TL-10), which the
 *     sandbox worker has no handle to;
 *   - `ask_user` needs a live user channel, which the sandbox worker cannot reach either.
 *
 * So they run IN-PROCESS, through an ordinary `ToolExecutor`. "Ordinary" is the whole security
 * point: the engine wraps this executor in the SAME hook -> policy -> approval -> persist order it
 * wraps the sandbox pipeline and the MCP executor in. There is no privileged path here, and no way
 * to add one — the engine, not this file, owns the ordering (see turn-engine.ts `#runOneCall`).
 *
 * The allowlist below is FIXED and CLOSED. Only `retrieve_output` and `ask_user` are handled; any
 * other name is refused here (defence in depth) and — more importantly — never routed here at all by
 * `compositeExecutor`, which checks the same closed set. The in-process path can never run a
 * model-chosen name.
 */

/**
 * The FIXED, HARDCODED, closed allowlist. No wildcard, no prefix match — exactly these three names.
 * `delegate` (AG-02) joins `retrieve_output`/`ask_user` because it, too, needs an in-process handle
 * the sandbox worker cannot hold: the durable store (for a forked seed and the child's own thread)
 * and the live `SubagentSupervisor`. It is STILL routed through the same engine wrapping as the other
 * two — hook → policy → approval → persist — and its name being in this closed set is the only thing
 * that routes it in-process; the model cannot add a fourth.
 */
export const IN_PROCESS_TOOL_NAMES: ReadonlySet<string> = Object.freeze(
  new Set(['retrieve_output', 'ask_user', 'delegate']),
) as ReadonlySet<string>;

/** A bound on how much retrieved content we feed back, so a huge blob cannot re-blow the budget. */
export const MAX_RETRIEVE_CHARS = 200_000;

/**
 * The narrow read port `retrieve_output` needs. `EventStore` satisfies it. Deliberately minimal: the
 * tool can ONLY read the blob store by digest — it has no way to name an arbitrary filesystem path.
 */
export interface BlobPort {
  readBlob(digest: string): string | undefined;
}

/**
 * The user-interaction channel `ask_user` needs. Separate from `ApprovalDecision` on purpose:
 * asking the user an open question is not a permission decision and must not be squeezed through the
 * approval type. `ask` returns the answer, or `null` when there is no channel to ask on (a `--json`
 * run, a daemon with no attached client, a closed stdin). `null` is never an answer.
 */
export interface UserInteraction {
  ask(question: string, signal: AbortSignal): Promise<string | null>;
}

/**
 * The port `delegate` spawns through. Kept narrow and free of the `agents`/`policy` types so this
 * module stays a leaf: the concrete supervisor/runner wiring lives in `subagent-tool.ts`. `run`
 * returns the child's bounded conclusion (foreground) or an immediate "started" note (background);
 * a normal child failure is `ok:false`, never a throw.
 */
export interface DelegatePort {
  run(
    args: {
      label: string;
      prompt: string;
      context: 'fresh' | 'forked';
      timing: 'foreground' | 'background';
    },
    signal: AbortSignal,
  ): Promise<{ ok: boolean; modelText: string }>;
}

const RetrieveInput = z.object({
  ref: z.string().min(1).max(512).describe('The offload reference (blob digest) to retrieve.'),
});
const AskInput = z.object({
  question: z.string().min(1).max(4000).describe('The question to put to the user.'),
});
const DelegateInput = z.object({
  label: z.string().min(1).max(200).describe('A short name for the subagent/subtask.'),
  prompt: z.string().min(1).max(20_000).describe('The task the subagent should carry out.'),
  context: z
    .enum(['fresh', 'forked'])
    .default('fresh')
    .describe('fresh = isolated; forked = seeded with this conversation.'),
  timing: z
    .enum(['foreground', 'background'])
    .default('foreground')
    .describe('foreground = wait for the conclusion; background = start and continue.'),
});

function paramsSchema(schema: z.ZodType): Readonly<Record<string, unknown>> {
  const s = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
  delete s['$schema'];
  return s;
}

/** The model-facing schemas for both in-process tools, advertised alongside the built-ins. */
export const inProcessToolSchemas: readonly ModelTool[] = [
  {
    name: 'retrieve_output',
    description:
      'Retrieve the full content of a previously offloaded tool output by its reference (the ' +
      'digest shown when a large output was replaced by a preview). Reads only the durable output ' +
      'store; it cannot read files.',
    parameters: paramsSchema(RetrieveInput),
  },
  {
    name: 'ask_user',
    description:
      'Ask the user a single free-form question and wait for their typed answer. Use when you ' +
      'genuinely need information only the user has. Unavailable in non-interactive runs.',
    parameters: paramsSchema(AskInput),
  },
  {
    name: 'delegate',
    description:
      'Spawn a bounded subagent to handle a focused subtask and return only its conclusion. The ' +
      'child runs one turn under an authority that can never exceed yours. `context` "fresh" ' +
      '(default) gives the child only its prompt; "forked" seeds it with this conversation. ' +
      '`timing` "foreground" (default) waits for and returns the conclusion; "background" starts ' +
      'it and returns immediately, naming the subagent id.',
    parameters: paramsSchema(DelegateInput),
  },
];

function riskFor(outcome: 'allow' | 'deny' | 'ask' | 'passthrough'): 'low' | 'medium' | 'high' {
  return outcome === 'deny' ? 'high' : outcome === 'ask' ? 'medium' : 'low';
}

/**
 * Build the in-process `ToolExecutor`.
 *
 * `evaluate` is a REAL policy decision, not a hardcoded allow: it runs the SAME `PolicyEngine`
 * instance the built-in pipeline and the MCP executor use, over an honest `file-read` action scoped
 * to the session workspace. Both tools are read-only / interaction — they change nothing on the host
 * — so a workspace read is the conservative representation: an operator deny-rule or protected-path
 * over the workspace still gets to refuse or ask, and nothing over-permits. There is deliberately no
 * blanket allow that would dodge the approval channel.
 */
export function inProcessExecutor(opts: {
  blob: BlobPort;
  userInteraction: UserInteraction;
  /** The SAME engine the built-ins and MCP are judged by — "same policy" as an object identity. */
  policy: PolicyEngine;
  /** Re-read per call so a grant minted mid-turn and the current time are both visible. */
  policyContext: () => PolicyContext;
  /** Canonical absolute workspace root (the same value the built-in pipeline uses). */
  workspaceRoot: string;
  clock: { now(): number };
  /**
   * The subagent-spawn port (AG-02). Present only when the run wired a `SubagentSupervisor` + runner
   * (production always does). Absent means `delegate` is still in the closed allowlist but declines
   * with `unsupported` rather than escalating — defence in depth, same as an unknown name.
   */
  delegate?: DelegatePort;
  /**
   * Guarded, observe-only hook fire (HK-01). `ask_user` is a genuine ELICITATION: the system asks the
   * human for input. Elicitation fires before the prompt, ElicitationResult after it resolves (with
   * whether an answer came back or the channel declined). Observe-only — it never changes the answer.
   */
  fireHook?: FireHook;
}): ToolExecutor {
  const failure = (category: string, message: string, durationMs: number): ToolExecutionResult => ({
    ok: false,
    modelText: message,
    userText: message,
    errorCategory: category,
    resultDigest: null,
    outputRef: null,
    truncated: false,
    durationMs,
  });

  return {
    intentFor: (call) => ({
      // Mirrors the built-in read path: identity is name + arguments, and neither tool is a host
      // side effect (`destructive: false`, `kind: 'other'`).
      idempotencyKey: `${call.toolName}:${JSON.stringify(call.arguments)}`,
      destructive: false,
      kind: 'other',
      normalizedAction: call.toolName,
    }),

    evaluate: (call): Promise<ToolEvaluation> => {
      // The honest NormalizedAction differs by tool. `retrieve_output`/`ask_user` are read-only /
      // interaction, so a workspace READ is the conservative representation. `delegate` spawns an
      // agent that can act on the workspace — at least as sensitive as a workspace WRITE — so it is
      // evaluated as a `file-write` scoped to the workspace root. Either way this routes through the
      // SHARED engine and yields a genuine allow/ask/deny; nothing is hardcoded to allow.
      const action: NormalizedAction =
        call.toolName === 'delegate'
          ? {
              kind: 'file-write',
              path: opts.workspaceRoot,
              createsExecutable: false,
              // A stable, valid sha256 over the arguments — approval binds to THIS delegate request.
              contentDigest: createHash('sha256')
                .update(JSON.stringify(call.arguments))
                .digest('hex'),
            }
          : { kind: 'file-read', path: opts.workspaceRoot };
      const decision = opts.policy.evaluate(action, opts.policyContext());
      const status =
        decision.outcome === 'deny' ? 'deny' : decision.outcome === 'ask' ? 'ask' : 'allow';
      return Promise.resolve({
        status,
        actionDigest: decision.actionDigest,
        description: call.toolName,
        risk: riskFor(decision.outcome),
        reason: decision.reason,
        source: `${decision.source.stage}:${decision.source.id}`,
      });
    },

    execute: async (call): Promise<ToolExecutionResult> => {
      const start = opts.clock.now();
      const done = (): number => opts.clock.now() - start;

      // Defence in depth: the CLOSED allowlist, enforced a second time at execution. Even if a name
      // somehow reached here, only these two branches can run; anything else is refused.
      if (call.toolName === 'retrieve_output') {
        const parsed = RetrieveInput.safeParse(call.arguments);
        if (!parsed.success) {
          return failure(
            'invalid-input',
            `invalid retrieve_output arguments: ${parsed.error.message}`,
            done(),
          );
        }
        // Reads ONLY the blob store, by digest. There is no filesystem path anywhere in this branch.
        const content = opts.blob.readBlob(parsed.data.ref);
        if (content === undefined) {
          return failure(
            'not-found',
            `no offloaded output found for reference '${parsed.data.ref}'`,
            done(),
          );
        }
        let text = content;
        let truncated = false;
        if (text.length > MAX_RETRIEVE_CHARS) {
          text = `${text.slice(0, MAX_RETRIEVE_CHARS)}\n\n[retrieve_output: truncated to ${MAX_RETRIEVE_CHARS} chars]`;
          truncated = true;
        }
        return {
          ok: true,
          modelText: text,
          userText: content,
          errorCategory: null,
          resultDigest: null,
          outputRef: parsed.data.ref,
          truncated,
          durationMs: done(),
        };
      }

      if (call.toolName === 'ask_user') {
        const parsed = AskInput.safeParse(call.arguments);
        if (!parsed.success) {
          return failure(
            'invalid-input',
            `invalid ask_user arguments: ${parsed.error.message}`,
            done(),
          );
        }
        // Elicitation (HK-01): the system is about to ask the human a question. Observe-only.
        await opts.fireHook?.('Elicitation', {
          source: 'ask_user',
          question: parsed.data.question,
        });
        // A blocking prompt is fine here: durability of an in-flight question is OUT OF SCOPE for
        // TL-02 (a coverage claim, not a durability claim). The abort signal is honoured by the
        // channel implementation.
        const answer = await opts.userInteraction.ask(parsed.data.question, call.signal);
        // ElicitationResult (HK-01): the question resolved — either an answer or a declined channel.
        await opts.fireHook?.('ElicitationResult', {
          source: 'ask_user',
          answered: answer !== null,
        });
        if (answer === null) {
          return failure(
            'unsupported',
            'no interactive user channel is available to answer this question',
            done(),
          );
        }
        return {
          ok: true,
          modelText: answer,
          userText: answer,
          errorCategory: null,
          resultDigest: null,
          outputRef: null,
          truncated: false,
          durationMs: done(),
        };
      }

      if (call.toolName === 'delegate') {
        if (opts.delegate === undefined) {
          return failure('unsupported', 'subagent delegation is not available in this run', done());
        }
        const parsed = DelegateInput.safeParse(call.arguments);
        if (!parsed.success) {
          return failure(
            'invalid-input',
            `invalid delegate arguments: ${parsed.error.message}`,
            done(),
          );
        }
        // The spawn itself. A normal child failure returns `ok:false` with the reason as text — the
        // parent turn continues; only a broken runner would throw, and the port never does.
        const outcome = await opts.delegate.run(
          {
            label: parsed.data.label,
            prompt: parsed.data.prompt,
            context: parsed.data.context,
            timing: parsed.data.timing,
          },
          call.signal,
        );
        return {
          ok: outcome.ok,
          modelText: outcome.modelText,
          userText: outcome.modelText,
          errorCategory: outcome.ok ? null : 'subagent-failed',
          resultDigest: null,
          outputRef: null,
          truncated: false,
          durationMs: done(),
        };
      }

      return failure(
        'unsupported',
        `the in-process executor does not handle '${call.toolName}'`,
        done(),
      );
    },
  };
}

/** Assemble the surface `compositeExecutor` routes to: the fixed allowlist, schemas, and executor. */
export function inProcessSurface(opts: Parameters<typeof inProcessExecutor>[0]): InProcessSurface {
  return {
    tools: inProcessToolSchemas,
    names: IN_PROCESS_TOOL_NAMES,
    executor: inProcessExecutor(opts),
  };
}

/**
 * The CLI user channel for `ask_user`: a terminal prompt, reusing the SAME `readLine` the approval
 * gate uses, so interaction I/O is uniform. `null` from `readLine` (closed stdin / EOF) becomes a
 * `null` answer — never a fabricated one.
 */
export function cliUserInteraction(io: {
  stdout: (line: string) => void;
  readLine: (prompt: string) => Promise<string | null>;
}): UserInteraction {
  return {
    ask: async (question: string, signal: AbortSignal): Promise<string | null> => {
      if (signal.aborted) return null;
      io.stdout('');
      io.stdout(`  the agent is asking:`);
      io.stdout(`  ${question}`);
      const answer = await io.readLine('  your answer (empty to skip): ');
      if (signal.aborted) return null;
      if (answer === null) return null;
      const trimmed = answer.trim();
      return trimmed.length === 0 ? null : trimmed;
    },
  };
}

/** The headless channel: there is nobody to ask, so `ask` always declines with `null` (never fakes). */
export function headlessUserInteraction(): UserInteraction {
  return { ask: () => Promise.resolve(null) };
}
