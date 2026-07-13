/**
 * Background work categories and foreground/background classification (BG-01, BG-03).
 *
 * Only the three categories whose owners exist today are modelled. Agent, teammate, remote, and MCP
 * background work are added later, once those owners land — a no-op placeholder category would be a
 * lie the lifecycle has to special-case, so it is deliberately absent.
 */

export const BACKGROUND_CATEGORIES = [
  'local-shell',
  'local-workflow',
  'dream-consolidation',
] as const;

export type BackgroundCategory = (typeof BACKGROUND_CATEGORIES)[number];

export function isBackgroundCategory(value: string): value is BackgroundCategory {
  return (BACKGROUND_CATEGORIES as readonly string[]).includes(value);
}

/** Where a task runs: foreground counts against the four-way concurrency limit; background does not. */
export type Placement = 'foreground' | 'background';

/**
 * A hint used ONLY when neither the model nor the user stated a placement. It is intentionally not a
 * duration estimate (BG-01 forbids an "opaque duration guess"): it is a small, explicit signal, and
 * the fallback is conservative.
 */
export interface ForegroundHint {
  /** True when the work is known to be long-lived (e.g. a watch/daemon). Long-lived leans background. */
  readonly longLived?: boolean;
  /** True when the work needs the user's attention/terminal. Interactive leans foreground. */
  readonly interactive?: boolean;
}

/**
 * Decide placement (BG-01). An EXPLICIT choice always wins. With no explicit choice we fall back to a
 * conservative rule, NOT a duration guess: default to FOREGROUND (keep the work visible and attached,
 * subject to the concurrency limit) unless the hint clearly indicates long-lived, non-interactive
 * work, which is the only case safe to background on its own. "When unsure, stay foreground" is the
 * conservative side: it never silently detaches work the user is watching.
 */
export function classifyForeground(input: {
  explicit?: Placement;
  hint?: ForegroundHint;
}): Placement {
  if (input.explicit) return input.explicit;

  const hint = input.hint;
  if (hint?.longLived === true && hint.interactive !== true) return 'background';
  return 'foreground';
}
