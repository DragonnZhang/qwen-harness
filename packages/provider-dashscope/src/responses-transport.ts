import {
  UNKNOWN_USAGE,
  freezeCapabilities,
  type FinishReason,
  type ModelInputItem,
  type ModelRequest,
  type NormalizedUsage,
  type ProviderCapabilities,
  type ProviderStreamEvent,
  type ReasoningEffort,
} from '@qwen-harness/provider-core';
import type { z } from 'zod';

import { malformedToolArgumentsError, streamFailureError, truncatedStreamError } from './errors.ts';
import { openSseStream, type FetchLike, type StreamState } from './http.ts';
import { responsesReasoningParam } from './reasoning.ts';
import { readSseFrames } from './sse.ts';
import type { ResponsesUsageSchema } from './wire.ts';
import {
  ResponsesEnvelopeSchema,
  ResponsesErrorEventSchema,
  ResponsesItemEventSchema,
  ResponsesTextDeltaSchema,
} from './wire.ts';

/**
 * The Responses transport — the PRIMARY one, proven against the live service in checkpoint 0.
 *
 * `background` and `structuredOutput` are frozen false (PV-07). `background: true` is not merely
 * unsupported-and-ignored: the live server answers HTTP 400 "Currently not support background".
 * We therefore never put the key on the wire at all.
 */
export const RESPONSES_CAPABILITIES: ProviderCapabilities = freezeCapabilities({
  textStreaming: true,
  /** The service really does return `summary_text` parts. Renderable and persistable. */
  reasoningSummary: true,
  reasoningEffortGranularity: 'graded',
  /**
   * Argument deltas ARE observed on the wire, and we deliberately do not consume them (requirement
   * 6). Declaring `true` would invite a consumer to depend on a stream the contract says may vanish.
   */
  incrementalToolArgs: false,
  background: false,
  structuredOutput: false,
  /** `tool_stream` is not applicable to this transport. */
  toolStream: false,
});

function toResponsesInput(items: readonly ModelInputItem[]): unknown[] {
  return items.map((item) => {
    switch (item.type) {
      case 'message':
        return { type: 'message', role: item.role, content: item.text };
      case 'function-call':
        return {
          type: 'function_call',
          call_id: item.callId,
          name: item.name,
          arguments: item.argumentsJson,
        };
      case 'function-output':
        // Paired by the EXACT call_id the model produced, never by position (PV-06).
        return { type: 'function_call_output', call_id: item.callId, output: item.output };
    }
  });
}

export function buildResponsesBody(
  request: ModelRequest,
  effort: ReasoningEffort,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    instructions: request.instructions,
    input: toResponsesInput(request.input),
    stream: true,
    reasoning: responsesReasoningParam(effort),
  };
  if (request.tools.length > 0) {
    body['tools'] = request.tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }
  if (request.maxOutputTokens !== undefined) body['max_output_tokens'] = request.maxOutputTokens;
  // Deliberately absent: `background` (server rejects it with 400), `previous_response_id` (local
  // history is authoritative, PV-08), and any `extra_body` key (PV-13).
  return body;
}

function normalizeUsage(raw: z.infer<typeof ResponsesUsageSchema>): NormalizedUsage {
  return {
    inputTokens: raw.input_tokens ?? null,
    outputTokens: raw.output_tokens ?? null,
    totalTokens: raw.total_tokens ?? null,
    reasoningTokens: raw.output_tokens_details?.reasoning_tokens ?? null,
    cachedInputTokens: raw.input_tokens_details?.cached_tokens ?? null,
  };
}

export interface TransportContext {
  readonly url: string;
  readonly apiKey: string;
  readonly fetchImpl: FetchLike;
}

export async function* streamResponses(
  ctx: TransportContext,
  request: ModelRequest,
  effort: ReasoningEffort,
  state: StreamState,
): AsyncGenerator<ProviderStreamEvent> {
  const body = await openSseStream({
    url: ctx.url,
    apiKey: ctx.apiKey,
    body: buildResponsesBody(request, effort),
    signal: request.signal,
    fetchImpl: ctx.fetchImpl,
    state,
  });

  if (state.requestId !== null) yield { type: 'request-id', requestId: state.requestId };

  let sawToolCall = false;
  let finished = false;

  for await (const frame of readSseFrames(body, request.signal)) {
    const parsed: unknown = JSON.parse(frame.data);

    switch (frame.event) {
      case 'response.created': {
        const envelope = ResponsesEnvelopeSchema.parse(parsed);
        const id = envelope.response.id;
        // Header request ID wins; the response ID is the fallback so an error is never anonymous.
        if (state.requestId === null && id != null && id !== '') {
          state.requestId = id;
          yield { type: 'request-id', requestId: id };
        }
        break;
      }

      case 'response.output_text.delta': {
        const delta = ResponsesTextDeltaSchema.parse(parsed);
        if (delta.delta === '') break;
        state.visibleOutputEmitted = true;
        yield { type: 'text-delta', itemId: delta.item_id, delta: delta.delta };
        break;
      }

      case 'response.reasoning_summary_text.delta': {
        const delta = ResponsesTextDeltaSchema.parse(parsed);
        if (delta.delta === '') break;
        yield { type: 'reasoning-summary-delta', itemId: delta.item_id, delta: delta.delta };
        break;
      }

      case 'response.output_item.added': {
        const { item } = ResponsesItemEventSchema.parse(parsed);
        if (item.type !== 'function_call') break;
        const callId = item.call_id ?? item.id;
        if (callId == null || item.name == null) break;
        sawToolCall = true;
        yield {
          type: 'tool-call-begin',
          itemId: item.id ?? callId,
          callId,
          toolName: item.name,
        };
        break;
      }

      /**
       * EVERY completion is taken from the completed item, never from a `*.done` delta event or
       * from accumulated deltas. That is requirement 6 stated positively: the completed item is
       * sufficient, so the adapter depends on nothing else. `response.function_call_arguments.delta`
       * is observed on this wire and is intentionally ignored — see the default case below.
       */
      case 'response.output_item.done': {
        const { item } = ResponsesItemEventSchema.parse(parsed);

        if (item.type === 'reasoning') {
          const summary = (item.summary ?? [])
            .filter((part) => part.type === 'summary_text')
            .map((part) => part.text)
            .join('');
          if (summary !== '') {
            yield { type: 'reasoning-summary-done', itemId: item.id ?? '', summary };
          }
          break;
        }

        if (item.type === 'message') {
          const text = (item.content ?? [])
            .filter((part) => part.type === 'output_text')
            .map((part) => part.text ?? '')
            .join('');
          state.visibleOutputEmitted = state.visibleOutputEmitted || text !== '';
          yield { type: 'text-done', itemId: item.id ?? '', text };
          break;
        }

        if (item.type === 'function_call') {
          const callId = item.call_id ?? item.id ?? '';
          const toolName = item.name ?? '';
          const argumentsJson = item.arguments ?? '';
          // PV-05: parse first. A call is not surfaced at all until its JSON is known-good.
          const args = parseToolArguments(argumentsJson);
          if (!args.ok) {
            throw malformedToolArgumentsError({
              toolName,
              callId,
              argumentsJson,
              requestId: state.requestId,
              visibleOutputEmitted: state.visibleOutputEmitted,
              cause: args.cause,
            });
          }
          sawToolCall = true;
          yield {
            type: 'tool-call-complete',
            itemId: item.id ?? callId,
            callId,
            toolName,
            argumentsJson,
            arguments: args.value,
          };
        }
        break;
      }

      case 'response.completed': {
        const envelope = ResponsesEnvelopeSchema.parse(parsed);
        const usage = envelope.response.usage;
        yield { type: 'usage', usage: usage != null ? normalizeUsage(usage) : UNKNOWN_USAGE };
        yield {
          type: 'done',
          finishReason: finishReasonFor(envelope.response.status ?? 'completed', sawToolCall),
        };
        finished = true;
        break;
      }

      case 'response.failed':
      case 'response.incomplete': {
        const envelope = ResponsesEnvelopeSchema.parse(parsed);
        throw streamFailureError({
          code:
            envelope.response.error?.code ?? envelope.response.incomplete_details?.reason ?? null,
          message: envelope.response.error?.message ?? `response ended as ${frame.event}`,
          requestId: state.requestId,
          visibleOutputEmitted: state.visibleOutputEmitted,
        });
      }

      case 'error': {
        const err = ResponsesErrorEventSchema.parse(parsed);
        throw streamFailureError({
          code: err.code ?? null,
          message: err.message ?? 'stream error',
          requestId: state.requestId,
          visibleOutputEmitted: state.visibleOutputEmitted,
        });
      }

      default:
        // Includes `response.function_call_arguments.delta` and `.done`, `response.in_progress`,
        // `response.content_part.*`, `response.output_text.done`, and anything the service adds
        // later. Ignoring them is the contract, not an oversight (requirement 6).
        break;
    }

    if (finished) break;
  }

  if (!finished) {
    throw truncatedStreamError({
      visibleOutputEmitted: state.visibleOutputEmitted,
      requestId: state.requestId,
    });
  }
}

function finishReasonFor(status: string, sawToolCall: boolean): FinishReason {
  if (status === 'incomplete') return 'length';
  if (sawToolCall) return 'tool-calls';
  if (status === 'completed') return 'stop';
  return 'unknown';
}

type ParseResult =
  | { readonly ok: true; readonly value: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly cause: unknown };

/**
 * Tool arguments must be a JSON OBJECT. `"42"` and `"[1,2]"` are valid JSON and invalid arguments;
 * accepting them would hand a tool a value its schema can never validate, one layer too late.
 */
export function parseToolArguments(argumentsJson: string): ParseResult {
  const source = argumentsJson.trim() === '' ? '{}' : argumentsJson;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    return { ok: false, cause };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, cause: new TypeError('tool arguments must be a JSON object') };
  }
  return { ok: true, value: parsed as Readonly<Record<string, unknown>> };
}
