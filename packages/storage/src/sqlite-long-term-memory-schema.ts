import type { DatabaseSync } from 'node:sqlite';

export const SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION = 1;

const SQLITE_INITIALIZATION_BUSY_TIMEOUT_MS = 5_000;
const SQLITE_INITIALIZATION_RETRY_DELAY_MS = 10;
const initializationRetryGate = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

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

    CREATE INDEX memory_items_by_kind
      ON memory_items(kind, lifecycle_state, updated_at DESC, item_id);

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

interface RequiredSchemaDefinition {
  readonly type: 'table' | 'index';
  readonly tableName: string;
  readonly normalizedSql: string;
}

const REQUIRED_SCHEMA_DEFINITIONS = extractRequiredSchemaDefinitions(MIGRATIONS.get(1)!);

const REQUIRED_TABLE_COLUMNS: ReadonlyMap<string, readonly string[]> = new Map([
  [
    'memory_items',
    [
      'item_id',
      'version',
      'content',
      'kind',
      'statement_type',
      'temporal_type',
      'scope_type',
      'scope_key',
      'event_started_at',
      'event_ended_at',
      'observed_at',
      'lifecycle_state',
      'origin',
      'content_hash',
      'created_at',
      'updated_at',
    ],
  ],
  ['memory_item_keys', ['item_id', 'key_text', 'normalized_key', 'key_type', 'key_origin']],
  ['memory_item_sources', ['item_id', 'session_id', 'run_id', 'turn_id', 'event_id']],
  [
    'memory_write_operations',
    ['operation_id', 'operation_type', 'request_hash', 'result_json', 'committed_at'],
  ],
]);

const REQUIRED_INDEX_COLUMNS: ReadonlyMap<string, readonly string[]> = new Map([
  [
    'memory_items_by_scope_and_lifecycle',
    ['scope_type', 'scope_key', 'lifecycle_state', 'updated_at', 'item_id'],
  ],
  [
    'memory_items_by_active_hash',
    ['lifecycle_state', 'scope_type', 'scope_key', 'content_hash', 'item_id'],
  ],
  ['memory_items_by_kind', ['kind', 'lifecycle_state', 'updated_at', 'item_id']],
  ['memory_item_keys_by_normalized_key', ['normalized_key', 'item_id']],
  ['memory_item_sources_by_event', ['event_id', 'item_id']],
  ['memory_item_sources_by_turn', ['session_id', 'turn_id', 'item_id']],
]);

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
  for (const [table, expectedColumns] of REQUIRED_TABLE_COLUMNS) {
    assertSchemaObject(db, 'table', table);
    const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name?: unknown }>;
    assertColumnList(`table ${table}`, rows, expectedColumns);
  }
  for (const [index, expectedColumns] of REQUIRED_INDEX_COLUMNS) {
    assertSchemaObject(db, 'index', index);
    const rows = db.prepare(`PRAGMA index_info("${index}")`).all() as Array<{ name?: unknown }>;
    assertColumnList(`index ${index}`, rows, expectedColumns);
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

function assertSchemaObject(db: DatabaseSync, type: 'table' | 'index', name: string): void {
  const row = db
    .prepare('SELECT type, tbl_name, sql FROM sqlite_schema WHERE name = ?')
    .get(name) as { type?: unknown; tbl_name?: unknown; sql?: unknown } | undefined;
  if (row?.type !== type) {
    throw new Error(`Incomplete long-term memory SQLite schema: missing ${type} ${name}`);
  }
  const expected = REQUIRED_SCHEMA_DEFINITIONS.get(name);
  if (
    !expected ||
    expected.type !== type ||
    row.tbl_name !== expected.tableName ||
    typeof row.sql !== 'string' ||
    normalizeSchemaSql(row.sql) !== expected.normalizedSql
  ) {
    throw new Error(
      `Incomplete long-term memory SQLite schema: invalid definition for ${type} ${name}`,
    );
  }
}

function assertColumnList(
  subject: string,
  rows: readonly { readonly name?: unknown }[],
  expected: readonly string[],
): void {
  const actual = rows.map((row) => row.name);
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error(`Incomplete long-term memory SQLite schema: invalid ${subject}`);
  }
}

function extractRequiredSchemaDefinitions(
  sql: string,
): ReadonlyMap<string, RequiredSchemaDefinition> {
  const definitions = new Map<string, RequiredSchemaDefinition>();
  for (const candidate of sql.split(';')) {
    const statement = candidate.trim();
    if (statement === '') continue;
    const table = /^CREATE\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/iu.exec(statement);
    const index =
      /^CREATE\s+INDEX\s+([A-Za-z_][A-Za-z0-9_]*)\s+ON\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/iu.exec(
        statement,
      );
    const definition: RequiredSchemaDefinition | undefined = table
      ? { type: 'table', tableName: table[1]!, normalizedSql: normalizeSchemaSql(statement) }
      : index
        ? {
            type: 'index',
            tableName: index[2]!,
            normalizedSql: normalizeSchemaSql(statement),
          }
        : undefined;
    const name = table?.[1] ?? index?.[1];
    if (!definition || !name || definitions.has(name)) {
      throw new Error('Invalid built-in long-term memory SQLite migration definition');
    }
    definitions.set(name, definition);
  }
  return definitions;
}

function normalizeSchemaSql(sql: string): string {
  return sql.replace(/\s+/gu, ' ').trim();
}

function rollback(db: DatabaseSync): void {
  try {
    db.exec('ROLLBACK');
  } catch {
    // Preserve the migration failure that triggered rollback.
  }
}
