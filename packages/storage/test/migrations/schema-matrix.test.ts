import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CorrelationId, IdSource, ThreadId, TurnId } from '@qwen-harness/protocol';
import { ManualClock, SequentialIds, USER_ACTOR } from '@qwen-harness/testkit';

import {
  EventStore,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  SchemaTooNewError,
  currentVersion,
  exportJsonl,
  importJsonl,
  migrate,
  replayInto,
} from '../../src/index.ts';

/**
 * SS-06 / SS-07 / RT-09: the migration matrix, run from EVERY shipped version.
 *
 * This suite exists because `pnpm test:migrations` was previously a VACUOUS gate — the vitest
 * project globbed `packages/*​/test/migrations/**` and matched nothing, so `pnpm check` composed a
 * suite that asserted precisely zero things about the schema. A gate that cannot fail is worse than
 * no gate, because it reads as coverage.
 *
 * The rules a released migration must obey, each asserted below rather than assumed:
 *   - a shipped migration is IMMUTABLE (its version/name pair is a contract with every database
 *     already on disk);
 *   - migrating is forward-only, and applying it twice is a no-op;
 *   - data written under an OLD version survives the upgrade to the newest, byte for byte;
 *   - a database from the FUTURE is refused, never opened;
 *   - an export taken at version N still imports and replays at the latest version.
 */

const THREAD = 'thr_000001' as ThreadId;
const TURN = 'trn_000001' as TurnId;
const CORR = 'cor_000001' as CorrelationId;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qh-migrations-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Materialize a database at exactly `version` — the state a user of that release has on disk. */
function dbAtVersion(path: string, version: number): Database.Database {
  const db = new Database(path);
  for (const migration of MIGRATIONS) {
    if (migration.version > version) break;
    const run = db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    });
    run();
  }
  return db;
}

/**
 * A deterministic id source that starts above `offset`. Reopening a store with a fresh
 * `SequentialIds` would remint ids the database already holds — the UNIQUE constraint on
 * `events.id` catches that, which is itself reassuring, but here we want to append genuinely NEW
 * events on top of migrated history, so the second writer continues the sequence.
 */
function idsFrom(offset: number): IdSource {
  const counters = new Map<string, number>();
  return {
    next(prefix: string): string {
      const n = (counters.get(prefix) ?? offset) + 1;
      counters.set(prefix, n);
      return `${prefix}_${String(n).padStart(6, '0')}`;
    },
  };
}

function newStore(path: string, ids: IdSource = new SequentialIds()): EventStore {
  return new EventStore({
    path,
    clock: new ManualClock(1_700_000_000_000),
    ids,
  });
}

function seedThread(store: EventStore, text: string): void {
  const base = { threadId: THREAD, correlationId: CORR, permissionProfile: 'ask' as const };
  store.append({
    ...base,
    actor: USER_ACTOR,
    payload: { type: 'thread-created', cwd: '/workspace', canonicalRepo: '/workspace', name: null },
  });
  store.append({
    ...base,
    actor: USER_ACTOR,
    turnId: TURN,
    payload: { type: 'turn-started', userText: text },
  });
}

/**
 * Write history the way a build at that OLD version left it on disk — with raw SQL.
 *
 * We cannot seed through `EventStore` here: opening the store MIGRATES it, so the rows would land
 * under the newest schema and the test would prove nothing about upgrading. The point is to have
 * genuinely old rows present when the migration runs.
 */
function seedRaw(db: Database.Database, text: string): void {
  const insert = db.prepare(
    `INSERT INTO events (id, schema_version, thread_id, seq, timestamp, turn_id, item_id,
       actor_kind, actor_id, correlation_id, causation_id, permission_profile, payload_type, payload)
     VALUES (@id, @schemaVersion, @threadId, @seq, @timestamp, @turnId, @itemId,
       @actorKind, @actorId, @correlationId, @causationId, @permissionProfile, @payloadType, @payload)`,
  );
  const common = {
    schemaVersion: 1,
    threadId: THREAD,
    timestamp: 1_700_000_000_000,
    itemId: null,
    actorKind: USER_ACTOR.kind,
    actorId: USER_ACTOR.id,
    correlationId: CORR,
    causationId: null,
    permissionProfile: 'ask',
  };
  insert.run({
    ...common,
    id: 'evt_000001',
    seq: 0,
    turnId: null,
    payloadType: 'thread-created',
    payload: JSON.stringify({
      type: 'thread-created',
      cwd: '/workspace',
      canonicalRepo: '/workspace',
      name: null,
    }),
  });
  insert.run({
    ...common,
    id: 'evt_000002',
    seq: 1,
    turnId: TURN,
    payloadType: 'turn-started',
    payload: JSON.stringify({ type: 'turn-started', userText: text }),
  });
}

describe('the migration list is an append-only contract', () => {
  it('versions are dense, ascending, and start at 1', () => {
    expect(MIGRATIONS.length).toBeGreaterThan(0);
    MIGRATIONS.forEach((migration, index) => {
      expect(migration.version).toBe(index + 1);
      expect(migration.name).not.toBe('');
    });
    expect(LATEST_SCHEMA_VERSION).toBe(MIGRATIONS.length);
  });

  it('every shipped version has a unique name (a rename would silently rewrite history)', () => {
    const names = new Set(MIGRATIONS.map((m) => m.name));
    expect(names.size).toBe(MIGRATIONS.length);
  });
});

describe('upgrading from every shipped version', () => {
  // The whole matrix: a database created by ANY released build must reach the latest schema.
  for (const start of MIGRATIONS.map((m) => m.version)) {
    it(`a v${start} database migrates to v${LATEST_SCHEMA_VERSION} and keeps its data`, () => {
      const path = join(dir, `v${start}.db`);

      // A database exactly as a build at v{start} left it, with real rows in it.
      const old = dbAtVersion(path, start);
      expect(currentVersion(old)).toBe(start);
      seedRaw(old, 'written under the old schema');
      old.close();

      // Migrate it the way the current build does on open.
      const db = new Database(path);
      const result = migrate(db);
      expect(result.from).toBe(start);
      expect(result.to).toBe(LATEST_SCHEMA_VERSION);
      db.close();

      // The old rows survived the upgrade and still decode under the current schema.
      const after = newStore(path, idsFrom(100));
      const migrated = after.readThread(THREAD);
      expect(migrated.length).toBe(2);
      expect(migrated[0]?.payload).toEqual({
        type: 'thread-created',
        cwd: '/workspace',
        canonicalRepo: '/workspace',
        name: null,
      });
      expect(migrated[1]?.payload).toEqual({
        type: 'turn-started',
        userText: 'written under the old schema',
      });

      // And the store still works: a new event appends on top of the migrated history.
      after.append({
        threadId: THREAD,
        correlationId: CORR,
        permissionProfile: 'ask',
        actor: USER_ACTOR,
        turnId: 'trn_000002' as TurnId,
        payload: { type: 'turn-started', userText: 'written under the new schema' },
      });
      expect(after.readThread(THREAD).length).toBe(3);
      after.close();
    });
  }

  it('migrating an already-current database applies nothing (idempotent)', () => {
    const path = join(dir, 'current.db');
    const db = dbAtVersion(path, LATEST_SCHEMA_VERSION);
    const result = migrate(db);
    expect(result.from).toBe(LATEST_SCHEMA_VERSION);
    expect(result.to).toBe(LATEST_SCHEMA_VERSION);
    expect(result.applied).toEqual([]);
    db.close();
  });

  it('a fresh database is created at the latest version in one pass', () => {
    const path = join(dir, 'fresh.db');
    const db = new Database(path);
    const result = migrate(db);
    expect(result.from).toBe(0);
    expect(result.to).toBe(LATEST_SCHEMA_VERSION);
    expect(result.applied.length).toBe(MIGRATIONS.length);
    db.close();
  });
});

describe('a database from the future is refused, not opened', () => {
  it('throws SchemaTooNewError rather than writing with stale assumptions', () => {
    const path = join(dir, 'future.db');
    const db = dbAtVersion(path, LATEST_SCHEMA_VERSION);
    // Simulate a NEWER build having migrated this database.
    const future = LATEST_SCHEMA_VERSION + 1;
    db.pragma(`user_version = ${future}`);
    db.close();

    const reopened = new Database(path);
    expect(() => migrate(reopened)).toThrow(SchemaTooNewError);
    // The version is left untouched: refusing must not mutate the database.
    expect(currentVersion(reopened)).toBe(future);
    reopened.close();
  });

  it('the error names both versions so an operator knows what to do', () => {
    const path = join(dir, 'future2.db');
    const db = dbAtVersion(path, LATEST_SCHEMA_VERSION);
    db.pragma(`user_version = ${LATEST_SCHEMA_VERSION + 3}`);
    db.close();

    const reopened = new Database(path);
    try {
      migrate(reopened);
      expect.unreachable('migrate must refuse a future schema');
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaTooNewError);
      const e = err as SchemaTooNewError;
      expect(e.found).toBe(LATEST_SCHEMA_VERSION + 3);
      expect(e.supported).toBe(LATEST_SCHEMA_VERSION);
      expect(e.message).toContain('newer qwen-harness');
    }
    reopened.close();
  });
});

describe('export compatibility across versions (SS-06)', () => {
  it('an export taken at an older schema imports and replays at the latest', () => {
    // Produce the export from a database that was created at the FIRST shipped version.
    const oldPath = join(dir, 'old-export.db');
    dbAtVersion(oldPath, 1).close();
    const oldStore = newStore(oldPath);
    seedThread(oldStore, 'exported from v1');
    const jsonl = exportJsonl(oldStore, THREAD);
    const originalEvents = oldStore.readThread(THREAD);
    oldStore.close();

    // Import it into a database at the CURRENT schema.
    const parsed = importJsonl(jsonl);
    expect(parsed.events.length).toBe(originalEvents.length);

    const freshPath = join(dir, 'fresh-import.db');
    const fresh = newStore(freshPath);
    replayInto(fresh, parsed.events);

    const replayed = fresh.readThread(THREAD);
    expect(replayed.map((e) => e.payload)).toEqual(originalEvents.map((e) => e.payload));
    fresh.close();
  });
});
