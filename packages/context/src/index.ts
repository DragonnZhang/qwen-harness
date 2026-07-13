/**
 * @qwen-harness/context
 *
 * Token budgeting and compaction (CX-01, CX-02, CX-03, CX-06).
 *
 * Pure coordination (scripts/graph.ts): this package performs NO direct host I/O. It uses
 * `provider-core` item/token types for its estimates and persists compaction boundaries THROUGH an
 * injected `storage` port — it never opens a database or a file itself. The expensive, lossy parts
 * (the summarizer model call, the durable boundary write) are injected so budgeting, reduction, and
 * compaction stay deterministic and testable.
 */

export {
  DEFAULT_CHARS_PER_TOKEN,
  DEFAULT_RESERVE_FRACTION,
  PROACTIVE_THRESHOLD_FRACTION,
  defaultTokenEstimator,
  serializeInputItem,
  estimateItems,
  computeBudget,
} from './budget.ts';
export type { TokenEstimator, BudgetInput, BudgetBreakdown } from './budget.ts';

export { boundedPreview, makeContextRef, renderOffloaded } from './refs.ts';
export type { ContextRef, ContextRefKind, RefPreviewOptions } from './refs.ts';

export { isPairingIntact, reduceContext } from './reduction.ts';
export type { ReductionOptions, ReductionResult } from './reduction.ts';

export {
  PRESERVED_FIELDS,
  PreservedContextSchema,
  SummaryDraftSchema,
  InMemoryBoundaryStore,
  InvalidCompactionSummaryError,
  digestTranscript,
  renderSummary,
  compact,
} from './compaction.ts';
export type {
  CompactionTrigger,
  PreservedContext,
  SummaryDraft,
  SummarizerInput,
  Summarizer,
  TranscriptBoundary,
  BoundaryStore,
  CompactionResult,
  CompactOptions,
} from './compaction.ts';

export {
  DEFAULT_MIN_FREED_FRACTION,
  contextCommand,
  evaluateCompaction,
  compactCommand,
  isDiminishingReturns,
  clearCommand,
} from './commands.ts';
export type {
  ContextReport,
  CompactionOutcome,
  CompactCommandOptions,
  ClearOptions,
  ClearedState,
} from './commands.ts';

export { eventStoreBoundaryStore } from './storage-boundary.ts';
export type { EventStoreBoundaryContext } from './storage-boundary.ts';

export { stableHash } from './hash.ts';
