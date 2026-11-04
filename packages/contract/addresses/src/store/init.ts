import { readMisroutedPreviewAccountIds } from '@lace-contract/wallet-repo';
import { createMigrate } from 'redux-persist';

import { fixPreviewAddressNetwork } from './migrations/2-fix-preview-address-network';
import { addressesReducers } from './slice';

import type { LaceInit, LaceModuleStoreInit } from '@lace-contract/module';
import type { Storage } from 'redux-persist';

const addressesStoreInit: LaceInit<LaceModuleStoreInit> = async (
  _props,
  dependencies,
) => {
  const { reduxPersistStorage } = dependencies as typeof dependencies & {
    reduxPersistStorage: Storage;
  };
  const misroutedAccountIds = await readMisroutedPreviewAccountIds(
    reduxPersistStorage,
  );
  return {
    reducers: addressesReducers,
    persistConfig: {
      addresses: {
        whitelist: ['addresses'],
        version: 2,
        migrate: createMigrate({
          2: state => fixPreviewAddressNetwork(state, misroutedAccountIds),
        }),
      },
    },
  };
};

export default addressesStoreInit;
