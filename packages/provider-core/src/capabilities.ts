/**
 * What a transport can actually do. This is a frozen TABLE, not a negotiation: a successful
 * response can never upgrade a bit here, because an unsupported parameter may simply be ignored
 * by the server, and "it did not complain" is not evidence of support (PV-07).
 *
 * Changing a bit requires newer official documentation, a captured contract fixture, and an ADR.
 */
export type ReasoningEffortGranularity =
  /** The transport takes no effort parameter at all. */
  | 'none'
  /** Thinking is on or off; anything finer must be REJECTED, never rounded. */
  | 'binary'
  /** The full none/minimal/low/medium/high scale. */
  | 'graded';

export interface ProviderCapabilities {
  readonly textStreaming: boolean;
  /** True only when the transport returns a model-authored SUMMARY, never raw reasoning. */
  readonly reasoningSummary: boolean;
  readonly reasoningEffortGranularity: ReasoningEffortGranularity;
  /** Whether argument deltas are usable. False does NOT mean tool calls are unsupported. */
  readonly incrementalToolArgs: boolean;
  readonly background: boolean;
  readonly structuredOutput: boolean;
  readonly toolStream: boolean;
}

/** Freeze a capability table so a caller cannot mutate a bit at runtime to unlock a feature. */
export function freezeCapabilities(table: ProviderCapabilities): Readonly<ProviderCapabilities> {
  return Object.freeze({ ...table });
}
