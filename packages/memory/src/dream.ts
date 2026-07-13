/**
 * Dream orchestration (MM-04).
 *
 * This is the side-effecting wrapper around the pure consolidation core. It enforces EVERY frozen
 * operational gate and does so in an order that makes a corrupt or truncated result impossible to
 * commit:
 *
 *   1. Eligibility — {@link isDreamEligible}. Ineligible returns without touching disk.
 *   2. Lock — a renewable 5-minute lease on the scope directory. Only one Dream runs per repo.
 *   3. Deadline — a 10-minute wall clock; any step past it aborts WITHOUT writing.
 *   4. One model call — exactly one injected `summarize`, with input capped at 64K tokens and output
 *      at 8K. The model is INJECTED so this is deterministic and testable.
 *   5. Schema/provenance check — the final memory set is re-validated. If ANYTHING fails, NO WRITE.
 *   6. Atomic write — retired/superseded files removed, survivors rewritten, and the index written
 *      last through the atomic temp+rename. A crash or a lost lease leaves the prior index intact.
 *
 * The pure decisions (who wins a conflict, whether Dream may run) live in `consolidation.ts` and are
 * tested there; this module is tested for the operational guarantees — eligibility short-circuit,
 * no-write-on-failure, and atomic recovery.
 */

import { join } from 'node:path';

import type { Clock } from '@qwen-harness/protocol';

import {
  buildIndex,
  consolidateMemories,
  DREAM_LOCK_LEASE_MS,
  DREAM_MAX_INPUT_TOKENS,
  DREAM_MAX_OUTPUT_TOKENS,
  DREAM_WALL_MS,
  estimateTokens,
  isDreamEligible,
  type ConsolidationPlan,
  type DreamIneligibleReason,
  type DreamState,
  type MemoryConflict,
  type MemoryRecord,
} from './consolidation.ts';
import type { Memory, MemoryType } from './frontmatter.ts';
import { MemoryFrontmatterSchema } from './frontmatter.ts';
import { FileLock, MemoryLockError } from './lock.ts';
import type { MemoryScope } from './scopes.ts';
import type { MemoryStore } from './store.ts';

/** What the injected model sees. A structured, capped view of the candidate memories. */
export interface DreamModelInput {
  readonly memories: readonly {
    name: string;
    description: string;
    type: MemoryType;
    body: string;
  }[];
  readonly conflicts: readonly MemoryConflict[];
  readonly maxOutputTokens: number;
}

/** What the injected model returns: a summary and, optionally, a rewritten memory set. */
export interface DreamModelResult {
  readonly summary: string;
  /**
   * An optional model-consolidated memory set that REPLACES the mechanical survivors. Every entry is
   * re-validated against the frontmatter schema; if any is invalid the whole run writes nothing.
   */
  readonly memories?: readonly { name: string; description: string; type: string; body: string }[];
}

export type DreamSummarizer = (
  input: DreamModelInput,
) => DreamModelResult | Promise<DreamModelResult>;

export type DreamOutcomeReason =
  | DreamIneligibleReason
  | 'ok'
  | 'schema-check-failed'
  | 'wall-time-exceeded'
  | 'lease-lost'
  | 'lock-unavailable';

export interface DreamRunResult {
  /** Did the run pass eligibility and acquire the lock? */
  readonly ran: boolean;
  /** Did it commit a new index and memory set? */
  readonly written: boolean;
  readonly reason: DreamOutcomeReason;
  readonly plan?: ConsolidationPlan;
  readonly indexPath?: string;
  readonly modelCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface RunDreamOptions {
  readonly store: MemoryStore;
  readonly clock: Clock;
  /** The scope directory to consolidate. */
  readonly dir: string;
  readonly scope: MemoryScope;
  readonly state: DreamState;
  readonly summarize: DreamSummarizer;
  /** Records with `updatedAt` older than this are retired as stale. */
  readonly staleBefore?: number;
  readonly lockHolder?: string;
  readonly lockTimeoutMs?: number;
  /** Failure-injection hook forwarded to the index's atomic write (MM-04, evidence F). */
  readonly onIndexBeforeRename?: () => void | Promise<void>;
}

/** Truncate text so its estimated token count does not exceed `maxTokens` (~4 bytes/token). */
function capTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  const maxBytes = maxTokens * 4;
  // Byte-accurate slice for ASCII-heavy memory content; a trailing multibyte char is harmless.
  return Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
}

/** Build the capped model input, dropping the lowest-ranked memories until within the token budget. */
function buildModelInput(
  kept: readonly MemoryRecord[],
  conflicts: readonly MemoryConflict[],
): {
  input: DreamModelInput;
  inputTokens: number;
} {
  const memories = kept.map((r) => ({
    name: r.memory.name,
    description: r.memory.description,
    type: r.memory.type,
    body: r.memory.body,
  }));

  const serialize = (list: typeof memories): string =>
    JSON.stringify({ memories: list, conflicts });
  const trimmed = [...memories];
  while (trimmed.length > 0 && estimateTokens(serialize(trimmed)) > DREAM_MAX_INPUT_TOKENS) {
    trimmed.pop();
  }
  const inputTokens = estimateTokens(serialize(trimmed));
  return {
    input: { memories: trimmed, conflicts, maxOutputTokens: DREAM_MAX_OUTPUT_TOKENS },
    inputTokens,
  };
}

export async function runDream(options: RunDreamOptions): Promise<DreamRunResult> {
  const { store, clock, dir, scope, state, summarize } = options;

  const list = await store.listMemories(dir, scope);
  const records: MemoryRecord[] = list.records.map((r) => ({
    memory: r.memory,
    provenance: r.provenance,
    updatedAt: r.updatedAt,
  }));
  const candidateBytes = records.reduce(
    (sum, r) => sum + Buffer.byteLength(r.memory.body, 'utf8'),
    0,
  );

  const eligibility = isDreamEligible(
    state,
    { count: records.length, bytes: candidateBytes },
    clock.now(),
  );
  if (!eligibility.eligible) {
    return {
      ran: false,
      written: false,
      reason: eligibility.reason,
      modelCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  const deadline = clock.now() + DREAM_WALL_MS;
  let lock: FileLock;
  try {
    lock = await FileLock.acquire(`${dir}/.dream.lock`, {
      clock,
      holder: options.lockHolder ?? 'dream',
      leaseMs: DREAM_LOCK_LEASE_MS,
      timeoutMs: options.lockTimeoutMs ?? 30_000,
    });
  } catch (err) {
    if (err instanceof MemoryLockError) {
      return {
        ran: false,
        written: false,
        reason: 'lock-unavailable',
        modelCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
    }
    throw err;
  }

  try {
    const plan = consolidateMemories(
      records,
      options.staleBefore !== undefined ? { staleBefore: options.staleBefore } : {},
    );

    const { input, inputTokens } = buildModelInput(plan.kept, plan.conflicts);

    // Renew before the (potentially long) model call so the lease covers it.
    await lock.renew();
    if (clock.now() > deadline) {
      return {
        ran: true,
        written: false,
        reason: 'wall-time-exceeded',
        plan,
        modelCalls: 0,
        inputTokens,
        outputTokens: 0,
      };
    }

    const modelResult = await summarize(input);
    const summary = capTokens(modelResult.summary, DREAM_MAX_OUTPUT_TOKENS);
    const outputTokens = estimateTokens(summary);

    // Determine the final memory set. A model rewrite REPLACES the mechanical survivors and must
    // pass schema validation; the mechanical survivors are already valid by construction.
    let finalMemories: Memory[];
    if (modelResult.memories) {
      const validated: Memory[] = [];
      for (const proposal of modelResult.memories) {
        const parsed = MemoryFrontmatterSchema.safeParse({
          name: proposal.name,
          description: proposal.description,
          type: proposal.type,
        });
        if (!parsed.success) {
          return {
            ran: true,
            written: false,
            reason: 'schema-check-failed',
            plan,
            modelCalls: 1,
            inputTokens,
            outputTokens,
          };
        }
        validated.push({ ...parsed.data, body: proposal.body.replace(/\n+$/, '') });
      }
      finalMemories = validated;
    } else {
      finalMemories = plan.kept.map((r) => r.memory);
    }

    // Wall-time and lease re-check immediately before any write.
    if (clock.now() > deadline) {
      return {
        ran: true,
        written: false,
        reason: 'wall-time-exceeded',
        plan,
        modelCalls: 1,
        inputTokens,
        outputTokens,
      };
    }
    try {
      await lock.renew();
    } catch (err) {
      if (err instanceof MemoryLockError) {
        return {
          ran: true,
          written: false,
          reason: 'lease-lost',
          plan,
          modelCalls: 1,
          inputTokens,
          outputTokens,
        };
      }
      throw err;
    }

    // Remove every prior file that is not a survivor's canonical path — retired memories, conflict
    // losers, and files whose stem disagreed with their frontmatter name. Keying on the CANONICAL
    // path (not the name) is what makes a superseded duplicate actually disappear.
    const survivorPaths = new Set(finalMemories.map((m) => join(dir, `${m.name}.md`)));
    for (const record of list.records) {
      if (!survivorPaths.has(record.provenance.path)) {
        await store.removeMemory(record.provenance.path);
      }
    }
    for (const memory of finalMemories) {
      await store.writeMemory(dir, memory, scope, { holder: options.lockHolder ?? 'dream' });
    }

    const finalRecords: MemoryRecord[] = finalMemories.map((memory) => ({
      memory,
      provenance: { scope, path: join(dir, `${memory.name}.md`) },
      updatedAt: clock.now(),
    }));
    const indexContent = buildIndex(finalRecords, { summary });
    const indexPath = await store.writeIndex(
      dir,
      indexContent,
      options.onIndexBeforeRename ? { onBeforeRename: options.onIndexBeforeRename } : {},
    );

    return {
      ran: true,
      written: true,
      reason: 'ok',
      plan,
      indexPath,
      modelCalls: 1,
      inputTokens,
      outputTokens,
    };
  } finally {
    await lock.release();
  }
}
