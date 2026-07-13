/**
 * @qwen-harness/memory
 *
 * Long-term memory: Markdown files with validated YAML frontmatter (MM-01), budgeted retrieval with
 * a keyword fallback (MM-02), safe post-turn extraction (MM-03), Dream consolidation with the frozen
 * eligibility/lock/token gates (MM-04), the project/team/user/auto/session scope model (MM-05), and
 * concurrent-writer locks with atomic writes (MM-06).
 *
 * A declared I/O owner (scripts/graph.ts): memory FILES are Markdown on disk, so this package reads
 * and writes them. Every stored memory is redacted through @qwen-harness/storage so it can never
 * contain a secret. See README.md for scopes, Dream gates, and the atomic-write/lock guarantee.
 */

export {
  MEMORY_TYPES,
  MemoryTypeSchema,
  MEMORY_NAME_RE,
  MemoryNameSchema,
  MemoryFrontmatterSchema,
  MemoryFormatError,
  parseMemory,
  serializeMemory,
} from './frontmatter.ts';
export type { MemoryType, MemoryFrontmatter, Memory } from './frontmatter.ts';

export {
  MEMORY_INDEX_MAX_LINES,
  MEMORY_INDEX_MAX_BYTES,
  MEMORY_INDEX_FILENAME,
  loadMemoryIndex,
} from './index-file.ts';
export type { LoadedIndex } from './index-file.ts';

export {
  MEMORY_SCOPES,
  PERSISTENT_SCOPES,
  isPersistentScope,
  REPO_STATE_DIR,
  PROJECT_MEMORY_SUBDIR,
  TEAM_MEMORY_SUBDIR,
  APP_DIR,
  canonicalRepoKey,
  resolveMemoryDir,
  MemoryScopeError,
} from './scopes.ts';
export type { MemoryScope, MemoryLocation, MemoryProvenance, Env } from './scopes.ts';

export { normalizeBody, dedupKey } from './dedup.ts';

export { RETRIEVAL_MAX_FILES, RETRIEVAL_MAX_BYTES, retrieve } from './retrieval.ts';
export type {
  MemoryCandidate,
  RetrievedMemory,
  RetrievalResult,
  RetrievalOptions,
} from './retrieval.ts';

export { maybeExtract } from './extraction.ts';
export type {
  TurnOutcome,
  MemoryProposal,
  ExtractionRejection,
  ExtractionSkip,
  ExtractionResult,
  ExtractionOptions,
} from './extraction.ts';

export {
  DREAM_MIN_SESSIONS,
  DREAM_MAX_AGE_MS,
  DREAM_MIN_CANDIDATES,
  DREAM_MIN_BYTES,
  DREAM_MIN_INTERVAL_MS,
  DREAM_LOCK_LEASE_MS,
  DREAM_WALL_MS,
  DREAM_MAX_MODEL_CALLS,
  DREAM_MAX_INPUT_TOKENS,
  DREAM_MAX_OUTPUT_TOKENS,
  estimateTokens,
  isDreamEligible,
  consolidateMemories,
  buildIndex,
} from './consolidation.ts';
export type {
  DreamState,
  DreamCandidateSummary,
  DreamIneligibleReason,
  DreamEligibility,
  MemoryRecord,
  MemoryConflict,
  RetiredMemory,
  ConsolidationPlan,
  ConsolidateOptions,
  BuildIndexOptions,
} from './consolidation.ts';

export { SystemClock, FileLock, MemoryLockError, atomicWriteFile } from './lock.ts';
export type { AcquireOptions, AtomicWriteOptions } from './lock.ts';

export { MemoryStore, recordsToCandidates } from './store.ts';
export type { LoadedMemoryRecord, ListResult, MemoryStoreOptions } from './store.ts';

export { runDream } from './dream.ts';
export type {
  DreamModelInput,
  DreamModelResult,
  DreamSummarizer,
  DreamOutcomeReason,
  DreamRunResult,
  RunDreamOptions,
} from './dream.ts';
