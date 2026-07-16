import type { NormalizedAction, PolicyContext, PolicyEngine } from '@qwen-harness/policy';
import type { ToolEvaluation, ToolExecutionResult, ToolExecutor } from '@qwen-harness/runtime';
import { z } from 'zod';

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

/** The FIXED, HARDCODED, closed allowlist. No wildcard, no prefix match — exactly these two names. */
export const IN_PROCESS_TOOL_NAMES: ReadonlySet<string> = Object.freeze(
  new Set(['retrieve_output', 'ask_user']),
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

const RetrieveInput = z.object({
  ref: z.string().min(1).max(512).describe('The offload reference (blob digest) to retrieve.'),
});
const AskInput = z.object({
  question: z.string().min(1).max(4000).describe('The question to put to the user.'),
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
      // A workspace read is the honest, conservative NormalizedAction for both tools (see note
      // above). This routes through the shared engine and yields a genuine allow/ask/deny.
      const action: NormalizedAction = { kind: 'file-read', path: opts.workspaceRoot };
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
        // A blocking prompt is fine here: durability of an in-flight question is OUT OF SCOPE for
        // TL-02 (a coverage claim, not a durability claim). The abort signal is honoured by the
        // channel implementation.
        const answer = await opts.userInteraction.ask(parsed.data.question, call.signal);
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
