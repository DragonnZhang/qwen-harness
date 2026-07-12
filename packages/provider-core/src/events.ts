import type { HarnessError } from '@qwen-harness/protocol';

import type { NormalizedUsage } from './usage.ts';

/** Why the model stopped. A stream always ends with a named reason or with an error. */
export type FinishReason = 'stop' | 'tool-calls' | 'length' | 'content-filter' | 'unknown';

/**
 * The normalized stream. This is the ONLY thing a provider is allowed to emit; a vendor wire
 * object never crosses this boundary (task.md boundary 6).
 *
 * Two shapes here exist because of the security contract, not for convenience:
 *
 *  - `reasoning-summary-*` carries a reasoning SUMMARY — model-authored, renderable, persistable.
 *  - `reasoning-status` carries NO text at all. It is what a transport emits when it saw raw
 *    private chain-of-thought and threw it away (PV-04). It can never be relabeled as a summary
 *    because it has no field that could hold one.
 *
 * `tool-call-complete` is emitted only after the full argument stream closed AND the JSON parsed
 * (PV-05), so a consumer that acts on this event can never act on half an argument object.
 */
export type ProviderStreamEvent =
  /** Provider request ID, emitted as early as the transport knows it, for support and audit. */
  | { readonly type: 'request-id'; readonly requestId: string }
  | { readonly type: 'text-delta'; readonly itemId: string; readonly delta: string }
  | { readonly type: 'text-done'; readonly itemId: string; readonly text: string }
  | { readonly type: 'reasoning-summary-delta'; readonly itemId: string; readonly delta: string }
  | { readonly type: 'reasoning-summary-done'; readonly itemId: string; readonly summary: string }
  | {
      readonly type: 'reasoning-status';
      readonly reasoningOccurred: true;
      /** Token count only. There is deliberately no field that could carry reasoning text. */
      readonly reasoningTokens: number | null;
    }
  | {
      readonly type: 'tool-call-begin';
      readonly itemId: string;
      readonly callId: string;
      readonly toolName: string;
    }
  | {
      readonly type: 'tool-call-complete';
      readonly itemId: string;
      /** Exact provider call ID, preserved byte-for-byte so outputs pair correctly (PV-06). */
      readonly callId: string;
      readonly toolName: string;
      /** Raw JSON as the model produced it, retained for audit and exact-approval binding. */
      readonly argumentsJson: string;
      /** Parsed arguments. Present only because the parse already succeeded. */
      readonly arguments: Readonly<Record<string, unknown>>;
    }
  | { readonly type: 'usage'; readonly usage: NormalizedUsage }
  | { readonly type: 'error'; readonly error: HarnessError }
  | { readonly type: 'done'; readonly finishReason: FinishReason };

export type ProviderStreamEventType = ProviderStreamEvent['type'];
