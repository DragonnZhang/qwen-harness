import { harnessError } from '@qwen-harness/protocol';
import type { ReasoningEffort } from '@qwen-harness/provider-core';

/**
 * Reasoning-effort mapping (PV-13 / requirement 12).
 *
 * The legacy compatibility shape is a Python-flavored escape hatch that some existing configs
 * carry: `generationConfig.extra_body.enable_thinking`. We ACCEPT it as input and we NEVER emit it.
 * `extra_body` is an OpenAI-Python SDK convention for smuggling non-standard fields into a request
 * body; forwarding that key verbatim from TypeScript would put a literal `extra_body` object on the
 * wire, which is not a parameter the endpoint has — it would be silently ignored, and thinking
 * would quietly not be configured at all. So the shape is translated, never relayed.
 */
export interface LegacyGenerationConfig {
  readonly extra_body?: {
    readonly enable_thinking?: boolean;
  };
}

/** The frozen default from task.md's default safe configuration. */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'medium';

/**
 * Explicit effort ALWAYS wins over the legacy shape. `enable_thinking:false` means `none`;
 * `true` means the default `medium` — true says "think", not "think as hard as possible".
 */
export function resolveReasoningEffort(
  explicit: ReasoningEffort | undefined,
  legacy: LegacyGenerationConfig | undefined,
): ReasoningEffort {
  if (explicit !== undefined) return explicit;
  const enableThinking = legacy?.extra_body?.enable_thinking;
  if (enableThinking === false) return 'none';
  if (enableThinking === true) return DEFAULT_REASONING_EFFORT;
  return DEFAULT_REASONING_EFFORT;
}

export interface ResponsesReasoningParam {
  readonly effort: ReasoningEffort;
  /** Ask for a summary whenever the model is thinking; a summary is renderable and persistable. */
  readonly summary?: 'auto';
}

/** Responses accepts the full graded scale, so every effort maps straight through. */
export function responsesReasoningParam(effort: ReasoningEffort): ResponsesReasoningParam {
  return effort === 'none' ? { effort } : { effort, summary: 'auto' };
}

/**
 * Chat/Qwen has BINARY thinking and nothing else. `minimal`, `low` and `high` have no honest
 * representation here, so they are rejected with a typed error.
 *
 * Rounding `high` down to `enable_thinking:true` would be a silent degradation: the user asked for
 * a specific effort, would be billed for a different one, and would have no way to see it. Refusing
 * is the only behavior that keeps the request and the result the same request.
 */
export function chatEnableThinking(effort: ReasoningEffort): boolean {
  if (effort === 'none') return false;
  if (effort === 'medium') return true;
  throw unsupportedReasoningGranularityError(effort);
}

export function unsupportedReasoningGranularityError(effort: ReasoningEffort): Error {
  return harnessError({
    origin: 'config',
    category: 'provider.unsupported.reasoning_granularity',
    message:
      `The Chat Completions transport supports binary thinking only ('none' or 'medium'); ` +
      `reasoningEffort '${effort}' cannot be expressed. Use the Responses transport for graded ` +
      'effort, or choose none/medium.',
    retryable: false,
    userActionRequired: true,
    sideEffectCertainty: 'not-started',
  });
}
