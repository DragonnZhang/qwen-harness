/**
 * @qwen-harness/instructions
 *
 * Repository instruction resolution and deterministic system-prompt assembly (IN-06, IN-07, IN-08,
 * IN-10).
 *
 * A declared I/O owner (scripts/graph.ts): `discovery.ts` may read instruction files with
 * `node:fs`/`node:path`; everything else is pure and testable without a filesystem. The package
 * enforces one non-negotiable posture: repository instructions are UNTRUSTED CONTEXT, never
 * authority. They resolve into text with provenance and precedence; they can never change a managed
 * value, grant a tool, or alter policy (SC-02).
 */

export {
  INSTRUCTION_SCOPES,
  SCOPE_PRECEDENCE,
  INSTRUCTIONS_ARE_CONTEXT_ONLY,
  precedenceOf,
  directoryDepth,
  resolveInstructions,
  pathIsUnder,
  applicableInstructions,
  composeInstructionText,
} from './resolution.ts';
export type {
  InstructionScope,
  InstructionProvenance,
  DiscoveredInstruction,
  ResolvedInstruction,
  InstructionsLoaded,
} from './resolution.ts';

export {
  DEFAULT_INSTRUCTION_FILENAMES,
  DEFAULT_IGNORE_DIRS,
  DEFAULT_MAX_DEPTH,
  InstructionReadError,
  discoverInstructionFiles,
  loadInstructions,
} from './discovery.ts';
export type { DiscoverOptions } from './discovery.ts';

export {
  STABLE_SECTION_IDS,
  DYNAMIC_SECTION_IDS,
  CacheKeyInputSchema,
  PromptSectionSchema,
  sectionCacheKey,
  composeSystemPrompt,
  buildStandardSections,
} from './prompt.ts';
export type {
  StableSectionId,
  DynamicSectionId,
  PromptSectionKind,
  CacheKeyInput,
  PromptSection,
  ComposedSystemPrompt,
  SystemPromptState,
} from './prompt.ts';

export {
  instructionStringForRequest,
  buildRequestInstructions,
  attachInstructions,
} from './request.ts';
export type {
  RequestInstructions,
  InstructionRequestOptions,
  BuiltRequestInstructions,
} from './request.ts';

export { stableHash, stableStringify } from './hash.ts';
