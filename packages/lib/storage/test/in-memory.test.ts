import { firstValueFrom, take, toArray } from 'rxjs';
import { describe, expect, it } from 'vitest';

import { inMemoryStorageDependencies } from '../src/in-memory';

type Doc = { id: string; value: number };

const createCollection = () =>
  inMemoryStorageDependencies.createCollectionStorage<Doc>({
    collectionId: 'collection',
    computeDocId: ({ id }) => id,
  });

describe('storage:in-memory', () => {
  it('keeps a document for the life of the store', async () => {
    const store = inMemoryStorageDependencies.createDocumentStorage<{
      language: string;
    }>({ documentId: 'document' });
    await expect(
      firstValueFrom(store.get(), { defaultValue: 'absent' }),
    ).resolves.toBe('absent');
    await firstValueFrom(store.set({ language: 'en' }));
    await expect(firstValueFrom(store.get())).resolves.toEqual({
      language: 'en',
    });
  });

  it('keeps key-value entries, and completes without a value when a key is missing', async () => {
    const store = inMemoryStorageDependencies.createKeyValueStorage<
      'a' | 'b',
      number
    >({ collectionId: 'key-values' });
    await firstValueFrom(store.setValue('a', 1));
    await expect(firstValueFrom(store.getValues(['a']))).resolves.toEqual([1]);
    await expect(
      firstValueFrom(store.getValues(['a', 'b']), { defaultValue: 'missing' }),
    ).resolves.toBe('missing');
    await firstValueFrom(store.setValue('a', undefined));
    await expect(
      firstValueFrom(store.getValues(['a']), { defaultValue: 'missing' }),
    ).resolves.toBe('missing');
  });

  it('upserts, reads, removes and clears collection documents', async () => {
    const store = createCollection();
    await expect(
      firstValueFrom(store.getAll(), { defaultValue: 'empty' }),
    ).resolves.toBe('empty');
    await firstValueFrom(store.upsert({ id: 'x', value: 1 }));
    await firstValueFrom(store.upsert({ id: 'y', value: 2 }));
    await firstValueFrom(store.upsert({ id: 'x', value: 3 }));
    await expect(firstValueFrom(store.getAll())).resolves.toEqual([
      { id: 'x', value: 3 },
      { id: 'y', value: 2 },
    ]);
    await expect(firstValueFrom(store.get('y'))).resolves.toEqual({
      id: 'y',
      value: 2,
    });
    await expect(
      firstValueFrom(store.get('z'), { defaultValue: 'absent' }),
    ).resolves.toBe('absent');
    await firstValueFrom(store.removeWhere(({ id }) => id === 'x'));
    await expect(firstValueFrom(store.getAll())).resolves.toEqual([
      { id: 'y', value: 2 },
    ]);
    await firstValueFrom(store.clear());
    await expect(
      firstValueFrom(store.getAll(), { defaultValue: 'empty' }),
    ).resolves.toBe('empty');
  });

  it('setAll replaces every document', async () => {
    const store = createCollection();
    await firstValueFrom(store.upsert({ id: 'x', value: 1 }));
    await firstValueFrom(store.setAll([{ id: 'y', value: 2 }]));
    await expect(firstValueFrom(store.getAll())).resolves.toEqual([
      { id: 'y', value: 2 },
    ]);
  });

  it('observeAll emits the empty collection, then every write', async () => {
    const store = createCollection();
    const emissions = firstValueFrom(
      store.observeAll().pipe(take(2), toArray()),
    );
    await firstValueFrom(store.upsert({ id: 'x', value: 1 }));
    await expect(emissions).resolves.toEqual([[], [{ id: 'x', value: 1 }]]);
  });
});
