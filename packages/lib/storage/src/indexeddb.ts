import {
  CollectionStore,
  DocumentStore,
  KeyValueStore,
} from '@lace-contract/storage';

import { storageApi } from './indexeddb-adapter';

import type {
  CreateKeyValueStorageProps,
  KeyValueStorageDependencies,
} from '@lace-contract/module';
import type {
  CreateCollectionStorageProps,
  CreateDocumentStorageProps,
  StorageAdapter,
  StorageDependencies,
} from '@lace-contract/storage';
import type { Logger } from 'ts-log';

/** A document store in the origin's IndexedDB, on the adapter every store of this library shares. */
export const createDocumentStorage = <T extends object>(
  { documentId }: Readonly<CreateDocumentStorageProps>,
  { logger }: Readonly<{ logger: Logger }>,
) => new DocumentStore<T>(documentId, storageApi as StorageAdapter<T>, logger);

/**
 * The storage factories over the origin's IndexedDB: the contract's stores on
 * the one adapter, so every store in the origin reads and writes the same
 * database.
 */
export const createIndexedDbStorageDependencies = ({
  logger,
}: Readonly<{ logger: Logger }>): KeyValueStorageDependencies &
  StorageDependencies => ({
  createDocumentStorage: <T extends object>(
    props: Readonly<CreateDocumentStorageProps>,
  ) => createDocumentStorage<T>(props, { logger }),
  createKeyValueStorage: <K extends string, V>(
    props: Readonly<CreateKeyValueStorageProps>,
  ) =>
    new KeyValueStore<K, V>(
      props.collectionId,
      storageApi as StorageAdapter<V>,
      logger,
    ),
  createCollectionStorage: <T extends object>({
    collectionId,
    computeDocId,
  }: Readonly<CreateCollectionStorageProps<T>>) =>
    new CollectionStore<T>({
      collectionId,
      storage: storageApi,
      logger,
      computeDocId,
    }),
});
