import { inMemoryStorageDependencies } from '@lace-lib/storage/in-memory';
import { dummyLogger } from 'ts-log';
import { describe, expect, it } from 'vitest';

import moduleMap from '../src';
import initializeStore from '../src/store/init';

import type { ModuleInitProps } from '@lace-contract/module';

describe('storage-in-memory:store', () => {
  it("provides the library's in-memory storage dependencies", async () => {
    const { sideEffectDependencies } = await initializeStore(
      {} as ModuleInitProps,
      { logger: dummyLogger },
    );
    expect(sideEffectDependencies).toBe(inMemoryStorageDependencies);
  });
});

describe('storage-in-memory:module', () => {
  it('is a lace-mobile-only module', () => {
    expect(Object.keys(moduleMap)).toEqual(['lace-mobile']);
    expect(moduleMap['lace-mobile']?.moduleName).toBe('storage-in-memory');
  });
});
