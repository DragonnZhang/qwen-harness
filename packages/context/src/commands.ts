/**
 * Context commands (CX-06): `/context`, `/compact [focus]`, `/clear`.
 *
 * These are pure descriptions of effects. `/context` reports the budget breakdown; `/compact`
 * triggers compaction with an optional focus and — crucially — DETECTS DIMINISHING RETURNS: if a
 * compaction frees too little, it returns a typed "no further reduction possible" signal instead of
 * looping. Context thrashing (compacting over and over for a shrinking payoff) is stopped safely by
 * the caller acting on that signal.
 */

import type { ModelInputItem } from '@qwen-harness/provider-core';

import {
  computeBudget,
  type BudgetBreakdown,
  type BudgetInput,
  type TokenEstimator,
} from './budget.ts';
import { compact, type CompactionResult, type CompactOptions } from './compaction.ts';

// ---------------------------------------------------------------------------------------------
// /context
// ---------------------------------------------------------------------------------------------

export interface ContextReport {
  readonly budget: BudgetBreakdown;
  /** Human-facing one-line status a client can print directly. */
  readonly status: string;
}

/** `/context`: the current budget breakdown plus a printable status line. */
export function contextCommand(input: BudgetInput): ContextReport {
  const budget = computeBudget(input);
  const pct = budget.utilization === Infinity ? '∞' : `${Math.round(budget.utilization * 100)}%`;
  const status =
    `context: ${budget.usedTokens}/${budget.usableInputBudget} tokens used (${pct}), ` +
    `${budget.availableTokens} available` +
    (budget.overCapacity
      ? ' — OVER CAPACITY'
      : budget.overThreshold
        ? ' — over compaction threshold'
        : '');
  return { budget, status };
}

// ---------------------------------------------------------------------------------------------
// /compact
// ---------------------------------------------------------------------------------------------

/**
 * A compaction must free at least this fraction of its input to be worth committing. Below it, we
 * are thrashing — spending a model call for negligible headroom — so we stop.
 */
export const DEFAULT_MIN_FREED_FRACTION = 0.1;

export type CompactionOutcome =
  | { readonly kind: 'compacted'; readonly result: CompactionResult }
  | {
      readonly kind: 'no-further-reduction';
      readonly reason: string;
      readonly tokensBefore: number;
      readonly tokensAfter: number;
      readonly freedTokens: number;
    };

/**
 * Decide whether a completed compaction made enough progress. Returns the typed
 * `no-further-reduction` signal when the freed fraction is below `minFreedFraction` (or when
 * compaction did not shrink the payload at all), so a scheduler can stop rather than loop.
 */
export function evaluateCompaction(
  result: CompactionResult,
  minFreedFraction: number = DEFAULT_MIN_FREED_FRACTION,
): CompactionOutcome {
  const freedFraction = result.tokensBefore > 0 ? result.freedTokens / result.tokensBefore : 0;
  if (result.freedTokens <= 0 || freedFraction < minFreedFraction) {
    return {
      kind: 'no-further-reduction',
      reason:
        result.freedTokens <= 0
          ? 'compaction did not reduce the transcript'
          : `compaction freed ${(freedFraction * 100).toFixed(1)}% (< ${(minFreedFraction * 100).toFixed(0)}% threshold)`,
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
      freedTokens: result.freedTokens,
    };
  }
  return { kind: 'compacted', result };
}

export interface CompactCommandOptions extends CompactOptions {
  /** Optional focus for the summary — the `[focus]` argument of `/compact`. */
  readonly focus?: string;
  /** Diminishing-returns threshold. Defaults to `DEFAULT_MIN_FREED_FRACTION`. */
  readonly minFreedFraction?: number;
}

/**
 * `/compact [focus]`: run compaction, then apply the diminishing-returns guard. The result is
 * either a committed compaction or the typed no-further-reduction signal — never a loop.
 */
export async function compactCommand(options: CompactCommandOptions): Promise<CompactionOutcome> {
  const result = await compact(options);
  return evaluateCompaction(result, options.minFreedFraction);
}

/**
 * Detect thrashing across successive compactions: if the most recent one freed less than
 * `minFreedFraction`, further compaction is not worthwhile. A pure predicate the caller consults
 * before scheduling another pass.
 */
export function isDiminishingReturns(
  previousTokens: number,
  currentTokens: number,
  minFreedFraction: number = DEFAULT_MIN_FREED_FRACTION,
): boolean {
  if (previousTokens <= 0) return true;
  const freed = (previousTokens - currentTokens) / previousTokens;
  return freed < minFreedFraction;
}

// ---------------------------------------------------------------------------------------------
// /clear
// ---------------------------------------------------------------------------------------------

export interface ClearOptions {
  readonly contextWindow: number;
  readonly reserveFraction?: number;
  readonly estimate?: TokenEstimator;
  /** Timestamp of the clear, from an injected clock. `null` when the caller does not supply one. */
  readonly clearedAt?: number;
}

export interface ClearedState {
  /** The transcript after `/clear`: empty. */
  readonly items: readonly ModelInputItem[];
  /** No offloaded references survive a clear. */
  readonly refs: readonly [];
  readonly clearedAt: number | null;
  /** Budget recomputed against the empty transcript, so a client can show the reset immediately. */
  readonly budget: BudgetBreakdown;
}

/** `/clear`: reset the context to empty and report the fresh (near-zero) budget. */
export function clearCommand(options: ClearOptions): ClearedState {
  const items: readonly ModelInputItem[] = [];
  const budget = computeBudget({
    contextWindow: options.contextWindow,
    items,
    ...(options.reserveFraction !== undefined ? { reserveFraction: options.reserveFraction } : {}),
    ...(options.estimate !== undefined ? { estimate: options.estimate } : {}),
  });
  return {
    items,
    refs: [],
    clearedAt: options.clearedAt ?? null,
    budget,
  };
}
