import { inMemoryStorageDependencies } from '@lace-lib/storage/in-memory';
import { createIndexedDbStorageDependencies } from '@lace-lib/storage/indexeddb';
import { derivePendingActivityFromMidnightTx } from '@lace-module/dapp-connector-midnight/sdk';
import { MIDNIGHT_CHECKPOINT_COLLECTION } from '@lace-module/midnight-sync/sdk';
import { createMidnightEngineHost } from '@lace-module/midnight-sync/sdk-engine';

import type { StorageDependencies } from '@lace-contract/storage';
import type {
  MidnightEngineHost,
  MidnightWorkerStorageKind,
} from '@lace-module/midnight-sync/sdk';
import type { Logger } from 'ts-log';

/**
 * The engine host the SDK's worker serves: checkpoints in the storage backends the SDK's storage modules build on, in
 * memory or in the origin's IndexedDB as each client asks, in the collection page mode uses; Pending activities
 * derived as the dApp connector derives them.
 *
 * @param logger - Receives the host's diagnostics.
 */
export const createSdkMidnightEngineHost = (
  logger: Logger,
): MidnightEngineHost => {
  const factories: Record<
    MidnightWorkerStorageKind,
    StorageDependencies['createCollectionStorage']
  > = {
    memory: inMemoryStorageDependencies.createCollectionStorage,
    indexeddb: createIndexedDbStorageDependencies({ logger })
      .createCollectionStorage,
  };
  return createMidnightEngineHost({
    createStore: kind => factories[kind](MIDNIGHT_CHECKPOINT_COLLECTION),
    derivePendingActivity: derivePendingActivityFromMidnightTx,
    logger,
  });
};
