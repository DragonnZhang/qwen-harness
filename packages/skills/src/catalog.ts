/**
 * The catalog: level one of two-level loading (IN-01), and the first of the two enforced token
 * budgets (IN-05).
 *
 * The catalog is the ONLY thing the model sees before it selects a skill: name, description, usage
 * condition, how it runs, and how a user may invoke it. No body, no scripts, no file paths that the
 * model could then try to open — a path in the catalog would invite exactly the "model supplies a
 * path" pattern IN-02 forbids.
 *
 * BUDGET. A catalog grows linearly with the number of installed skills, and skills arrive from
 * repositories, plugins, and MCP servers — i.e. from places an attacker can add to. An unbounded
 * catalog is therefore both a cost bug and a context-flooding attack. So the catalog has a token
 * budget, and when the budget binds, the catalog is TRUNCATED — deterministically, in precedence
 * order, with an explicit signal that names every omitted skill. Never silently.
 */

import type { Clock } from '@qwen-harness/protocol';

import type { SkillDescriptor } from './descriptor.ts';
import { SOURCE_PRECEDENCE, type SkillSource } from './sources.ts';
import { estimateTokens } from './tokens.ts';

/**
 * Default catalog budget, in estimated tokens.
 *
 * This value is NOT frozen in defaults.md (that table freezes the per-skill and total REATTACH
 * budgets, which are enforced in registry.ts). It is a product default chosen to be generous for a
 * realistic install — roughly a hundred skills at a typical metadata size — while remaining a hard
 * ceiling that a hostile plugin cannot grow past. It is overridable per registry.
 */
export const DEFAULT_CATALOG_TOKEN_BUDGET = 4_000;

/** One catalog row. Metadata only, by construction: there is no field here that names a file. */
export interface CatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly condition: string | null;
  readonly source: SkillSource;
  readonly contextMode: 'inline' | 'forked';
  /** The `/command` a user may type, or `null` when the skill is model-selected only. */
  readonly command: string | null;
  readonly argumentHint: string | null;
  /** Estimated tokens this row costs in the prompt. The unit the budget is spent in. */
  readonly tokens: number;
}

/** Why a skill is not in the catalog. Every omission has exactly one of these reasons. */
export type OmissionReason = 'catalog-token-budget' | 'condition-not-met';

export interface CatalogOmission {
  readonly name: string;
  readonly source: SkillSource;
  readonly reason: OmissionReason;
}

/**
 * The observable signal emitted when the budget binds. This is the "explicit, observable signal"
 * IN-05 requires: it names the budget, what was used, and EVERY skill that did not make it, so a
 * user can be told "12 skills are installed, 9 are visible to the model" instead of quietly getting
 * a model that has never heard of their skill.
 */
export interface SkillCatalogTruncated {
  readonly type: 'skill-catalog-truncated';
  readonly at: number;
  readonly budgetTokens: number;
  readonly usedTokens: number;
  readonly includedCount: number;
  readonly omitted: readonly CatalogOmission[];
}

export interface SkillCatalog {
  readonly entries: readonly CatalogEntry[];
  /** The rendered catalog text — exactly what goes in the prompt. */
  readonly text: string;
  readonly tokens: number;
  readonly truncated: boolean;
  /** Skills that were discovered and are NOT in `entries`, each with a reason. */
  readonly omitted: readonly CatalogOmission[];
  /** Present exactly when the token budget caused an omission. */
  readonly signal: SkillCatalogTruncated | null;
}

/** Render one row. Stable format: the catalog text is a cache input, so it must be reproducible. */
export function renderCatalogEntry(entry: CatalogEntry): string {
  const parts = [`- ${entry.name} [${entry.source}, ${entry.contextMode}]: ${entry.description}`];
  if (entry.condition !== null) parts.push(`  use when: ${entry.condition}`);
  if (entry.command !== null) {
    const hint = entry.argumentHint === null ? '' : ` ${entry.argumentHint}`;
    parts.push(`  user command: /${entry.command}${hint}`);
  }
  return parts.join('\n');
}

function entryOf(descriptor: SkillDescriptor): CatalogEntry {
  const fm = descriptor.frontmatter;
  const partial: Omit<CatalogEntry, 'tokens'> = {
    name: descriptor.name,
    description: fm.description,
    condition: fm.condition,
    source: descriptor.source,
    contextMode: fm.contextMode,
    command: fm.userInvocation.command,
    argumentHint: fm.userInvocation.argumentHint,
  };
  return { ...partial, tokens: estimateTokens(renderCatalogEntry({ ...partial, tokens: 0 })) };
}

export interface BuildCatalogOptions {
  readonly budgetTokens?: number;
  /** Injected — no ambient `Date.now()`; the signal's timestamp must be reproducible in a test. */
  readonly clock: Clock;
}

const CATALOG_HEADER =
  'Available skills (invoke by NAME; the body loads only when you select one):';

/**
 * Build the catalog from the already-precedence-resolved, already-condition-filtered descriptors.
 *
 * Determinism, precisely: entries are ordered by source precedence (highest first) and then by name
 * (ascending). Rows are admitted in that order while they fit. The FIRST row that does not fit ends
 * the catalog — it and every row after it are omitted. We stop rather than "keep trying smaller
 * rows" so that the result is a stable PREFIX of a stable order: adding one skill can only ever push
 * lower-precedence skills out of the tail, and can never silently reshuffle which of two equal-rank
 * skills survives. A managed skill can therefore never be evicted by a flood of plugin skills.
 */
export function buildCatalog(
  descriptors: readonly SkillDescriptor[],
  options: BuildCatalogOptions,
): SkillCatalog {
  const budgetTokens = options.budgetTokens ?? DEFAULT_CATALOG_TOKEN_BUDGET;

  const ordered = [...descriptors].sort((a, b) => {
    const rank = SOURCE_PRECEDENCE[b.source] - SOURCE_PRECEDENCE[a.source];
    if (rank !== 0) return rank;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  const headerTokens = estimateTokens(CATALOG_HEADER);
  const entries: CatalogEntry[] = [];
  const omitted: CatalogOmission[] = [];
  let used = headerTokens;
  let budgetBound = false;

  for (const descriptor of ordered) {
    const entry = entryOf(descriptor);
    if (budgetBound || used + entry.tokens > budgetTokens) {
      budgetBound = true;
      omitted.push({
        name: descriptor.name,
        source: descriptor.source,
        reason: 'catalog-token-budget',
      });
      continue;
    }
    entries.push(entry);
    used += entry.tokens;
  }

  const text = [CATALOG_HEADER, ...entries.map(renderCatalogEntry)].join('\n');
  const tokens = estimateTokens(text);

  const signal: SkillCatalogTruncated | null = budgetBound
    ? {
        type: 'skill-catalog-truncated',
        at: options.clock.now(),
        budgetTokens,
        usedTokens: tokens,
        includedCount: entries.length,
        omitted,
      }
    : null;

  return { entries, text, tokens, truncated: budgetBound, omitted, signal };
}
