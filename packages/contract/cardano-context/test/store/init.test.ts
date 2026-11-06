import { AccountId } from '@lace-contract/wallet-repo';
import { Cardano } from '@lace-lib/cardano-core';
import { Serializable } from '@lace-lib/util-store';
import { describe, expect, it } from 'vitest';

import initializeStore, {
  accountTransactionHistoryTransform,
  MAX_TRANSACTIONS_PER_ACCOUNT,
} from '../../src/store/init';
import { UtxoCacheKey } from '../../src/value-objects';
import { utxo1 } from '../mocks';

describe('legacy mobile upgrade with an already-settled UTxO cache key', () => {
  it('does not invalidate a cache key already persisted at version 5', async () => {
    const initialized = await initializeStore(
      {
        runtime: {
          config: { defaultTestnetChainId: Cardano.ChainIds.Preprod },
        },
      } as never,
      { reduxPersistStorage: { getItem: async () => null } } as never,
    );
    const persistence = initialized.persistConfig?.cardanoContext;
    if (!persistence?.migrate || persistence.version === undefined) {
      throw new Error('Missing Cardano persistence migration configuration');
    }
    const accountId = AccountId('legacy-mobile-account');
    const cacheKey = UtxoCacheKey({
      topOnChainActivityId: 'b'.repeat(64),
      stakeKeys: [],
      accountAddressCount: 1,
    });
    const state = {
      _persist: { rehydrated: true, version: 5 },
      accountUtxos: {
        [accountId]: { cacheKey, utxos: Serializable.to([utxo1]) },
      },
    };

    const migrated = await persistence.migrate(state, persistence.version);

    expect(migrated).toBe(state);
    expect(state.accountUtxos[accountId].cacheKey).toBe(cacheKey);
  });
});

describe('accountTransactionHistoryTransform', () => {
  it('should return the same state if the key is not accountTransactionHistory', () => {
    const state = {
      account1: {
        address1: {
          transactionHistory: [
            {
              id: 'tx1',
              blockTime: 1746526784980,
            },
          ],
          hasLoadedOldestEntry: false,
        },
      },
    };

    const result = accountTransactionHistoryTransform.in(state, '_persist', {});
    expect(result).toEqual(state);
  });

  it('should return transformed state if the key is accountTransactionHistory', () => {
    const txHistory = Array.from(
      { length: MAX_TRANSACTIONS_PER_ACCOUNT + 1 },
      (_, index) => ({
        id: `tx${index + 1}`,
        blockTime: 1746526784980 - index * 5,
      }),
    );

    const state = {
      account1: {
        address1: {
          transactionHistory: txHistory,
          hasLoadedOldestEntry: false,
        },
        address2: {
          transactionHistory: txHistory.slice(0, MAX_TRANSACTIONS_PER_ACCOUNT),
          hasLoadedOldestEntry: false,
        },
      },
      account2: {
        address1: {
          transactionHistory: txHistory.slice(0, MAX_TRANSACTIONS_PER_ACCOUNT),
          hasLoadedOldestEntry: true,
        },
      },
    };

    const result = accountTransactionHistoryTransform.in(
      state,
      'accountTransactionHistory',
      {},
    );
    expect(result).toEqual({
      account1: {
        address1: {
          transactionHistory: txHistory.slice(0, MAX_TRANSACTIONS_PER_ACCOUNT),
          hasLoadedOldestEntry: false,
        },
        address2: {
          transactionHistory: txHistory.slice(0, MAX_TRANSACTIONS_PER_ACCOUNT),
          hasLoadedOldestEntry: false,
        },
      },
      account2: {
        address1: {
          transactionHistory: txHistory.slice(0, MAX_TRANSACTIONS_PER_ACCOUNT),
          hasLoadedOldestEntry: true,
        },
      },
    });
  });
});

describe('cardano-context store init', () => {
  it('persists the deposited head ids and tagged accounts of the Hydra Head index', async () => {
    const result = (await initializeStore(
      { runtime: { config: {} } } as never,
      { reduxPersistStorage: { getItem: async () => null } } as never,
    )) as {
      persistConfig: Record<string, { whitelist?: string[] }>;
    };

    expect(result.persistConfig.hydraHeadsIndex).toEqual({
      version: 1,
      whitelist: ['depositedHeadIdsByAccount', 'activitiesTaggedByAccount'],
    });
  });
});
