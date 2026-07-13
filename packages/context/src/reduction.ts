/**
 * Cheap reduction BEFORE compaction (CX-02).
 *
 * Compaction is expensive (a model call) and lossy (prose replaces structure). So we run cheaper,
 * loss-bounded steps first, IN ORDER:
 *
 *   (a) offload large tool results to a durable reference, keeping a bounded preview inline;
 *   (b) prune only SAFE middle content — plain messages between the goal and the recent tail;
 *   (c) if a target is set and still over it, drop the OLDEST complete tool-call/result PAIRS,
 *       always removing a call and its result TOGETHER.
 *
 * The invariant that dominates every step: a tool RESULT is never orphaned from its CALL. We only
 * ever (1) shrink a result's body while keeping the item, (2) delete plain messages, or (3) delete
 * a call and its matching result as a unit. `isPairingIntact` is the checkable statement of that.
 */

import type { ModelInputItem } from '@qwen-harness/provider-core';

import { defaultTokenEstimator, estimateItems, type TokenEstimator } from './budget.ts';
import {
  makeContextRef,
  renderOffloaded,
  type ContextRef,
  type RefPreviewOptions,
} from './refs.ts';

type FunctionOutput = Extract<ModelInputItem, { type: 'function-output' }>;

/**
 * True when every tool RESULT is paired with a preceding CALL of the same id. This is the property
 * the whole module protects: a result must never appear without the call that produced it, because
 * a provider given an orphan output has no request to attach it to.
 */
export function isPairingIntact(items: readonly ModelInputItem[]): boolean {
  const seenCalls = new Set<string>();
  for (const item of items) {
    if (item.type === 'function-call') seenCalls.add(item.callId);
    else if (item.type === 'function-output' && !seenCalls.has(item.callId)) return false;
  }
  return true;
}

export interface ReductionOptions {
  readonly estimate?: TokenEstimator;
  /** Produce the opaque durable ref id for an offloaded result. Deterministic in tests. */
  readonly makeRefId: (item: FunctionOutput, index: number) => string;
  /** Results longer than this (in chars) are offloaded/referenced. Default 2048. */
  readonly offloadThresholdChars?: number;
  /** Keep the last N items untouched — recent context is the most valuable. Default 4. */
  readonly preserveRecent?: number;
  readonly previewOptions?: RefPreviewOptions;
  /**
   * Optional token target. When set and reduction is still above it after (a) and (b), the oldest
   * complete call/result pairs are dropped (together) until under target or nothing droppable
   * remains.
   */
  readonly targetTokens?: number;
}

export interface ReductionResult {
  readonly items: readonly ModelInputItem[];
  readonly refs: readonly ContextRef[];
  readonly offloadedCount: number;
  readonly prunedCount: number;
  readonly droppedPairCount: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  /** Always true; returned so callers and tests can assert the invariant held. */
  readonly pairingIntact: boolean;
}

export function reduceContext(
  items: readonly ModelInputItem[],
  options: ReductionOptions,
): ReductionResult {
  const estimate = options.estimate ?? defaultTokenEstimator;
  const preserveRecent = options.preserveRecent ?? 4;
  const offloadThreshold = options.offloadThresholdChars ?? 2048;
  const tokensBefore = estimateItems(items, estimate);
  const n = items.length;
  const recentStart = Math.max(0, n - preserveRecent);

  const refs: ContextRef[] = [];
  let offloadedCount = 0;
  let prunedCount = 0;
  let droppedPairCount = 0;

  // (a) + (c-inline): offload/replace old tool results with references. Recent results are left
  // whole. Pairing is untouched: the item stays, only its body shrinks.
  const offloaded: ModelInputItem[] = items.map((item, i) => {
    if (i >= recentStart) return item;
    if (item.type === 'function-output' && item.output.length > offloadThreshold) {
      const ref = makeContextRef(options.makeRefId(item, i), item.output, 'tool-result', {
        ...options.previewOptions,
        estimate,
      });
      refs.push(ref);
      offloadedCount += 1;
      return { ...item, output: renderOffloaded(ref) };
    }
    return item;
  });

  // (b) prune safe middle content: plain messages strictly between the first item (the goal) and
  // the recent tail. Never a tool call or result, so pairing cannot break.
  const pruned: ModelInputItem[] = [];
  offloaded.forEach((item, i) => {
    const isMiddle = i > 0 && i < recentStart;
    if (isMiddle && item.type === 'message') {
      prunedCount += 1;
      return;
    }
    pruned.push(item);
  });

  // (c) if still over target, drop oldest complete pairs — call AND result together.
  let working = pruned;
  if (options.targetTokens !== undefined) {
    const dropped = dropOldestPairsUntil(working, options.targetTokens, recentStart, estimate);
    working = dropped.items;
    droppedPairCount = dropped.droppedPairs;
  }

  const tokensAfter = estimateItems(working, estimate);
  return {
    items: working,
    refs,
    offloadedCount,
    prunedCount,
    droppedPairCount,
    tokensBefore,
    tokensAfter,
    pairingIntact: isPairingIntact(working),
  };
}

/**
 * Drop the oldest complete call/result pairs (each as a unit) until the estimate is at or below
 * `target`, or no droppable pair remains. Pairs whose members fall inside the preserved-recent
 * window are never dropped. Stops as soon as it cannot make progress — the diminishing-returns
 * guard at the reduction layer.
 */
function dropOldestPairsUntil(
  items: readonly ModelInputItem[],
  target: number,
  recentStart: number,
  estimate: TokenEstimator,
): { items: ModelInputItem[]; droppedPairs: number } {
  const remove = new Set<number>();
  let droppedPairs = 0;

  const pairs = completePairs(items).filter(
    (p) => p.callIndex < recentStart && p.outputIndex < recentStart,
  );

  for (const pair of pairs) {
    if (estimateItems(surviving(items, remove), estimate) <= target) break;
    remove.add(pair.callIndex);
    remove.add(pair.outputIndex);
    droppedPairs += 1;
  }

  return { items: surviving(items, remove), droppedPairs };
}

interface Pair {
  readonly callId: string;
  readonly callIndex: number;
  readonly outputIndex: number;
}

/** Complete call/result pairs, in call order. A call with no result is not a pair (never dropped). */
function completePairs(items: readonly ModelInputItem[]): Pair[] {
  const callIndex = new Map<string, number>();
  const pairs: Pair[] = [];
  items.forEach((item, i) => {
    if (item.type === 'function-call') {
      callIndex.set(item.callId, i);
    } else if (item.type === 'function-output') {
      const ci = callIndex.get(item.callId);
      if (ci !== undefined) {
        pairs.push({ callId: item.callId, callIndex: ci, outputIndex: i });
      }
    }
  });
  return pairs;
}

function surviving(
  items: readonly ModelInputItem[],
  remove: ReadonlySet<number>,
): ModelInputItem[] {
  return items.filter((_, i) => !remove.has(i));
}
