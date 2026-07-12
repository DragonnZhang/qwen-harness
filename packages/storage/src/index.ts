/**
 * @qwen-harness/storage
 *
 * The append-only typed event store: SQLite WAL, transactional projections, migrations,
 * JSONL export/replay, and boundary redaction.
 *
 * This package is one of the declared I/O owners (see `scripts/graph.ts`): it owns its database
 * and its files, and nothing else. No other package may open SQLite.
 */

export { EventStore, InjectedFailure } from './event-store.ts';
export type { EventStoreOptions, AppendInput, FailureBoundary } from './event-store.ts';

export { MIGRATIONS, LATEST_SCHEMA_VERSION, migrate, currentVersion } from './migrations.ts';
export type { Migration } from './migrations.ts';

export { Redactor, createRedactor, encodedVariants, REDACTED } from './redaction.ts';

export { exportJsonl, importJsonl, replayInto, EXPORT_FORMAT_VERSION } from './export.ts';
export type { ExportHeader, ImportResult } from './export.ts';
