import { createIndexedDbStorageDependencies } from '@lace-lib/storage/indexeddb';

import type { LaceInit, LaceModuleStoreInit } from '@lace-contract/module';

const store: LaceInit<LaceModuleStoreInit> = (_, { logger }) => ({
  sideEffectDependencies: createIndexedDbStorageDependencies({ logger }),
});

export default store;
