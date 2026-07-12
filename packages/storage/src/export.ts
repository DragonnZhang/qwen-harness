import {
  HarnessEventSchema,
  parseEventLenient,
  type HarnessEvent,
  type ThreadId,
} from '@qwen-harness/protocol';

import type { EventStore } from './event-store.ts';

/**
 * JSONL export/replay (SS-06).
 *
 * The export schema is a STABLE PUBLIC CONTRACT and is deliberately decoupled from the SQLite
 * tables. Internal tables may be renamed, split, or indexed differently across releases; an
 * export written today must still import into a future build. So we serialize the typed event —
 * not a row dump.
 */

export const EXPORT_FORMAT_VERSION = 1;

export interface ExportHeader {
  readonly format: 'qwen-harness/jsonl';
  readonly formatVersion: number;
  readonly exportedAt: number;
  readonly threadId: ThreadId | null;
  readonly eventCount: number;
}

/**
 * Serializes to JSONL: one header line, then one event per line.
 *
 * Events are already redacted at write time (see redaction.ts), so an export cannot contain a
 * secret that the database did not. Redaction is not re-applied here — that would be a second
 * place to get it wrong.
 */
export function exportJsonl(
  store: EventStore,
  opts: { threadId?: ThreadId; exportedAt: number },
): string {
  const events = opts.threadId ? store.readThread(opts.threadId) : store.readAll();

  const header: ExportHeader = {
    format: 'qwen-harness/jsonl',
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: opts.exportedAt,
    threadId: opts.threadId ?? null,
    eventCount: events.length,
  };

  const lines = [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))];
  return lines.join('\n') + '\n';
}

export interface ImportResult {
  readonly header: ExportHeader;
  readonly events: HarnessEvent[];
  /** Events whose payload this build does not understand, preserved rather than dropped. */
  readonly unknownCount: number;
}

/**
 * Parses a JSONL export. An event with an unrecognized payload type is preserved as `unknown`
 * (RT-09) rather than rejected — otherwise an older build could not read a newer export, and a
 * round trip would silently destroy data.
 */
export function importJsonl(text: string): ImportResult {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const first = lines[0];
  if (first === undefined) throw new Error('empty export: missing header line');

  const header = JSON.parse(first) as ExportHeader;
  if (header.format !== 'qwen-harness/jsonl') {
    throw new Error(`unrecognized export format: ${String(header.format)}`);
  }
  if (header.formatVersion > EXPORT_FORMAT_VERSION) {
    throw new Error(
      `export is format version ${header.formatVersion}, this build understands up to ${EXPORT_FORMAT_VERSION}`,
    );
  }

  const events: HarnessEvent[] = [];
  let unknownCount = 0;

  for (const line of lines.slice(1)) {
    const event = parseEventLenient(JSON.parse(line));
    if (event.payload.type === 'unknown') unknownCount++;
    events.push(event);
  }

  if (events.length !== header.eventCount) {
    throw new Error(`export claims ${header.eventCount} events but contains ${events.length}`);
  }

  return { header, events, unknownCount };
}

/**
 * Deterministic replay (SS-06): feed an event list back through projection and compare.
 *
 * This is the check that makes "projections rebuild deterministically" a *tested* property
 * rather than a design intention.
 */
export function replayInto(store: EventStore, events: readonly HarnessEvent[]): void {
  const insert = store.db.prepare(
    `INSERT INTO events (id, schema_version, thread_id, seq, timestamp, turn_id, item_id,
       actor_kind, actor_id, correlation_id, causation_id, permission_profile, payload_type, payload)
     VALUES (@id, @schemaVersion, @threadId, @seq, @timestamp, @turnId, @itemId,
       @actorKind, @actorId, @correlationId, @causationId, @permissionProfile, @payloadType, @payload)`,
  );

  const tx = store.db.transaction(() => {
    for (const e of events) {
      // Round-trip through the schema so a hand-edited or corrupted export cannot inject an
      // event that never could have been produced.
      const validated = e.payload.type === 'unknown' ? e : HarnessEventSchema.parse(e);
      insert.run({
        id: validated.id,
        schemaVersion: validated.schemaVersion,
        threadId: validated.threadId,
        seq: validated.seq,
        timestamp: validated.timestamp,
        turnId: validated.turnId,
        itemId: validated.itemId,
        actorKind: validated.actor.kind,
        actorId: validated.actor.id,
        correlationId: validated.correlationId,
        causationId: validated.causationId,
        permissionProfile: validated.permissionProfile,
        payloadType:
          validated.payload.type === 'unknown'
            ? validated.payload.originalType
            : validated.payload.type,
        payload: JSON.stringify(
          validated.payload.type === 'unknown' ? validated.payload.raw : validated.payload,
        ),
      });
    }
  });

  tx();
  store.rebuildProjections();
}
