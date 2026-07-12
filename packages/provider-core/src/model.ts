/**
 * The normalized model request. Provider-NEUTRAL by construction: no vendor field name appears
 * here, and nothing in this file knows that DashScope exists. A second provider would implement
 * the same `ModelProvider` against these types without changing them.
 */

/**
 * Effort as the harness understands it. A transport that cannot express this granularity must
 * reject it with a typed error rather than silently degrade (PV-13) — a request for `high` that
 * quietly becomes `medium` is a lie the user cannot see.
 */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high';

export const REASONING_EFFORTS = Object.freeze([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
] as const satisfies readonly ReasoningEffort[]);

export function isReasoningEffort(value: string): value is ReasoningEffort {
  return (REASONING_EFFORTS as readonly string[]).includes(value);
}

/** A JSON Schema document. Kept opaque: provider-core never interprets tool schemas. */
export type JsonSchema = Readonly<Record<string, unknown>>;

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the arguments object. */
  readonly parameters: JsonSchema;
}

/**
 * One entry of conversation input. Local history is authoritative (PV-08): the harness always
 * sends the reconstructed input it owns, so a `function-call` and its `function-output` are paired
 * here by `callId` and never by remote server state.
 */
export type ModelInputItem =
  | { readonly type: 'message'; readonly role: 'user' | 'assistant'; readonly text: string }
  | {
      readonly type: 'function-call';
      readonly callId: string;
      readonly name: string;
      readonly argumentsJson: string;
    }
  | {
      readonly type: 'function-output';
      readonly callId: string;
      readonly name: string;
      readonly output: string;
    };

export interface ModelRequest {
  readonly model: string;
  /** System/developer instructions. Sent every call; never inherited from remote server state. */
  readonly instructions: string;
  readonly input: readonly ModelInputItem[];
  readonly tools: readonly ToolDefinition[];
  /** When present this ALWAYS wins over any provider-level legacy compatibility shape (PV-13). */
  readonly reasoningEffort?: ReasoningEffort;
  readonly maxOutputTokens?: number;
  /** Joins the single abort tree (RT-06). Aborting rejects the stream with the signal's reason. */
  readonly signal?: AbortSignal;
}
