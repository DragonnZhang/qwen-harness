import type { Database } from 'better-sqlite3';

/**
 * Migrations are an ordered, append-only list. A migration is NEVER edited once shipped —
 * a released schema is a contract with every database already on disk. Fixes go in a new entry.
 *
 * `up` runs inside a transaction. `SS-07` requires the whole matrix be tested from every
 * supported version, which `test/migrations` does by materializing each version in turn.
 */
export interface Migration {
  readonly version: number;
  readonly name: string;
  up(db: Database): void;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial-event-store',
    up(db) {
      // The append-only log. This is the ONLY authoritative store; everything else is a
      // projection that can be dropped and rebuilt from here (SS-01).
      db.exec(`
        CREATE TABLE events (
          -- Global insertion order across all threads. Used for export and replay ordering.
          rowid_alias        INTEGER PRIMARY KEY AUTOINCREMENT,
          id                 TEXT    NOT NULL UNIQUE,
          schema_version     INTEGER NOT NULL,
          thread_id          TEXT    NOT NULL,
          -- Monotonic PER THREAD. The UNIQUE constraint below is what actually enforces it:
          -- two concurrent writers cannot both claim seq N. This is the single-writer guard
          -- at the storage layer, independent of the daemon lease (SS-08).
          seq                INTEGER NOT NULL,
          timestamp          INTEGER NOT NULL,
          turn_id            TEXT,
          item_id            TEXT,
          actor_kind         TEXT    NOT NULL,
          actor_id           TEXT    NOT NULL,
          correlation_id     TEXT    NOT NULL,
          causation_id       TEXT,
          permission_profile TEXT    NOT NULL,
          payload_type       TEXT    NOT NULL,
          payload            TEXT    NOT NULL,
          UNIQUE (thread_id, seq)
        ) STRICT;

        CREATE INDEX idx_events_thread_seq   ON events (thread_id, seq);
        CREATE INDEX idx_events_correlation  ON events (correlation_id);
        CREATE INDEX idx_events_payload_type ON events (payload_type);

        -- Projections. Rebuildable from the events log at any time; never a source of truth.
        CREATE TABLE threads (
          id                 TEXT PRIMARY KEY,
          name               TEXT,
          created_at         INTEGER NOT NULL,
          updated_at         INTEGER NOT NULL,
          canonical_repo     TEXT,
          cwd                TEXT    NOT NULL,
          permission_profile TEXT    NOT NULL,
          archived           INTEGER NOT NULL DEFAULT 0,
          forked_from_thread TEXT,
          forked_from_seq    INTEGER,
          last_seq           INTEGER NOT NULL DEFAULT -1
        ) STRICT;

        CREATE TABLE turns (
          id                 TEXT PRIMARY KEY,
          thread_id          TEXT    NOT NULL,
          seq                INTEGER NOT NULL,
          state              TEXT    NOT NULL,
          termination_reason TEXT,
          started_at         INTEGER NOT NULL,
          ended_at           INTEGER,
          permission_profile TEXT    NOT NULL
        ) STRICT;
        CREATE INDEX idx_turns_thread ON turns (thread_id, seq);

        CREATE TABLE items (
          id        TEXT PRIMARY KEY,
          thread_id TEXT    NOT NULL,
          turn_id   TEXT    NOT NULL,
          seq       INTEGER NOT NULL,
          type      TEXT    NOT NULL,
          data      TEXT    NOT NULL,
          created_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX idx_items_turn ON items (turn_id, seq);

        -- Side-effect ledger. THE mechanism that stops a known-complete destructive action from
        -- being replayed after a crash (SS-05, golden path 2).
        CREATE TABLE side_effects (
          id               TEXT PRIMARY KEY,
          thread_id        TEXT NOT NULL,
          turn_id          TEXT NOT NULL,
          -- Identical intents collide here, which is how duplicate execution is DETECTED
          -- rather than merely hoped against.
          idempotency_key  TEXT NOT NULL,
          kind             TEXT NOT NULL,
          destructive      INTEGER NOT NULL,
          normalized_action TEXT NOT NULL,
          state            TEXT NOT NULL,
          result_digest    TEXT,
          created_at       INTEGER NOT NULL,
          settled_at       INTEGER
        ) STRICT;
        CREATE INDEX idx_side_effects_key    ON side_effects (idempotency_key);
        CREATE INDEX idx_side_effects_thread ON side_effects (thread_id, state);

        -- Offloaded large tool output (TL-10). Content is addressed by digest, not by path,
        -- so a reference in the transcript can never be a traversal vector.
        CREATE TABLE blobs (
          digest     TEXT PRIMARY KEY,
          bytes      INTEGER NOT NULL,
          content    BLOB NOT NULL,
          created_at INTEGER NOT NULL
        ) STRICT;
      `);
    },
  },
  {
    version: 2,
    name: 'durable-task-graph',
    up(db) {
      // The durable dependency task graph (capability matrix E, WK-03..WK-08). It is a SEPARATE
      // append-only log from `events`: the frozen `EventPayloadSchema` (protocol) does not — and
      // must not — grow task variants, so task history lives in its own `task_events` table with a
      // `task_nodes` / `task_deps` projection rebuildable from it. The invariant mirrors the main
      // store: an event and the projection it implies commit in ONE transaction (see task-store.ts).
      db.exec(`
        -- The high-water mark. A SINGLE row whose counter only ever INCREASES, so a deleted id is
        -- never reused (WK-07) — reuse is impossible by construction, not by a uniqueness check.
        CREATE TABLE task_high_water (
          id      INTEGER PRIMARY KEY CHECK (id = 0),
          next_id INTEGER NOT NULL
        ) STRICT;
        INSERT INTO task_high_water (id, next_id) VALUES (0, 1);

        -- The authoritative append-only task log. Everything below is a projection of this.
        CREATE TABLE task_events (
          seq         INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id     INTEGER NOT NULL,
          type        TEXT    NOT NULL,
          payload     TEXT    NOT NULL,
          actor_kind  TEXT    NOT NULL,
          actor_id    TEXT    NOT NULL,
          actor_label TEXT,
          timestamp   INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX idx_task_events_task ON task_events (task_id, seq);

        -- Projection: current state of every task. Rebuildable from task_events (WK-07 crash
        -- survival). The version column is bumped on every mutation; a claimer reads it inside the
        -- write transaction to make claiming TOCTOU-safe (WK-06).
        CREATE TABLE task_nodes (
          id               INTEGER PRIMARY KEY,
          subject          TEXT    NOT NULL,
          description      TEXT    NOT NULL,
          active_form      TEXT    NOT NULL,
          owner            TEXT,
          status           TEXT    NOT NULL,
          metadata         TEXT    NOT NULL,
          version          INTEGER NOT NULL,
          created_at       INTEGER NOT NULL,
          updated_at       INTEGER NOT NULL,
          created_by_kind  TEXT    NOT NULL,
          created_by_id    TEXT    NOT NULL,
          created_by_label TEXT
        ) STRICT;

        -- Projection: dependency edges. blocker_id must complete before blocked_id can begin.
        -- Normalized (not denormalized JSON arrays) so the graph has a single source of truth and
        -- cycle detection reads coherent edges.
        CREATE TABLE task_deps (
          blocker_id INTEGER NOT NULL,
          blocked_id INTEGER NOT NULL,
          PRIMARY KEY (blocker_id, blocked_id)
        ) STRICT;
        CREATE INDEX idx_task_deps_blocked ON task_deps (blocked_id);
      `);
    },
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

export function currentVersion(db: Database): number {
  const row = db.pragma('user_version', { simple: true });
  return typeof row === 'number' ? row : 0;
}

/**
 * Applies every migration above the current version, each in its own transaction.
 * A failure leaves the database at the last successfully applied version — never half-migrated.
 */
export function migrate(db: Database): {
  from: number;
  to: number;
  applied: string[];
} {
  const from = currentVersion(db);
  const applied: string[] = [];

  for (const migration of MIGRATIONS) {
    if (migration.version <= from) continue;
    const run = db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    });
    run();
    applied.push(`${migration.version}:${migration.name}`);
  }

  return { from, to: currentVersion(db), applied };
}
