/**
 * Safe extraction after a completed turn (MM-03).
 *
 * When — and ONLY when — a turn completes naturally and was not cancelled, the runtime may extract a
 * durable lesson from it. This module is the deterministic gate and the safety filter around that;
 * the actual "is there a lesson, and what is it" decision is INJECTED as `propose`, so this code is
 * fully testable without a model and never itself invents a memory.
 *
 * Safety rules, all enforced here regardless of what `propose` returns:
 *   - A cancelled or non-completed turn extracts nothing (a no-op result, never an error).
 *   - An empty proposal is a clean no-op — a valid outcome, not a failure.
 *   - Every candidate is run through the STORAGE {@link Redactor}. If redaction would change the
 *     text, the candidate CONTAINED a secret and is REJECTED outright — we do not store even the
 *     redacted form, because a memory that carried a credential is untrustworthy transient noise,
 *     not a stable lesson. A candidate that still matches a secret shape after redaction is likewise
 *     rejected (defence in depth). A stored memory therefore never contains a secret (MM-03, S).
 *   - Candidates are deduplicated against each other and against the already-stored set, so the same
 *     lesson is never written twice (MM-03).
 */

import type { Redactor } from '@qwen-harness/storage';

import { dedupKey } from './dedup.ts';
import type { Memory, MemoryFrontmatter } from './frontmatter.ts';
import { MemoryFrontmatterSchema } from './frontmatter.ts';

/**
 * The turn outcome the gate reads. Only the two eligibility flags are required; richer context is
 * whatever `propose` closes over. `completed` means the turn reached its terminal completion
 * transition; `cancelled` means the user or an abort ended it early.
 */
export interface TurnOutcome {
  readonly completed: boolean;
  readonly cancelled: boolean;
}

/** A proposed memory before validation/redaction. The injected `propose` returns these. */
export interface MemoryProposal extends MemoryFrontmatter {
  readonly body: string;
}

/** Why a specific candidate was not stored. */
export type ExtractionRejection =
  | { readonly kind: 'contains-secret'; readonly name: string }
  | { readonly kind: 'invalid'; readonly name: string; readonly detail: string }
  | { readonly kind: 'duplicate'; readonly name: string };

/** Why extraction as a whole produced nothing (a no-op is not an error). */
export type ExtractionSkip = 'turn-not-eligible' | 'empty-proposal';

export interface ExtractionResult {
  /** Memories that passed every gate and are safe to persist. */
  readonly extracted: readonly Memory[];
  /** Candidates that were proposed but not stored, with a reason. */
  readonly rejected: readonly ExtractionRejection[];
  /** Set when nothing was extracted for a structural reason (no-op), otherwise `null`. */
  readonly skipped: ExtractionSkip | null;
}

export interface ExtractionOptions {
  /**
   * The injected lesson extractor. Returns zero or more proposals. This is where a model or a
   * heuristic decides whether the turn taught anything worth keeping; the gate never second-guesses
   * the CONTENT, only enforces eligibility, safety, and dedup.
   */
  readonly propose: (outcome: TurnOutcome) => readonly MemoryProposal[];
  /** The storage redactor, seeded with any live secret values by the caller. */
  readonly redactor: Redactor;
  /** Dedup keys of already-stored memories, so an existing lesson is not re-extracted. */
  readonly existing?: Iterable<string>;
}

/** True when redaction would alter the text — i.e. the text contains something secret-shaped. */
function containsSecret(redactor: Redactor, text: string): boolean {
  return redactor.redact(text) !== text;
}

/**
 * Run the extraction gate over a completed turn. Deterministic given `propose`.
 */
export function maybeExtract(outcome: TurnOutcome, options: ExtractionOptions): ExtractionResult {
  const empty = (skipped: ExtractionSkip): ExtractionResult => ({
    extracted: [],
    rejected: [],
    skipped,
  });

  // MM-03: extract only after a naturally completed, non-cancelled turn.
  if (!outcome.completed || outcome.cancelled) return empty('turn-not-eligible');

  const proposals = options.propose(outcome);
  if (proposals.length === 0) return empty('empty-proposal');

  const seen = new Set<string>(options.existing ?? []);
  const extracted: Memory[] = [];
  const rejected: ExtractionRejection[] = [];

  for (const proposal of proposals) {
    // Validate the frontmatter shape first, so a bad name/type never reaches disk.
    const parsed = MemoryFrontmatterSchema.safeParse({
      name: proposal.name,
      description: proposal.description,
      type: proposal.type,
    });
    if (!parsed.success) {
      rejected.push({
        kind: 'invalid',
        name: proposal.name,
        detail: parsed.error.issues.map((i) => i.message).join('; '),
      });
      continue;
    }

    // Secret filter across every field, not just the body — a name or description can leak too.
    const combined = `${proposal.name}\n${proposal.description}\n${proposal.body}`;
    if (containsSecret(options.redactor, combined)) {
      rejected.push({ kind: 'contains-secret', name: proposal.name });
      continue;
    }

    const memory: Memory = { ...parsed.data, body: proposal.body.replace(/\n+$/, '') };
    const key = dedupKey(memory);
    if (seen.has(key)) {
      rejected.push({ kind: 'duplicate', name: memory.name });
      continue;
    }
    seen.add(key);
    extracted.push(memory);
  }

  return { extracted, rejected, skipped: null };
}
