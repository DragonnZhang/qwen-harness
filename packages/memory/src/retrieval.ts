/**
 * Retrieval (MM-02).
 *
 * Given a query and a set of memory candidates, decide WHICH memories to pull into the turn. The
 * strategy is two-stage and deterministic:
 *
 *   1. Side-selection — score each candidate by how many query terms appear in its `name` and
 *      `description`. This is cheap (metadata only, no body read) and is the primary path, matching
 *      the product's "name/description side-selection" (MM-02).
 *   2. Keyword fallback — ONLY when side-selection matched nothing, score candidates by query terms
 *      found in their bodies. The fallback guarantees a relevant-but-poorly-described memory is
 *      still reachable, and it is deterministic (fixed tokenizer, stable tie-break by name).
 *
 * Two hard invariants:
 *   - Budgets. At most 5 files and 50 KiB total per turn (defaults.md). Enforced greedily in rank
 *     order; a candidate that would breach the byte budget stops inclusion.
 *   - Failure isolation. Reading a candidate's body may throw (an unreadable/corrupt file). One such
 *     failure is recorded and skipped; it never aborts the retrieval (MM-02, evidence F).
 *
 * Provenance travels with every result (scope + path) so the caller and `/memory` know where each
 * loaded memory came from.
 */

import type { MemoryType } from './frontmatter.ts';
import type { MemoryProvenance, MemoryScope } from './scopes.ts';

/** The per-turn retrieval budgets (defaults.md, "Memory defaults"). */
export const RETRIEVAL_MAX_FILES = 5;
export const RETRIEVAL_MAX_BYTES = 50 * 1024;

/**
 * A retrieval candidate. The body is loaded LAZILY through `readBody` so side-selection can score on
 * metadata alone, and so a body read that fails can be isolated to the one candidate that owns it.
 */
export interface MemoryCandidate {
  readonly name: string;
  readonly description: string;
  readonly type: MemoryType;
  readonly scope: MemoryScope;
  readonly path: string;
  /** Load the Markdown body. May throw; retrieval catches and isolates the failure. */
  readBody(): string;
}

export interface RetrievedMemory {
  readonly name: string;
  readonly description: string;
  readonly type: MemoryType;
  readonly body: string;
  readonly sizeBytes: number;
  readonly provenance: MemoryProvenance;
  /** How this memory was matched. */
  readonly matchedBy: 'side-selection' | 'keyword-fallback';
  /** Number of query terms matched (higher = more relevant). */
  readonly score: number;
}

export interface RetrievalResult {
  readonly memories: readonly RetrievedMemory[];
  /** Candidates dropped by budget or by a read failure, with the reason. */
  readonly skipped: readonly {
    path: string;
    reason: 'budget-files' | 'budget-bytes' | 'unreadable';
  }[];
  readonly usedFiles: number;
  readonly usedBytes: number;
  /** True when no candidate matched on metadata and the keyword fallback ran. */
  readonly usedFallback: boolean;
}

export interface RetrievalOptions {
  readonly maxFiles?: number;
  readonly maxBytes?: number;
}

/** Split text into lowercase alphanumeric terms. Shared by query and candidate tokenization. */
function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z0-9]+/g);
  return matches ?? [];
}

/** How many DISTINCT query terms appear in `haystackTerms`. */
function overlap(queryTerms: readonly string[], haystackTerms: readonly string[]): number {
  const haystack = new Set(haystackTerms);
  let matched = 0;
  for (const term of queryTerms) if (haystack.has(term)) matched++;
  return matched;
}

interface Ranked {
  readonly candidate: MemoryCandidate;
  readonly score: number;
}

/** Stable ordering: higher score first, then by name ascending, then by path — fully deterministic. */
function byRank(a: Ranked, b: Ranked): number {
  if (b.score !== a.score) return b.score - a.score;
  if (a.candidate.name !== b.candidate.name) {
    return a.candidate.name < b.candidate.name ? -1 : 1;
  }
  return a.candidate.path < b.candidate.path ? -1 : a.candidate.path > b.candidate.path ? 1 : 0;
}

export function retrieve(
  query: string,
  candidates: readonly MemoryCandidate[],
  options: RetrievalOptions = {},
): RetrievalResult {
  const maxFiles = options.maxFiles ?? RETRIEVAL_MAX_FILES;
  const maxBytes = options.maxBytes ?? RETRIEVAL_MAX_BYTES;
  const queryTerms = [...new Set(tokenize(query))];

  // Stage 1: side-selection on name + description only.
  const sideSelected: Ranked[] = [];
  for (const candidate of candidates) {
    const score = overlap(queryTerms, tokenize(`${candidate.name} ${candidate.description}`));
    if (score > 0) sideSelected.push({ candidate, score });
  }

  // Stage 2: keyword fallback, ONLY when nothing matched on metadata. A body read failure here is
  // isolated so one bad file cannot suppress the whole fallback.
  const usedFallback = sideSelected.length === 0 && queryTerms.length > 0;
  const skipped: { path: string; reason: 'budget-files' | 'budget-bytes' | 'unreadable' }[] = [];

  let ranked: Ranked[];
  const fallbackBodies = new Map<string, string>();
  if (usedFallback) {
    const scored: Ranked[] = [];
    for (const candidate of candidates) {
      let body: string;
      try {
        body = candidate.readBody();
      } catch {
        skipped.push({ path: candidate.path, reason: 'unreadable' });
        continue;
      }
      fallbackBodies.set(candidate.path, body);
      const score = overlap(queryTerms, tokenize(body));
      if (score > 0) scored.push({ candidate, score });
    }
    ranked = scored;
  } else {
    ranked = sideSelected;
  }

  ranked.sort(byRank);

  // Inclusion under budget. A body we already read during fallback is reused, not re-read.
  const memories: RetrievedMemory[] = [];
  let usedBytes = 0;
  for (const { candidate, score } of ranked) {
    if (memories.length >= maxFiles) {
      skipped.push({ path: candidate.path, reason: 'budget-files' });
      continue;
    }
    let body: string;
    const cached = fallbackBodies.get(candidate.path);
    if (cached !== undefined) {
      body = cached;
    } else {
      try {
        body = candidate.readBody();
      } catch {
        skipped.push({ path: candidate.path, reason: 'unreadable' });
        continue;
      }
    }
    const sizeBytes = Buffer.byteLength(body, 'utf8');
    if (usedBytes + sizeBytes > maxBytes) {
      skipped.push({ path: candidate.path, reason: 'budget-bytes' });
      continue;
    }
    usedBytes += sizeBytes;
    memories.push({
      name: candidate.name,
      description: candidate.description,
      type: candidate.type,
      body,
      sizeBytes,
      provenance: { scope: candidate.scope, path: candidate.path },
      matchedBy: usedFallback ? 'keyword-fallback' : 'side-selection',
      score,
    });
  }

  return { memories, skipped, usedFiles: memories.length, usedBytes, usedFallback };
}
