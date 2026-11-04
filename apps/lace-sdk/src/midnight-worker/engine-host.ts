import { derivePendingActivityFromMidnightTx } from '@lace-module/dapp-connector-midnight/sdk';
import {
  createMidnightEngineHost,
  MIDNIGHT_CHECKPOINT_COLLECTION,
} from '@lace-module/midnight-sync/sdk';
import storageInMemory from '@lace-module/storage-in-memory/sdk';
import storageWebIndexeddb from '@lace-module/storage-web-indexeddb/sdk';

import type {
  AppConfig,
  LaceModule,
  ModuleInitProps,
} from '@lace-contract/module';
import type {
  MidnightEngineHost,
  MidnightWorkerStorageKind,
} from '@lace-module/midnight-sync/sdk';
import type { Logger } from 'ts-log';

// The worker loads no app and no other module: the storage modules read neither this runtime nor the loader.
const WORKER_MODULE_PROPS: ModuleInitProps = {
  runtime: {
    app: 'lace-sdk',
    env: 'production',
    config: {} as AppConfig,
    platform: 'web',
    features: {
      availableModules: [],
      loaded: { featureFlags: [], modules: [] },
    },
  },
  loadModules: () => {
    throw new Error(
      'A storage module in the Midnight worker cannot load other modules',
    );
  },
};

// A storage module's collection factory, from its store as the app's loader would initialize it.
const collectionStorageOf = async (module: LaceModule, logger: Logger) => {
  const store = await module.store?.load();
  const createCollectionStorage = store
    ? (await store.default(WORKER_MODULE_PROPS, { logger }))
        .sideEffectDependencies?.createCollectionStorage
    : undefined;
  if (!createCollectionStorage)
    throw new Error(
      `Storage module "${module.moduleName}" provides no collection storage for the Midnight worker`,
    );
  return createCollectionStorage;
};

/**
 * The engine host the SDK's worker serves: checkpoints in the SDK's storage modules, in memory or in the origin's
 * IndexedDB as each client asks, in the collection page mode uses; Pending activities derived as the dApp connector
 * derives them.
 *
 * @param logger - Receives the host's diagnostics.
 */
export const createSdkMidnightEngineHost = async (
  logger: Logger,
): Promise<MidnightEngineHost> => {
  const [inMemory, indexedDb] = await Promise.all([
    collectionStorageOf(storageInMemory as LaceModule, logger),
    collectionStorageOf(storageWebIndexeddb as LaceModule, logger),
  ]);
  const factories: Record<MidnightWorkerStorageKind, typeof inMemory> = {
    memory: inMemory,
    indexeddb: indexedDb,
  };
  return createMidnightEngineHost({
    createStore: kind => factories[kind](MIDNIGHT_CHECKPOINT_COLLECTION),
    derivePendingActivity: derivePendingActivityFromMidnightTx,
    logger,
  });
};
