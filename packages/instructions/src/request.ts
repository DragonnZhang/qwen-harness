/**
 * Instructions on every request (IN-10).
 *
 * The instruction text is included on every provider request when the transport does not inherit it
 * from server-side state. Crucially, cache optimization may NOT change behavior: whether or not a
 * transport claims to inherit instructions (e.g. Responses replaying a `previous_response_id`), the
 * SAME text is produced and sent. A cache is an optimization of transport, never of meaning — so
 * this helper returns identical text regardless of the inheritance hint, and records separately
 * whether the transport happens to also carry it.
 *
 * This package cannot depend on `provider-core` (see scripts/graph.ts), so the helper is generic
 * over the request object and only fills the `instructions` slot every provider request carries.
 */

import {
  applicableInstructions,
  composeInstructionText,
  type InstructionsLoaded,
} from './resolution.ts';

/** Every normalized provider request carries an `instructions` string. */
export interface RequestInstructions {
  readonly instructions: string;
}

export interface InstructionRequestOptions {
  /** Paths accessed this turn; unlocks matching path-scoped instructions (CX-05, defaults.md). */
  readonly accessedPaths?: readonly string[];
  /** The composed system prompt to prepend, if any. */
  readonly systemPrompt?: string;
  /**
   * Whether the transport also carries instructions server-side. Recorded for observability; it
   * does NOT change the returned text — the same instructions are always sent (IN-10).
   */
  readonly transportInheritsInstructions?: boolean;
}

export interface BuiltRequestInstructions {
  /** The exact instruction text to send. Identical whether or not the transport inherits it. */
  readonly instructions: string;
  /** Always `true`: instructions are sent every request. Present for auditability. */
  readonly sent: true;
  /** Echo of the inheritance hint, for logging only. */
  readonly transportInheritsInstructions: boolean;
}

/**
 * Produce the instruction string for a request: the system prompt (if any) followed by every
 * applicable repository instruction, composed in precedence order. Deterministic and side-effect
 * free.
 */
export function instructionStringForRequest(
  loaded: InstructionsLoaded,
  options: InstructionRequestOptions = {},
): string {
  const applicable = applicableInstructions(loaded, options.accessedPaths ?? []);
  const repositoryText = composeInstructionText(applicable);
  const blocks = [options.systemPrompt, repositoryText].filter(
    (block): block is string => block !== undefined && block.length > 0,
  );
  return blocks.join('\n\n');
}

/**
 * The full IN-10 result: the text plus the invariant record that it is sent every request. The
 * `transportInheritsInstructions` hint is carried through untouched so a caller can log it, but it
 * never gates the text.
 */
export function buildRequestInstructions(
  loaded: InstructionsLoaded,
  options: InstructionRequestOptions = {},
): BuiltRequestInstructions {
  return {
    instructions: instructionStringForRequest(loaded, options),
    sent: true,
    transportInheritsInstructions: options.transportInheritsInstructions ?? false,
  };
}

/**
 * Attach instructions to any request-shaped object, filling the `instructions` slot. Generic so the
 * runtime can use it against the real `ModelRequest` from `provider-core` without this package
 * importing that package.
 */
export function attachInstructions<T extends object>(
  request: T,
  instructions: string,
): T & RequestInstructions {
  return { ...request, instructions };
}
