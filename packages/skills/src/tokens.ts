/**
 * Token accounting for skill budgets (IN-05).
 *
 * A budget that cannot be computed cannot be enforced, and a budget computed by calling a model
 * tokenizer would make catalog assembly non-deterministic and network-dependent. So the estimator
 * is a pure, documented function of the text: 4 characters per token, rounded up.
 *
 * The estimate is deliberately CONSERVATIVE in the direction that matters. It is an upper-bounded
 * approximation used to decide what to INCLUDE; being slightly wrong makes the catalog marginally
 * smaller or larger than a real tokenizer would, never unbounded. The property the budgets exist to
 * guarantee — "the catalog cannot grow without limit as skills are added" — holds for any monotone
 * estimator, and this one is monotone in text length by construction.
 */

/** Characters per estimated token. The one place this ratio is written down. */
export const CHARS_PER_TOKEN = 4;

/** Deterministic token estimate. Same string in, same number out, on every machine, forever. */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** The character budget that corresponds to a token budget. */
export function tokensToChars(tokens: number): number {
  return Math.max(0, Math.floor(tokens)) * CHARS_PER_TOKEN;
}

/** The marker appended to any truncated body, so a truncation is never invisible to the model. */
export const TRUNCATION_MARKER = '\n\n[skill body truncated: loaded-content token budget reached]';

export interface TruncatedText {
  readonly text: string;
  readonly tokens: number;
  readonly truncated: boolean;
  /** Tokens the untruncated text would have cost. Equals `tokens` when nothing was cut. */
  readonly originalTokens: number;
}

/**
 * Truncate text to a token budget DETERMINISTICALLY.
 *
 * Cutting mid-line would hand the model a half-sentence that reads like a complete instruction, so
 * we cut at the last newline inside the character budget when there is one (and at the raw
 * character boundary when there is not — a single enormous line still has to be bounded). The
 * marker is always appended, which is what makes the truncation OBSERVABLE to the model itself, not
 * only to the runtime that emitted the signal.
 */
export function truncateToTokens(text: string, budgetTokens: number): TruncatedText {
  const originalTokens = estimateTokens(text);
  if (originalTokens <= budgetTokens) {
    return { text, tokens: originalTokens, truncated: false, originalTokens };
  }

  const maxChars = Math.max(0, tokensToChars(budgetTokens) - TRUNCATION_MARKER.length);
  const head = text.slice(0, maxChars);
  const lastNewline = head.lastIndexOf('\n');
  const cut = lastNewline > 0 ? head.slice(0, lastNewline) : head;
  const out = `${cut}${TRUNCATION_MARKER}`;
  return { text: out, tokens: estimateTokens(out), truncated: true, originalTokens };
}
