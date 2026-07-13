/**
 * Consolidation / Dream — pure logic and eligibility (MM-04).
 *
 * Dream is the background pass that keeps long-term memory healthy: it deduplicates, resolves
 * conflicting notes with provenance, retires stale content, and rebuilds the index. This module
 * holds the DETERMINISTIC core of that — no I/O, no model, no locks — so the hard rules (who wins a
 * conflict, when Dream is even allowed to run, how big the model input may be) are unit-testable in
 * isolation. The orchestration that adds the lock, the single model call, and the atomic write lives
 * in `dream.ts`.
 *
 * Every threshold here is a FROZEN default (defaults.md, "Memory defaults"); none may be changed to
 * make a test pass.
 */

import { dedupKey, normalizeBody } from './dedup.ts';
import type { Memory } from './frontmatter.ts';
import type { MemoryProvenance } from './scopes.ts';

// --- Frozen Dream gates (defaults.md) --------------------------------------------------------

/** Eligible after this many successfully completed sessions since the last consolidation. */
export const DREAM_MIN_SESSIONS = 5;
/** ...OR this long since the last consolidation. */
export const DREAM_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Gated on at least this many candidate memories... */
export const DREAM_MIN_CANDIDATES = 10;
/** ...OR this many bytes of candidate content. */
export const DREAM_MIN_BYTES = 32 * 1024;
/** Run at most once per this window, per canonical repository. */
export const DREAM_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** The renewable lock lease. */
export const DREAM_LOCK_LEASE_MS = 5 * 60 * 1000;
/** Hard wall-clock limit for one Dream run. */
export const DREAM_WALL_MS = 10 * 60 * 1000;
/** At most one model call, bounded by these token budgets. */
export const DREAM_MAX_MODEL_CALLS = 1;
export const DREAM_MAX_INPUT_TOKENS = 64_000;
export const DREAM_MAX_OUTPUT_TOKENS = 8_000;

/** A rough token estimate: ~4 bytes/token. Used only to enforce the input/output caps. */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}

// --- Eligibility -----------------------------------------------------------------------------

export interface DreamState {
  /** Completed sessions observed since the last consolidation for this canonical repo. */
  readonly sessionsSinceLastConsolidation: number;
  /** Epoch ms of the last successful consolidation, or `null` if it has never run. */
  readonly lastConsolidationAt: number | null;
}

export interface DreamCandidateSummary {
  readonly count: number;
  readonly bytes: number;
}

export type DreamIneligibleReason =
  'within-24h' | 'not-enough-sessions-or-age' | 'not-enough-candidates';

export type DreamEligibility =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: DreamIneligibleReason };

/**
 * Decide whether Dream may run now. All gates must pass:
 *
 *   1. Frequency: not within 24h of the last run (per canonical repo).
 *   2. Trigger:   >= 5 completed sessions OR >= 7 days since the last run (or never run).
 *   3. Volume:    >= 10 candidate memories OR >= 32 KiB of candidate content.
 */
export function isDreamEligible(
  state: DreamState,
  candidates: DreamCandidateSummary,
  now: number,
): DreamEligibility {
  const { lastConsolidationAt, sessionsSinceLastConsolidation } = state;

  if (lastConsolidationAt !== null && now - lastConsolidationAt < DREAM_MIN_INTERVAL_MS) {
    return { eligible: false, reason: 'within-24h' };
  }

  const sessionTrigger = sessionsSinceLastConsolidation >= DREAM_MIN_SESSIONS;
  const ageTrigger = lastConsolidationAt === null || now - lastConsolidationAt >= DREAM_MAX_AGE_MS;
  if (!sessionTrigger && !ageTrigger) {
    return { eligible: false, reason: 'not-enough-sessions-or-age' };
  }

  const volumeTrigger =
    candidates.count >= DREAM_MIN_CANDIDATES || candidates.bytes >= DREAM_MIN_BYTES;
  if (!volumeTrigger) {
    return { eligible: false, reason: 'not-enough-candidates' };
  }

  return { eligible: true };
}

// --- Consolidation plan ----------------------------------------------------------------------

/** A memory with the provenance and timestamp consolidation needs to resolve conflicts. */
export interface MemoryRecord {
  readonly memory: Memory;
  readonly provenance: MemoryProvenance;
  /** Epoch ms the memory was last written. Newer wins a conflict. */
  readonly updatedAt: number;
}

export interface MemoryConflict {
  readonly name: string;
  readonly winner: MemoryProvenance;
  readonly losers: readonly MemoryProvenance[];
  /** Why the winner won: it was newer, or (on a tie) more specific. */
  readonly resolvedBy: 'newer' | 'more-specific';
}

export interface RetiredMemory {
  readonly name: string;
  readonly provenance: MemoryProvenance;
  readonly updatedAt: number;
}

export interface ConsolidationPlan {
  /** The surviving, deduplicated, conflict-resolved memories, sorted by name. */
  readonly kept: readonly MemoryRecord[];
  readonly conflicts: readonly MemoryConflict[];
  readonly retired: readonly RetiredMemory[];
}

export interface ConsolidateOptions {
  /** Records older than this epoch-ms are retired as stale. Omit to retire nothing. */
  readonly staleBefore?: number;
}

/** Pick the winner between two records of the same name. Newer wins; a tie breaks to more-specific. */
function chooseWinner(
  a: MemoryRecord,
  b: MemoryRecord,
): { winner: MemoryRecord; loser: MemoryRecord; resolvedBy: 'newer' | 'more-specific' } {
  if (a.updatedAt !== b.updatedAt) {
    return a.updatedAt > b.updatedAt
      ? { winner: a, loser: b, resolvedBy: 'newer' }
      : { winner: b, loser: a, resolvedBy: 'newer' };
  }
  // Same timestamp: prefer the MORE SPECIFIC (longer normalized) body; final tie-break by path so
  // the outcome is fully deterministic.
  const aLen = normalizeBody(a.memory.body).length;
  const bLen = normalizeBody(b.memory.body).length;
  if (aLen !== bLen) {
    return aLen > bLen
      ? { winner: a, loser: b, resolvedBy: 'more-specific' }
      : { winner: b, loser: a, resolvedBy: 'more-specific' };
  }
  return a.provenance.path <= b.provenance.path
    ? { winner: a, loser: b, resolvedBy: 'more-specific' }
    : { winner: b, loser: a, resolvedBy: 'more-specific' };
}

/**
 * Deduplicate, resolve conflicts, and retire stale content. Pure and deterministic.
 *
 *   - Exact duplicates (same name + same normalized body) collapse to the newest copy, silently.
 *   - Distinct bodies under one name are a CONFLICT: the winner is kept, the losers recorded with
 *     provenance so `/memory` can show what was superseded and why (MM-04).
 *   - A surviving record older than `staleBefore` is retired and recorded.
 */
export function consolidateMemories(
  records: readonly MemoryRecord[],
  options: ConsolidateOptions = {},
): ConsolidationPlan {
  const byName = new Map<string, MemoryRecord[]>();
  for (const record of records) {
    const list = byName.get(record.memory.name);
    if (list) list.push(record);
    else byName.set(record.memory.name, [record]);
  }

  const kept: MemoryRecord[] = [];
  const conflicts: MemoryConflict[] = [];
  const retired: RetiredMemory[] = [];

  for (const [name, group] of byName) {
    // Collapse exact duplicates first: one representative per distinct dedup key, newest kept.
    const distinct = new Map<string, MemoryRecord>();
    for (const record of group) {
      const key = dedupKey(record.memory);
      const existing = distinct.get(key);
      if (!existing || record.updatedAt > existing.updatedAt) distinct.set(key, record);
    }
    const variants = [...distinct.values()];

    let winner = variants[0]!;
    const losers: MemoryProvenance[] = [];
    let resolvedBy: 'newer' | 'more-specific' = 'newer';
    for (let i = 1; i < variants.length; i++) {
      const outcome = chooseWinner(winner, variants[i]!);
      losers.push(outcome.loser.provenance);
      winner = outcome.winner;
      resolvedBy = outcome.resolvedBy;
    }
    if (losers.length > 0) {
      conflicts.push({ name, winner: winner.provenance, losers, resolvedBy });
    }

    if (options.staleBefore !== undefined && winner.updatedAt < options.staleBefore) {
      retired.push({ name, provenance: winner.provenance, updatedAt: winner.updatedAt });
      continue;
    }
    kept.push(winner);
  }

  kept.sort((a, b) => (a.memory.name < b.memory.name ? -1 : a.memory.name > b.memory.name ? 1 : 0));
  conflicts.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  retired.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return { kept, conflicts, retired };
}

// --- Index rebuild ---------------------------------------------------------------------------

export interface BuildIndexOptions {
  /** An optional model-written summary paragraph placed under the heading. */
  readonly summary?: string;
  /** Heading text. Defaults to a stable title. */
  readonly title?: string;
}

/**
 * Rebuild `MEMORY.md` from the kept records. The index lists each memory's name, type, and
 * description — enough for retrieval side-selection to work without loading any topic file (MM-01).
 */
export function buildIndex(kept: readonly MemoryRecord[], options: BuildIndexOptions = {}): string {
  const title = options.title ?? 'Memory index';
  const lines = [`# ${title}`, ''];
  if (options.summary && options.summary.trim() !== '') {
    lines.push(options.summary.trim(), '');
  }
  if (kept.length === 0) {
    lines.push('_No memories yet._', '');
  } else {
    for (const record of kept) {
      const { name, type, description } = record.memory;
      lines.push(`- **${name}** (${type}): ${description}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
