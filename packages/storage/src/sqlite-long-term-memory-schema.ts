import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';

export const SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION = 1;

const SQLITE_INITIALIZATION_BUSY_TIMEOUT_MS = 5_000;
const SQLITE_INITIALIZATION_RETRY_DELAY_MS = 10;
const initializationRetryGate = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
const require = createRequire(import.meta.url);

export type SqliteLongTermMemoryMigrationFailpoint = 'after_schema_sql';

export interface SqliteLongTermMemoryMigrationOptions {
  readonly failpoint?: (point: SqliteLongTermMemoryMigrationFailpoint) => void;
}

const MIGRATIONS: ReadonlyMap<number, string> = new Map([
  [
    1,
    `
    CREATE TABLE memory_items (
      item_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL CHECK (version >= 1),
      content TEXT NOT NULL CHECK (length(content) > 0),
      kind TEXT NOT NULL CHECK (
        kind IN ('preference', 'identity', 'context', 'knowledge', 'failure', 'note')
      ),
      statement_type TEXT NOT NULL CHECK (statement_type IN ('fact', 'plan', 'prediction')),
      temporal_type TEXT NOT NULL CHECK (
        temporal_type IN ('undated', 'point', 'interval', 'open_ended')
      ),
      scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'workspace')),
      scope_key TEXT,
      event_started_at INTEGER,
      event_ended_at INTEGER,
      observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
      lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('active', 'archived')),
      origin TEXT NOT NULL CHECK (origin IN ('agent_extracted', 'user_requested')),
      content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      CHECK (
        (scope_type = 'global' AND scope_key IS NULL)
        OR
        (scope_type = 'workspace' AND scope_key IS NOT NULL AND length(scope_key) > 0)
      ),
      CHECK (
        (temporal_type = 'undated'
          AND event_started_at IS NULL
          AND event_ended_at IS NULL)
        OR
        (temporal_type = 'point'
          AND event_started_at IS NOT NULL
          AND event_started_at >= 0
          AND (event_ended_at IS NULL OR event_ended_at > event_started_at))
        OR
        (temporal_type = 'interval'
          AND event_started_at IS NOT NULL
          AND event_started_at >= 0
          AND event_ended_at IS NOT NULL
          AND event_ended_at > event_started_at)
        OR
        (temporal_type = 'open_ended'
          AND event_started_at IS NOT NULL
          AND event_started_at >= 0
          AND event_ended_at IS NULL)
      ),
      CHECK (created_at <= updated_at),
      CHECK (observed_at <= updated_at)
    );

    CREATE INDEX memory_items_by_scope_and_lifecycle
      ON memory_items(scope_type, scope_key, lifecycle_state, updated_at DESC, item_id);

    CREATE INDEX memory_items_by_active_hash
      ON memory_items(lifecycle_state, scope_type, scope_key, content_hash, item_id);

    CREATE TABLE memory_item_keys (
      item_id TEXT NOT NULL,
      key_text TEXT NOT NULL CHECK (length(key_text) > 0),
      normalized_key TEXT NOT NULL CHECK (length(normalized_key) > 0),
      key_type TEXT NOT NULL CHECK (key_type IN ('exact', 'entity', 'concept', 'alias', 'code')),
      key_origin TEXT NOT NULL CHECK (key_origin IN ('deterministic', 'llm', 'user')),
      PRIMARY KEY(item_id, normalized_key),
      FOREIGN KEY(item_id) REFERENCES memory_items(item_id) ON DELETE CASCADE
    ) WITHOUT ROWID;

    CREATE INDEX memory_item_keys_by_normalized_key
      ON memory_item_keys(normalized_key, item_id);

    CREATE TABLE memory_item_sources (
      item_id TEXT NOT NULL,
      session_id TEXT NOT NULL CHECK (length(session_id) > 0),
      run_id TEXT NOT NULL CHECK (length(run_id) > 0),
      turn_id TEXT NOT NULL CHECK (length(turn_id) > 0),
      event_id TEXT NOT NULL CHECK (length(event_id) > 0),
      PRIMARY KEY(item_id, event_id),
      FOREIGN KEY(item_id) REFERENCES memory_items(item_id) ON DELETE CASCADE
    ) WITHOUT ROWID;

    CREATE INDEX memory_item_sources_by_event
      ON memory_item_sources(event_id, item_id);

    CREATE INDEX memory_item_sources_by_turn
      ON memory_item_sources(session_id, turn_id, item_id);

    CREATE TABLE memory_write_operations (
      operation_id TEXT PRIMARY KEY,
      operation_type TEXT NOT NULL CHECK (
        operation_type IN ('create', 'update', 'archive', 'restore', 'batch')
      ),
      request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
      result_json TEXT NOT NULL,
      committed_at INTEGER NOT NULL CHECK (committed_at >= 0)
    );
  `,
  ],
]);

type SchemaObjectType = 'table' | 'index' | 'trigger' | 'view';

interface SchemaDefinition {
  readonly type: SchemaObjectType;
  readonly tableName: string;
  readonly normalizedSql: string;
}

const expectedSchemaByVersion = new Map<number, ReadonlyMap<string, SchemaDefinition>>();

for (let version = 1; version <= SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION; version += 1) {
  if (!MIGRATIONS.has(version)) {
    throw new Error(`Missing long-term memory SQLite migration ${version}`);
  }
}

export function configureSqliteLongTermMemoryDatabase(db: DatabaseSync): void {
  db.exec(`PRAGMA busy_timeout = ${SQLITE_INITIALIZATION_BUSY_TIMEOUT_MS}`);
  ensureWalJournalMode(db);
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
}

export function migrateSqliteLongTermMemoryDatabase(
  db: DatabaseSync,
  options: SqliteLongTermMemoryMigrationOptions = {},
): void {
  const observedVersion = readSqliteLongTermMemorySchemaVersion(db);
  if (observedVersion > SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION) {
    throw newerSchemaError(observedVersion);
  }
  if (observedVersion === SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION) {
    validateSqliteLongTermMemorySchema(db);
    return;
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const current = readSqliteLongTermMemorySchemaVersion(db);
    if (current > SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION) throw newerSchemaError(current);
    for (
      let version = current + 1;
      version <= SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION;
      version += 1
    ) {
      const sql = MIGRATIONS.get(version);
      if (!sql) throw new Error(`Missing long-term memory SQLite migration ${version}`);
      db.exec(sql);
      options.failpoint?.('after_schema_sql');
      db.exec(`PRAGMA user_version = ${version}`);
    }
    validateSqliteLongTermMemorySchema(db);
    db.exec('COMMIT');
  } catch (error) {
    rollback(db);
    throw error;
  }
}

export function validateSqliteLongTermMemorySchema(db: DatabaseSync): void {
  const version = readSqliteLongTermMemorySchemaVersion(db);
  if (version < 1 || version > SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION) {
    throw new Error(`Missing long-term memory SQLite schema definition ${version}`);
  }
  const missing: Array<{ readonly type: SchemaObjectType; readonly name: string }> = [];
  for (const [name, expected] of getExpectedSchema(version)) {
    if (!assertSchemaObject(db, expected.type, name, expected)) {
      missing.push({ type: expected.type, name });
    }
  }
  const firstMissing = missing[0];
  if (firstMissing) {
    throw new Error(
      `Incomplete long-term memory SQLite schema: missing ${firstMissing.type} ${firstMissing.name}`,
    );
  }
}

export function assertSupportedSqliteLongTermMemorySchemaVersion(db: DatabaseSync): void {
  const observedVersion = readSqliteLongTermMemorySchemaVersion(db);
  if (observedVersion > SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION) {
    throw newerSchemaError(observedVersion);
  }
}

export function readSqliteLongTermMemorySchemaVersion(db: DatabaseSync): number {
  return retryWhileSqliteBusy(() => {
    const row = db.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined;
    const value = row?.user_version;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new Error('Invalid long-term memory SQLite schema version');
    }
    return value;
  });
}

function readJournalMode(db: DatabaseSync): string {
  return retryWhileSqliteBusy(() => {
    const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode?: unknown } | undefined;
    if (typeof row?.journal_mode !== 'string') {
      throw new Error('Invalid long-term memory SQLite journal mode');
    }
    return row.journal_mode.toLowerCase();
  });
}

function ensureWalJournalMode(db: DatabaseSync): void {
  const deadline = Date.now() + SQLITE_INITIALIZATION_BUSY_TIMEOUT_MS;
  while (true) {
    const journalMode = readJournalMode(db);
    if (journalMode === 'wal' || journalMode === 'memory') return;
    try {
      db.exec('PRAGMA journal_mode = WAL');
      const configuredMode = readJournalMode(db);
      if (configuredMode !== 'wal') {
        throw new Error(
          `Long-term memory SQLite requires WAL journal mode, received ${configuredMode}`,
        );
      }
      return;
    } catch (error) {
      if (!isSqliteBusy(error) || Date.now() >= deadline) throw error;
      Atomics.wait(
        initializationRetryGate,
        0,
        0,
        Math.min(SQLITE_INITIALIZATION_RETRY_DELAY_MS, Math.max(1, deadline - Date.now())),
      );
    }
  }
}

function isSqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = 'code' in error ? String(error.code) : '';
  return code === 'SQLITE_BUSY' || /database is locked/i.test(error.message);
}

function retryWhileSqliteBusy<T>(operation: () => T): T {
  const deadline = Date.now() + SQLITE_INITIALIZATION_BUSY_TIMEOUT_MS;
  while (true) {
    try {
      return operation();
    } catch (error) {
      if (!isSqliteBusy(error) || Date.now() >= deadline) throw error;
      Atomics.wait(
        initializationRetryGate,
        0,
        0,
        Math.min(SQLITE_INITIALIZATION_RETRY_DELAY_MS, Math.max(1, deadline - Date.now())),
      );
    }
  }
}

function newerSchemaError(version: number): Error {
  return new Error(
    `Long-term memory SQLite schema ${version} is newer than supported version ${SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION}`,
  );
}

function assertSchemaObject(
  db: DatabaseSync,
  type: SchemaObjectType,
  name: string,
  expected: SchemaDefinition,
): boolean {
  const row = db
    .prepare('SELECT type, tbl_name, sql FROM sqlite_schema WHERE name = ?')
    .get(name) as { type?: unknown; tbl_name?: unknown; sql?: unknown } | undefined;
  if (!row) return false;
  if (
    row.type !== type ||
    row.tbl_name !== expected.tableName ||
    typeof row.sql !== 'string' ||
    normalizeSchemaSql(row.sql) !== expected.normalizedSql
  ) {
    throw new Error(
      `Incomplete long-term memory SQLite schema: invalid definition for ${type} ${name}`,
    );
  }
  return true;
}

function getExpectedSchema(version: number): ReadonlyMap<string, SchemaDefinition> {
  const cached = expectedSchemaByVersion.get(version);
  if (cached) return cached;

  const Database = loadDatabaseSync();
  const canonical = new Database(':memory:');
  try {
    for (let migrationVersion = 1; migrationVersion <= version; migrationVersion += 1) {
      const sql = MIGRATIONS.get(migrationVersion);
      if (!sql) throw new Error(`Missing long-term memory SQLite migration ${migrationVersion}`);
      canonical.exec(sql);
    }
    const expected = readSchemaDefinitions(canonical);
    expectedSchemaByVersion.set(version, expected);
    return expected;
  } finally {
    canonical.close();
  }
}

function readSchemaDefinitions(db: DatabaseSync): ReadonlyMap<string, SchemaDefinition> {
  const rows = db
    .prepare(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_schema
       WHERE type IN ('table', 'index', 'trigger', 'view')
         AND name NOT LIKE 'sqlite_%'
         AND sql IS NOT NULL
       ORDER BY CASE type
         WHEN 'table' THEN 0
         WHEN 'index' THEN 1
         WHEN 'trigger' THEN 2
         ELSE 3
       END, name ASC`,
    )
    .all() as Array<{
    type?: unknown;
    name?: unknown;
    tbl_name?: unknown;
    sql?: unknown;
  }>;
  const definitions = new Map<string, SchemaDefinition>();
  for (const row of rows) {
    if (
      !isSchemaObjectType(row.type) ||
      typeof row.name !== 'string' ||
      typeof row.tbl_name !== 'string' ||
      typeof row.sql !== 'string' ||
      definitions.has(row.name)
    ) {
      throw new Error('Invalid built-in long-term memory SQLite migration definition');
    }
    definitions.set(row.name, {
      type: row.type,
      tableName: row.tbl_name,
      normalizedSql: normalizeSchemaSql(row.sql),
    });
  }
  return definitions;
}

function isSchemaObjectType(value: unknown): value is SchemaObjectType {
  return value === 'table' || value === 'index' || value === 'trigger' || value === 'view';
}

function normalizeSchemaSql(sql: string): string {
  return sql.replace(/\s+/gu, ' ').trim();
}

function loadDatabaseSync(): typeof import('node:sqlite').DatabaseSync {
  return (require('node:sqlite') as typeof import('node:sqlite')).DatabaseSync;
}

function rollback(db: DatabaseSync): void {
  try {
    db.exec('ROLLBACK');
  } catch {
    // Preserve the migration failure that triggered rollback.
  }
}
