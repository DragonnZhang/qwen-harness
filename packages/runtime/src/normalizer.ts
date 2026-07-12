import type { NormalizedUsage, ProviderStreamEvent } from '@qwen-harness/provider-core';

/**
 * Accumulates one model round's stream events into a finished, ordered result.
 *
 * The provider layer already normalized wire formats into typed events; this turns the *stream* of
 * those events into the *outcome* the runtime acts on — the assistant text, the reasoning summary,
 * the complete tool calls (paired by call ID), the usage, and the finish reason.
 *
 * It deliberately holds no I/O and no policy. It is a fold over events, so it is trivially testable
 * against the captured provider fixtures.
 */
export interface NormalizedToolCall {
  readonly itemId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly argumentsJson: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface NormalizedRound {
  readonly assistantText: string;
  /** A reasoning SUMMARY, never raw chain-of-thought. Null if none was returned (Chat transport). */
  readonly reasoningSummary: string | null;
  /** True if the model reasoned but we discarded the raw text (Chat) — a status, not content. */
  readonly reasoningOccurred: boolean;
  readonly toolCalls: readonly NormalizedToolCall[];
  readonly usage: NormalizedUsage | null;
  readonly requestId: string | null;
  readonly finishReason: string | null;
  /** Every stream error, in order. Non-empty means the round did not complete cleanly. */
  readonly errors: readonly Error[];
}

export class RoundNormalizer {
  #text = '';
  #summary = '';
  #summarySeen = false;
  #reasoningOccurred = false;
  #toolCalls: NormalizedToolCall[] = [];
  #usage: NormalizedUsage | null = null;
  #requestId: string | null = null;
  #finishReason: string | null = null;
  #errors: Error[] = [];

  accept(event: ProviderStreamEvent): void {
    switch (event.type) {
      case 'request-id':
        this.#requestId = event.requestId;
        break;
      case 'text-delta':
        this.#text += event.delta;
        break;
      case 'text-done':
        // The done event carries the authoritative full text; prefer it over accumulated deltas,
        // which can differ if the transport re-segmented.
        this.#text = event.text;
        break;
      case 'reasoning-summary-delta':
        this.#summary += event.delta;
        this.#summarySeen = true;
        break;
      case 'reasoning-summary-done':
        this.#summary = event.summary;
        this.#summarySeen = true;
        break;
      case 'reasoning-status':
        // Chat transport reasoned; we never received or kept the text. Record only that it happened.
        this.#reasoningOccurred = true;
        break;
      case 'tool-call-begin':
        // Nothing durable yet — a call is only real once its arguments have parsed (PV-05). The
        // begin event exists so a UI can show "calling X…" while arguments stream.
        break;
      case 'tool-call-complete':
        this.#toolCalls.push({
          itemId: event.itemId,
          callId: event.callId,
          toolName: event.toolName,
          argumentsJson: event.argumentsJson,
          arguments: event.arguments,
        });
        break;
      case 'usage':
        this.#usage = event.usage;
        break;
      case 'done':
        this.#finishReason = event.finishReason;
        break;
      case 'error':
        this.#errors.push(event.error);
        break;
    }
  }

  finish(): NormalizedRound {
    return {
      assistantText: this.#text,
      reasoningSummary: this.#summarySeen ? this.#summary : null,
      reasoningOccurred: this.#reasoningOccurred || this.#summarySeen,
      toolCalls: this.#toolCalls,
      usage: this.#usage,
      requestId: this.#requestId,
      finishReason: this.#finishReason,
      errors: this.#errors,
    };
  }
}

/** Convenience: fold an entire event stream into one round. */
export async function normalizeRound(
  events: AsyncIterable<ProviderStreamEvent>,
): Promise<NormalizedRound> {
  const n = new RoundNormalizer();
  for await (const event of events) n.accept(event);
  return n.finish();
}
