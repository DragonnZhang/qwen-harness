/**
 * Normalized token usage.
 *
 * Every field is `number | null` and an unknown value STAYS null (PV-09). Coercing a missing count
 * to 0 would make a budget silently under-report, and a budget that under-reports is worse than a
 * budget that admits it does not know.
 *
 * `reasoningTokens` is a subset of `outputTokens`, not an addition to it: reasoning tokens are
 * output tokens and are billable.
 */
export interface NormalizedUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly cachedInputTokens: number | null;
}

export const UNKNOWN_USAGE: NormalizedUsage = Object.freeze({
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  reasoningTokens: null,
  cachedInputTokens: null,
});

/** Sum two usages, treating unknown as unknown: `null + n` is `n`, `null + null` stays `null`. */
export function addUsage(a: NormalizedUsage, b: NormalizedUsage): NormalizedUsage {
  const add = (x: number | null, y: number | null): number | null =>
    x === null && y === null ? null : (x ?? 0) + (y ?? 0);
  return Object.freeze({
    inputTokens: add(a.inputTokens, b.inputTokens),
    outputTokens: add(a.outputTokens, b.outputTokens),
    totalTokens: add(a.totalTokens, b.totalTokens),
    reasoningTokens: add(a.reasoningTokens, b.reasoningTokens),
    cachedInputTokens: add(a.cachedInputTokens, b.cachedInputTokens),
  });
}
