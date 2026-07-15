import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { migrate } from '../../src/migrations.ts';

/**
 * A failing migration rolls back atomically (SS-07).
 *
 * Each migration runs inside a transaction that bumps `user_version` in the SAME step, so a migration
 * that throws part-way leaves NO partial schema and does NOT advance the version — the store is left
 * exactly where it was, recoverable rather than half-migrated.
 */

describe('migration rollback (SS-07)', () => {
  it('a migration that fails leaves the schema version unchanged and nothing partially applied', () => {
    const db = new Database(':memory:');
    try {
      // Force migration 1 to fail: pre-create a table it will also try to CREATE, so its statement
      // throws mid-migration.
      db.exec('CREATE TABLE events (bogus TEXT)');
      const versionBefore = db.pragma('user_version', { simple: true });

      expect(() => migrate(db)).toThrow();

      // The version bump was inside the same transaction as the schema change, so it rolled back too.
      expect(db.pragma('user_version', { simple: true })).toBe(versionBefore);
      // And the migration created no OTHER table (e.g. `threads`) before it hit the failure.
      const threads = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='threads'")
        .get();
      expect(threads).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
