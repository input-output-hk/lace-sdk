import { inMemoryStorageDependencies } from '@lace-lib/storage/in-memory';

import type { LaceInit, LaceModuleStoreInit } from '@lace-contract/module';

const store: LaceInit<LaceModuleStoreInit> = () => ({
  sideEffectDependencies: inMemoryStorageDependencies,
});

export default store;
