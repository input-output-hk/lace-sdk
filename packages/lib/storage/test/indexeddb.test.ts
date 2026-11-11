import 'fake-indexeddb/auto';
import {
  CollectionStore,
  DocumentStore,
  KeyValueStore,
} from '@lace-contract/storage';
import { firstValueFrom } from 'rxjs';
import { dummyLogger } from 'ts-log';
import { describe, expect, it } from 'vitest';

import {
  createDocumentStorage,
  createIndexedDbStorageDependencies,
} from '../src/indexeddb';

describe('storage:indexeddb', () => {
  const dependencies = createIndexedDbStorageDependencies({
    logger: dummyLogger,
  });

  it("builds the contract's stores over IndexedDB", () => {
    expect(
      dependencies.createKeyValueStorage({ collectionId: 'key-values' }),
    ).toBeInstanceOf(KeyValueStore);
    expect(
      dependencies.createDocumentStorage({ documentId: 'document' }),
    ).toBeInstanceOf(DocumentStore);
    expect(
      dependencies.createCollectionStorage<{ id: string }>({
        collectionId: 'collection',
        computeDocId: ({ id }) => id,
      }),
    ).toBeInstanceOf(CollectionStore);
  });

  it('round-trips a document through IndexedDB', async () => {
    const documentStorage = dependencies.createDocumentStorage<{
      language: string;
    }>({ documentId: 'indexeddb-test-document' });
    await firstValueFrom(documentStorage.set({ language: 'en' }));
    await expect(firstValueFrom(documentStorage.get())).resolves.toEqual({
      language: 'en',
    });
  });

  it('round-trips a collection document through IndexedDB', async () => {
    const collectionStorage = dependencies.createCollectionStorage<{
      id: string;
      value: number;
    }>({
      collectionId: 'indexeddb-test-collection',
      computeDocId: ({ id }) => id,
    });
    await firstValueFrom(collectionStorage.upsert({ id: 'x', value: 1 }));
    await expect(firstValueFrom(collectionStorage.get('x'))).resolves.toEqual({
      id: 'x',
      value: 1,
    });
  });

  it('builds the document store the bootstrap loads', () => {
    expect(
      createDocumentStorage(
        { documentId: 'bootstrap-document' },
        { logger: dummyLogger },
      ),
    ).toBeInstanceOf(DocumentStore);
  });
});
