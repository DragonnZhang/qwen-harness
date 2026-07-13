import {
  compact,
  computeBudget,
  eventStoreBoundaryStore,
  evaluateCompaction,
  reduceContext,
  stableHash,
  type CompactionResult,
  type CompactionTrigger,
  type PreservedContext,
  type SummaryDraft,
  type Summarizer,
} from '@qwen-harness/context';
import type {
  Actor,
  Clock,
  CorrelationId,
  IdSource,
  Item,
  ItemId,
  PermissionProfile,
  ThreadId,
  TurnId,
} from '@qwen-harness/protocol';
import type { ModelInputItem } from '@qwen-harness/provider-core';
import type { ContextManager, ContextPreparation } from '@qwen-harness/runtime';
import type { EventStore } from '@qwen-harness/storage';

/**
 * The CLI's context manager (CX-01..CX-06): the composition that finally makes
 * `@qwen-harness/context` reachable from a turn.
 *
 * The engine calls `prepare` before every model round and adopts the conversation it returns. This
 * runs, in order:
 *
 *   1. Cheap reduction (CX-02). Large tool outputs are OFFLOADED — the full payload is written to
 *      the durable blob store, addressed by its own content digest, and the inline item is replaced
 *      by a bounded preview plus that reference. Safe middle messages are pruned. Nothing here is a
 *      model call, so it runs every round.
 *   2. Budget (CX-01). The reduced conversation is measured against the provider's context window,
 *      minus the reserved response/tool headroom, with the always-sent instructions counted as fixed
 *      overhead. The utilization it reports is REAL — the number the CLI used to hard-code as 0.
 *   3. Compaction (CX-03/CX-04), only when the reduced conversation is past the proactive threshold
 *      (85% of usable input) or already over capacity (reactive overflow). The pre-compaction span
 *      is written to a durable boundary FIRST, then a structured summary replaces it while the recent
 *      tail is kept intact. A summary that frees too little trips the diminishing-returns circuit
 *      breaker and is discarded rather than looped — context thrashing stops safely.
 *
 * A compaction that fails (an invalid summary, or any error) NEVER kills the turn: the manager falls
 * back to the cheaply-reduced conversation. Losing a prompt's worth of headroom is recoverable;
 * dropping the turn on the floor is not.
 */

/** Keep this many most-recent items out of any compaction — recent context is the most valuable. */
const KEEP_RECENT = 4;

/** Offload a single tool output once it exceeds this many characters. */
const DEFAULT_OFFLOAD_THRESHOLD_CHARS = 4096;

export interface ContextManagerOptions {
  readonly store: EventStore;
  /** The provider's declared context window in tokens (`DASHSCOPE_DEFAULTS.contextWindowSize`). */
  readonly contextWindow: number;
  readonly clock: Clock;
  readonly ids: IdSource;
  /** The actor to attribute boundary/compaction items to. The model turn's actor. */
  readonly actor: Actor;
  /** Fraction of the window reserved for response + tool overhead. Defaults to 15%. */
  readonly reserveFraction?: number;
  /**
   * The structured summarizer. Production defaults to {@link deterministicSummarizer}, which cannot
   * lose the goal because it reads it straight from the transcript. A test injects a scripted one.
   */
  readonly summarizer?: Summarizer;
  /** Durable tasks carried into the summary, so a compaction does not forget outstanding work. */
  readonly tasksProvider?: () => readonly string[];
  readonly offloadThresholdChars?: number;
  /** Observers, for reporting and telemetry. */
  readonly onUtilization?: (utilization: number) => void;
  readonly onCompaction?: (result: CompactionResult) => void;
}

/**
 * A structured summarizer that extracts what it can PROVE from the transcript rather than inventing
 * it. The goal is the first user message (verbatim); active files are the workspace-relative paths
 * that actually appear; outstanding tasks come from the durable task graph via an injected provider.
 * The remaining structured fields are left empty rather than fabricated — a model-backed summarizer
 * is where richer constraints/decisions/errors would come from; this one guarantees the fields it
 * fills are true.
 */
export function deterministicSummarizer(
  tasksProvider: () => readonly string[] = () => [],
): Summarizer {
  return ({ items }): SummaryDraft => {
    const firstUser = items.find(
      (i): i is Extract<ModelInputItem, { type: 'message' }> =>
        i.type === 'message' && i.role === 'user',
    );
    const goal = firstUser?.text.trim() || 'continue the prior work';

    const preserved: PreservedContext = {
      goal,
      constraints: [],
      plan: [],
      tasks: [...tasksProvider()],
      activeFiles: extractActiveFiles(items),
      decisions: [],
      errors: [],
      obligations: [],
    };

    const prose = items
      .filter(
        (i): i is Extract<ModelInputItem, { type: 'message' }> =>
          i.type === 'message' && i.role === 'assistant',
      )
      .slice(-2)
      .map((i) => i.text.trim())
      .filter((t) => t.length > 0)
      .join('\n')
      .slice(0, 1000);

    return { prose, preserved };
  };
}

const FILE_PATH = /(?:^|[\s"'(`])([A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,8})(?=[\s"'`):,]|$)/g;

/** Best-effort workspace-relative file paths mentioned anywhere in the span, de-duplicated. */
function extractActiveFiles(items: readonly ModelInputItem[]): string[] {
  const seen = new Set<string>();
  for (const item of items) {
    const text =
      item.type === 'message'
        ? item.text
        : item.type === 'function-output'
          ? item.output
          : item.argumentsJson;
    for (const match of text.matchAll(FILE_PATH)) {
      const path = match[1];
      if (path !== undefined && !path.startsWith('.') && path.includes('.')) seen.add(path);
      if (seen.size >= 20) return [...seen];
    }
  }
  return [...seen];
}

/**
 * Build the CLI context manager. The returned object is the runtime's `ContextManager` plus two
 * live counters a client can read to report status honestly.
 */
export function createContextManager(options: ContextManagerOptions): ContextManager & {
  readonly lastUtilization: number;
  readonly compactionCount: number;
} {
  const summarizer = options.summarizer ?? deterministicSummarizer(options.tasksProvider);
  const offloadThresholdChars = options.offloadThresholdChars ?? DEFAULT_OFFLOAD_THRESHOLD_CHARS;
  let itemSeq = 0;
  let lastUtilization = 0;
  let compactionCount = 0;

  return {
    get lastUtilization(): number {
      return lastUtilization;
    },
    get compactionCount(): number {
      return compactionCount;
    },

    async prepare(call): Promise<ContextPreparation> {
      const instructionsOverhead = Math.ceil(call.instructions.length / 4);

      // (1) cheap reduction: offload large outputs to the durable blob store, prune safe middle.
      const reduced = reduceContext(call.conversation, {
        offloadThresholdChars,
        preserveRecent: KEEP_RECENT,
        // The ref id IS the content digest, and computing it here is also where the full payload is
        // durably captured. Idempotent by digest, so re-offloading the same output never duplicates.
        makeRefId: (item) => {
          const digest = `blb_${stableHash(item.output)}`;
          options.store.putBlob(digest, item.output);
          return digest;
        },
      });

      // (2) budget against the reduced conversation.
      const budget = computeBudget({
        contextWindow: options.contextWindow,
        items: reduced.items,
        fixedOverheadTokens: instructionsOverhead,
        ...(options.reserveFraction !== undefined
          ? { reserveFraction: options.reserveFraction }
          : {}),
      });
      lastUtilization = budget.utilization;
      options.onUtilization?.(budget.utilization);

      const overThreshold = budget.overThreshold || budget.overCapacity;
      if (!overThreshold) {
        return {
          items: reduced.items,
          utilization: budget.utilization,
          compacted: false,
          trigger: null,
        };
      }

      // (3) compaction. Keep the recent tail; compact everything older into a structured summary.
      const splitAt = Math.max(0, reduced.items.length - KEEP_RECENT);
      const head = reduced.items.slice(0, splitAt);
      const tail = reduced.items.slice(splitAt);
      if (head.length === 0) {
        // Nothing old enough to compact — the recent tail alone is over budget. Cheap reduction is
        // all we can honestly do; do not fabricate a compaction that reclaims nothing.
        return {
          items: reduced.items,
          utilization: budget.utilization,
          compacted: false,
          trigger: null,
        };
      }

      const trigger: CompactionTrigger = budget.overCapacity ? 'reactive-overflow' : 'proactive';

      try {
        const boundaryStore = eventStoreBoundaryStore({
          store: options.store,
          threadId: call.threadId,
          turnId: call.turnId,
          actor: options.actor,
          correlationId: call.correlationId,
          permissionProfile: call.permissionProfile,
          ids: options.ids,
          clock: options.clock,
          nextItemSeq: () => itemSeq++,
        });

        const result = await compact({ items: head, summarizer, boundaryStore, trigger });

        // Diminishing-returns circuit breaker (CX-06): a compaction that frees too little is not
        // worth committing. Fall back to the cheaply-reduced conversation instead of looping.
        const outcome = evaluateCompaction(result);
        if (outcome.kind === 'no-further-reduction') {
          return {
            items: reduced.items,
            utilization: budget.utilization,
            compacted: false,
            trigger: null,
          };
        }

        // Record the FINAL compaction item (with the real summary) durably, carrying the same
        // boundary ref as the marker written above. This is the observable, auditable record that a
        // compaction happened and what it preserved (CX-03/CX-04).
        recordCompactionItem(options, call, result, itemSeq++);
        compactionCount += 1;
        options.onCompaction?.(result);

        const summaryItem: ModelInputItem = {
          type: 'message',
          role: 'user',
          text: result.summary,
        };
        return {
          items: [summaryItem, ...tail],
          utilization: budget.utilization,
          compacted: true,
          trigger: result.trigger === 'manual' ? null : result.trigger,
        };
      } catch {
        // A failed compaction (invalid summary, or any error) must never end the turn. Send the
        // cheaply-reduced conversation and let the next round try again if still over budget.
        return {
          items: reduced.items,
          utilization: budget.utilization,
          compacted: false,
          trigger: null,
        };
      }
    },
  };
}

function recordCompactionItem(
  options: ContextManagerOptions,
  call: {
    threadId: ThreadId;
    turnId: TurnId;
    correlationId: CorrelationId;
    permissionProfile: PermissionProfile;
  },
  result: CompactionResult,
  seq: number,
): void {
  const id = options.ids.next('itm') as ItemId;
  const item: Extract<Item, { type: 'compaction' }> = {
    id,
    turnId: call.turnId,
    threadId: call.threadId,
    seq,
    createdAt: options.clock.now(),
    type: 'compaction',
    trigger: result.trigger,
    transcriptBoundaryRef: result.boundaryRef,
    summary: result.summary,
    tokensBefore: result.tokensBefore,
    tokensAfter: Math.max(0, result.tokensAfter),
  };
  options.store.append({
    threadId: call.threadId,
    turnId: call.turnId,
    itemId: id,
    actor: options.actor,
    correlationId: call.correlationId,
    permissionProfile: call.permissionProfile,
    payload: { type: 'item-appended', item },
  });
}

/**
 * The current context utilization for a reconstructed history, for the system prompt's context
 * section (CX-01). Computed the same way `prepare` does, so the number the model is told matches the
 * number the turn will act on.
 */
export function contextUtilizationPercent(
  history: readonly ModelInputItem[],
  contextWindow: number,
  instructionChars: number,
  reserveFraction?: number,
): number {
  const budget = computeBudget({
    contextWindow,
    items: history,
    fixedOverheadTokens: Math.ceil(Math.max(0, instructionChars) / 4),
    ...(reserveFraction !== undefined ? { reserveFraction } : {}),
  });
  if (!Number.isFinite(budget.utilization)) return 100;
  return Math.min(100, Math.round(budget.utilization * 100));
}
