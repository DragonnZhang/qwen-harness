/**
 * Context budgeting (CX-01).
 *
 * Given the provider's context window and the items we intend to send, estimate the serialized
 * token cost, reserve headroom for the response and tool overhead, and report utilization. Two
 * defaults are frozen in `docs/product/defaults.md` and encoded here:
 *
 *   • reserve 15% of the context window for response + tool overhead;
 *   • start proactive compaction at 85% of the USABLE input budget (window minus reserve).
 *
 * The token estimator is intentionally simple and INJECTABLE. The default (~4 characters per token)
 * is a coarse but deterministic proxy — a budget that is reproducible and slightly conservative is
 * worth more here than one that is precise but depends on a live tokenizer. A caller with a real
 * tokenizer passes its own estimator; nothing else changes.
 */

import type { ModelInputItem } from '@qwen-harness/provider-core';

export type TokenEstimator = (text: string) => number;

/** ~4 characters per token — the documented default proxy. */
export const DEFAULT_CHARS_PER_TOKEN = 4;

export const defaultTokenEstimator: TokenEstimator = (text) =>
  Math.ceil(text.length / DEFAULT_CHARS_PER_TOKEN);

/** Reserve 15% of the window for response + tool overhead (defaults.md). */
export const DEFAULT_RESERVE_FRACTION = 0.15;

/** Proactive compaction begins at 85% of the usable input budget (defaults.md). */
export const PROACTIVE_THRESHOLD_FRACTION = 0.85;

/**
 * Serialize one input item to the text whose length we estimate. Field labels are included so a
 * function-call's name and arguments are counted, not just its output — an estimate that ignored
 * them would systematically under-report tool-heavy turns.
 */
export function serializeInputItem(item: ModelInputItem): string {
  switch (item.type) {
    case 'message':
      return `${item.role}: ${item.text}`;
    case 'function-call':
      return `call ${item.name} ${item.callId} ${item.argumentsJson}`;
    case 'function-output':
      return `output ${item.name} ${item.callId} ${item.output}`;
  }
}

export function estimateItems(
  items: readonly ModelInputItem[],
  estimate: TokenEstimator = defaultTokenEstimator,
): number {
  let total = 0;
  for (const item of items) total += estimate(serializeInputItem(item));
  return total;
}

export interface BudgetInput {
  /** Provider capability: the declared context-window size in tokens. */
  readonly contextWindow: number;
  readonly items: readonly ModelInputItem[];
  /** Fraction reserved for response + tool overhead. Defaults to 15%. */
  readonly reserveFraction?: number;
  readonly estimate?: TokenEstimator;
  /** Already-committed overhead (system prompt, tool schemas) counted against the input budget. */
  readonly fixedOverheadTokens?: number;
}

export interface BudgetBreakdown {
  readonly contextWindow: number;
  readonly reserveFraction: number;
  /** Tokens withheld for response + tool overhead. */
  readonly reservedTokens: number;
  /** What is actually available for input: window minus reserve. */
  readonly usableInputBudget: number;
  readonly fixedOverheadTokens: number;
  /** Estimated tokens in use: items plus fixed overhead. */
  readonly usedTokens: number;
  /** Room left before the usable input budget is exhausted (never negative). */
  readonly availableTokens: number;
  /** used / usable. May exceed 1 when input already overflows the usable budget. */
  readonly utilization: number;
  /** The proactive threshold as a fraction (0.85). */
  readonly proactiveThreshold: number;
  /** The proactive threshold in tokens: 85% of the usable input budget. */
  readonly proactiveLimitTokens: number;
  /** True once utilization reaches the proactive threshold — time to compact proactively. */
  readonly overThreshold: boolean;
  /** True when input already exceeds the usable budget — reactive overflow territory. */
  readonly overCapacity: boolean;
}

/**
 * Compute the budget breakdown. Reserve is rounded so the reserved + usable split is exact against
 * the window; the proactive limit is floored so crossing it is unambiguous.
 */
export function computeBudget(input: BudgetInput): BudgetBreakdown {
  const reserveFraction = input.reserveFraction ?? DEFAULT_RESERVE_FRACTION;
  const estimate = input.estimate ?? defaultTokenEstimator;
  const fixedOverheadTokens = input.fixedOverheadTokens ?? 0;

  const reservedTokens = Math.round(input.contextWindow * reserveFraction);
  const usableInputBudget = Math.max(0, input.contextWindow - reservedTokens);
  const usedTokens = estimateItems(input.items, estimate) + fixedOverheadTokens;
  const availableTokens = Math.max(0, usableInputBudget - usedTokens);
  const utilization = usableInputBudget === 0 ? Infinity : usedTokens / usableInputBudget;
  const proactiveLimitTokens = Math.floor(usableInputBudget * PROACTIVE_THRESHOLD_FRACTION);

  return {
    contextWindow: input.contextWindow,
    reserveFraction,
    reservedTokens,
    usableInputBudget,
    fixedOverheadTokens,
    usedTokens,
    availableTokens,
    utilization,
    proactiveThreshold: PROACTIVE_THRESHOLD_FRACTION,
    proactiveLimitTokens,
    overThreshold: usedTokens >= proactiveLimitTokens,
    overCapacity: usedTokens > usableInputBudget,
  };
}
