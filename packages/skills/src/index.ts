/**
 * @qwen-harness/skills
 *
 * Skill discovery, registry, catalog, and execution semantics (IN-01..IN-05).
 *
 * A declared I/O owner (scripts/graph.ts): `fs.ts` may open `node:fs`; everything else is pure and
 * testable without a filesystem. The package holds one posture, and every file in it exists to keep
 * it true:
 *
 *   A SKILL IS UNTRUSTED CONTENT ADDRESSED BY NAME.
 *
 *   - untrusted: a SKILL.md can come from a repository the user merely opened, a plugin, or an MCP
 *     server. Its frontmatter crosses a strict zod schema; its body is `UntrustedText`; its
 *     `allowed-tools` can only NARROW the caller's authority, never widen it.
 *   - by name: the registry is the only way to reach a skill, and a resource inside one is reached
 *     as (name, relative path) — re-validated against the canonical, realpath'd skill root. There is
 *     no API here that accepts a path from a model.
 *
 * See README.md for the security model and the attacks each barrier stops.
 */

export {
  SKILL_HOOK_EVENTS,
  SKILL_CONTEXT_MODES,
  SKILL_NAME_RE,
  SkillNameSchema,
  SkillFrontmatterSchema,
  MAX_ARGUMENT_CHARS,
  splitFrontmatter,
  parseFrontmatterYaml,
  parseSkillDocument,
  validateSkillFrontmatter,
  neutralizeArgument,
  substituteArguments,
} from './frontmatter.ts';
export type {
  SkillHookEvent,
  SkillContextMode,
  SkillFrontmatter,
  SkillUserInvocation,
  ParsedSkillDocument,
  RawSkillFrontmatter,
  ArgumentSubstitution,
} from './frontmatter.ts';

export {
  SkillFrontmatterError,
  SkillScopeError,
  SkillNotFoundError,
  SkillBudgetError,
  SkillInvocationError,
  SkillReadError,
} from './errors.ts';
export type { SkillScopeRejection } from './errors.ts';

export { CHARS_PER_TOKEN, TRUNCATION_MARKER, estimateTokens, truncateToTokens } from './tokens.ts';
export type { TruncatedText } from './tokens.ts';

export {
  SKILL_SOURCES,
  SOURCE_PRECEDENCE,
  MANAGED_IS_IMMUTABLE,
  outranks,
  resolvePrecedence,
} from './sources.ts';
export type {
  SkillSource,
  PrecedenceCandidate,
  ShadowedSkill,
  PrecedenceResolution,
} from './sources.ts';

export { provenanceOf } from './descriptor.ts';
export type { SkillDescriptor, SkillOrigin, SkillProvenance } from './descriptor.ts';

export { nodeSkillFileSystem, DEFAULT_HEAD_BYTES } from './fs.ts';
export type { SkillFileSystem } from './fs.ts';

export {
  MAX_RESOURCE_PATH_CHARS,
  PATH_SEPARATOR,
  canonicalizeSkillRoot,
  resolveSkillResource,
  assertInsideRoot,
} from './scope.ts';
export type { SkillResource } from './scope.ts';

export { DEFAULT_CATALOG_TOKEN_BUDGET, buildCatalog, renderCatalogEntry } from './catalog.ts';
export type {
  CatalogEntry,
  CatalogOmission,
  OmissionReason,
  SkillCatalog,
  SkillCatalogTruncated,
  BuildCatalogOptions,
} from './catalog.ts';

export { planSkillExecution, assertPlanNeverBroadens } from './execution.ts';
export type {
  SkillExecutionPlan,
  PlanSkillArgs,
  SkillContextDisposition,
  SkillResultDisposition,
  SkillPermissionDisposition,
} from './execution.ts';

export { SKILL_FILE, defaultSkillSourceDirs, discoverSkills, inMemorySkill } from './discovery.ts';
export type {
  SkillSourceDir,
  SkillDirectoryLayout,
  DiscoverSkillsOptions,
  SkillDiscovery,
} from './discovery.ts';

export { SkillRegistry, DEFAULT_SKILL_BUDGETS } from './registry.ts';
export type {
  SkillBudgets,
  SkillRegistryOptions,
  SkillContext,
  RegistrationResult,
  InvocationRequest,
  PreparedInvocation,
  LoadedSkill,
  SkillContentTruncated,
} from './registry.ts';
