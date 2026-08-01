import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chmod, link, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { Worker } from 'node:worker_threads';
import {
  MemoryItemStoreConflictError,
  type MemoryItemSource,
  type MemoryItemWrite,
} from '@maka/core/long-term-memory';
import {
  LONG_TERM_MEMORY_DATABASE_NAME,
  authenticateLongTermMemoryStoreWriter,
  openHeadlessLongTermMemoryStoreForWrite,
  openInteractiveLongTermMemoryStoreForWrite,
} from '../long-term-memory-store.js';
import {
  createHeadlessRootLease,
  resolveStorageRoot,
  STORAGE_ROOT_MARKER_FILE,
  tryAcquireInteractiveRootOwner,
} from '../root-authority.js';
import { SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION } from '../sqlite-long-term-memory-schema.js';
import {
  buildSqliteMemoryKeySearchQuery,
  SqliteMemoryItemStore,
  type SqliteMemoryItemStoreFailpoint,
} from '../sqlite-long-term-memory-store.js';

const require = createRequire(import.meta.url);

describe('SqliteMemoryItemStore', () => {
  test('creates a private, versioned WAL database and reopens it idempotently', async () => {
    await withStore(async ({ store, databasePath }) => {
      assert.equal(store.schemaVersion(), SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION);
      assert.equal(store.journalMode(), 'wal');
      assert.equal(store.foreignKeysEnabled(), true);
      if (process.platform !== 'win32') {
        assert.equal((await stat(databasePath)).mode & 0o777, 0o600);
        for (const sidecar of [`${databasePath}-wal`, `${databasePath}-shm`]) {
          assert.equal((await stat(sidecar)).mode & 0o777, 0o600);
        }
      }
      store.close();

      const reopened = new SqliteMemoryItemStore(databasePath);
      try {
        assert.equal(reopened.schemaVersion(), SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION);
        assert.equal(await reopened.readItem('missing-item'), undefined);
      } finally {
        reopened.close();
      }
    });
  });

  test('rolls back a failed migration and rejects a newer unknown schema without changing it', async () => {
    await withTempRoot(async (root) => {
      const failedPath = join(root, 'failed.sqlite');
      assert.throws(
        () =>
          new SqliteMemoryItemStore(failedPath, {
            migrationFailpoint: () => {
              throw new Error('migration failure');
            },
          }),
        /migration failure/,
      );
      const recovered = new SqliteMemoryItemStore(failedPath);
      assert.equal(recovered.schemaVersion(), SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION);
      recovered.close();

      const newerPath = join(root, 'newer.sqlite');
      const Database = loadDatabaseSync();
      const newer = new Database(newerPath);
      newer.exec('PRAGMA user_version = 99');
      const originalJournalMode = String(
        (newer.prepare('PRAGMA journal_mode').get() as { journal_mode?: unknown }).journal_mode,
      );
      newer.close();
      assert.throws(() => new SqliteMemoryItemStore(newerPath), /newer than supported/);
      const unchanged = new Database(newerPath);
      try {
        assert.equal(
          (unchanged.prepare('PRAGMA user_version').get() as { user_version?: unknown })
            .user_version,
          99,
        );
        assert.equal(
          String(
            (unchanged.prepare('PRAGMA journal_mode').get() as { journal_mode?: unknown })
              .journal_mode,
          ),
          originalJournalMode,
        );
      } finally {
        unchanged.close();
      }
    });
  });

  test('rejects a current-version database with incomplete tables or indexes', async () => {
    await withTempRoot(async (root) => {
      const Database = loadDatabaseSync();
      const missingTablesPath = join(root, 'missing-tables.sqlite');
      const missingTables = new Database(missingTablesPath);
      missingTables.exec(`PRAGMA user_version = ${SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION}`);
      missingTables.close();
      assert.throws(
        () => new SqliteMemoryItemStore(missingTablesPath),
        /missing table memory_items/,
      );

      const missingConstraintsPath = join(root, 'missing-constraints.sqlite');
      const missingConstraints = new Database(missingConstraintsPath);
      missingConstraints.exec(`
        CREATE TABLE memory_items (
          item_id TEXT, version INTEGER, content TEXT, kind TEXT, statement_type TEXT,
          temporal_type TEXT, scope_type TEXT, scope_key TEXT, event_started_at INTEGER,
          event_ended_at INTEGER, observed_at INTEGER, lifecycle_state TEXT, origin TEXT,
          content_hash TEXT, created_at INTEGER, updated_at INTEGER
        );
        PRAGMA user_version = ${SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION};
      `);
      missingConstraints.close();
      assert.throws(
        () => new SqliteMemoryItemStore(missingConstraintsPath),
        /invalid definition for table memory_items/,
      );

      const missingIndexPath = join(root, 'missing-index.sqlite');
      const complete = new SqliteMemoryItemStore(missingIndexPath);
      complete.close();
      const missingIndex = new Database(missingIndexPath);
      missingIndex.exec('DROP INDEX memory_item_keys_by_normalized_key');
      missingIndex.close();
      assert.throws(
        () => new SqliteMemoryItemStore(missingIndexPath),
        /missing index memory_item_keys_by_normalized_key/,
      );
    });
  });

  test('serializes truly concurrent first-open migrations', async () => {
    await withTempRoot(async (root) => {
      const databasePath = join(root, 'concurrent.sqlite');
      const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
      const moduleUrl = new URL('../sqlite-long-term-memory-store.js', import.meta.url).href;
      const workers = [
        startConcurrentMigrationWorker(databasePath, moduleUrl, gate),
        startConcurrentMigrationWorker(databasePath, moduleUrl, gate),
      ];
      await Promise.all(workers.map((worker) => worker.ready));
      const gateView = new Int32Array(gate);
      Atomics.store(gateView, 0, 1);
      Atomics.notify(gateView, 0, workers.length);
      assert.deepEqual((await Promise.all(workers.map((worker) => worker.result))).sort(), [
        SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION,
        SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION,
      ]);

      const reopened = new SqliteMemoryItemStore(databasePath);
      assert.equal(reopened.schemaVersion(), SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION);
      reopened.close();
    });
  });

  test('rejects database links and sidecar symlinks without changing their targets', async (t) => {
    await withTempRoot(async (root) => {
      const target = join(root, 'outside.txt');
      await writeFile(target, 'do-not-touch', { mode: 0o644 });
      const databasePath = join(root, LONG_TERM_MEMORY_DATABASE_NAME);
      await link(target, databasePath);
      assert.throws(() => new SqliteMemoryItemStore(databasePath), /hard-linked/);
      assert.equal(await readFile(target, 'utf8'), 'do-not-touch');
      if (process.platform !== 'win32') {
        assert.equal((await stat(target)).mode & 0o777, 0o644);
      }

      await rm(databasePath);
      if (!(await createSymlinkIfSupported(target, databasePath))) {
        t.diagnostic('symbolic links are unavailable in this environment');
        return;
      }
      assert.throws(() => new SqliteMemoryItemStore(databasePath), /symbolic link/);
      assert.equal(await readFile(target, 'utf8'), 'do-not-touch');

      await rm(databasePath);
      const initial = new SqliteMemoryItemStore(databasePath);
      initial.close();
      await symlink(target, `${databasePath}-wal`);
      assert.throws(() => new SqliteMemoryItemStore(databasePath), /symbolic link/);
      assert.equal(await readFile(target, 'utf8'), 'do-not-touch');
    });
  });

  test('normalizes keys and searches global plus the selected workspace', async () => {
    await withStore(async ({ store }) => {
      const global = await createItem(
        store,
        'create-global',
        write({
          content: '用户偏好简洁的中文回答。',
          keys: [
            { key: ' 偏好 ', keyType: 'concept', keyOrigin: 'llm' },
            { key: '偏好', keyType: 'exact', keyOrigin: 'user' },
            { key: 'Chinese answer', keyType: 'alias', keyOrigin: 'deterministic' },
          ],
        }),
      );
      const workspace = await createItem(
        store,
        'create-workspace',
        write({
          content: 'Maka uses RuntimeEvent as evidence.',
          kind: 'knowledge',
          scopeType: 'workspace',
          scopeKey: 'workspace-maka',
          keys: [
            { key: 'RuntimeEvent', keyType: 'code', keyOrigin: 'deterministic' },
            { key: 'memory_item', keyType: 'code', keyOrigin: 'deterministic' },
          ],
        }),
      );

      assert.deepEqual((await store.readItem(global))?.keys[0], {
        key: 'Chinese answer',
        normalizedKey: 'chinese answer',
        keyType: 'alias',
        keyOrigin: 'deterministic',
      });
      assert.equal((await store.readItem(global))?.keys[1]?.keyOrigin, 'user');
      assert.deepEqual(await itemIds(store, ['偏好']), [global]);
      assert.deepEqual(await itemIds(store, ['runtime'], 'prefix'), []);
      assert.deepEqual(await itemIds(store, ['runtime'], 'prefix', 'workspace-maka'), [workspace]);
      assert.deepEqual(await itemIds(store, ['memory_'], 'prefix', 'workspace-maka'), [workspace]);
      assert.deepEqual(await itemIds(store, ['偏'], 'prefix'), [global]);
      await assert.rejects(
        store.searchByKeys({
          terms: ['偏好'],
          match: 'exact',
          includeArchived: 'false' as unknown as boolean,
        }),
        /includeArchived/,
      );
    });
  });

  test('replays operation receipts and returns semantic duplicates without merging sources', async () => {
    await withStore(async ({ store }) => {
      const request = {
        operationId: 'idempotent-create',
        mutations: [{ type: 'create' as const, item: write() }],
      };
      const created = await store.applyMutations(request);
      const replayed = await store.applyMutations(request);
      assert.deepEqual(replayed, { ...created, replayed: true });

      await assert.rejects(
        store.applyMutations({
          operationId: request.operationId,
          mutations: [{ type: 'create', item: write({ content: 'Different fact.' }) }],
        }),
        conflict('operation_reused'),
      );

      const duplicate = await store.applyMutations({
        operationId: 'semantic-duplicate',
        mutations: [
          {
            type: 'create',
            item: write({
              origin: 'user_requested',
              keys: [{ key: 'other', keyType: 'exact', keyOrigin: 'user' }],
              sources: [source({ eventId: 'event-other' })],
            }),
          },
        ],
      });
      assert.equal(duplicate.results[0]?.outcome, 'existing');
      assert.equal(duplicate.results[0]?.itemId, created.results[0]?.itemId);
      assert.deepEqual((await store.readItem(created.results[0]!.itemId))?.sources, [source()]);
    });
  });

  test('uses CAS, replaces current keys and sources, and records no-op writes', async () => {
    await withStore(async ({ store }) => {
      const itemId = await createItem(store, 'cas-create', write());
      const replacement = write({
        content: 'User prefers no more than three concise points.',
        keys: [{ key: 'three-points', keyType: 'exact', keyOrigin: 'user' }],
        sources: [source({ eventId: 'event-2', turnId: 'turn-2' })],
      });
      const updated = await store.applyMutations({
        operationId: 'cas-update',
        mutations: [{ type: 'update', itemId, expectedVersion: 1, item: replacement }],
      });
      assert.equal(updated.results[0]?.version, 2);
      assert.deepEqual((await store.readItem(itemId))?.sources, [
        source({ eventId: 'event-2', turnId: 'turn-2' }),
      ]);

      const noop = await store.applyMutations({
        operationId: 'cas-noop',
        mutations: [{ type: 'update', itemId, expectedVersion: 2, item: replacement }],
      });
      assert.equal(noop.results[0]?.outcome, 'noop');
      assert.equal(noop.results[0]?.version, 2);
      assert.ok(await store.readOperation('cas-noop'));
      await assert.rejects(
        store.applyMutations({
          operationId: 'cas-stale',
          mutations: [{ type: 'update', itemId, expectedVersion: 1, item: replacement }],
        }),
        conflict('version_conflict'),
      );
    });
  });

  test('rejects a stale CAS from a second SQLite connection', async () => {
    await withTempRoot(async (root) => {
      const databasePath = join(root, LONG_TERM_MEMORY_DATABASE_NAME);
      const first = new SqliteMemoryItemStore(databasePath, {
        now: () => 1_000,
        idFactory: () => 'shared-item',
      });
      const second = new SqliteMemoryItemStore(databasePath, { now: () => 1_000 });
      try {
        const itemId = await createItem(first, 'cross-connection-create', write());
        assert.equal((await second.readItem(itemId))?.item.version, 1);

        await first.applyMutations({
          operationId: 'cross-connection-first-update',
          mutations: [
            {
              type: 'update',
              itemId,
              expectedVersion: 1,
              item: write({ content: 'First writer wins.' }),
            },
          ],
        });
        await assert.rejects(
          second.applyMutations({
            operationId: 'cross-connection-stale-update',
            mutations: [
              {
                type: 'update',
                itemId,
                expectedVersion: 1,
                item: write({ content: 'Stale second writer.' }),
              },
            ],
          }),
          conflict('version_conflict'),
        );
        assert.equal((await second.readItem(itemId))?.item.content, 'First writer wins.');
      } finally {
        first.close();
        second.close();
      }
    });
  });

  test('rejects an archived update or restore that collides with an active Item', async () => {
    await withStore(async ({ store }) => {
      const archivedId = await createItem(store, 'archived-create', write());
      await store.applyMutations({
        operationId: 'archive',
        mutations: [{ type: 'archive', itemId: archivedId, expectedVersion: 1 }],
      });
      const activeId = await createItem(store, 'active-replacement', write());
      assert.notEqual(activeId, archivedId);

      await assert.rejects(
        store.applyMutations({
          operationId: 'archived-update-collision',
          mutations: [{ type: 'update', itemId: archivedId, expectedVersion: 2, item: write() }],
        }),
        conflict('duplicate_active'),
      );
      await assert.rejects(
        store.applyMutations({
          operationId: 'restore-collision',
          mutations: [{ type: 'restore', itemId: archivedId, expectedVersion: 2 }],
        }),
        conflict('duplicate_active'),
      );
      assert.deepEqual(await itemIds(store, ['concise']), [activeId]);
    });
  });

  test('excludes archived Items by default and returns them after restore', async () => {
    await withStore(async ({ store }) => {
      const itemId = await createItem(store, 'lifecycle-create', write());
      const archived = await store.applyMutations({
        operationId: 'lifecycle-archive',
        mutations: [{ type: 'archive', itemId, expectedVersion: 1 }],
      });
      assert.equal(archived.results[0]?.lifecycleState, 'archived');
      assert.deepEqual(await itemIds(store, ['concise']), []);
      assert.deepEqual(
        (
          await store.searchByKeys({
            terms: ['concise'],
            match: 'exact',
            includeArchived: true,
          })
        ).map((record) => record.item.itemId),
        [itemId],
      );

      const restored = await store.applyMutations({
        operationId: 'lifecycle-restore',
        mutations: [{ type: 'restore', itemId, expectedVersion: 2 }],
      });
      assert.equal(restored.results[0]?.lifecycleState, 'active');
      assert.deepEqual(await itemIds(store, ['concise']), [itemId]);
    });
  });

  test('rolls back the full batch at every write boundary', async () => {
    for (const point of [
      'after_item_write',
      'after_keys_write',
      'after_sources_write',
      'before_operation_write',
    ] as const) {
      await withStore(async ({ store, setFailpoint }) => {
        setFailpoint(point);
        await assert.rejects(
          store.applyMutations({
            operationId: `batch-${point}`,
            mutations: [
              { type: 'create', item: write({ content: 'First fact.' }) },
              { type: 'create', item: write({ content: 'Second fact.' }) },
            ],
          }),
          new RegExp(point),
        );
        assert.equal(await store.readItem('item-1'), undefined);
        assert.equal(await store.readOperation(`batch-${point}`), undefined);
      });
    }
  });

  test('rolls back an earlier completed mutation when a later mutation conflicts', async () => {
    await withStore(async ({ store }) => {
      const existingId = await createItem(store, 'batch-conflict-existing', write());
      await assert.rejects(
        store.applyMutations({
          operationId: 'batch-later-conflict',
          mutations: [
            {
              type: 'create',
              item: write({
                content: 'This Item must be rolled back.',
                keys: [{ key: 'rolled-back', keyType: 'exact', keyOrigin: 'deterministic' }],
                sources: [source({ eventId: 'event-rollback' })],
              }),
            },
            {
              type: 'update',
              itemId: existingId,
              expectedVersion: 99,
              item: write({ content: 'Stale update.' }),
            },
          ],
        }),
        conflict('version_conflict'),
      );
      assert.equal(await store.readItem('item-2'), undefined);
      assert.deepEqual(await itemIds(store, ['rolled-back']), []);
      assert.equal(await store.readOperation('batch-later-conflict'), undefined);
      assert.equal((await store.readItem(existingId))?.item.version, 1);
    });
  });

  test('keeps updated_at monotonic and replays after the injected clock moves backwards', async () => {
    await withTempRoot(async (root) => {
      const databasePath = join(root, LONG_TERM_MEMORY_DATABASE_NAME);
      let now = 1_000;
      const store = new SqliteMemoryItemStore(databasePath, {
        now: () => now,
        idFactory: () => 'clock-item',
      });
      try {
        const request = {
          operationId: 'clock-create',
          mutations: [{ type: 'create' as const, item: write({ observedAt: 900 }) }],
        };
        await store.applyMutations(request);
        now = 800;
        assert.equal((await store.applyMutations(request)).replayed, true);
        now = 1_100;
        await store.applyMutations({
          operationId: 'clock-update-newer',
          mutations: [
            {
              type: 'update',
              itemId: 'clock-item',
              expectedVersion: 1,
              item: write({ content: 'New current fact.', observedAt: 1_000 }),
            },
          ],
        });
        now = 1_050;
        await store.applyMutations({
          operationId: 'clock-archive',
          mutations: [{ type: 'archive', itemId: 'clock-item', expectedVersion: 2 }],
        });
        assert.equal((await store.readItem('clock-item'))?.item.updatedAt, 1_100);
      } finally {
        store.close();
      }
    });
  });

  test('fails closed over a structurally corrupt idempotency receipt', async () => {
    await withStore(async ({ store, databasePath }) => {
      const created = await store.applyMutations({
        operationId: 'corrupt-receipt',
        mutations: [{ type: 'create', item: write() }],
      });
      store.close();
      const Database = loadDatabaseSync();
      const database = new Database(databasePath);
      database
        .prepare('UPDATE memory_write_operations SET result_json = ? WHERE operation_id = ?')
        .run(
          JSON.stringify([
            {
              mutationIndex: 0,
              mutationType: 'update',
              itemId: created.results[0]!.itemId,
              version: 1,
              lifecycleState: 'active',
              outcome: 'updated',
            },
          ]),
          'corrupt-receipt',
        );
      database
        .prepare('UPDATE memory_items SET content_hash = ? WHERE item_id = ?')
        .run('0'.repeat(64), created.results[0]!.itemId);
      database.close();

      const reopened = new SqliteMemoryItemStore(databasePath);
      try {
        await assert.rejects(reopened.readOperation('corrupt-receipt'), /Invalid/);
        await assert.rejects(reopened.readItem(created.results[0]!.itemId), /content_hash/);
      } finally {
        reopened.close();
      }
    });
  });

  test('fails closed over corrupt Item child cardinality', async () => {
    for (const childTable of ['memory_item_keys', 'memory_item_sources'] as const) {
      await withTempRoot(async (root) => {
        const databasePath = join(root, `${childTable}.sqlite`);
        const store = new SqliteMemoryItemStore(databasePath, {
          now: () => 1_000,
          idFactory: () => 'corrupt-child-item',
        });
        await createItem(store, `create-${childTable}`, write());
        store.close();

        const Database = loadDatabaseSync();
        const database = new Database(databasePath);
        database.prepare(`DELETE FROM ${childTable} WHERE item_id = ?`).run('corrupt-child-item');
        database.close();

        const reopened = new SqliteMemoryItemStore(databasePath, { now: () => 1_000 });
        try {
          await assert.rejects(reopened.readItem('corrupt-child-item'), /cardinality/);
          await assert.rejects(
            reopened.applyMutations({
              operationId: `duplicate-${childTable}`,
              mutations: [{ type: 'create', item: write() }],
            }),
            /cardinality/,
          );
        } finally {
          reopened.close();
        }
      });
    }
  });

  test('bounds corrupt Item child reads before checking cardinality', async () => {
    for (const childTable of ['memory_item_keys', 'memory_item_sources'] as const) {
      await withTempRoot(async (root) => {
        const databasePath = join(root, `${childTable}-oversize.sqlite`);
        const store = new SqliteMemoryItemStore(databasePath, {
          now: () => 1_000,
          idFactory: () => 'oversize-child-item',
        });
        await createItem(store, `create-${childTable}`, write());
        store.close();

        const Database = loadDatabaseSync();
        const database = new Database(databasePath);
        database.exec('BEGIN');
        try {
          if (childTable === 'memory_item_keys') {
            const insert = database.prepare(
              `INSERT INTO memory_item_keys(
                 item_id, key_text, normalized_key, key_type, key_origin
               ) VALUES ('oversize-child-item', ?, ?, 'exact', 'deterministic')`,
            );
            for (let index = 0; index < 32; index += 1) {
              insert.run(`extra-key-${index}`, `extra-key-${index}`);
            }
          } else {
            const insert = database.prepare(
              `INSERT INTO memory_item_sources(item_id, session_id, run_id, turn_id, event_id)
               VALUES ('oversize-child-item', 'session-1', 'run-1', 'turn-1', ?)`,
            );
            for (let index = 0; index < 256; index += 1) {
              insert.run(`extra-event-${index}`);
            }
          }
          database.exec('COMMIT');
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        } finally {
          database.close();
        }

        const reopened = new SqliteMemoryItemStore(databasePath);
        try {
          await assert.rejects(reopened.readItem('oversize-child-item'), /cardinality/);
        } finally {
          reopened.close();
        }
      });
    }
  });

  test('rejects a corrupt idempotency receipt beyond the batch limit', async () => {
    await withStore(async ({ store, databasePath }) => {
      await store.applyMutations({
        operationId: 'oversize-receipt',
        mutations: [{ type: 'create', item: write() }],
      });
      store.close();
      const result = {
        mutationIndex: 0,
        mutationType: 'create',
        itemId: 'item-1',
        version: 1,
        lifecycleState: 'active',
        outcome: 'created',
      } as const;
      const results = Array.from({ length: 33 }, (_, mutationIndex) => ({
        ...result,
        mutationIndex,
      }));
      const Database = loadDatabaseSync();
      const database = new Database(databasePath);
      database
        .prepare(
          `UPDATE memory_write_operations
           SET operation_type = 'batch', result_json = ?
           WHERE operation_id = 'oversize-receipt'`,
        )
        .run(JSON.stringify(results));
      database.close();

      const reopened = new SqliteMemoryItemStore(databasePath);
      try {
        await assert.rejects(reopened.readOperation('oversize-receipt'), /at most 32/);
      } finally {
        reopened.close();
      }
    });
  });

  test('rejects an oversized idempotency receipt before JSON parsing', async () => {
    await withStore(async ({ store, databasePath }) => {
      await store.applyMutations({
        operationId: 'huge-receipt',
        mutations: [{ type: 'create', item: write() }],
      });
      store.close();
      const Database = loadDatabaseSync();
      const database = new Database(databasePath);
      database
        .prepare(
          `UPDATE memory_write_operations SET result_json = ?
           WHERE operation_id = 'huge-receipt'`,
        )
        .run(`"${'x'.repeat(129 * 1_024)}"`);
      database.close();

      const reopened = new SqliteMemoryItemStore(databasePath);
      try {
        await assert.rejects(reopened.readOperation('huge-receipt'), /too large/);
      } finally {
        reopened.close();
      }
    });
  });

  test('uses the normalized-key index for production exact and prefix queries', async () => {
    await withStore(async ({ store, databasePath }) => {
      await createItem(store, 'query-plan', write());
      store.close();
      const Database = loadDatabaseSync();
      const database = new Database(databasePath);
      try {
        for (const [match, terms] of [
          ['exact', ['concise']],
          ['prefix', ['con']],
        ] as const) {
          const query = buildSqliteMemoryKeySearchQuery({
            terms,
            match,
            includeArchived: false,
            limit: 20,
          });
          const plan = database
            .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
            .all(...query.parameters) as Array<{ detail?: unknown }>;
          assert.match(
            plan.map((row) => String(row.detail)).join('\n'),
            /SEARCH memory_item_keys USING (?:COVERING )?INDEX memory_item_keys_by_normalized_key/,
          );
        }
      } finally {
        database.close();
      }
    });
  });
});

describe('long-term memory Storage Root authority', () => {
  test('rejects a structurally forged writer facade', () => {
    assert.throws(
      () =>
        authenticateLongTermMemoryStoreWriter(
          {
            kind: 'headless',
            access: 'write',
          } as unknown as Parameters<typeof authenticateLongTermMemoryStoreWriter>[0],
          'headless',
        ),
      /authentic headless long-term memory writer/,
    );
  });

  test('rejects a Headless lease at the Interactive opener without creating a database', async () => {
    await withTempRoot(async (root) => {
      const capability = await resolveStorageRoot({ path: root, kind: 'headless' });
      const lease = createHeadlessRootLease(capability, 'write');
      await assert.rejects(
        openInteractiveLongTermMemoryStoreForWrite(
          lease as unknown as Parameters<typeof openInteractiveLongTermMemoryStoreForWrite>[0],
        ),
        /interactive/,
      );
      await assert.rejects(stat(join(root, LONG_TERM_MEMORY_DATABASE_NAME)), { code: 'ENOENT' });
    });
  });

  test('snapshots mutation input before crossing the authority boundary', async () => {
    await withTempRoot(async (root) => {
      const capability = await resolveStorageRoot({ path: root, kind: 'headless' });
      const lease = createHeadlessRootLease(capability, 'write');
      const writer = await openHeadlessLongTermMemoryStoreForWrite(lease);
      try {
        const item = write({
          keys: [{ key: 'original-key', keyType: 'exact', keyOrigin: 'deterministic' }],
          sources: [source({ eventId: 'original-event' })],
        });
        const request = {
          operationId: 'snapshot-input',
          mutations: [{ type: 'create' as const, item }],
        };
        const writing = writer.applyMutations(request);
        (item as { content: string }).content = 'Mutated after admission.';
        (item.keys[0] as { key: string }).key = 'mutated-key';
        (item.sources[0] as { eventId: string }).eventId = 'mutated-event';

        const result = await writing;
        const record = await writer.readItem(result.results[0]!.itemId);
        assert.equal(record?.item.content, 'User prefers concise answers.');
        assert.deepEqual(
          record?.keys.map((key) => key.key),
          ['original-key'],
        );
        assert.deepEqual(
          record?.sources.map((entry) => entry.eventId),
          ['original-event'],
        );
      } finally {
        writer.close();
      }
    });
  });

  test('rejects operations after the durable root identity changes', async () => {
    await withTempRoot(async (root) => {
      const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      const writer = await openInteractiveLongTermMemoryStoreForWrite(owner.lease);
      try {
        const markerPath = join(root, STORAGE_ROOT_MARKER_FILE);
        const marker = JSON.parse(await readFile(markerPath, 'utf8')) as { rootId: string };
        marker.rootId = `${marker.rootId.startsWith('0') ? '1' : '0'}${marker.rootId.slice(1)}`;
        await writeFile(markerPath, `${JSON.stringify(marker)}\n`);
        await assert.rejects(writer.readItem('after-root-replacement'), {
          code: 'root_identity_changed',
        });
      } finally {
        writer.close();
        await owner.close();
      }
    });
  });

  test('single-flights an isolated Headless writer and closes it explicitly', async () => {
    await withTempRoot(async (root) => {
      const capability = await resolveStorageRoot({ path: root, kind: 'headless' });
      const lease = createHeadlessRootLease(capability, 'write');
      const [first, second] = await Promise.all([
        openHeadlessLongTermMemoryStoreForWrite(lease),
        openHeadlessLongTermMemoryStoreForWrite(lease),
      ]);
      assert.equal(first, second);
      assert.equal(authenticateLongTermMemoryStoreWriter(first, 'headless'), first);
      assert.equal((await stat(join(root, LONG_TERM_MEMORY_DATABASE_NAME))).isFile(), true);
      first.close();
      await assert.rejects(first.readItem('closed-item'), /closed/);

      const reopened = await openHeadlessLongTermMemoryStoreForWrite(lease);
      assert.notEqual(reopened, first);
      reopened.close();
    });
  });
});

type Store = SqliteMemoryItemStore;

async function withStore(
  run: (context: {
    store: Store;
    databasePath: string;
    setFailpoint: (point: SqliteMemoryItemStoreFailpoint | undefined) => void;
  }) => Promise<void>,
): Promise<void> {
  await withTempRoot(async (root) => {
    const databasePath = join(root, LONG_TERM_MEMORY_DATABASE_NAME);
    let failpoint: SqliteMemoryItemStoreFailpoint | undefined;
    let nextId = 1;
    const store = new SqliteMemoryItemStore(databasePath, {
      now: () => 1_000,
      idFactory: () => `item-${nextId++}`,
      failpoint: (point) => {
        if (point === failpoint) throw new Error(`SQLite Memory failpoint: ${point}`);
      },
    });
    try {
      await run({
        store,
        databasePath,
        setFailpoint: (point) => {
          failpoint = point;
        },
      });
    } finally {
      store.close();
    }
  });
}

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-long-term-memory-'));
  try {
    await chmod(root, 0o700);
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function createItem(
  store: Store,
  operationId: string,
  item: MemoryItemWrite,
): Promise<string> {
  const result = await store.applyMutations({
    operationId,
    mutations: [{ type: 'create', item }],
  });
  return result.results[0]!.itemId;
}

async function itemIds(
  store: Store,
  terms: readonly string[],
  match: 'exact' | 'prefix' = 'exact',
  workspaceKey?: string,
): Promise<string[]> {
  return (
    await store.searchByKeys({
      terms,
      match,
      ...(workspaceKey ? { workspaceKey } : {}),
    })
  ).map((record) => record.item.itemId);
}

function write(overrides: Partial<MemoryItemWrite> = {}): MemoryItemWrite {
  return {
    content: 'User prefers concise answers.',
    kind: 'preference',
    statementType: 'fact',
    temporalType: 'undated',
    scopeType: 'global',
    observedAt: 900,
    origin: 'agent_extracted',
    keys: [{ key: 'concise', keyType: 'exact', keyOrigin: 'deterministic' }],
    sources: [source()],
    ...overrides,
  };
}

function source(overrides: Partial<MemoryItemSource> = {}): MemoryItemSource {
  return {
    sessionId: 'session-1',
    runId: 'run-1',
    turnId: 'turn-1',
    eventId: 'event-1',
    ...overrides,
  };
}

function conflict(reason: MemoryItemStoreConflictError['reason']) {
  return (error: unknown): boolean =>
    error instanceof MemoryItemStoreConflictError && error.reason === reason;
}

function loadDatabaseSync(): typeof import('node:sqlite').DatabaseSync {
  return (require('node:sqlite') as typeof import('node:sqlite')).DatabaseSync;
}

function startConcurrentMigrationWorker(
  databasePath: string,
  moduleUrl: string,
  gate: SharedArrayBuffer,
): { readonly ready: Promise<void>; readonly result: Promise<number> } {
  const worker = new Worker(
    `
      const { parentPort, workerData } = require('node:worker_threads');
      const gate = new Int32Array(workerData.gate);
      parentPort.postMessage({ type: 'ready' });
      Atomics.wait(gate, 0, 0);
      import(workerData.moduleUrl)
        .then(({ SqliteMemoryItemStore }) => {
          const store = new SqliteMemoryItemStore(workerData.databasePath);
          const version = store.schemaVersion();
          store.close();
          parentPort.postMessage({ type: 'result', version });
          parentPort.close();
        })
        .catch((error) => {
          parentPort.postMessage({
            type: 'error',
            message: error && error.stack ? error.stack : String(error),
          });
          parentPort.close();
        });
    `,
    {
      eval: true,
      workerData: { databasePath, moduleUrl, gate },
    },
  );

  let readyResolved = false;
  let resultSettled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveResult!: (version: number) => void;
  let rejectResult!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise<number>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const fail = (error: Error): void => {
    if (!readyResolved) rejectReady(error);
    if (!resultSettled) {
      resultSettled = true;
      rejectResult(error);
    }
  };

  worker.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object') {
      fail(new Error('Concurrent migration worker returned an invalid message'));
      return;
    }
    const payload = message as { type?: unknown; version?: unknown; message?: unknown };
    if (payload.type === 'ready') {
      readyResolved = true;
      resolveReady();
      return;
    }
    if (payload.type === 'result' && typeof payload.version === 'number') {
      resultSettled = true;
      resolveResult(payload.version);
      return;
    }
    if (payload.type === 'error') {
      fail(new Error(String(payload.message)));
      return;
    }
    fail(new Error('Concurrent migration worker returned an invalid message'));
  });
  worker.on('error', (error) => fail(error instanceof Error ? error : new Error(String(error))));
  worker.on('exit', (code) => {
    if (code !== 0) {
      fail(new Error(`Concurrent migration worker exited with code ${code}`));
    } else if (!resultSettled) {
      fail(new Error('Concurrent migration worker exited before returning a result'));
    }
  });

  return { ready, result };
}

async function createSymlinkIfSupported(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path);
    return true;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      ['EPERM', 'EACCES', 'ENOTSUP'].includes(String(error.code))
    ) {
      return false;
    }
    throw error;
  }
}
