import {
  isReduxPersistState,
  type LaceInit,
  type LaceModuleStoreInit,
  type PersistedStateProperty,
} from '@lace-contract/module';
import { readMisroutedPreviewAccountIds } from '@lace-contract/wallet-repo';
import { createMigrate, createTransform } from 'redux-persist';

import { clearPreviewSyncStatus } from './migrations/2-clear-preview-sync-status';
import { syncReducers } from './slice';

import type { SyncSliceState } from '../types';
import type { AccountId } from '@lace-contract/wallet-repo';
import type { Storage } from 'redux-persist';

/**
 * Transform that excludes pendingSync from being persisted.
 * Only lastSuccessfulSync is persisted for each account.
 */
const ExcludePendingSyncTransform = createTransform<
  PersistedStateProperty<SyncSliceState>,
  PersistedStateProperty<SyncSliceState>
>(
  // transform state on its way to being serialized and persisted
  (inboundState, key) => {
    if (isReduxPersistState(key, inboundState)) {
      return inboundState;
    }

    const outboundState: SyncSliceState['syncStatusByAccount'] = {};

    if (key === 'syncStatusByAccount') {
      const syncStatusByAccount = inboundState;

      // Use for...in loop which safely handles undefined/null (doesn't iterate)
      for (const accountId in syncStatusByAccount) {
        const accountStatus = syncStatusByAccount[accountId as AccountId];
        outboundState[accountId as AccountId] = {
          lastSuccessfulSync: accountStatus.lastSuccessfulSync,
          // pendingSync is intentionally excluded (transient state)
        };
      }
    }

    return outboundState;
  },
);

const store: LaceInit<LaceModuleStoreInit> = async (_props, dependencies) => {
  const { reduxPersistStorage } = dependencies as typeof dependencies & {
    reduxPersistStorage: Storage;
  };
  const misroutedAccountIds = await readMisroutedPreviewAccountIds(
    reduxPersistStorage,
  );
  return {
    reducers: syncReducers,
    persistConfig: {
      sync: {
        version: 2,
        migrate: createMigrate({
          2: state => clearPreviewSyncStatus(state, misroutedAccountIds),
        }),
        whitelist: ['syncStatusByAccount'],
        transforms: [ExcludePendingSyncTransform],
      },
    },
  };
};

export default store;
