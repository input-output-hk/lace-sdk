import {
  isReduxPersistState,
  type LaceInit,
  type LaceModuleStoreInit,
  type PersistedStateProperty,
} from '@lace-contract/module';
import { readMisroutedPreviewAccountIds } from '@lace-contract/wallet-repo';
import { createMigrate, createTransform } from 'redux-persist';

import {
  cardanoSettledAccountUnspendableUtxos$,
  cardanoSettledAvailableAccountUtxos$,
  cardanoAddresses$,
  cardanoChainId$,
  cardanoNetworkMagic$,
  cardanoPendingRewardWithdrawals$,
  cardanoProtocolParameters$,
  cardanoRewardAccountDetails$,
} from '../cardano-observables';
import { extensionPersistConfig } from '../extensions';

import {
  deleteProtocolParameters,
  deleteStakePoolsData,
  deleteStakePoolsSystem,
  stubAccountUtxoCacheKeys,
} from './migrations';
import { clearPreviewAccountCache } from './migrations/6-clear-preview-account-cache';
import { createCardanoProviderSideEffects } from './side-effects';
import { cardanoContextReducers, initialState } from './slice';

import type { CardanoAccountId } from '../value-objects';
import type { CardanoContextSliceState } from './slice';
import type {
  CardanoAccountAddressHistoryMap,
  CardanoAddressTransactionHistoryMap,
  CardanoPaymentAddress,
} from '../types';
import type { AccountId } from '@lace-contract/wallet-repo';
import type { Storage } from 'redux-persist';

export const MAX_TRANSACTIONS_PER_ACCOUNT = 20;

export const accountTransactionHistoryTransform = createTransform<
  PersistedStateProperty<CardanoContextSliceState>,
  PersistedStateProperty<CardanoContextSliceState>
>((inboundState, key) => {
  if (isReduxPersistState(key, inboundState)) {
    return inboundState;
  }

  if (key === 'accountTransactionHistory') {
    const inboundHistory =
      inboundState as unknown as CardanoAccountAddressHistoryMap;
    const outboundState: CardanoAccountAddressHistoryMap = {};

    for (const accountId in inboundHistory) {
      const accountHistory = inboundHistory[accountId as CardanoAccountId];
      const newAccountHistory: CardanoAddressTransactionHistoryMap = {};

      for (const [address, addressHistory] of Object.entries(accountHistory)) {
        // assume that the transactions are sorted by block time in descending order
        const latestAccountTransactions = [
          ...addressHistory.transactionHistory,
        ].slice(0, MAX_TRANSACTIONS_PER_ACCOUNT);

        newAccountHistory[address as CardanoPaymentAddress] = {
          transactionHistory: latestAccountTransactions,
          hasLoadedOldestEntry:
            addressHistory.transactionHistory.length >
            MAX_TRANSACTIONS_PER_ACCOUNT
              ? false
              : addressHistory.hasLoadedOldestEntry,
        };
      }

      outboundState[accountId as AccountId] = newAccountHistory;
    }

    return outboundState;
  }

  return inboundState;
});

const store: LaceInit<LaceModuleStoreInit> = async (
  { runtime: { config } },
  dependencies,
) => {
  const { reduxPersistStorage } = dependencies as typeof dependencies & {
    reduxPersistStorage: Storage;
  };
  const misroutedAccountIds = await readMisroutedPreviewAccountIds(
    reduxPersistStorage,
  );
  return {
    sideEffects: createCardanoProviderSideEffects(config),
    reducers: cardanoContextReducers,
    preloadedState: {
      cardanoContext: initialState,
    },
    sideEffectDependencies: {
      txExecutorCardano: {
        cardanoProtocolParameters$,
        cardanoNetworkMagic$,
        cardanoSettledAvailableAccountUtxos$,
        cardanoSettledAccountUnspendableUtxos$,
        cardanoAddresses$,
        cardanoChainId$,
        cardanoRewardAccountDetails$,
        cardanoPendingRewardWithdrawals$,
      },
    },
    persistConfig: {
      cardanoContext: {
        version: 6,
        whitelist: [
          'accountTransactionHistory',
          'accountRewardsHistory',
          'networkInfo',
          'accountUtxos',
          'inFlightTransactions',
          'securityScanByAccount',
          'securityRescanDismissedByAccount',
        ],
        migrate: createMigrate({
          2: deleteStakePoolsData,
          3: deleteProtocolParameters,
          4: deleteStakePoolsSystem,
          5: stubAccountUtxoCacheKeys,
          6: state => clearPreviewAccountCache(state, misroutedAccountIds),
        }),
        transforms: [accountTransactionHistoryTransform],
      },
      ...extensionPersistConfig,
    },
  };
};

export default store;
