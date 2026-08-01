import { join } from 'node:path';
import type {
  ApplyMemoryMutationsRequest,
  MemoryItemStore,
  MemoryItemWrite,
  SearchMemoryItemsByKeyRequest,
} from '@maka/core/long-term-memory';
import {
  assertStorageRootLease,
  runWithStorageRootLease,
  StorageRootAuthorityError,
  type StorageRootKind,
  type StorageRootLease,
} from './root-authority.js';
import { SqliteMemoryItemStore } from './sqlite-long-term-memory-store.js';

export { SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION } from './sqlite-long-term-memory-schema.js';

export const LONG_TERM_MEMORY_DATABASE_NAME = 'memory.sqlite';

const writerBrand: unique symbol = Symbol('LongTermMemoryStoreWriter');
const writerKinds = new WeakMap<object, StorageRootKind>();
const writerByLease = new WeakMap<object, LongTermMemoryStoreWriter<StorageRootKind>>();
const writerOpeningByLease = new WeakMap<
  object,
  Promise<LongTermMemoryStoreWriter<StorageRootKind>>
>();

export interface LongTermMemoryStoreWriter<K extends StorageRootKind = StorageRootKind>
  extends MemoryItemStore {
  readonly kind: K;
  readonly access: 'write';
  readonly [writerBrand]: K;
  close(): void;
}

export function authenticateLongTermMemoryStoreWriter<K extends StorageRootKind>(
  writer: LongTermMemoryStoreWriter<K>,
  expectedKind: K,
): LongTermMemoryStoreWriter<K> {
  if (writerKinds.get(writer) !== expectedKind) {
    throw new StorageRootAuthorityError(
      'invalid_lease',
      `Expected an authentic ${expectedKind} long-term memory writer`,
    );
  }
  return writer;
}

/**
 * Open the dedicated memory.sqlite through an authenticated Storage Root lease.
 * Production code must use this facade rather than opening the low-level Store.
 */
export function openInteractiveLongTermMemoryStoreForWrite(
  lease: StorageRootLease<'interactive', 'write'>,
): Promise<LongTermMemoryStoreWriter<'interactive'>> {
  return openLongTermMemoryStoreForWrite(lease, 'interactive');
}

export function openHeadlessLongTermMemoryStoreForWrite(
  lease: StorageRootLease<'headless', 'write'>,
): Promise<LongTermMemoryStoreWriter<'headless'>> {
  return openLongTermMemoryStoreForWrite(lease, 'headless');
}

async function openLongTermMemoryStoreForWrite<K extends StorageRootKind>(
  lease: StorageRootLease<K, 'write'>,
  expectedKind: K,
): Promise<LongTermMemoryStoreWriter<K>> {
  await assertStorageRootLease(lease, expectedKind, 'write');
  const existing = writerByLease.get(lease);
  if (existing) return existing as LongTermMemoryStoreWriter<K>;
  const opening = writerOpeningByLease.get(lease);
  if (opening) return opening as Promise<LongTermMemoryStoreWriter<K>>;

  const pending = Promise.resolve().then(async () => {
    let store: SqliteMemoryItemStore | undefined;
    try {
      store = await runWithStorageRootLease(
        lease,
        expectedKind,
        'write',
        async (root) => new SqliteMemoryItemStore(join(root, LONG_TERM_MEMORY_DATABASE_NAME)),
      );
      await assertStorageRootLease(lease, expectedKind, 'write');
      const recoveredExisting = writerByLease.get(lease);
      if (recoveredExisting) {
        store.close();
        return recoveredExisting;
      }
      const writer = createWriterFacade(lease, expectedKind, store);
      writerKinds.set(writer, expectedKind);
      writerByLease.set(lease, writer);
      return writer;
    } catch (error) {
      store?.close();
      throw error;
    }
  });
  writerOpeningByLease.set(lease, pending);
  try {
    return (await pending) as LongTermMemoryStoreWriter<K>;
  } finally {
    if (writerOpeningByLease.get(lease) === pending) writerOpeningByLease.delete(lease);
  }
}

function createWriterFacade<K extends StorageRootKind>(
  lease: StorageRootLease<K, 'write'>,
  kind: K,
  store: SqliteMemoryItemStore,
): LongTermMemoryStoreWriter<K> {
  let closed = false;
  const run = <T>(operation: () => Promise<T>): Promise<T> => {
    if (closed) {
      return Promise.reject(
        new StorageRootAuthorityError('invalid_lease', 'Long-term memory writer is closed'),
      );
    }
    return runWithStorageRootLease(lease, kind, 'write', operation);
  };
  const writer: LongTermMemoryStoreWriter<K> = {
    kind,
    access: 'write',
    [writerBrand]: kind,
    applyMutations: (request) => {
      const snapshot = snapshotApplyRequest(request);
      return run(() => store.applyMutations(snapshot));
    },
    readItem: (itemId) => run(() => store.readItem(itemId)),
    searchByKeys: (request) => {
      const snapshot = snapshotSearchRequest(request);
      return run(() => store.searchByKeys(snapshot));
    },
    readOperation: (operationId) => run(() => store.readOperation(operationId)),
    close: () => {
      if (closed) return;
      closed = true;
      if (writerByLease.get(lease) === writer) writerByLease.delete(lease);
      writerKinds.delete(writer);
      store.close();
    },
  };
  return Object.freeze(writer);
}

function snapshotApplyRequest(request: ApplyMemoryMutationsRequest): ApplyMemoryMutationsRequest {
  return Object.freeze({
    operationId: request.operationId,
    mutations: Object.freeze(
      request.mutations.map((mutation) => {
        if (mutation.type === 'create') {
          return Object.freeze({ type: mutation.type, item: snapshotItemWrite(mutation.item) });
        }
        if (mutation.type === 'update') {
          return Object.freeze({
            type: mutation.type,
            itemId: mutation.itemId,
            expectedVersion: mutation.expectedVersion,
            item: snapshotItemWrite(mutation.item),
          });
        }
        return Object.freeze({
          type: mutation.type,
          itemId: mutation.itemId,
          expectedVersion: mutation.expectedVersion,
        });
      }),
    ),
  });
}

function snapshotItemWrite(item: MemoryItemWrite): MemoryItemWrite {
  return Object.freeze({
    ...item,
    keys: Object.freeze(item.keys.map((key) => Object.freeze({ ...key }))),
    sources: Object.freeze(item.sources.map((source) => Object.freeze({ ...source }))),
  });
}

function snapshotSearchRequest(
  request: SearchMemoryItemsByKeyRequest,
): SearchMemoryItemsByKeyRequest {
  return Object.freeze({ ...request, terms: Object.freeze([...request.terms]) });
}
