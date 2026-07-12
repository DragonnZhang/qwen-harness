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

import { malformedToolArgumentsError, truncatedStreamError } from './errors.ts';
import { openSseStream, type StreamState } from './http.ts';
import { chatEnableThinking } from './reasoning.ts';
import { parseToolArguments, type TransportContext } from './responses-transport.ts';
import { SSE_DONE, readSseFrames } from './sse.ts';
import type { ChatUsageSchema } from './wire.ts';
import { ChatChunkSchema } from './wire.ts';

/**
 * The Chat Completions compatibility transport.
 *
 * Two things about this wire are load-bearing and both are security-relevant:
 *
 *  1. `delta.reasoning_content` is RAW private chain-of-thought, not a summary. It is discarded
 *     here and never leaves this file. The only trace it leaves is a `reasoning-status` event,
 *     whose type has no field capable of holding text (PV-04).
 *  2. `delta.tool_calls` is FRAGMENTED. `id` and `function.name` arrive on the first fragment only;
 *     every later fragment has an empty `id` and a slice of the argument string. `index` is the
 *     sole stable identity, so assembly keys on it (PV-05).
 */
export const CHAT_CAPABILITIES: ProviderCapabilities = freezeCapabilities({
  textStreaming: true,
  /** `reasoning_content` is NOT a summary. This transport returns no summary at all. */
  reasoningSummary: false,
  /** Binary thinking only. minimal/low/high are rejected, never rounded (PV-13). */
  reasoningEffortGranularity: 'binary',
  incrementalToolArgs: true,
  background: false,
  structuredOutput: false,
  /**
   * `tool_stream` is an optional vendor capability we do not implement. Declaring `true` because
   * the vendor offers it would claim support this adapter has never exercised.
   */
  toolStream: false,
});

interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly tool_calls?: readonly unknown[];
  readonly tool_call_id?: string;
}

/**
 * Chat has no `function_call` item type: a call is an assistant message carrying `tool_calls`, and
 * consecutive calls from one model turn belong to ONE such message. Splitting them into several
 * assistant messages would misrepresent the turn structure to the model on the next round trip.
 */
export function toChatMessages(
  instructions: string,
  items: readonly ModelInputItem[],
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (instructions !== '') messages.push({ role: 'system', content: instructions });

  let pendingCalls: unknown[] = [];
  const flushCalls = (): void => {
    if (pendingCalls.length === 0) return;
    messages.push({ role: 'assistant', content: '', tool_calls: pendingCalls });
    pendingCalls = [];
  };

  for (const item of items) {
    if (item.type === 'function-call') {
      pendingCalls.push({
        id: item.callId,
        type: 'function',
        function: { name: item.name, arguments: item.argumentsJson },
      });
      continue;
    }
    flushCalls();
    if (item.type === 'message') {
      messages.push({ role: item.role, content: item.text });
    } else {
      messages.push({ role: 'tool', content: item.output, tool_call_id: item.callId });
    }
  }
  flushCalls();
  return messages;
}

export function buildChatBody(
  request: ModelRequest,
  effort: ReasoningEffort,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: toChatMessages(request.instructions, request.input),
    stream: true,
    // PV-09: without this the final usage chunk never arrives and every count stays null.
    stream_options: { include_usage: true },
    // Top-level, translated from the effort scale. NEVER a Python-style `extra_body` (PV-13).
    enable_thinking: chatEnableThinking(effort),
  };
  if (request.tools.length > 0) {
    body['tools'] = request.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }
  if (request.maxOutputTokens !== undefined) body['max_tokens'] = request.maxOutputTokens;
  return body;
}

function normalizeUsage(raw: z.infer<typeof ChatUsageSchema>): NormalizedUsage {
  return {
    inputTokens: raw.prompt_tokens ?? null,
    outputTokens: raw.completion_tokens ?? null,
    totalTokens: raw.total_tokens ?? null,
    reasoningTokens: raw.completion_tokens_details?.reasoning_tokens ?? null,
    cachedInputTokens: raw.prompt_tokens_details?.cached_tokens ?? null,
  };
}

function chatFinishReason(raw: string | null): FinishReason {
  switch (raw) {
    case 'stop':
      return 'stop';
    case 'tool_calls':
    case 'function_call':
      return 'tool-calls';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content-filter';
    default:
      return 'unknown';
  }
}

/** One tool call under construction, identified by `index` across fragments. */
interface PendingToolCall {
  callId: string;
  toolName: string;
  argumentsJson: string;
  begun: boolean;
}

export async function* streamChat(
  ctx: TransportContext,
  request: ModelRequest,
  effort: ReasoningEffort,
  state: StreamState,
): AsyncGenerator<ProviderStreamEvent> {
  // Throws the typed unsupported-granularity error BEFORE any socket is opened.
  const body = buildChatBody(request, effort);

  const stream = await openSseStream({
    url: ctx.url,
    apiKey: ctx.apiKey,
    body,
    signal: request.signal,
    fetchImpl: ctx.fetchImpl,
    state,
  });

  if (state.requestId !== null) yield { type: 'request-id', requestId: state.requestId };

  const pending = new Map<number, PendingToolCall>();
  let reasoningOccurred = false;
  let usage: NormalizedUsage | null = null;
  let finishReason: FinishReason | null = null;
  let completedCalls = 0;

  for await (const frame of readSseFrames(stream, request.signal)) {
    if (frame.data === SSE_DONE) break;
    const chunk = ChatChunkSchema.parse(JSON.parse(frame.data));

    if (state.requestId === null && chunk.id != null && chunk.id !== '') {
      state.requestId = chunk.id;
      yield { type: 'request-id', requestId: chunk.id };
    }

    // The FINAL chunk carries `choices: []` and the usage (PV-09).
    if (chunk.usage != null) usage = normalizeUsage(chunk.usage);

    for (const choice of chunk.choices) {
      const delta = choice.delta;

      if (delta?.content != null && delta.content !== '') {
        state.visibleOutputEmitted = true;
        yield { type: 'text-delta', itemId: chunk.id ?? '', delta: delta.content };
      }

      // ---------------------------------------------------------------------------------------
      // PV-04. `reasoning_content` is raw private reasoning. It is read here ONLY to know that it
      // happened, and the string is dropped on the floor. It is not accumulated, not returned, not
      // persisted, and not relabeled as a summary. `reasoning-status` carries a flag and a token
      // count — there is no field it could be smuggled through.
      // ---------------------------------------------------------------------------------------
      if (delta?.reasoning_content != null && delta.reasoning_content !== '') {
        if (!reasoningOccurred) {
          reasoningOccurred = true;
          // Emitted immediately so a UI can honestly say "the model is thinking" while it happens.
          // The token count is not known until the usage chunk, so it is null here.
          yield { type: 'reasoning-status', reasoningOccurred: true, reasoningTokens: null };
        }
      }

      for (const fragment of delta?.tool_calls ?? []) {
        const existing = pending.get(fragment.index);
        const call: PendingToolCall = existing ?? {
          callId: '',
          toolName: '',
          argumentsJson: '',
          begun: false,
        };
        // `id` and `name` are present on the FIRST fragment only; later ones send `id: ""`.
        if (fragment.id != null && fragment.id !== '') call.callId = fragment.id;
        if (fragment.function?.name != null && fragment.function.name !== '') {
          call.toolName = fragment.function.name;
        }
        if (fragment.function?.arguments != null) call.argumentsJson += fragment.function.arguments;
        pending.set(fragment.index, call);

        if (!call.begun && call.callId !== '' && call.toolName !== '') {
          call.begun = true;
          yield {
            type: 'tool-call-begin',
            itemId: call.callId,
            callId: call.callId,
            toolName: call.toolName,
          };
        }
      }

      if (choice.finish_reason != null && choice.finish_reason !== '') {
        finishReason = chatFinishReason(choice.finish_reason);

        // The stream has closed every call. Only NOW may a call be surfaced (PV-05): the argument
        // stream is complete and the JSON must parse. Emit in index order so tool ordering is the
        // model's ordering, not map-insertion luck.
        for (const index of [...pending.keys()].sort((a, b) => a - b)) {
          const call = pending.get(index);
          if (call === undefined) continue;
          const args = parseToolArguments(call.argumentsJson);
          if (!args.ok) {
            throw malformedToolArgumentsError({
              toolName: call.toolName,
              callId: call.callId,
              argumentsJson: call.argumentsJson,
              requestId: state.requestId,
              visibleOutputEmitted: state.visibleOutputEmitted,
              cause: args.cause,
            });
          }
          completedCalls += 1;
          yield {
            type: 'tool-call-complete',
            itemId: call.callId,
            callId: call.callId,
            toolName: call.toolName,
            argumentsJson: call.argumentsJson,
            arguments: args.value,
          };
        }
        pending.clear();
      }
    }
  }

  if (finishReason === null) {
    throw truncatedStreamError({
      visibleOutputEmitted: state.visibleOutputEmitted,
      requestId: state.requestId,
    });
  }

  yield { type: 'usage', usage: usage ?? UNKNOWN_USAGE };

  // The eventual token count for the reasoning we discarded. Still no text — by construction.
  if (reasoningOccurred) {
    yield {
      type: 'reasoning-status',
      reasoningOccurred: true,
      reasoningTokens: usage?.reasoningTokens ?? null,
    };
  }

  // The server may report `stop` while still having emitted calls; trust what we actually parsed.
  yield {
    type: 'done',
    finishReason: completedCalls > 0 ? 'tool-calls' : finishReason,
  };
}
