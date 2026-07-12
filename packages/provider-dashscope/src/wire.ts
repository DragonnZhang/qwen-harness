import { z } from 'zod';

/**
 * The vendor wire shapes. NOTHING in this file may escape this package (task.md boundary 6): the
 * types below exist only to be validated and immediately normalized into `provider-core` events.
 *
 * Every schema is deliberately LENIENT about fields we do not consume and STRICT about the fields
 * we do. A model stream is an untrusted boundary, but it is also a boundary where a server is free
 * to add a field tomorrow — rejecting an event because it grew a new key would take the product
 * down for a change that does not affect it.
 */

const Nullable = <T extends z.ZodType>(inner: T) => inner.nullish();

// ---------------------------------------------------------------------------------------------
// Responses transport
// ---------------------------------------------------------------------------------------------

/** Reasoning SUMMARY parts. `summary_text` is model-authored and safe to render (PV-04). */
const ResponsesSummaryPartSchema = z.object({
  type: z.string(),
  text: z.string().default(''),
});

const ResponsesContentPartSchema = z.object({
  type: z.string(),
  text: Nullable(z.string()),
});

export const ResponsesOutputItemSchema = z.object({
  id: Nullable(z.string()),
  type: z.string(),
  status: Nullable(z.string()),
  /** `type: 'reasoning'` */
  summary: Nullable(z.array(ResponsesSummaryPartSchema)),
  /** `type: 'message'` */
  content: Nullable(z.array(ResponsesContentPartSchema)),
  /** `type: 'function_call'` */
  name: Nullable(z.string()),
  arguments: Nullable(z.string()),
  /** DISTINCT from `id`. This is the ID a function output must be paired against (PV-06). */
  call_id: Nullable(z.string()),
});
export type ResponsesOutputItem = z.infer<typeof ResponsesOutputItemSchema>;

export const ResponsesUsageSchema = z.object({
  input_tokens: Nullable(z.number()),
  output_tokens: Nullable(z.number()),
  total_tokens: Nullable(z.number()),
  output_tokens_details: Nullable(z.object({ reasoning_tokens: Nullable(z.number()) })),
  input_tokens_details: Nullable(z.object({ cached_tokens: Nullable(z.number()) })),
});

const ResponsesResponseSchema = z.object({
  id: Nullable(z.string()),
  status: Nullable(z.string()),
  usage: Nullable(ResponsesUsageSchema),
  incomplete_details: Nullable(z.object({ reason: Nullable(z.string()) })),
  error: Nullable(z.object({ code: Nullable(z.string()), message: Nullable(z.string()) })),
});

export const ResponsesItemEventSchema = z.object({ item: ResponsesOutputItemSchema });
export const ResponsesTextDeltaSchema = z.object({
  item_id: z.string().default(''),
  delta: z.string().default(''),
});
export const ResponsesEnvelopeSchema = z.object({ response: ResponsesResponseSchema });
export const ResponsesErrorEventSchema = z.object({
  code: Nullable(z.string()),
  message: Nullable(z.string()),
});

// ---------------------------------------------------------------------------------------------
// Chat Completions transport
// ---------------------------------------------------------------------------------------------

/**
 * A tool-call FRAGMENT. `id` and `function.name` appear on the first fragment only; every later
 * fragment carries an empty `id` and a slice of the argument string. `index` is the only stable
 * identity across fragments, which is why assembly keys on it (PV-05).
 */
export const ChatToolCallDeltaSchema = z.object({
  index: z.number(),
  id: Nullable(z.string()),
  type: Nullable(z.string()),
  function: Nullable(
    z.object({
      name: Nullable(z.string()),
      arguments: Nullable(z.string()),
    }),
  ),
});

const ChatDeltaSchema = z.object({
  role: Nullable(z.string()),
  content: Nullable(z.string()),
  /**
   * RAW private chain-of-thought. Validated so we can recognize it — and then DISCARDED (PV-04).
   * It is never a summary, and it is never persisted. The normalizer has no code path that can
   * put this string into an event.
   */
  reasoning_content: Nullable(z.string()),
  tool_calls: Nullable(z.array(ChatToolCallDeltaSchema)),
});

const ChatChoiceSchema = z.object({
  index: Nullable(z.number()),
  delta: Nullable(ChatDeltaSchema),
  finish_reason: Nullable(z.string()),
});

export const ChatUsageSchema = z.object({
  prompt_tokens: Nullable(z.number()),
  completion_tokens: Nullable(z.number()),
  total_tokens: Nullable(z.number()),
  completion_tokens_details: Nullable(z.object({ reasoning_tokens: Nullable(z.number()) })),
  prompt_tokens_details: Nullable(z.object({ cached_tokens: Nullable(z.number()) })),
});

export const ChatChunkSchema = z.object({
  id: Nullable(z.string()),
  /** The final usage chunk carries `choices: []`. That empty array is the signal, not an error. */
  choices: z.array(ChatChoiceSchema).default([]),
  usage: Nullable(ChatUsageSchema),
});
export type ChatChunk = z.infer<typeof ChatChunkSchema>;
