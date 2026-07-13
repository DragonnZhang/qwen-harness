/**
 * Storage-backed transcript boundary persistence (CX-03).
 *
 * `context` is not an I/O owner — it performs no direct filesystem or database I/O (scripts/graph.ts
 * lists it as pure coordination that persists boundaries THROUGH `storage`). So this adapter takes
 * an already-constructed `EventStore` (an injected port) and records the compaction boundary as a
 * `compaction` item on the durable, append-only log. The full pre-compaction transcript is already
 * in that log as prior `item-appended` events; the boundary marker we write captures the content
 * digest and the pre-compaction token count, so recovery can locate exactly what was compacted.
 *
 * The returned reference is the content digest — a content-addressed, stable id for the boundary.
 * The final compaction summary is written later by the runtime as its own item carrying this same
 * `transcriptBoundaryRef`; the marker here is the durable "we are about to compact this" record.
 */

import type {
  Actor,
  Clock,
  CorrelationId,
  IdSource,
  Item,
  ItemId,
  PermissionProfile,
  ThreadId,
  TurnId,
} from '@qwen-harness/protocol';
import type { EventStore } from '@qwen-harness/storage';

import type { BoundaryStore, TranscriptBoundary } from './compaction.ts';

type CompactionItem = Extract<Item, { type: 'compaction' }>;

export interface EventStoreBoundaryContext {
  readonly store: EventStore;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly actor: Actor;
  readonly correlationId: CorrelationId;
  readonly permissionProfile: PermissionProfile;
  readonly ids: IdSource;
  readonly clock: Clock;
  /** Ordinal of the boundary item within the turn. Injected so it stays deterministic. */
  readonly nextItemSeq: () => number;
}

/**
 * Build a `BoundaryStore` that records boundaries on a real `EventStore`. Appending goes through the
 * store's single transactional path (event + projection commit together), so a crash cannot leave a
 * boundary recorded in the log but missing from the item projection.
 */
export function eventStoreBoundaryStore(ctx: EventStoreBoundaryContext): BoundaryStore {
  return {
    write(boundary: TranscriptBoundary): string {
      const item: CompactionItem = {
        id: ctx.ids.next('itm') as ItemId,
        turnId: ctx.turnId,
        threadId: ctx.threadId,
        seq: ctx.nextItemSeq(),
        createdAt: ctx.clock.now(),
        type: 'compaction',
        trigger: boundary.trigger,
        transcriptBoundaryRef: boundary.digest,
        // Marker only: the runtime appends the final compaction item (with the real summary) later,
        // carrying this same boundary ref. Recording tokensBefore here makes the marker useful on
        // its own for recovery and audit.
        summary: `[boundary marker for ${boundary.itemCount} item(s)]`,
        tokensBefore: boundary.tokensBefore,
        tokensAfter: 0,
      };

      ctx.store.append({
        threadId: ctx.threadId,
        payload: { type: 'item-appended', item },
        actor: ctx.actor,
        correlationId: ctx.correlationId,
        turnId: ctx.turnId,
        itemId: item.id,
        permissionProfile: ctx.permissionProfile,
      });

      return boundary.digest;
    },
  };
}
