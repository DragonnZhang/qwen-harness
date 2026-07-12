import type { ToolCallId } from '@qwen-harness/protocol';

import type { ResourceFootprint, ToolAnnotations } from './contract.ts';

/**
 * Batching model-emitted tool calls (TL-08).
 *
 * One model output can contain many calls. Running them all in parallel is wrong (two writes to
 * the same file race); running them all serially is needlessly slow (eight independent reads
 * should not queue).
 *
 * The rule this implements: **partition in ORIGINAL ORDER into batches, based on the ACTUAL
 * resource conflicts of the ACTUAL arguments.** Not on the tool's name — two `write_file` calls
 * to different paths do not conflict, and a `read_file` of a path a sibling call is writing very
 * much does.
 *
 * Original order is preserved across batches, so a call never observes a state that the model did
 * not intend it to observe.
 */

export interface PlannedCall {
  readonly callId: ToolCallId;
  readonly toolName: string;
  readonly annotations: ToolAnnotations;
  readonly footprint: ResourceFootprint;
}

export interface Batch {
  readonly kind: 'parallel' | 'serial';
  readonly calls: readonly PlannedCall[];
}

export interface ScheduleOptions {
  /** Frozen default: 8 (docs/product/defaults.md, "safe read-tool concurrency"). */
  readonly maxParallel: number;
}

/** Two calls conflict if either writes something the other touches, or if either is unbounded. */
export function conflicts(a: PlannedCall, b: PlannedCall): boolean {
  // An unbounded call (an arbitrary shell command) could touch anything. We cannot reason about
  // it, so we never run it beside anything else. Conservative by construction.
  if (a.footprint.unbounded || b.footprint.unbounded) return true;

  const aWrites = new Set(a.footprint.writes);
  const bWrites = new Set(b.footprint.writes);

  // write/write on the same path
  for (const w of aWrites) if (bWrites.has(w)) return true;
  // write/read and read/write on the same path
  for (const r of a.footprint.reads) if (bWrites.has(r)) return true;
  for (const r of b.footprint.reads) if (aWrites.has(r)) return true;

  return false;
}

/**
 * Partitions calls into ordered batches.
 *
 * A call joins the current parallel batch only if it conflicts with NOTHING already in it. The
 * moment a conflict appears, the batch closes and a new one opens — which is what preserves the
 * original ordering semantics while still parallelizing the safe majority.
 */
export function planBatches(calls: readonly PlannedCall[], options: ScheduleOptions): Batch[] {
  const batches: Batch[] = [];
  let current: PlannedCall[] = [];

  const flush = () => {
    if (current.length === 0) return;
    batches.push({
      // A single-call batch is `serial` if the call is a mutation — this is what the audit trail
      // and the UI read to explain *why* something did not run concurrently.
      kind: current.length === 1 && !isSafeParallel(current[0]!) ? 'serial' : 'parallel',
      calls: current,
    });
    current = [];
  };

  for (const call of calls) {
    // A mutating or unbounded call is never merged into a parallel batch. Even two writes to
    // different files are serialized: a mutation's real footprint can exceed what it declares
    // (a write triggers a file watcher, a shell command has arbitrary effects), and the cost of
    // being wrong here is a corrupted workspace.
    if (!isSafeParallel(call)) {
      flush();
      batches.push({ kind: 'serial', calls: [call] });
      continue;
    }

    const conflictsWithBatch = current.some((existing) => conflicts(existing, call));
    if (conflictsWithBatch || current.length >= options.maxParallel) {
      flush();
    }
    current.push(call);
  }

  flush();
  return batches;
}

/** Only a read-only, bounded call is eligible to share a batch. */
function isSafeParallel(call: PlannedCall): boolean {
  return call.annotations.readOnly && !call.annotations.destructive && !call.footprint.unbounded;
}
