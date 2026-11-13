import { ActivityType } from '@lace-contract/activities';
import { TokenId } from '@lace-contract/tokens';
import {
  AccountId,
  WalletId,
  WalletType,
  walletsActions,
} from '@lace-contract/wallet-repo';
import { Cardano, Milliseconds } from '@lace-lib/cardano-core';
import { BigNumber, Timestamp } from '@lace-lib/util';
import { Serializable } from '@lace-lib/util-store';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  CardanoRewardAccount,
  CardanoPaymentAddress,
  CardanoNetworkId,
  CardanoAccountId,
  CardanoSyncFailureId,
  RewardAccountDetailsCacheKey,
  UNBOUNDED_IN_FLIGHT_SLOTS,
  UtxoCacheKey,
} from '../../src';
import {
  cardanoContextActions as actions,
  cardanoContextReducers as reducers,
  cardanoContextSelectors as selectors,
} from '../../src/store/slice';
import { recordInFlight } from '../in-flight-mocks';
import {
  threeAccountCardanoWalletAccounts,
  cardanoAccount1Addr,
  cardanoAccount2Addr1,
  cardanoAccount2Addr2,
  createTransactionHistoryItem,
  tip1,
  utxo1,
  utxo2,
} from '../mocks';

import type {
  AccountRewardAccountDetailsMap,
  CardanoContextSliceState,
  InFlightTransactionKey,
  CardanoTransactionHistoryItem,
  RequiredProtocolParameters,
  Reward,
} from '../../src';
import type { Activity } from '@lace-contract/activities';
import type { Failure, FailureId } from '@lace-contract/failures';
import type { TranslationKey } from '@lace-contract/i18n';
import type { NetworkSliceState, NetworkType } from '@lace-contract/network';
import type { AnyAccount, WalletEntity } from '@lace-contract/wallet-repo';
import type { EraSummary } from '@lace-lib/cardano-core';

describe('cardanoContext slice', () => {
  let initialState: CardanoContextSliceState;
  const protocolParameters = {
    stakeKeyDeposit: 1000000,
    poolDeposit: 1000000,
  } as RequiredProtocolParameters;

  const testNetwork = CardanoNetworkId(Cardano.NetworkMagics.Preprod);

  beforeEach(() => {
    initialState = {
      inFlightTransactions: {},
      accountTransactionHistory: {},
      accountRewardsHistory: {},
      networkInfo: {},
      accountUtxos: {},
      accountUnspendableUtxos: {},
      rewardAccountDetails: {},
      lastFetchedRewardAccountDetailsCacheKey: {},
      accountDelegationsHistory: {},
      delegationActivities: {},
      securityScanByAccount: {},
      securityScanInProgress: {},
      securityRescanDismissedByAccount: {},
    };
  });

  describe('reducers', () => {
    describe('setTip', () => {
      it('should set the tip for the specified network', () => {
        const action = actions.cardanoContext.setTip({
          network: testNetwork,
          tip: tip1,
        });

        const state = reducers.cardanoContext(initialState, action);

        expect(state.networkInfo[testNetwork]?.tip).toEqual(tip1);
      });

      it('should store tips for different networks separately', () => {
        const previewNetwork = CardanoNetworkId(Cardano.NetworkMagics.Preview);
        const tip2 = { blockNo: 2 } as Cardano.Tip;

        let state = reducers.cardanoContext(
          initialState,
          actions.cardanoContext.setTip({ network: testNetwork, tip: tip1 }),
        );
        state = reducers.cardanoContext(
          state,
          actions.cardanoContext.setTip({ network: previewNetwork, tip: tip2 }),
        );

        expect(state.networkInfo[testNetwork]?.tip).toEqual(tip1);
        expect(state.networkInfo[previewNetwork]?.tip).toEqual(tip2);
      });
    });

    describe('setProtocolParameters', () => {
      it('should set the protocol parameters for the specified network', () => {
        const action = actions.cardanoContext.setProtocolParameters({
          network: testNetwork,
          protocolParameters,
        });

        const state = reducers.cardanoContext(initialState, action);

        expect(state.networkInfo[testNetwork]?.protocolParameters).toEqual({
          stakeKeyDeposit: 1000000,
          poolDeposit: 1000000,
        });
      });

      it('should store protocol parameters for different networks separately', () => {
        const previewNetwork = CardanoNetworkId(Cardano.NetworkMagics.Preview);
        const protocolParameters2 = {
          stakeKeyDeposit: 2000000,
          poolDeposit: 2000000,
        } as RequiredProtocolParameters;

        let state = reducers.cardanoContext(
          initialState,
          actions.cardanoContext.setProtocolParameters({
            network: testNetwork,
            protocolParameters,
          }),
        );
        state = reducers.cardanoContext(
          state,
          actions.cardanoContext.setProtocolParameters({
            network: previewNetwork,
            protocolParameters: protocolParameters2,
          }),
        );

        expect(state.networkInfo[testNetwork]?.protocolParameters).toEqual({
          stakeKeyDeposit: 1000000,
          poolDeposit: 1000000,
        });
        expect(state.networkInfo[previewNetwork]?.protocolParameters).toEqual({
          stakeKeyDeposit: 2000000,
          poolDeposit: 2000000,
        });
      });
    });

    describe('setEraSummaries', () => {
      it('should set the era summaries for the specified network', () => {
        const eraSummaries: EraSummary[] = [
          {
            parameters: { epochLength: 21600, slotLength: Milliseconds(20000) },
            start: { slot: 0, time: new Date('2022-06-01T00:00:00.000Z') },
          },
        ];
        const action = actions.cardanoContext.setEraSummaries({
          network: testNetwork,
          eraSummaries,
        });

        const state = reducers.cardanoContext(initialState, action);

        expect(state.networkInfo[testNetwork]?.eraSummaries).toEqual(
          Serializable.to(eraSummaries),
        );
      });

      it('should store era summaries for different networks separately', () => {
        const previewNetwork = CardanoNetworkId(Cardano.NetworkMagics.Preview);
        const eraSummaries1: EraSummary[] = [
          {
            parameters: { epochLength: 21600, slotLength: Milliseconds(20000) },
            start: { slot: 0, time: new Date('2022-06-01T00:00:00.000Z') },
          },
        ];
        const eraSummaries2: EraSummary[] = [
          {
            parameters: { epochLength: 43200, slotLength: Milliseconds(10000) },
            start: { slot: 0, time: new Date('2022-07-01T00:00:00.000Z') },
          },
        ];

        let state = reducers.cardanoContext(
          initialState,
          actions.cardanoContext.setEraSummaries({
            network: testNetwork,
            eraSummaries: eraSummaries1,
          }),
        );
        state = reducers.cardanoContext(
          state,
          actions.cardanoContext.setEraSummaries({
            network: previewNetwork,
            eraSummaries: eraSummaries2,
          }),
        );

        expect(state.networkInfo[testNetwork]?.eraSummaries).toEqual(
          Serializable.to(eraSummaries1),
        );
        expect(state.networkInfo[previewNetwork]?.eraSummaries).toEqual(
          Serializable.to(eraSummaries2),
        );
      });
    });

    describe('setAccountRewardsHistory', () => {
      it('should set the account rewards history', () => {
        const testRewardHistory = {
          [CardanoRewardAccount(
            'stake_test1uqrw9tjymlm8wrwq7jk68n6v7fs9qz8z0tkdkve26dylmfc2ux2hj',
          )]: [
            {
              epoch: Cardano.EpochNo(100),
              rewards: BigNumber(BigInt(1000000)),
              poolId: Cardano.PoolId(
                'pool1h8yl5mkyrfmfls2x9fu9mls3ry6egnw4q6efg34xr37zc243gkf',
              ),
            },
          ],
        };

        const action = actions.cardanoContext.setAccountRewardsHistory({
          accountId: AccountId('test1'),
          rewardsHistory: testRewardHistory,
        });

        const state = reducers.cardanoContext(initialState, action);

        expect(state.accountRewardsHistory).toEqual({
          [AccountId('test1')]: testRewardHistory,
        });
      });
    });

    describe('setAccountDelegationsHistory', () => {
      const accountId = AccountId('test1');
      const rewardAccount = CardanoRewardAccount(
        'stake_test1uqrw9tjymlm8wrwq7jk68n6v7fs9qz8z0tkdkve26dylmfc2ux2hj',
      );
      const delegationEntry = {
        activeEpoch: Cardano.EpochNo(100),
        txHash: Cardano.TransactionId(
          '80be2d8820b8946037764fcba8177a3eb1cae94bf8993def14dda20cb89390c2',
        ),
        amount: BigNumber(BigInt(1000000)),
        poolId: Cardano.PoolId(
          'pool1h8yl5mkyrfmfls2x9fu9mls3ry6egnw4q6efg34xr37zc243gkf',
        ),
      };
      const registrationEntry = {
        txHash: Cardano.TransactionId(
          '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20',
        ),
        action: 'registered' as const,
      };
      const withdrawalEntry = {
        txHash: Cardano.TransactionId(
          'f0e1d2c3b4a5968778695a4b3c2d1e0f00112233445566778899aabbccddeeff',
        ),
        amount: BigNumber(BigInt(2500000)),
      };

      it('should initialize and append delegations', () => {
        const action = actions.cardanoContext.setAccountDelegationsHistory({
          accountId,
          rewardAccount,
          items: [delegationEntry],
        });

        const state = reducers.cardanoContext(initialState, action);

        expect(
          state.accountDelegationsHistory[accountId][rewardAccount],
        ).toEqual([delegationEntry]);
      });

      it('should append to existing delegations entries', () => {
        const firstState = reducers.cardanoContext(
          initialState,
          actions.cardanoContext.setAccountDelegationsHistory({
            accountId,
            rewardAccount,
            items: [delegationEntry],
          }),
        );

        const nextDelegation = {
          ...delegationEntry,
          activeEpoch: Cardano.EpochNo(101),
        };
        const secondState = reducers.cardanoContext(
          firstState,
          actions.cardanoContext.setAccountDelegationsHistory({
            accountId,
            rewardAccount,
            items: [nextDelegation],
          }),
        );

        expect(
          secondState.accountDelegationsHistory[accountId][rewardAccount],
        ).toEqual([delegationEntry, nextDelegation]);
      });

      it('should append registrations and preserve delegations', () => {
        const firstState = reducers.cardanoContext(
          initialState,
          actions.cardanoContext.setAccountDelegationsHistory({
            accountId,
            rewardAccount,
            items: [delegationEntry],
          }),
        );

        const state = reducers.cardanoContext(
          firstState,
          actions.cardanoContext.setAccountDelegationsHistory({
            accountId,
            rewardAccount,
            items: [registrationEntry],
          }),
        );

        expect(
          state.accountDelegationsHistory[accountId][rewardAccount],
        ).toEqual([delegationEntry, registrationEntry]);
      });

      it('should append withdrawals and preserve existing entries', () => {
        const firstState = reducers.cardanoContext(
          initialState,
          actions.cardanoContext.setAccountDelegationsHistory({
            accountId,
            rewardAccount,
            items: [registrationEntry],
          }),
        );

        const state = reducers.cardanoContext(
          firstState,
          actions.cardanoContext.setAccountDelegationsHistory({
            accountId,
            rewardAccount,
            items: [withdrawalEntry],
          }),
        );

        expect(
          state.accountDelegationsHistory[accountId][rewardAccount],
        ).toEqual([registrationEntry, withdrawalEntry]);
      });

      it('should append mixed items in a single call', () => {
        const state = reducers.cardanoContext(
          initialState,
          actions.cardanoContext.setAccountDelegationsHistory({
            accountId,
            rewardAccount,
            items: [delegationEntry, registrationEntry, withdrawalEntry],
          }),
        );

        expect(
          state.accountDelegationsHistory[accountId][rewardAccount],
        ).toEqual([delegationEntry, registrationEntry, withdrawalEntry]);
      });
    });

    describe('setDelegationActivities', () => {
      const accountId = AccountId('test1');
      const rewardAccount = CardanoRewardAccount(
        'stake_test1uqrw9tjymlm8wrwq7jk68n6v7fs9qz8z0tkdkve26dylmfc2ux2hj',
      );
      const rewardAccount2 = CardanoRewardAccount(
        'stake_test1urpklgzqsh9yqz8pkyuxcw9dlszpe5flnxjtl55epla6ftqktdyfz',
      );

      const createActivity = (
        activityId: string,
        type: ActivityType,
        timestamp: number,
      ): Activity => ({
        accountId,
        activityId,
        type,
        timestamp: Timestamp(timestamp),
        tokenBalanceChanges: [
          {
            tokenId: TokenId('lovelace'),
            amount: BigNumber(BigInt(1000000)),
          },
        ],
      });

      it('should initialize delegationActivities structure when setting activities for the first time', () => {
        const activities = [
          createActivity('activity1', ActivityType.Delegation, 1000),
        ];

        const action = actions.cardanoContext.setDelegationActivities({
          accountId,
          rewardAccount,
          activities,
        });

        const state = reducers.cardanoContext(initialState, action);

        expect(state.delegationActivities).toBeDefined();
        expect(state.delegationActivities[accountId]).toBeDefined();
        expect(
          state.delegationActivities[accountId][rewardAccount],
        ).toBeDefined();
        expect(
          state.delegationActivities[accountId][rewardAccount],
        ).toHaveLength(1);
        expect(
          state.delegationActivities[accountId][rewardAccount][0].activityId,
        ).toBe('activity1');
      });

      it('should append new activities to existing ones', () => {
        const initialActivities = [
          createActivity('activity1', ActivityType.Delegation, 1000),
          createActivity('activity2', ActivityType.Registration, 2000),
        ];

        const firstState = reducers.cardanoContext(
          initialState,
          actions.cardanoContext.setDelegationActivities({
            accountId,
            rewardAccount,
            activities: initialActivities,
          }),
        );

        const newActivities = [
          createActivity('activity3', ActivityType.Withdrawal, 3000),
        ];

        const finalState = reducers.cardanoContext(
          firstState,
          actions.cardanoContext.setDelegationActivities({
            accountId,
            rewardAccount,
            activities: newActivities,
          }),
        );

        expect(
          finalState.delegationActivities[accountId][rewardAccount],
        ).toHaveLength(3);
        expect(
          finalState.delegationActivities[accountId][rewardAccount].map(
            a => a.activityId,
          ),
        ).toEqual(['activity3', 'activity2', 'activity1']);
      });

      it('should deduplicate activities by activityId and type', () => {
        const activities1 = [
          createActivity('activity1', ActivityType.Delegation, 1000),
          createActivity('activity2', ActivityType.Registration, 2000),
        ];

        const firstState = reducers.cardanoContext(
          initialState,
          actions.cardanoContext.setDelegationActivities({
            accountId,
            rewardAccount,
            activities: activities1,
          }),
        );

        // Add same activity again with different timestamp
        const activities2 = [
          createActivity('activity1', ActivityType.Delegation, 5000),
          createActivity('activity3', ActivityType.Withdrawal, 3000),
        ];

        const finalState = reducers.cardanoContext(
          firstState,
          actions.cardanoContext.setDelegationActivities({
            accountId,
            rewardAccount,
            activities: activities2,
          }),
        );

        // Should have 3 unique activities (activity1, activity2, activity3)
        // activity1 should be deduplicated, keeping the newer one
        expect(
          finalState.delegationActivities[accountId][rewardAccount],
        ).toHaveLength(3);
        const activityIds = finalState.delegationActivities[accountId][
          rewardAccount
        ].map(a => a.activityId);
        expect(activityIds).toContain('activity1');
        expect(activityIds).toContain('activity2');
        expect(activityIds).toContain('activity3');
      });

      it('should allow same activityId with different types', () => {
        const activities = [
          createActivity('activity1', ActivityType.Delegation, 1000),
          createActivity('activity1', ActivityType.Registration, 2000),
          createActivity('activity1', ActivityType.Withdrawal, 3000),
        ];

        const action = actions.cardanoContext.setDelegationActivities({
          accountId,
          rewardAccount,
          activities,
        });

        const state = reducers.cardanoContext(initialState, action);

        // All three should be present since they have different types
        expect(
          state.delegationActivities[accountId][rewardAccount],
        ).toHaveLength(3);
      });

      it('should sort activities by timestamp descending (newest first)', () => {
        const activities = [
          createActivity('activity1', ActivityType.Delegation, 1000),
          createActivity('activity2', ActivityType.Registration, 3000),
          createActivity('activity3', ActivityType.Withdrawal, 2000),
        ];

        const action = actions.cardanoContext.setDelegationActivities({
          accountId,
          rewardAccount,
          activities,
        });

        const state = reducers.cardanoContext(initialState, action);

        const timestamps = state.delegationActivities[accountId][
          rewardAccount
        ].map(a => a.timestamp);
        expect(timestamps).toEqual([3000, 2000, 1000]);
      });

      it('should handle multiple accounts independently', () => {
        const accountId2 = AccountId('test2');
        const activities1 = [
          createActivity('activity1', ActivityType.Delegation, 1000),
        ];
        const activities2 = [
          createActivity('activity2', ActivityType.Registration, 2000),
        ];

        const firstState = reducers.cardanoContext(
          initialState,
          actions.cardanoContext.setDelegationActivities({
            accountId,
            rewardAccount,
            activities: activities1,
          }),
        );

        const finalState = reducers.cardanoContext(
          firstState,
          actions.cardanoContext.setDelegationActivities({
            accountId: accountId2,
            rewardAccount,
            activities: activities2,
          }),
        );

        expect(
          finalState.delegationActivities[accountId][rewardAccount],
        ).toHaveLength(1);
        expect(
          finalState.delegationActivities[accountId][rewardAccount][0]
            .activityId,
        ).toBe('activity1');

        expect(
          finalState.delegationActivities[accountId2][rewardAccount],
        ).toHaveLength(1);
        expect(
          finalState.delegationActivities[accountId2][rewardAccount][0]
            .activityId,
        ).toBe('activity2');
      });

      it('should handle multiple reward accounts independently', () => {
        const activities1 = [
          createActivity('activity1', ActivityType.Delegation, 1000),
        ];
        const activities2 = [
          createActivity('activity2', ActivityType.Registration, 2000),
        ];

        const firstState = reducers.cardanoContext(
          initialState,
          actions.cardanoContext.setDelegationActivities({
            accountId,
            rewardAccount,
            activities: activities1,
          }),
        );

        const finalState = reducers.cardanoContext(
          firstState,
          actions.cardanoContext.setDelegationActivities({
            accountId,
            rewardAccount: rewardAccount2,
            activities: activities2,
          }),
        );

        expect(
          finalState.delegationActivities[accountId][rewardAccount],
        ).toHaveLength(1);
        expect(
          finalState.delegationActivities[accountId][rewardAccount][0]
            .activityId,
        ).toBe('activity1');

        expect(
          finalState.delegationActivities[accountId][rewardAccount2],
        ).toHaveLength(1);
        expect(
          finalState.delegationActivities[accountId][rewardAccount2][0]
            .activityId,
        ).toBe('activity2');
      });

      it('should handle empty activities array', () => {
        const action = actions.cardanoContext.setDelegationActivities({
          accountId,
          rewardAccount,
          activities: [],
        });

        const state = reducers.cardanoContext(initialState, action);

        expect(state.delegationActivities).toBeDefined();
        expect(state.delegationActivities[accountId]).toBeDefined();
        expect(
          state.delegationActivities[accountId][rewardAccount],
        ).toBeDefined();
        expect(
          state.delegationActivities[accountId][rewardAccount],
        ).toHaveLength(0);
      });
    });

    describe('clearAccountDelegationHistory', () => {
      const accountId = AccountId('test1');
      const rewardAccount = CardanoRewardAccount(
        'stake_test1uqrw9tjymlm8wrwq7jk68n6v7fs9qz8z0tkdkve26dylmfc2ux2hj',
      );
      const rewardAccount2 = CardanoRewardAccount(
        'stake_test1urpklgzqsh9yqz8pkyuxcw9dlszpe5flnxjtl55epla6ftqktdyfz',
      );

      const delegationEntry = {
        activeEpoch: Cardano.EpochNo(100),
        txHash: Cardano.TransactionId(
          '80be2d8820b8946037764fcba8177a3eb1cae94bf8993def14dda20cb89390c2',
        ),
        amount: BigNumber(BigInt(1000000)),
        poolId: Cardano.PoolId(
          'pool1h8yl5mkyrfmfls2x9fu9mls3ry6egnw4q6efg34xr37zc243gkf',
        ),
      };

      const createActivity = (
        activityId: string,
        type: ActivityType,
        timestamp: number,
      ): Activity => ({
        accountId,
        activityId,
        type,
        timestamp: Timestamp(timestamp),
        tokenBalanceChanges: [
          {
            tokenId: TokenId('lovelace'),
            amount: BigNumber(BigInt(1000000)),
          },
        ],
      });

      it('should clear account delegations history for a specific reward account', () => {
        const stateWithHistory = reducers.cardanoContext(
          initialState,
          actions.cardanoContext.setAccountDelegationsHistory({
            accountId,
            rewardAccount,
            items: [delegationEntry],
          }),
        );

        expect(
          stateWithHistory.accountDelegationsHistory[accountId][rewardAccount],
        ).toBeDefined();

        const clearedState = reducers.cardanoContext(
          stateWithHistory,
          actions.cardanoContext.clearAccountDelegationHistory({
            accountId,
            rewardAccount,
          }),
        );

        // Account entry should be removed since it's now empty
        expect(
          clearedState.accountDelegationsHistory[accountId],
        ).toBeUndefined();
      });

      it('should clear delegation activities for a specific reward account', () => {
        const activities = [
          createActivity('activity1', ActivityType.Delegation, 1000),
          createActivity('activity2', ActivityType.Registration, 2000),
        ];

        const stateWithActivities = reducers.cardanoContext(
          initialState,
          actions.cardanoContext.setDelegationActivities({
            accountId,
            rewardAccount,
            activities,
          }),
        );

        expect(
          stateWithActivities.delegationActivities[accountId][rewardAccount],
        ).toHaveLength(2);

        const clearedState = reducers.cardanoContext(
          stateWithActivities,
          actions.cardanoContext.clearAccountDelegationHistory({
            accountId,
            rewardAccount,
          }),
        );

        // Account entry should be removed since it's now empty
        expect(clearedState.delegationActivities[accountId]).toBeUndefined();
      });

      it('should clear both delegations history and activities in one action', () => {
        const stateWithData = reducers.cardanoContext(
          initialState,
          actions.cardanoContext.setAccountDelegationsHistory({
            accountId,
            rewardAccount,
            items: [delegationEntry],
          }),
        );

        const stateWithBoth = reducers.cardanoContext(
          stateWithData,
          actions.cardanoContext.setDelegationActivities({
            accountId,
            rewardAccount,
            activities: [
              createActivity('activity1', ActivityType.Delegation, 1000),
            ],
          }),
        );

        expect(
          stateWithBoth.accountDelegationsHistory[accountId][rewardAccount],
        ).toBeDefined();
        expect(
          stateWithBoth.delegationActivities[accountId][rewardAccount],
        ).toBeDefined();

        const clearedState = reducers.cardanoContext(
          stateWithBoth,
          actions.cardanoContext.clearAccountDelegationHistory({
            accountId,
            rewardAccount,
          }),
        );

        // Account entries should be removed since they're now empty
        expect(
          clearedState.accountDelegationsHistory[accountId],
        ).toBeUndefined();
        expect(clearedState.delegationActivities[accountId]).toBeUndefined();
      });

      it('should only clear the specified reward account, leaving others intact', () => {
        const stateWithMultiple = reducers.cardanoContext(
          initialState,
          actions.cardanoContext.setAccountDelegationsHistory({
            accountId,
            rewardAccount,
            items: [delegationEntry],
          }),
        );

        const stateWithBothAccounts = reducers.cardanoContext(
          stateWithMultiple,
          actions.cardanoContext.setAccountDelegationsHistory({
            accountId,
            rewardAccount: rewardAccount2,
            items: [delegationEntry],
          }),
        );

        expect(
          stateWithBothAccounts.accountDelegationsHistory[accountId][
            rewardAccount
          ],
        ).toBeDefined();
        expect(
          stateWithBothAccounts.accountDelegationsHistory[accountId][
            rewardAccount2
          ],
        ).toBeDefined();

        const clearedState = reducers.cardanoContext(
          stateWithBothAccounts,
          actions.cardanoContext.clearAccountDelegationHistory({
            accountId,
            rewardAccount,
          }),
        );

        // First reward account should be cleared
        expect(
          clearedState.accountDelegationsHistory[accountId][rewardAccount],
        ).toBeUndefined();
        // Second reward account should still exist
        expect(
          clearedState.accountDelegationsHistory[accountId][rewardAccount2],
        ).toBeDefined();
      });

      it('should clean up empty account entry when no reward accounts remain', () => {
        const stateWithHistory = reducers.cardanoContext(
          initialState,
          actions.cardanoContext.setAccountDelegationsHistory({
            accountId,
            rewardAccount,
            items: [delegationEntry],
          }),
        );

        expect(
          stateWithHistory.accountDelegationsHistory[accountId],
        ).toBeDefined();

        const clearedState = reducers.cardanoContext(
          stateWithHistory,
          actions.cardanoContext.clearAccountDelegationHistory({
            accountId,
            rewardAccount,
          }),
        );

        // Account entry should be removed since it's now empty
        expect(
          clearedState.accountDelegationsHistory[accountId],
        ).toBeUndefined();
      });

      it('should clean up empty account entry in delegation activities when no reward accounts remain', () => {
        const stateWithActivities = reducers.cardanoContext(
          initialState,
          actions.cardanoContext.setDelegationActivities({
            accountId,
            rewardAccount,
            activities: [
              createActivity('activity1', ActivityType.Delegation, 1000),
            ],
          }),
        );

        expect(
          stateWithActivities.delegationActivities[accountId],
        ).toBeDefined();

        const clearedState = reducers.cardanoContext(
          stateWithActivities,
          actions.cardanoContext.clearAccountDelegationHistory({
            accountId,
            rewardAccount,
          }),
        );

        // Account entry should be removed since it's now empty
        expect(clearedState.delegationActivities[accountId]).toBeUndefined();
      });

      it('should not remove account entry when other reward accounts still exist', () => {
        const stateWithMultiple = reducers.cardanoContext(
          initialState,
          actions.cardanoContext.setAccountDelegationsHistory({
            accountId,
            rewardAccount,
            items: [delegationEntry],
          }),
        );

        const stateWithBothAccounts = reducers.cardanoContext(
          stateWithMultiple,
          actions.cardanoContext.setAccountDelegationsHistory({
            accountId,
            rewardAccount: rewardAccount2,
            items: [delegationEntry],
          }),
        );

        const clearedState = reducers.cardanoContext(
          stateWithBothAccounts,
          actions.cardanoContext.clearAccountDelegationHistory({
            accountId,
            rewardAccount,
          }),
        );

        // Account entry should still exist because rewardAccount2 still has data
        expect(clearedState.accountDelegationsHistory[accountId]).toBeDefined();
        expect(
          clearedState.accountDelegationsHistory[accountId][rewardAccount2],
        ).toBeDefined();
      });

      it('should handle clearing non-existent reward account gracefully', () => {
        const action = actions.cardanoContext.clearAccountDelegationHistory({
          accountId,
          rewardAccount,
        });

        const state = reducers.cardanoContext(initialState, action);

        // Should not throw and state should remain unchanged
        expect(state.accountDelegationsHistory).toEqual({});
        expect(state.delegationActivities).toEqual({});
      });

      it('should handle clearing from non-existent account gracefully', () => {
        const nonExistentAccountId = AccountId('non-existent');
        const action = actions.cardanoContext.clearAccountDelegationHistory({
          accountId: nonExistentAccountId,
          rewardAccount,
        });

        const state = reducers.cardanoContext(initialState, action);

        // Should not throw and state should remain unchanged
        expect(state.accountDelegationsHistory).toEqual({});
        expect(state.delegationActivities).toEqual({});
      });

      it('should only affect the specified account, leaving other accounts intact', () => {
        const accountId2 = AccountId('test2');

        const stateWithMultipleAccounts = reducers.cardanoContext(
          initialState,
          actions.cardanoContext.setAccountDelegationsHistory({
            accountId,
            rewardAccount,
            items: [delegationEntry],
          }),
        );

        const stateWithBoth = reducers.cardanoContext(
          stateWithMultipleAccounts,
          actions.cardanoContext.setAccountDelegationsHistory({
            accountId: accountId2,
            rewardAccount,
            items: [delegationEntry],
          }),
        );

        const clearedState = reducers.cardanoContext(
          stateWithBoth,
          actions.cardanoContext.clearAccountDelegationHistory({
            accountId,
            rewardAccount,
          }),
        );

        // First account should be cleared
        expect(
          clearedState.accountDelegationsHistory[accountId],
        ).toBeUndefined();
        // Second account should still exist
        expect(
          clearedState.accountDelegationsHistory[accountId2],
        ).toBeDefined();
        expect(
          clearedState.accountDelegationsHistory[accountId2][rewardAccount],
        ).toBeDefined();
      });
    });

    describe('account address transaction history', () => {
      const exampleTxId =
        '80be2d8820b8946037764fcba8177a3eb1cae94bf8993def14dda20cb89390c2';
      const exampleHistoryItem: CardanoTransactionHistoryItem =
        createTransactionHistoryItem({
          id: exampleTxId,
          blockTime: Date.now(),
        });

      describe('setAccountTransactionHistory', () => {
        it('sets address transaction histories for accounts', () => {
          const firstState = reducers.cardanoContext(
            initialState,
            actions.cardanoContext.setAccountTransactionHistory({
              accountId: cardanoAccount1Addr.accountId,
              addressHistories: [
                {
                  address: CardanoPaymentAddress(cardanoAccount1Addr.address),
                  transactionHistory: [exampleHistoryItem],
                  hasLoadedOldestEntry: false,
                },
              ],
            }),
          );

          const finalState = reducers.cardanoContext(
            firstState,
            actions.cardanoContext.setAccountTransactionHistory({
              accountId: cardanoAccount2Addr2.accountId,
              addressHistories: [
                {
                  address: CardanoPaymentAddress(cardanoAccount2Addr1.address),
                  transactionHistory: [exampleHistoryItem],
                  hasLoadedOldestEntry: false,
                },
                {
                  address: CardanoPaymentAddress(cardanoAccount2Addr2.address),
                  transactionHistory: [exampleHistoryItem],
                  hasLoadedOldestEntry: true,
                },
              ],
            }),
          );
          expect(finalState.accountTransactionHistory).toStrictEqual({
            [cardanoAccount1Addr.accountId]: {
              [cardanoAccount1Addr.address]: {
                transactionHistory: [exampleHistoryItem],
                hasLoadedOldestEntry: false,
              },
            },
            [cardanoAccount2Addr2.accountId]: {
              [cardanoAccount2Addr1.address]: {
                transactionHistory: [exampleHistoryItem],
                hasLoadedOldestEntry: false,
              },
              [cardanoAccount2Addr2.address]: {
                transactionHistory: [exampleHistoryItem],
                hasLoadedOldestEntry: true,
              },
            },
          });
        });
      });

      describe('clearAccountTransactionHistory', () => {
        it('resets all address transaction histories for an account', () => {
          const state = reducers.cardanoContext(
            {
              ...initialState,
              accountTransactionHistory: {
                // this should be removed
                [cardanoAccount2Addr1.accountId]: {
                  [cardanoAccount2Addr1.address]: {
                    transactionHistory: [exampleHistoryItem],
                    hasLoadedOldestEntry: false,
                  },
                },
                // the one to keep
                [cardanoAccount1Addr.accountId]: {
                  [cardanoAccount1Addr.address]: {
                    transactionHistory: [exampleHistoryItem],
                    hasLoadedOldestEntry: false,
                  },
                },
              },
            },
            actions.cardanoContext.clearAccountTransactionHistory({
              accountId: cardanoAccount2Addr2.accountId,
            }),
          );
          expect(state.accountTransactionHistory).toStrictEqual({
            [cardanoAccount1Addr.accountId]: {
              [cardanoAccount1Addr.address]: {
                transactionHistory: [exampleHistoryItem],
                hasLoadedOldestEntry: false,
              },
            },
          });
        });
      });

      describe('clearAllTransactionHistories', () => {
        it('resets transaction histories for all accounts', () => {
          const state = reducers.cardanoContext(
            {
              ...initialState,
              accountTransactionHistory: {
                [cardanoAccount1Addr.accountId]: {
                  [cardanoAccount1Addr.address]: {
                    transactionHistory: [exampleHistoryItem],
                    hasLoadedOldestEntry: false,
                  },
                },
                [cardanoAccount2Addr2.accountId]: {
                  [cardanoAccount2Addr1.address]: {
                    transactionHistory: [exampleHistoryItem],
                    hasLoadedOldestEntry: false,
                  },
                  [cardanoAccount2Addr2.address]: {
                    transactionHistory: [exampleHistoryItem],
                    hasLoadedOldestEntry: false,
                  },
                },
              },
            },
            actions.cardanoContext.clearAllTransactionHistories(),
          );
          expect(state.accountTransactionHistory).toStrictEqual(
            initialState.accountTransactionHistory,
          );
        });
      });
    });
  });

  describe('in-flight transactions', () => {
    const txId = Cardano.TransactionId('ab'.repeat(32));
    const otherTxId = Cardano.TransactionId('cd'.repeat(32));
    const spentInput = {
      txId: Cardano.TransactionId('ef'.repeat(32)),
      index: 0,
    };
    const preprodKey: InFlightTransactionKey = `${testNetwork}:${txId}`;
    const previewKey: InFlightTransactionKey = `${CardanoNetworkId(
      Cardano.NetworkMagics.Preview,
    )}:${txId}`;
    const accountId = AccountId('in-flight-account');

    const withTip = (network: CardanoNetworkId, slot: number) =>
      reducers.cardanoContext(
        initialState,
        actions.cardanoContext.setTip({
          network,
          tip: {
            slot: Cardano.Slot(slot),
            blockNo: Cardano.BlockNo(1),
            hash: Cardano.BlockId('12'.repeat(32)),
          },
        }),
      );

    const selectInFlight = (cardanoContext: CardanoContextSliceState) =>
      selectors.cardanoContext.selectInFlightTransactions({
        cardanoContext,
      } as unknown as Parameters<typeof selectors.cardanoContext.selectInFlightTransactions>[0]);

    describe('recordInFlightTransaction', () => {
      it('stores the transaction under its network and transaction id', () => {
        const state = recordInFlight(initialState, {
          txId,
          consumedInputs: [spentInput],
          invalidHereafter: Cardano.Slot(500),
          submittedAt: Timestamp(42),
        });

        expect(Object.keys(state.inFlightTransactions)).toEqual([preprodKey]);
        expect(selectInFlight(state)).toEqual({
          [preprodKey]: {
            chainId: Cardano.ChainIds.Preprod,
            txId,
            effects: { consumedInputs: [spentInput], producedOutputs: [] },
            invalidHereafter: Cardano.Slot(500),
            submittedAt: Timestamp(42),
          },
        });
      });

      it('keeps the first entry of a transaction: a repeated record never extends its bound or moves its time', () => {
        const first = recordInFlight(initialState, {
          txId,
          invalidHereafter: Cardano.Slot(500),
          submittedAt: Timestamp(1),
        });
        const second = recordInFlight(first, {
          txId,
          consumedInputs: [spentInput],
          invalidHereafter: Cardano.Slot(900),
          submittedAt: Timestamp(2),
        });

        expect(second).toBe(first);
      });

      it('records a body that sets no upper bound without one, whatever tip is stored', () => {
        const state = recordInFlight(withTip(testNetwork, 1_000), { txId });

        expect(state.inFlightTransactions[preprodKey]).toBeDefined();
        expect(state.inFlightTransactions[preprodKey]).not.toHaveProperty(
          'invalidHereafter',
        );
      });

      it('keeps the same transaction on two networks apart (ADR 11)', () => {
        const both = recordInFlight(recordInFlight(initialState, { txId }), {
          txId,
          chainId: Cardano.ChainIds.Preview,
          consumedInputs: [spentInput],
        });

        expect(Object.keys(both.inFlightTransactions).sort()).toEqual(
          [preprodKey, previewKey].sort(),
        );
        expect(
          selectInFlight(both)[previewKey]?.effects.consumedInputs,
        ).toEqual([spentInput]);
        expect(
          selectInFlight(both)[preprodKey]?.effects.consumedInputs,
        ).toEqual([]);
      });
    });

    describe('setTip', () => {
      const tipAt = (slot: number): Cardano.Tip => ({
        slot: Cardano.Slot(slot),
        blockNo: Cardano.BlockNo(slot),
        hash: Cardano.BlockId(slot.toString(16).padStart(64, '0')),
      });
      const setTip = (
        state: CardanoContextSliceState,
        slot: number,
        network = testNetwork,
      ) =>
        reducers.cardanoContext(
          state,
          actions.cardanoContext.setTip({ network, tip: tipAt(slot) }),
        );

      it("gives an entry without a bound the cut-off from its network's next tip", () => {
        const state = setTip(
          recordInFlight(withTip(testNetwork, 1_000), { txId }),
          1_020,
        );

        expect(state.inFlightTransactions[preprodKey]?.invalidHereafter).toBe(
          1_020 + UNBOUNDED_IN_FLIGHT_SLOTS,
        );
      });

      it('never moves a cut-off once set', () => {
        const state = setTip(
          setTip(recordInFlight(initialState, { txId }), 1_020),
          1_040,
        );

        expect(state.inFlightTransactions[preprodKey]?.invalidHereafter).toBe(
          1_020 + UNBOUNDED_IN_FLIGHT_SLOTS,
        );
      });

      it("keeps the body's upper bound", () => {
        const state = setTip(
          recordInFlight(initialState, {
            txId,
            invalidHereafter: Cardano.Slot(1_200),
          }),
          1_020,
        );

        expect(state.inFlightTransactions[preprodKey]?.invalidHereafter).toBe(
          1_200,
        );
      });

      it('leaves the entries of another network without a bound', () => {
        const state = setTip(
          recordInFlight(initialState, { txId }),
          1_020,
          CardanoNetworkId(Cardano.NetworkMagics.Preview),
        );

        expect(state.inFlightTransactions[preprodKey]).not.toHaveProperty(
          'invalidHereafter',
        );
      });
    });

    describe('removeInFlightTransactions', () => {
      it('removes the named entries only', () => {
        const recorded = recordInFlight(
          recordInFlight(recordInFlight(initialState, { txId }), {
            txId,
            chainId: Cardano.ChainIds.Preview,
          }),
          { txId: otherTxId },
        );

        const state = reducers.cardanoContext(
          recorded,
          actions.cardanoContext.removeInFlightTransactions({
            keys: [preprodKey],
          }),
        );

        expect(Object.keys(state.inFlightTransactions).sort()).toEqual(
          [previewKey, `${testNetwork}:${otherTxId}`].sort(),
        );
      });
    });

    describe('recordInFlightTransactionLookup', () => {
      const lookup = {
        tipSlot: Cardano.Slot(1_200),
        inclusion: {
          blockHash: Cardano.BlockId('12'.repeat(32)),
          blockHeight: Cardano.BlockNo(7),
          slot: Cardano.Slot(480),
          txIndex: Cardano.TxIndex(2),
          isValid: true,
        },
      };
      const recordLookup = (
        state: CardanoContextSliceState,
        key: InFlightTransactionKey,
      ) =>
        reducers.cardanoContext(
          state,
          actions.cardanoContext.recordInFlightTransactionLookup({
            key,
            lookup,
          }),
        );

      it('records the answer on the entry and changes nothing else', () => {
        const recorded = recordInFlight(
          recordInFlight(initialState, {
            txId,
            consumedInputs: [spentInput],
            invalidHereafter: Cardano.Slot(500),
            submittedAt: Timestamp(42),
          }),
          { txId, chainId: Cardano.ChainIds.Preview },
        );

        const state = recordLookup(recorded, preprodKey);

        expect(state.inFlightTransactions[preprodKey]).toEqual({
          ...recorded.inFlightTransactions[preprodKey],
          lookup,
        });
        expect(state.inFlightTransactions[previewKey]).toBe(
          recorded.inFlightTransactions[previewKey],
        );
        expect(selectInFlight(state)[preprodKey]?.lookup).toEqual(lookup);
      });

      it('records nothing for a key the store holds no entry for', () => {
        const recorded = recordInFlight(initialState, { txId });

        expect(recordLookup(recorded, previewKey)).toBe(recorded);
      });

      it('keeps the answer through what a restart reads back from storage', () => {
        const state = recordLookup(
          recordInFlight(initialState, {
            txId,
            invalidHereafter: Cardano.Slot(500),
          }),
          preprodKey,
        );
        const restored = JSON.parse(
          JSON.stringify(state),
        ) as CardanoContextSliceState;

        expect(selectInFlight(restored)[preprodKey]?.lookup).toEqual(lookup);
      });
    });

    it.each([
      [
        'removeAccount',
        walletsActions.wallets.removeAccount(WalletId('wallet'), accountId),
      ],
      [
        'removeWallet',
        walletsActions.wallets.removeWallet(WalletId('wallet'), [accountId]),
      ],
      [
        'resetWalletSyncState',
        actions.cardanoContext.resetWalletSyncState({ accountId }),
      ],
    ])('keeps every entry on %s: an entry names no account', (_, action) => {
      const recorded = recordInFlight(initialState, { txId });

      expect(
        reducers.cardanoContext(recorded, action).inFlightTransactions,
      ).toBe(recorded.inFlightTransactions);
    });

    describe('selectInFlightTransactions', () => {
      it('returns one stable empty object while nothing is in flight', () => {
        const first = selectInFlight(initialState);

        expect(first).toEqual({});
        expect(
          selectInFlight({ ...initialState, inFlightTransactions: {} }),
        ).toBe(first);
      });

      it('decodes the effects as persisted, values and assets included', () => {
        const assetId = Cardano.AssetId(
          'b0d07d45fe9514f80213f4020e5a61241458be626841cde717cb38a76e75746f6b656e31',
        );
        const output: Cardano.Utxo = [
          {
            txId,
            index: 0,
            address: Cardano.PaymentAddress(cardanoAccount1Addr.address),
          },
          {
            address: Cardano.PaymentAddress(cardanoAccount1Addr.address),
            value: {
              coins: 9_007_199_254_740_993n,
              assets: new Map([[assetId, 5n]]),
            },
          },
        ];
        const recorded = recordInFlight(initialState, {
          txId,
          producedOutputs: [output],
        });
        // What a restart reads back from storage.
        const restored = JSON.parse(
          JSON.stringify(recorded),
        ) as CardanoContextSliceState;

        expect(
          selectInFlight(restored)[preprodKey]?.effects.producedOutputs,
        ).toEqual([output]);
      });

      it('keeps the decoded entry of an unchanged transaction across emissions', () => {
        const one = recordInFlight(initialState, { txId });
        const first = selectInFlight(one)[preprodKey];
        const two = recordInFlight(one, { txId: otherTxId });
        const second = selectInFlight(two);

        expect(Object.keys(second)).toHaveLength(2);
        expect(second[preprodKey]).toBe(first);
      });
    });
  });

  describe('reducers (UTxOs)', () => {
    const cacheKey1 = UtxoCacheKey({
      topOnChainActivityId: 'tx-abc',
      stakeKeys: [],
      accountAddressCount: 0,
    });
    const cacheKey2 = UtxoCacheKey({
      topOnChainActivityId: 'tx-def',
      stakeKeys: [],
      accountAddressCount: 0,
    });
    const cacheKey3 = UtxoCacheKey({
      topOnChainActivityId: 'tx-ghi',
      stakeKeys: [],
      accountAddressCount: 0,
    });

    it('setAccountUtxos sets utxos per account', () => {
      const accountId1 = AccountId('acc1');
      const accountId2 = AccountId('acc2');

      const state1 = reducers.cardanoContext(
        initialState,
        actions.cardanoContext.setAccountUtxos({
          accountId: accountId1,
          utxos: [utxo1],
        }),
      );
      const state2 = reducers.cardanoContext(
        state1,
        actions.cardanoContext.setAccountUtxos({
          accountId: accountId2,
          utxos: [utxo2],
        }),
      );

      const result = selectors.cardanoContext.selectAccountUtxos({
        cardanoContext: state2,
      });

      expect(result).toEqual({
        [accountId1]: [utxo1],
        [accountId2]: [utxo2],
      });
    });

    // The only writer that can empty a live account's set — every other one
    // deletes the account's entry outright. A "don't clobber the balance with
    // an empty set" guard here would reinstate LW-15291 under the sync fix.
    it('setAccountUtxos sets empty array to clear utxos for an account', () => {
      const accountId = AccountId('acc1');

      const state1 = reducers.cardanoContext(
        initialState,
        actions.cardanoContext.setAccountUtxos({
          accountId,
          utxos: [utxo1, utxo2],
        }),
      );
      const state2 = reducers.cardanoContext(
        state1,
        actions.cardanoContext.setAccountUtxos({
          accountId,
          utxos: [],
        }),
      );

      const result = selectors.cardanoContext.selectAccountUtxos({
        cardanoContext: state2,
      });

      expect(result).toEqual({
        [accountId]: [],
      });
    });

    describe('setLastFetchedUtxoCacheKey', () => {
      it('preserves previously persisted utxos when only the cacheKey is advanced', () => {
        const accountId = AccountId('acc1');
        const state1 = reducers.cardanoContext(
          initialState,
          actions.cardanoContext.setAccountUtxos({
            accountId,
            utxos: [utxo1],
          }),
        );
        const state2 = reducers.cardanoContext(
          state1,
          actions.cardanoContext.setLastFetchedUtxoCacheKey({
            accountId,
            cacheKey: cacheKey1,
          }),
        );

        expect(
          selectors.cardanoContext.selectAccountUtxos({
            cardanoContext: state2,
          }),
        ).toEqual({ [accountId]: [utxo1] });
        expect(
          selectors.cardanoContext.selectLastFetchedUtxoCacheKeyByAccount({
            cardanoContext: state2,
          }),
        ).toEqual({ [accountId]: cacheKey1 });
      });

      it('setAccountUtxos preserves the previously persisted cacheKey', () => {
        const accountId = AccountId('acc1');
        const state1 = reducers.cardanoContext(
          initialState,
          actions.cardanoContext.setAccountUtxos({
            accountId,
            utxos: [utxo1],
          }),
        );
        const state2 = reducers.cardanoContext(
          state1,
          actions.cardanoContext.setLastFetchedUtxoCacheKey({
            accountId,
            cacheKey: cacheKey1,
          }),
        );
        const state3 = reducers.cardanoContext(
          state2,
          actions.cardanoContext.setAccountUtxos({
            accountId,
            utxos: [utxo2],
          }),
        );

        expect(
          selectors.cardanoContext.selectAccountUtxos({
            cardanoContext: state3,
          }),
        ).toEqual({ [accountId]: [utxo2] });
        expect(
          selectors.cardanoContext.selectLastFetchedUtxoCacheKeyByAccount({
            cardanoContext: state3,
          }),
        ).toEqual({ [accountId]: cacheKey1 });
      });

      it('overwrites a previously advanced cacheKey', () => {
        const accountId = AccountId('acc1');
        let state = reducers.cardanoContext(
          initialState,
          actions.cardanoContext.setAccountUtxos({
            accountId,
            utxos: [utxo1],
          }),
        );
        state = reducers.cardanoContext(
          state,
          actions.cardanoContext.setLastFetchedUtxoCacheKey({
            accountId,
            cacheKey: cacheKey1,
          }),
        );
        state = reducers.cardanoContext(
          state,
          actions.cardanoContext.setLastFetchedUtxoCacheKey({
            accountId,
            cacheKey: cacheKey2,
          }),
        );

        expect(
          selectors.cardanoContext.selectLastFetchedUtxoCacheKeyByAccount({
            cardanoContext: state,
          }),
        ).toEqual({ [accountId]: cacheKey2 });
      });

      it('removeAccount clears the account entry', () => {
        const accountId = AccountId('acc-rm');
        const walletId = WalletId('wallet1');

        let state = reducers.cardanoContext(
          initialState,
          actions.cardanoContext.setAccountUtxos({
            accountId,
            utxos: [utxo1],
          }),
        );
        state = reducers.cardanoContext(
          state,
          actions.cardanoContext.setLastFetchedUtxoCacheKey({
            accountId,
            cacheKey: cacheKey1,
          }),
        );

        const afterRemove = reducers.cardanoContext(
          state,
          walletsActions.wallets.removeAccount(walletId, accountId),
        );

        expect(
          selectors.cardanoContext.selectLastFetchedUtxoCacheKeyByAccount({
            cardanoContext: afterRemove,
          }),
        ).toEqual({});
        expect(
          selectors.cardanoContext.selectAccountUtxos({
            cardanoContext: afterRemove,
          }),
        ).toEqual({});
      });

      it('removeWallet clears entries for all wallet accounts', () => {
        const walletId = WalletId('wallet1');
        const accountId1 = AccountId('acc1');
        const accountId2 = AccountId('acc2');
        const accountId3 = AccountId('acc3');

        let state = initialState;
        for (const [id, utxo, key] of [
          [accountId1, utxo1, cacheKey1],
          [accountId2, utxo2, cacheKey2],
          [accountId3, utxo1, cacheKey3],
        ] as const) {
          state = reducers.cardanoContext(
            state,
            actions.cardanoContext.setAccountUtxos({
              accountId: id,
              utxos: [utxo],
            }),
          );
          state = reducers.cardanoContext(
            state,
            actions.cardanoContext.setLastFetchedUtxoCacheKey({
              accountId: id,
              cacheKey: key,
            }),
          );
        }

        const afterRemove = reducers.cardanoContext(
          state,
          walletsActions.wallets.removeWallet(walletId, [
            accountId1,
            accountId2,
          ]),
        );

        expect(
          selectors.cardanoContext.selectLastFetchedUtxoCacheKeyByAccount({
            cardanoContext: afterRemove,
          }),
        ).toEqual({ [accountId3]: cacheKey3 });
      });
    });

    describe('setLastFetchedRewardAccountDetailsCacheKey', () => {
      const stakeKey = CardanoRewardAccount(
        'stake_test1urpklgzqsh9yqz8pkyuxcw9dlszpe5flnxjtl55epla6ftqktdyfz',
      );
      const cacheKey1 = RewardAccountDetailsCacheKey({
        topNonPendingActivityId: 'tx-abc',
        topOnChainTxActivityId: 'tx-abc',
        stakeKey,
      });
      const cacheKey2 = RewardAccountDetailsCacheKey({
        topNonPendingActivityId: 'tx-def',
        topOnChainTxActivityId: 'tx-def',
        stakeKey,
      });

      it('writes a cacheKey for the given account', () => {
        const accountId = AccountId('acc1');

        const state = reducers.cardanoContext(
          initialState,
          actions.cardanoContext.setLastFetchedRewardAccountDetailsCacheKey({
            accountId,
            cacheKey: cacheKey1,
          }),
        );

        expect(
          selectors.cardanoContext.selectLastFetchedRewardAccountDetailsCacheKeyByAccount(
            { cardanoContext: state },
          ),
        ).toEqual({ [accountId]: cacheKey1 });
      });

      it('overwrites a previously advanced cacheKey', () => {
        const accountId = AccountId('acc1');
        let state = reducers.cardanoContext(
          initialState,
          actions.cardanoContext.setLastFetchedRewardAccountDetailsCacheKey({
            accountId,
            cacheKey: cacheKey1,
          }),
        );
        state = reducers.cardanoContext(
          state,
          actions.cardanoContext.setLastFetchedRewardAccountDetailsCacheKey({
            accountId,
            cacheKey: cacheKey2,
          }),
        );

        expect(
          selectors.cardanoContext.selectLastFetchedRewardAccountDetailsCacheKeyByAccount(
            { cardanoContext: state },
          ),
        ).toEqual({ [accountId]: cacheKey2 });
      });

      it('removeAccount clears the account entry', () => {
        const accountId = AccountId('acc-rm');
        const walletId = WalletId('wallet1');

        const state = reducers.cardanoContext(
          initialState,
          actions.cardanoContext.setLastFetchedRewardAccountDetailsCacheKey({
            accountId,
            cacheKey: cacheKey1,
          }),
        );

        const afterRemove = reducers.cardanoContext(
          state,
          walletsActions.wallets.removeAccount(walletId, accountId),
        );

        expect(
          selectors.cardanoContext.selectLastFetchedRewardAccountDetailsCacheKeyByAccount(
            { cardanoContext: afterRemove },
          ),
        ).toEqual({});
      });

      it('removeWallet clears entries for all wallet accounts', () => {
        const walletId = WalletId('wallet1');
        const accountId1 = AccountId('acc1');
        const accountId2 = AccountId('acc2');
        const accountId3 = AccountId('acc3');

        let state = initialState;
        for (const [id, key] of [
          [accountId1, cacheKey1],
          [accountId2, cacheKey2],
          [accountId3, cacheKey1],
        ] as const) {
          state = reducers.cardanoContext(
            state,
            actions.cardanoContext.setLastFetchedRewardAccountDetailsCacheKey({
              accountId: id,
              cacheKey: key,
            }),
          );
        }

        const afterRemove = reducers.cardanoContext(
          state,
          walletsActions.wallets.removeWallet(walletId, [
            accountId1,
            accountId2,
          ]),
        );

        expect(
          selectors.cardanoContext.selectLastFetchedRewardAccountDetailsCacheKeyByAccount(
            { cardanoContext: afterRemove },
          ),
        ).toEqual({ [accountId3]: cacheKey1 });
      });
    });

    describe('setAccountUnspendableUtxos', () => {
      it('sets unspendable utxos per account', () => {
        const accountId1 = AccountId('acc1');
        const accountId2 = AccountId('acc2');

        const state1 = reducers.cardanoContext(
          initialState,
          actions.cardanoContext.setAccountUnspendableUtxos({
            accountId: accountId1,
            utxos: [utxo1],
          }),
        );
        const state2 = reducers.cardanoContext(
          state1,
          actions.cardanoContext.setAccountUnspendableUtxos({
            accountId: accountId2,
            utxos: [utxo2],
          }),
        );

        const result = selectors.cardanoContext.selectAccountUnspendableUtxos({
          cardanoContext: state2,
        });

        expect(result).toEqual({
          [accountId1]: [utxo1],
          [accountId2]: [utxo2],
        });
      });

      it('replaces existing unspendable utxos for the same account', () => {
        const accountId = AccountId('acc1');

        const state1 = reducers.cardanoContext(
          initialState,
          actions.cardanoContext.setAccountUnspendableUtxos({
            accountId,
            utxos: [utxo1],
          }),
        );
        const state2 = reducers.cardanoContext(
          state1,
          actions.cardanoContext.setAccountUnspendableUtxos({
            accountId,
            utxos: [utxo2],
          }),
        );

        const result = selectors.cardanoContext.selectAccountUnspendableUtxos({
          cardanoContext: state2,
        });

        expect(result).toEqual({
          [accountId]: [utxo2],
        });
      });

      it('sets empty array to clear unspendable utxos for an account', () => {
        const accountId = AccountId('acc1');

        const state1 = reducers.cardanoContext(
          initialState,
          actions.cardanoContext.setAccountUnspendableUtxos({
            accountId,
            utxos: [utxo1, utxo2],
          }),
        );
        const state2 = reducers.cardanoContext(
          state1,
          actions.cardanoContext.setAccountUnspendableUtxos({
            accountId,
            utxos: [],
          }),
        );

        const result = selectors.cardanoContext.selectAccountUnspendableUtxos({
          cardanoContext: state2,
        });

        expect(result).toEqual({
          [accountId]: [],
        });
      });

      it('preserves unspendable utxos for other accounts when updating one', () => {
        const accountId1 = AccountId('acc1');
        const accountId2 = AccountId('acc2');

        const state1 = reducers.cardanoContext(
          initialState,
          actions.cardanoContext.setAccountUnspendableUtxos({
            accountId: accountId1,
            utxos: [utxo1],
          }),
        );
        const state2 = reducers.cardanoContext(
          state1,
          actions.cardanoContext.setAccountUnspendableUtxos({
            accountId: accountId2,
            utxos: [utxo2],
          }),
        );
        const state3 = reducers.cardanoContext(
          state2,
          actions.cardanoContext.setAccountUnspendableUtxos({
            accountId: accountId1,
            utxos: [utxo1, utxo2],
          }),
        );

        const result = selectors.cardanoContext.selectAccountUnspendableUtxos({
          cardanoContext: state3,
        });

        expect(result).toEqual({
          [accountId1]: [utxo1, utxo2],
          [accountId2]: [utxo2],
        });
      });
    });
  });

  describe('extraReducers', () => {
    describe('removeAccount', () => {
      it('should remove all the cardano context data for the account', () => {
        const accountId = AccountId('accountid1');
        const accountId2 = AccountId('accountid2');
        const walletId = WalletId('wallet1');
        const rewardAccount = CardanoRewardAccount(
          'stake_test1uqrw9tjymlm8wrwq7jk68n6v7fs9qz8z0tkdkve26dylmfc2ux2hj',
        );

        const state = {
          ...initialState,
          accountTransactionHistory: {
            [accountId]: {
              [cardanoAccount1Addr.address]: {
                transactionHistory: [],
                hasLoadedOldestEntry: false,
              },
            },
            [accountId2]: {
              [cardanoAccount2Addr1.address]: {
                transactionHistory: [],
                hasLoadedOldestEntry: false,
              },
            },
          },
          accountRewardsHistory: {
            [accountId]: [],
            [accountId2]: [],
          },
          accountUtxos: {
            [accountId]: {
              utxos: Serializable.to<Cardano.Utxo[]>([]),
              cacheKey: UtxoCacheKey({
                topOnChainActivityId: 'tx-a',
                stakeKeys: [],
                accountAddressCount: 0,
              }),
            },
            [accountId2]: {
              utxos: Serializable.to<Cardano.Utxo[]>([]),
              cacheKey: UtxoCacheKey({
                topOnChainActivityId: 'tx-b',
                stakeKeys: [],
                accountAddressCount: 0,
              }),
            },
          },
          accountUnspendableUtxos: {
            [accountId]: Serializable.to<Cardano.Utxo[]>([utxo1]),
            [accountId2]: Serializable.to<Cardano.Utxo[]>([utxo2]),
          },
          accountDelegationsHistory: {
            [accountId]: {
              [rewardAccount]: {
                delegations: { entries: [], hasLoadedOldest: false },
                registrations: { entries: [], hasLoadedOldest: false },
                withdrawals: { entries: [], hasLoadedOldest: false },
              },
            },
            [accountId2]: {
              [rewardAccount]: {
                delegations: { entries: [], hasLoadedOldest: false },
                registrations: { entries: [], hasLoadedOldest: false },
                withdrawals: { entries: [], hasLoadedOldest: false },
              },
            },
          },
          delegationActivities: {
            [accountId]: {
              [rewardAccount]: [
                {
                  accountId,
                  activityId: 'activity1',
                  type: ActivityType.Delegation,
                  timestamp: Timestamp(1000),
                  tokenBalanceChanges: [],
                },
              ],
            },
            [accountId2]: {
              [rewardAccount]: [
                {
                  accountId: accountId2,
                  activityId: 'activity2',
                  type: ActivityType.Registration,
                  timestamp: Timestamp(2000),
                  tokenBalanceChanges: [],
                },
              ],
            },
          },
        } as unknown as CardanoContextSliceState;

        const newState = reducers.cardanoContext(
          state,
          walletsActions.wallets.removeAccount(walletId, accountId),
        );
        expect(
          selectors.cardanoContext.selectAccountUtxos({
            cardanoContext: newState,
          }),
        ).toEqual({
          [accountId2]: [],
        });
        expect(
          selectors.cardanoContext.selectAccountUnspendableUtxos({
            cardanoContext: newState,
          }),
        ).toEqual({
          [accountId2]: [utxo2],
        });
        expect(newState.accountTransactionHistory).toEqual({
          [accountId2]: {
            [cardanoAccount2Addr1.address]: {
              transactionHistory: [],
              hasLoadedOldestEntry: false,
            },
          },
        });
        expect(newState.accountRewardsHistory).toEqual({
          [accountId2]: [],
        });
        expect(newState.accountDelegationsHistory).toEqual({
          [accountId2]: {
            [rewardAccount]: {
              delegations: { entries: [], hasLoadedOldest: false },
              registrations: { entries: [], hasLoadedOldest: false },
              withdrawals: { entries: [], hasLoadedOldest: false },
            },
          },
        });
        expect(newState.delegationActivities).toEqual({
          [accountId2]: {
            [rewardAccount]: [
              {
                accountId: accountId2,
                activityId: 'activity2',
                type: ActivityType.Registration,
                timestamp: Timestamp(2000),
                tokenBalanceChanges: [],
              },
            ],
          },
        });
      });
    });

    describe('removeWallet', () => {
      it('should remove all the cardano context data for all accounts in the wallet', () => {
        const accountId = AccountId('accountid1');
        const accountId2 = AccountId('accountid2');
        const accountId3 = AccountId('accountid3');
        const walletId = WalletId('wallet1');
        const rewardAccount = CardanoRewardAccount(
          'stake_test1uqrw9tjymlm8wrwq7jk68n6v7fs9qz8z0tkdkve26dylmfc2ux2hj',
        );

        const state = {
          ...initialState,
          accountTransactionHistory: {
            [accountId]: {
              [cardanoAccount1Addr.address]: {
                transactionHistory: [],
                hasLoadedOldestEntry: false,
              },
            },
            [accountId2]: {
              [cardanoAccount2Addr1.address]: {
                transactionHistory: [],
                hasLoadedOldestEntry: false,
              },
            },
            [accountId3]: {
              [cardanoAccount1Addr.address]: {
                transactionHistory: [],
                hasLoadedOldestEntry: false,
              },
            },
          },
          accountRewardsHistory: {
            [accountId]: [],
            [accountId2]: [],
            [accountId3]: [],
          },
          accountUtxos: {
            [accountId]: {
              utxos: Serializable.to<Cardano.Utxo[]>([]),
              cacheKey: UtxoCacheKey({
                topOnChainActivityId: 'tx-a',
                stakeKeys: [],
                accountAddressCount: 0,
              }),
            },
            [accountId2]: {
              utxos: Serializable.to<Cardano.Utxo[]>([]),
              cacheKey: UtxoCacheKey({
                topOnChainActivityId: 'tx-b',
                stakeKeys: [],
                accountAddressCount: 0,
              }),
            },
            [accountId3]: {
              utxos: Serializable.to<Cardano.Utxo[]>([]),
              cacheKey: UtxoCacheKey({
                topOnChainActivityId: 'tx-c',
                stakeKeys: [],
                accountAddressCount: 0,
              }),
            },
          },
          accountDelegationsHistory: {
            [accountId]: {
              [rewardAccount]: {
                delegations: { entries: [], hasLoadedOldest: false },
                registrations: { entries: [], hasLoadedOldest: false },
                withdrawals: { entries: [], hasLoadedOldest: false },
              },
            },
            [accountId2]: {
              [rewardAccount]: {
                delegations: { entries: [], hasLoadedOldest: false },
                registrations: { entries: [], hasLoadedOldest: false },
                withdrawals: { entries: [], hasLoadedOldest: false },
              },
            },
            [accountId3]: {
              [rewardAccount]: {
                delegations: { entries: [], hasLoadedOldest: false },
                registrations: { entries: [], hasLoadedOldest: false },
                withdrawals: { entries: [], hasLoadedOldest: false },
              },
            },
          },
          delegationActivities: {
            [accountId]: {
              [rewardAccount]: [
                {
                  accountId,
                  activityId: 'activity1',
                  type: ActivityType.Delegation,
                  timestamp: Timestamp(1000),
                  tokenBalanceChanges: [],
                },
              ],
            },
            [accountId2]: {
              [rewardAccount]: [
                {
                  accountId: accountId2,
                  activityId: 'activity2',
                  type: ActivityType.Registration,
                  timestamp: Timestamp(2000),
                  tokenBalanceChanges: [],
                },
              ],
            },
            [accountId3]: {
              [rewardAccount]: [
                {
                  accountId: accountId3,
                  activityId: 'activity3',
                  type: ActivityType.Withdrawal,
                  timestamp: Timestamp(3000),
                  tokenBalanceChanges: [],
                },
              ],
            },
          },
        } as unknown as CardanoContextSliceState;

        const newState = reducers.cardanoContext(
          state,
          walletsActions.wallets.removeWallet(walletId, [
            accountId,
            accountId2,
          ]),
        );

        // accountId and accountId2 should be removed, accountId3 should remain
        expect(
          selectors.cardanoContext.selectAccountUtxos({
            cardanoContext: newState,
          }),
        ).toEqual({
          [accountId3]: [],
        });
        expect(newState.accountTransactionHistory).toEqual({
          [accountId3]: {
            [cardanoAccount1Addr.address]: {
              transactionHistory: [],
              hasLoadedOldestEntry: false,
            },
          },
        });
        expect(newState.accountRewardsHistory).toEqual({
          [accountId3]: [],
        });
        expect(newState.accountDelegationsHistory).toEqual({
          [accountId3]: {
            [rewardAccount]: {
              delegations: { entries: [], hasLoadedOldest: false },
              registrations: { entries: [], hasLoadedOldest: false },
              withdrawals: { entries: [], hasLoadedOldest: false },
            },
          },
        });
        expect(newState.delegationActivities).toEqual({
          [accountId3]: {
            [rewardAccount]: [
              {
                accountId: accountId3,
                activityId: 'activity3',
                type: ActivityType.Withdrawal,
                timestamp: Timestamp(3000),
                tokenBalanceChanges: [],
              },
            ],
          },
        });
      });
    });

    describe('removeWallet', () => {
      it('should remove account-level unspendable utxos when wallet is removed', () => {
        const walletId1 = WalletId('wallet1');
        const accountId1 = AccountId('wallet1-0-1');
        const accountId2 = AccountId('wallet1-1-1');
        const accountId3 = AccountId('wallet2-0-1');

        const state = {
          ...initialState,
          accountUtxos: {
            [accountId1]: [utxo1],
            [accountId2]: [utxo2],
            [accountId3]: [utxo1],
          },
          accountUnspendableUtxos: {
            [accountId1]: [utxo1],
            [accountId2]: [utxo2],
            [accountId3]: [utxo1],
          },
        } as unknown as CardanoContextSliceState;

        const newState = reducers.cardanoContext(
          state,
          walletsActions.wallets.removeWallet(walletId1, [
            accountId1,
            accountId2,
          ]),
        );

        expect(
          selectors.cardanoContext.selectAccountUnspendableUtxos({
            cardanoContext: newState,
          }),
        ).toEqual({
          [accountId3]: [utxo1],
        });
      });

      it('should remove all account data and account unspendable utxos when wallet is removed', () => {
        const walletId = WalletId('wallet1');
        const accountId1 = AccountId('wallet1-0-1');
        const accountId2 = AccountId('wallet1-1-1');

        const state = {
          ...initialState,
          accountTransactionHistory: {
            [accountId1]: {
              [cardanoAccount1Addr.address]: {
                transactionHistory: [],
                hasLoadedOldestEntry: false,
              },
            },
            [accountId2]: {
              [cardanoAccount2Addr1.address]: {
                transactionHistory: [],
                hasLoadedOldestEntry: false,
              },
            },
          },
          accountRewardsHistory: {
            [accountId1]: [],
            [accountId2]: [],
          },
          accountUtxos: {
            [accountId1]: [utxo1],
            [accountId2]: [utxo2],
          },
          accountUnspendableUtxos: {
            [accountId1]: [utxo1],
            [accountId2]: [utxo2],
          },
        } as unknown as CardanoContextSliceState;

        const newState = reducers.cardanoContext(
          state,
          walletsActions.wallets.removeWallet(walletId, [
            accountId1,
            accountId2,
          ]),
        );

        expect(newState.accountTransactionHistory).toEqual({});
        expect(newState.accountRewardsHistory).toEqual({});
        expect(newState.accountUtxos).toEqual({});
        expect(
          selectors.cardanoContext.selectAccountUnspendableUtxos({
            cardanoContext: newState,
          }),
        ).toEqual({});
      });
    });
  });

  describe('selectors', () => {
    // Define unique transaction IDs
    const txId1 =
      '80be2d8820b8946037764fcba8177a3eb1cae94bf8993def14dda20cb89390c2';
    const txId2 =
      '6e812e6da32276e76e7e73e7f15248c15ae24e7bb4e2aca1d985e20aaabc6d67';
    const txId3 =
      '7f812e6da32276e76e7e73e7f15248c15ae24e7bb4e2aca1d985e20aaabc6d68';
    const txId4 =
      '9f812e6da32276e76e7e73e7f15248c15ae24e7bb4e2aca1d985e20aaabc6d69';
    const txId5 =
      '03780eb43e1d09b6e447e440d86f26e3176de825b7c3215c7bab0be9898d9448';
    const txId6 =
      '13780eb43e1d09b6e447e440d86f26e3176de825b7c3215c7bab0be9898d9449';

    // account 1

    const accountId1 = cardanoAccount1Addr.accountId;
    const account1Address = CardanoPaymentAddress(cardanoAccount1Addr.address);

    const account1HistoryItem1: CardanoTransactionHistoryItem =
      createTransactionHistoryItem({
        id: txId1,
        blockTime: 1753969306000, // newest
      });

    const account1HistoryItem2: CardanoTransactionHistoryItem =
      createTransactionHistoryItem({
        id: txId2,
        blockTime: 1740659815000, // oldest
      });

    // account 2

    const accountId2 = cardanoAccount2Addr1.accountId;
    const account2Address1 = CardanoPaymentAddress(
      cardanoAccount2Addr1.address,
    );
    const account2Address2 = CardanoPaymentAddress(
      cardanoAccount2Addr2.address,
    );

    const account2HistoryItem1: CardanoTransactionHistoryItem =
      createTransactionHistoryItem({
        id: Cardano.TransactionId(txId3),
        blockTime: Timestamp(3), // newest
      });

    const account2HistoryItem2: CardanoTransactionHistoryItem =
      createTransactionHistoryItem({
        id: Cardano.TransactionId(txId4),
        blockTime: Timestamp(2),
      });

    const account2HistoryItem3: CardanoTransactionHistoryItem =
      createTransactionHistoryItem({
        id: Cardano.TransactionId(txId5),
        blockTime: Timestamp(1), // oldest
      });

    const account2HistoryItem4: CardanoTransactionHistoryItem =
      createTransactionHistoryItem({
        id: Cardano.TransactionId(txId6),
        blockTime: Timestamp(1),
        txIndex: 1,
      });

    const rewardAccount1 = CardanoRewardAccount(
      'stake_test1uqrw9tjymlm8wrwq7jk68n6v7fs9qz8z0tkdkve26dylmfc2ux2hj',
    );
    const rewardAccount2 = CardanoRewardAccount(
      'stake_test1uq7g7kqeucnqfweqzgxk3dw34e8zg4swnc7nagysug2mm4cm77jrx',
    );

    const accountReward1 = {
      epoch: Cardano.EpochNo(230),
      rewards: BigNumber(BigInt(1000000)),
      poolId: Cardano.PoolId(
        'pool1h8yl5mkyrfmfls2x9fu9mls3ry6egnw4q6efg34xr37zc243gkf',
      ),
    };

    const accountReward2 = {
      epoch: Cardano.EpochNo(229),
      rewards: BigNumber(BigInt(2000000)),
    };

    describe('selectTransactionHistoryGroupedByAccount', () => {
      it('returns empty object when there is no transaction history', () => {
        const state: CardanoContextSliceState = {
          ...initialState,
          accountTransactionHistory: {},
        };

        const accountHistory =
          selectors.cardanoContext.selectTransactionHistoryGroupedByAccount({
            cardanoContext: state,
          });
        expect(accountHistory).toEqual({});
      });

      it('groups and sorts transactions from multiple addresses per account', () => {
        const state: CardanoContextSliceState = {
          ...initialState,
          accountTransactionHistory: {
            [accountId1]: {
              [account1Address]: {
                transactionHistory: [
                  account1HistoryItem1,
                  account1HistoryItem2,
                ],
                hasLoadedOldestEntry: false,
              },
            },
            [accountId2]: {
              [account2Address1]: {
                transactionHistory: [
                  account2HistoryItem1,
                  account2HistoryItem2,
                ],
                hasLoadedOldestEntry: false,
              },
              [account2Address2]: {
                transactionHistory: [
                  // Duplicated transaction present in both account addresses
                  // should be de-duplicated in the result
                  account2HistoryItem2,
                  // should not be in account history because the address with
                  // longest history has only 2 items and so we cannot assume
                  // we know more than 2 history items in total.
                  account2HistoryItem3,
                ],
                hasLoadedOldestEntry: false,
              },
            },
          },
        };

        const accountHistory =
          selectors.cardanoContext.selectTransactionHistoryGroupedByAccount({
            cardanoContext: state,
          });

        // Should group items by account and sort by timestamp
        expect(accountHistory).toEqual({
          [accountId1]: [account1HistoryItem1, account1HistoryItem2],
          // account2HistoryItem2 is de-duplicated
          [accountId2]: [account2HistoryItem1, account2HistoryItem2],
        });
      });

      it('selects all account history items if all addresses are fully loaded', () => {
        const state: CardanoContextSliceState = {
          ...initialState,
          accountTransactionHistory: {
            [accountId2]: {
              [account2Address1]: {
                transactionHistory: [account2HistoryItem1],
                hasLoadedOldestEntry: true,
              },
              [account2Address2]: {
                transactionHistory: [
                  account2HistoryItem2,
                  account2HistoryItem4,
                  account2HistoryItem3,
                ],
                hasLoadedOldestEntry: true,
              },
            },
          },
        };

        const accountHistory =
          selectors.cardanoContext.selectTransactionHistoryGroupedByAccount({
            cardanoContext: state,
          });

        // Should group items by account and sort by timestamp
        expect(accountHistory).toEqual({
          [accountId2]: [
            account2HistoryItem1,
            account2HistoryItem2,
            account2HistoryItem4,
            account2HistoryItem3,
          ],
        });
      });
    });

    describe('selectAccountRewardsHistoryGroupedByAccount', () => {
      it('returns empty object when there is no rewards history', () => {
        const state: CardanoContextSliceState = {
          ...initialState,
          accountRewardsHistory: {},
        };

        const accountRewards =
          selectors.cardanoContext.selectRewardsHistoryGroupedByAccount({
            cardanoContext: state,
          });
        expect(accountRewards).toEqual({});
      });

      it('groups rewards by account', () => {
        const testRewardHistory = {
          [rewardAccount1]: [accountReward1],
          [rewardAccount2]: [accountReward2],
        };

        const state: CardanoContextSliceState = {
          ...initialState,
          accountRewardsHistory: {
            [accountId1]: testRewardHistory,
          },
        };

        const accountRewards =
          selectors.cardanoContext.selectRewardsHistoryGroupedByAccount({
            cardanoContext: state,
          });

        expect(accountRewards).toEqual({
          [accountId1]: [accountReward1, accountReward2],
        });
      });
    });

    describe('selectRewardsHistoryForAccount', () => {
      it('returns empty array when account has no rewards history', () => {
        const state: CardanoContextSliceState = {
          ...initialState,
          accountRewardsHistory: {},
        };

        const rewards = selectors.cardanoContext.selectRewardsHistoryForAccount(
          { cardanoContext: state },
          accountId1,
        );
        expect(rewards).toEqual([]);
      });

      it('returns stable empty reference for missing account', () => {
        const state: CardanoContextSliceState = {
          ...initialState,
          accountRewardsHistory: {},
        };

        const rewards1 =
          selectors.cardanoContext.selectRewardsHistoryForAccount(
            { cardanoContext: state },
            accountId1,
          );
        const rewards2 =
          selectors.cardanoContext.selectRewardsHistoryForAccount(
            { cardanoContext: state },
            accountId1,
          );
        expect(rewards1).toBe(rewards2);
      });

      it('flattens and sorts rewards for a single account', () => {
        const testRewardHistory = {
          [rewardAccount1]: [accountReward1],
          [rewardAccount2]: [accountReward2],
        };

        const state: CardanoContextSliceState = {
          ...initialState,
          accountRewardsHistory: {
            [accountId1]: testRewardHistory,
          },
        };

        const rewards = selectors.cardanoContext.selectRewardsHistoryForAccount(
          { cardanoContext: state },
          accountId1,
        );

        // accountReward1 has epoch 230, accountReward2 has epoch 229
        // Should be sorted descending by epoch
        expect(rewards).toEqual([accountReward1, accountReward2]);
      });

      it('returns stable reference on repeated calls with non-empty result', () => {
        const state: CardanoContextSliceState = {
          ...initialState,
          accountRewardsHistory: {
            [accountId1]: {
              [rewardAccount1]: [accountReward1],
              [rewardAccount2]: [accountReward2],
            },
          },
        };
        const wrappedState = { cardanoContext: state };

        const rewards1 =
          selectors.cardanoContext.selectRewardsHistoryForAccount(
            wrappedState,
            accountId1,
          );
        const rewards2 =
          selectors.cardanoContext.selectRewardsHistoryForAccount(
            wrappedState,
            accountId1,
          );

        expect(rewards1).toBe(rewards2);
      });

      it('preserves reference for account X when querying account Y with same state', () => {
        const state: CardanoContextSliceState = {
          ...initialState,
          accountRewardsHistory: {
            [accountId1]: {
              [rewardAccount1]: [accountReward1],
            },
            [accountId2]: {
              [rewardAccount2]: [accountReward2],
            },
          },
        };
        const wrappedState = { cardanoContext: state };

        const rewards1a =
          selectors.cardanoContext.selectRewardsHistoryForAccount(
            wrappedState,
            accountId1,
          );
        // interleaved call for a different account must not evict
        selectors.cardanoContext.selectRewardsHistoryForAccount(
          wrappedState,
          accountId2,
        );
        const rewards1b =
          selectors.cardanoContext.selectRewardsHistoryForAccount(
            wrappedState,
            accountId1,
          );

        expect(rewards1a).toBe(rewards1b);
      });

      it('preserves reference for account X when a sibling account entry is added to the root map', () => {
        const accountOneEntry = { [rewardAccount1]: [accountReward1] };
        const history1 = {
          [accountId1]: accountOneEntry,
        };
        const history2 = {
          [accountId1]: accountOneEntry,
          [accountId2]: { [rewardAccount2]: [accountReward2] },
        };

        const rewardsFirst =
          selectors.cardanoContext.selectRewardsHistoryForAccount(
            {
              cardanoContext: {
                ...initialState,
                accountRewardsHistory: history1,
              },
            },
            accountId1,
          );
        const rewardsAfterOtherAccountAdded =
          selectors.cardanoContext.selectRewardsHistoryForAccount(
            {
              cardanoContext: {
                ...initialState,
                accountRewardsHistory: history2,
              },
            },
            accountId1,
          );

        // accountId1's sub-map reference is unchanged, so the output must be
        // referentially stable even though the root map got a new reference.
        expect(rewardsFirst).toBe(rewardsAfterOtherAccountAdded);
      });
    });

    describe('selectCombinedTransactionHistory', () => {
      it('returns the combined transaction history', () => {
        const eraSummaries = [
          {
            parameters: {
              epochLength: 21600,
              slotLength: Milliseconds(20000),
            },
            start: {
              slot: 0,
              time: new Date('2022-06-01T00:00:00.000Z'),
            },
          },
          {
            parameters: {
              epochLength: 432000,
              slotLength: Milliseconds(1000),
            },
            start: {
              slot: 86400,
              time: new Date('2022-06-21T00:00:00.000Z'),
            },
          },
          {
            parameters: {
              epochLength: 432000,
              slotLength: Milliseconds(1000),
            },
            start: {
              slot: 518400,
              time: new Date('2022-06-26T00:00:00.000Z'),
            },
          },
          {
            parameters: {
              epochLength: 432000,
              slotLength: Milliseconds(1000),
            },
            start: {
              slot: 950400,
              time: new Date('2022-07-01T00:00:00.000Z'),
            },
          },
          {
            parameters: {
              epochLength: 432000,
              slotLength: Milliseconds(1000),
            },
            start: {
              slot: 1382400,
              time: new Date('2022-07-06T00:00:00.000Z'),
            },
          },
          {
            parameters: {
              epochLength: 432000,
              slotLength: Milliseconds(1000),
            },
            start: {
              slot: 3542400,
              time: new Date('2022-07-31T00:00:00.000Z'),
            },
          },
          {
            parameters: {
              epochLength: 432000,
              slotLength: Milliseconds(1000),
            },
            start: {
              slot: 68774400,
              time: new Date('2024-08-24T00:00:00.000Z'),
            },
          },
        ];

        const cardanoContextState: CardanoContextSliceState = {
          ...initialState,
          accountTransactionHistory: {
            [accountId1]: {
              [account1Address]: {
                transactionHistory: [
                  account1HistoryItem1,
                  account1HistoryItem2,
                ],
                hasLoadedOldestEntry: false,
              },
            },
            [accountId2]: {
              [account2Address1]: {
                transactionHistory: [account2HistoryItem1],
                hasLoadedOldestEntry: true,
              },
              [account2Address2]: {
                transactionHistory: [
                  account2HistoryItem2,
                  account2HistoryItem4,
                  account2HistoryItem3,
                ],
                hasLoadedOldestEntry: true,
              },
            },
          },
          accountRewardsHistory: {
            [accountId1]: {
              [rewardAccount1]: [accountReward1],
              [rewardAccount2]: [accountReward2],
            },
          },
          networkInfo: {
            [testNetwork]: {
              eraSummaries: Serializable.to(eraSummaries),
            },
          },
        };

        const result =
          selectors.cardanoContext.selectCombinedTransactionHistory({
            cardanoContext: cardanoContextState,
            network: {
              networkType: 'testnet',
              initialNetworkType: 'testnet' as const,
              blockchainNetworks: {
                Cardano: { mainnet: testNetwork, testnet: testNetwork },
              },
              testnetOptions: {},
            },
          });

        expect(result).toEqual({
          [accountId1]: [
            accountReward1,
            account1HistoryItem1,
            accountReward2,
            account1HistoryItem2,
          ],
          [accountId2]: [
            account2HistoryItem1,
            account2HistoryItem2,
            account2HistoryItem4,
            account2HistoryItem3,
          ],
        });
      });
    });

    describe('selectAccountUtxos', () => {
      it('returns empty object when there are no utxos for any account', () => {
        const state: CardanoContextSliceState = {
          ...initialState,
          accountUtxos: {},
        } as CardanoContextSliceState;

        const result = selectors.cardanoContext.selectAccountUtxos({
          cardanoContext: state,
        });
        expect(result).toEqual({});
      });

      it('returns utxos for the given account when present', () => {
        const expectedUtxos = {
          [AccountId('acc1')]: [utxo1],
          [AccountId('acc2')]: [utxo2],
        };
        const state: CardanoContextSliceState = {
          ...initialState,
          accountUtxos: {
            [AccountId('acc1')]: {
              utxos: Serializable.to([utxo1]),
              cacheKey: UtxoCacheKey({
                topOnChainActivityId: 'tx-a',
                stakeKeys: [],
                accountAddressCount: 0,
              }),
            },
            [AccountId('acc2')]: {
              utxos: Serializable.to([utxo2]),
              cacheKey: UtxoCacheKey({
                topOnChainActivityId: 'tx-b',
                stakeKeys: [],
                accountAddressCount: 0,
              }),
            },
          },
        };

        const result = selectors.cardanoContext.selectAccountUtxos({
          cardanoContext: state,
        });
        expect(result).toEqual(expectedUtxos);
      });
    });

    describe('selectSettledAvailableAccountUtxos', () => {
      const settledAccountId = AccountId('acc1');
      const unsyncedAccountId = AccountId('acc2');

      const stateOf = (cardanoContext: CardanoContextSliceState) =>
        ({
          cardanoContext,
          activities: {
            activities: {},
            desiredLoadedActivitiesCountPerAccount: {},
            hasLoadedOldestEntry: {},
          },
          addresses: { addresses: [] },
          wallets: { ids: [], entities: {} },
        } as unknown as Parameters<
          typeof selectors.cardanoContext.selectSettledAvailableAccountUtxos
        >[0]);

      const withSettled = (utxos: Cardano.Utxo[]) =>
        reducers.cardanoContext(
          initialState,
          actions.cardanoContext.setAccountUtxos({
            accountId: settledAccountId,
            utxos,
          }),
        );

      const withReserved = (
        cardanoContext: CardanoContextSliceState,
        accountId: AccountId,
        utxos: Cardano.Utxo[],
      ) =>
        reducers.cardanoContext(
          cardanoContext,
          actions.cardanoContext.setAccountUnspendableUtxos({
            accountId,
            utxos,
          }),
        );

      it('returns the settled array itself when nothing is reserved', () => {
        const state = stateOf(withSettled([utxo1, utxo2]));

        const result =
          selectors.cardanoContext.selectSettledAvailableAccountUtxos(state);

        expect(result[settledAccountId]).toBe(
          selectors.cardanoContext.selectAccountUtxos(state)[settledAccountId],
        );
      });

      it('leaves out reserved collateral', () => {
        const state = stateOf(
          withReserved(withSettled([utxo1, utxo2]), settledAccountId, [utxo2]),
        );

        const result =
          selectors.cardanoContext.selectSettledAvailableAccountUtxos(state);

        expect(result[settledAccountId]).toEqual([utxo1]);
      });

      it('omits an account with no settled set', () => {
        const state = stateOf(
          withReserved(withSettled([utxo1]), unsyncedAccountId, [utxo2]),
        );

        const result =
          selectors.cardanoContext.selectSettledAvailableAccountUtxos(state);

        expect(result).toEqual({ [settledAccountId]: [utxo1] });
      });
    });

    describe('selectAccountUnspendableUtxos', () => {
      it('returns empty object when there are no unspendable utxos for any account', () => {
        const state: CardanoContextSliceState = {
          ...initialState,
          accountUnspendableUtxos: Serializable.to({}),
        } as CardanoContextSliceState;

        const result = selectors.cardanoContext.selectAccountUnspendableUtxos({
          cardanoContext: state,
        });
        expect(result).toEqual({});
      });

      it('returns unspendable utxos for the given account when present', () => {
        const accountId1 = AccountId('acc1');
        const accountId2 = AccountId('acc2');
        const accountUnspendableUtxos = {
          [accountId1]: [utxo1],
          [accountId2]: [utxo2],
        };
        const state: CardanoContextSliceState = {
          ...initialState,
          accountUnspendableUtxos: Serializable.to(accountUnspendableUtxos),
        } as CardanoContextSliceState;

        const result = selectors.cardanoContext.selectAccountUnspendableUtxos({
          cardanoContext: state,
        });
        expect(result).toEqual(accountUnspendableUtxos);
      });
    });

    describe('in-flight views', () => {
      const sourceAccountId = AccountId('source-acc');
      const destinationAccountId = AccountId('dest-acc');
      // The source's keys on Preview: same address, another network (ADR 11).
      const previewAccountId = AccountId('source-acc-preview');
      const sourceAddress =
        'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp';
      const destinationAddress =
        'addr_test1qpuzeec0zqcm6lrdygkkvvd8e6qactnsl5zzeujsdpkpc939l2f2vykk0ctwq4ys6w3jg8pm0kknmy8m5pml8f9cauzq2zuc95';
      const foreignAddress =
        'addr_test1qqt3r9kd56aq9ajynjkz8hdfw3kc0pcv3tpzug8azxls62tvvz7nw9gmznn65g4ksrrfvyzhz52knc3mqxdyya47gz2qmcjmcq';
      const settledTxId = Cardano.TransactionId(
        '39a7a284c2a0948189dc45dec670211cd4d72f7b66c5726c08d9b3df11e44d58',
      );
      const sweepTxId = Cardano.TransactionId(
        '4c4e67bafa15e742c13c592b65c8f74c769cd7d9af04c848099672d1ba391b49',
      );
      const childTxId = Cardano.TransactionId(
        'a8c5b55caa9d716c3d98df7df19b33b66b1d5d5b4a894aa8f53adcdfb9e66ae9',
      );

      const makeUtxo = (address: string, coins: bigint): Cardano.Utxo => [
        {
          address: Cardano.PaymentAddress(address),
          txId: settledTxId,
          index: 0,
        },
        { address: Cardano.PaymentAddress(address), value: { coins } },
      ];
      const settledUtxo = makeUtxo(sourceAddress, 10_000_000n);
      const spendOfSettledUtxo = [{ txId: settledTxId, index: 0 }];
      /* eslint-disable max-params */
      const outputOf = (
        txId: Cardano.TransactionId,
        index: number,
        address: string,
        coins: bigint,
      ): Cardano.Utxo => [
        { txId, index, address: Cardano.PaymentAddress(address) },
        { address: Cardano.PaymentAddress(address), value: { coins } },
      ];
      /* eslint-enable max-params */
      const sweepOutput = (index: number, address: string, coins: bigint) =>
        outputOf(sweepTxId, index, address, coins);

      type InFlightEntry = Parameters<typeof recordInFlight>[1];

      const addressEntry = (accountId: AccountId, address: string) => ({
        name: 'test',
        address,
        blockchainName: 'Cardano',
        accountId,
      });

      const cardanoAccount = (
        accountId: AccountId,
        networkMagic: Cardano.NetworkMagic,
      ) => ({
        accountId,
        walletId: 'wallet',
        accountType: 'InMemory',
        blockchainName: 'Cardano',
        blockchainNetworkId: CardanoNetworkId(networkMagic),
      });

      const buildState = (
        inFlight: InFlightEntry[],
        {
          settled = [settledUtxo],
          previewSettled,
          reserved = [],
          activities = {},
        }: {
          settled?: Cardano.Utxo[];
          previewSettled?: Cardano.Utxo[];
          reserved?: Cardano.Utxo[];
          activities?: Record<string, Activity[]>;
        } = {},
      ) => {
        let cardanoContext = reducers.cardanoContext(
          initialState,
          actions.cardanoContext.setAccountUtxos({
            accountId: sourceAccountId,
            utxos: settled,
          }),
        );
        if (previewSettled) {
          cardanoContext = reducers.cardanoContext(
            cardanoContext,
            actions.cardanoContext.setAccountUtxos({
              accountId: previewAccountId,
              utxos: previewSettled,
            }),
          );
        }
        if (reserved.length > 0) {
          cardanoContext = reducers.cardanoContext(
            cardanoContext,
            actions.cardanoContext.setAccountUnspendableUtxos({
              accountId: sourceAccountId,
              utxos: reserved,
            }),
          );
        }
        for (const entry of inFlight) {
          cardanoContext = recordInFlight(cardanoContext, entry);
        }
        return {
          cardanoContext,
          activities: {
            activities,
            desiredLoadedActivitiesCountPerAccount: {},
            hasLoadedOldestEntry: {},
          },
          addresses: {
            addresses: [
              addressEntry(sourceAccountId, sourceAddress),
              addressEntry(destinationAccountId, destinationAddress),
              addressEntry(previewAccountId, sourceAddress),
            ],
          },
          wallets: {
            ids: ['wallet'],
            entities: {
              wallet: {
                walletId: 'wallet',
                type: WalletType.InMemory,
                metadata: { name: 'wallet', order: 0 },
                blockchainSpecific: {},
                accounts: [
                  cardanoAccount(
                    sourceAccountId,
                    Cardano.NetworkMagics.Preprod,
                  ),
                  cardanoAccount(
                    destinationAccountId,
                    Cardano.NetworkMagics.Preprod,
                  ),
                  cardanoAccount(
                    previewAccountId,
                    Cardano.NetworkMagics.Preview,
                  ),
                ],
              },
            },
          },
        } as unknown as Parameters<
          typeof selectors.cardanoContext.selectAvailableAccountUtxos
        >[0];
      };

      const outpoints = (utxos: Cardano.Utxo[] = []) =>
        utxos.map(([txIn]) => `${txIn.txId}#${txIn.index}`).sort();

      it('does not offer spent change when parent acceptance arrives after child reconciliation with the same confirmed activities', () => {
        const parentChange = sweepOutput(0, sourceAddress, 9_800_000n);
        const unspentChange = sweepOutput(1, sourceAddress, 100_000n);
        const childChange = outputOf(childTxId, 0, sourceAddress, 9_500_000n);
        const confirmed = (
          activityId: Cardano.TransactionId,
          consumedInputs: Cardano.TxIn[],
        ): Activity => ({
          accountId: sourceAccountId,
          activityId,
          timestamp: Timestamp(1_000),
          tokenBalanceChanges: [],
          type: ActivityType.Send,
          blockchainSpecific: { Cardano: { consumedInputs } },
        });
        const state = buildState(
          [
            {
              txId: childTxId,
              consumedInputs: [parentChange[0]],
              producedOutputs: [childChange],
            },
          ],
          {
            activities: {
              [sourceAccountId]: [
                confirmed(sweepTxId, spendOfSettledUtxo),
                confirmed(childTxId, [parentChange[0]]),
              ],
            },
          },
        );
        const reconciled = {
          ...state,
          cardanoContext: reducers.cardanoContext(
            state.cardanoContext,
            actions.cardanoContext.removeInFlightTransactions({
              keys: [`${testNetwork}:${childTxId}`],
            }),
          ),
        };
        const delayedAcceptance = {
          ...reconciled,
          cardanoContext: recordInFlight(reconciled.cardanoContext, {
            txId: sweepTxId,
            consumedInputs: spendOfSettledUtxo,
            producedOutputs: [parentChange, unspentChange],
          }),
        };

        expect(delayedAcceptance.activities).toBe(state.activities);
        for (const select of [
          selectors.cardanoContext.selectAvailableAccountUtxos,
          selectors.cardanoContext.selectAccountUtxosWithInFlight,
        ]) {
          expect(outpoints(select(delayedAcceptance)[sourceAccountId])).toEqual(
            outpoints([unspentChange]),
          );
        }
        expect(
          selectors.cardanoContext.selectAvailableAccountUtxos(reconciled)[
            sourceAccountId
          ],
        ).toEqual([]);
        expect(
          selectors.cardanoContext.selectSettledAvailableAccountUtxos(
            delayedAcceptance,
          )[sourceAccountId],
        ).toEqual([]);
      });

      it('applies confirmed spends across accounts only on their network, including reserved collateral', () => {
        const state = buildState([], {
          previewSettled: [settledUtxo],
          reserved: [settledUtxo],
          activities: {
            [destinationAccountId]: [
              {
                accountId: destinationAccountId,
                activityId: sweepTxId,
                timestamp: Timestamp(0),
                tokenBalanceChanges: [],
                type: ActivityType.Receive,
                blockchainSpecific: {
                  Cardano: { consumedInputs: spendOfSettledUtxo },
                },
              },
            ],
          },
        });

        for (const select of [
          selectors.cardanoContext.selectAvailableAccountUtxos,
          selectors.cardanoContext.selectAccountUtxosWithInFlight,
          selectors.cardanoContext.selectSettledAvailableAccountUtxos,
        ]) {
          const result = select(state);
          expect(result[sourceAccountId]).toEqual([]);
          expect(result[previewAccountId]).toEqual([settledUtxo]);
        }
        expect(
          selectors.cardanoContext.selectSettledAccountUnspendableUtxos(state)[
            sourceAccountId
          ],
        ).toEqual([]);
        expect(
          selectors.cardanoContext.selectAccountUtxosWithInFlight(state),
        ).toBe(selectors.cardanoContext.selectAccountUtxosWithInFlight(state));
      });

      it('retains confirmed spent-input evidence as the tip advances until a re-sync clears the activity', () => {
        const state = buildState([], {
          activities: {
            [sourceAccountId]: [
              {
                accountId: sourceAccountId,
                activityId: sweepTxId,
                timestamp: Timestamp(0),
                tokenBalanceChanges: [],
                type: ActivityType.Send,
                blockchainSpecific: {
                  Cardano: { consumedInputs: spendOfSettledUtxo },
                },
              },
            ],
          },
        });
        const advanced = {
          ...state,
          cardanoContext: reducers.cardanoContext(
            state.cardanoContext,
            actions.cardanoContext.setTip({
              network: testNetwork,
              tip: { ...tip1, slot: Cardano.Slot(1_000_000) },
            }),
          ),
        };
        const reset = {
          ...advanced,
          activities: { ...advanced.activities, activities: {} },
        };
        for (const select of [
          selectors.cardanoContext.selectAvailableAccountUtxos,
          selectors.cardanoContext.selectAccountUtxosWithInFlight,
        ]) {
          expect(select(advanced)[sourceAccountId]).toEqual([]);
          expect(select(reset)[sourceAccountId]).toEqual([settledUtxo]);
        }
      });

      describe('selectCollateralOwnershipUtxos', () => {
        const authorityFor = (
          accountId: AccountId,
          ...args: Parameters<typeof buildState>
        ) =>
          selectors.cardanoContext.selectCollateralOwnershipUtxos(
            buildState(...args),
          )[accountId];

        it('includes an own in-flight output the settled set does not have yet', () => {
          const change = sweepOutput(1, sourceAddress, 4_800_000n);
          const authority = authorityFor(sourceAccountId, [
            { txId: sweepTxId, producedOutputs: [change] },
          ]);

          expect(outpoints(authority)).toEqual(
            outpoints([settledUtxo, change]),
          );
        });

        it('covers an account whose ONLY funds are in flight, with no settled entry at all', () => {
          const credit = sweepOutput(0, destinationAddress, 9_800_000n);
          const authority = authorityFor(destinationAccountId, [
            { txId: sweepTxId, producedOutputs: [credit] },
          ]);

          expect(outpoints(authority)).toEqual(outpoints([credit]));
        });

        it('leaves out an account with no settled entry that no in-flight transaction credits', () => {
          const authority = authorityFor(destinationAccountId, [
            { txId: sweepTxId, consumedInputs: spendOfSettledUtxo },
          ]);

          expect(authority).toBeUndefined();
        });

        it('keeps a collateral-reserved settled output that the spendable view filters out', () => {
          const authority = authorityFor(sourceAccountId, [], {
            reserved: [settledUtxo],
          });

          expect(outpoints(authority)).toEqual(outpoints([settledUtxo]));
        });

        it('keeps a settled input an in-flight transaction consumes -- it still exists on chain', () => {
          const authority = authorityFor(sourceAccountId, [
            { txId: sweepTxId, consumedInputs: spendOfSettledUtxo },
          ]);

          expect(outpoints(authority)).toEqual(outpoints([settledUtxo]));
        });

        it('keeps an own in-flight output another in-flight transaction consumes', () => {
          const change = sweepOutput(0, sourceAddress, 4_800_000n);
          const childChange = outputOf(childTxId, 0, sourceAddress, 4_600_000n);
          const authority = authorityFor(sourceAccountId, [
            {
              txId: childTxId,
              consumedInputs: [{ txId: sweepTxId, index: 0 }],
              producedOutputs: [childChange],
            },
            { txId: sweepTxId, producedOutputs: [change] },
          ]);

          expect(outpoints(authority)).toEqual(
            outpoints([settledUtxo, change, childChange]),
          );
        });

        it('excludes an in-flight output paying an address the account does not own', () => {
          const authority = authorityFor(sourceAccountId, [
            {
              txId: sweepTxId,
              producedOutputs: [sweepOutput(0, foreignAddress, 3_000_000n)],
            },
          ]);

          expect(outpoints(authority)).toEqual(outpoints([settledUtxo]));
        });
      });

      describe('selectAccountUtxosWithInFlight', () => {
        it('subtracts an in-flight spend from the source and credits the destination it pays, before either settles', () => {
          const state = buildState([
            {
              txId: sweepTxId,
              consumedInputs: spendOfSettledUtxo,
              // The destination has no settled UTxO entry yet: the credit
              // appears anyway.
              producedOutputs: [sweepOutput(0, destinationAddress, 9_800_000n)],
            },
          ]);

          const result =
            selectors.cardanoContext.selectAccountUtxosWithInFlight(state);

          expect(result[sourceAccountId]).toEqual([]);
          expect(result[destinationAccountId]).toHaveLength(1);
          expect(result[destinationAccountId]?.[0]?.[1].value.coins).toBe(
            9_800_000n,
          );
        });

        it('returns the settled sets untouched when nothing is in flight', () => {
          const state = buildState([]);
          const result =
            selectors.cardanoContext.selectAccountUtxosWithInFlight(state);

          expect(result[sourceAccountId]).toHaveLength(1);
          expect(result[destinationAccountId]).toBeUndefined();
        });

        it('leaves out an account with no settled entry that no in-flight transaction credits', () => {
          const state = buildState([
            { txId: sweepTxId, consumedInputs: spendOfSettledUtxo },
          ]);

          expect(
            selectors.cardanoContext.selectAccountUtxosWithInFlight(state)[
              destinationAccountId
            ],
          ).toBeUndefined();
        });

        it('keeps collateral (unspendable) UTxOs in the balance view', () => {
          // The balance view answers "what does the account hold", so the
          // collateral stays counted; only selectAvailableAccountUtxos ("what
          // can a transaction spend") filters it.
          const state = buildState([], { reserved: [settledUtxo] });

          const result =
            selectors.cardanoContext.selectAccountUtxosWithInFlight(state);

          expect(result[sourceAccountId]).toHaveLength(1);
        });

        it('returns the same reference for the same state (input stability)', () => {
          const state = buildState([]);
          const first =
            selectors.cardanoContext.selectAccountUtxosWithInFlight(state);
          const second =
            selectors.cardanoContext.selectAccountUtxosWithInFlight(state);

          expect(second).toBe(first);
        });

        it('keeps its result while a wallet changes but none of its accounts', () => {
          const state = buildState([
            { txId: sweepTxId, consumedInputs: spendOfSettledUtxo },
          ]);
          const first =
            selectors.cardanoContext.selectAccountUtxosWithInFlight(state);
          const { wallets } = state as unknown as {
            wallets: { entities: Record<string, WalletEntity> };
          };
          const renamed = {
            ...state,
            wallets: {
              ...wallets,
              entities: {
                wallet: {
                  ...wallets.entities.wallet,
                  metadata: { name: 'renamed', order: 0 },
                },
              },
            },
          } as unknown as typeof state;

          expect(
            selectors.cardanoContext.selectAccountUtxosWithInFlight(renamed),
          ).toBe(first);
        });
      });

      describe('selectSettledAvailableAccountUtxos with transactions in flight', () => {
        const otherSettledUtxo = outputOf(
          settledTxId,
          1,
          sourceAddress,
          4_000_000n,
        );
        const settledAvailable = (state: ReturnType<typeof buildState>) =>
          selectors.cardanoContext.selectSettledAvailableAccountUtxos(state)[
            sourceAccountId
          ];

        it('leaves out a settled UTxO an in-flight transaction spends', () => {
          const state = buildState(
            [{ txId: sweepTxId, consumedInputs: spendOfSettledUtxo }],
            { settled: [settledUtxo, otherSettledUtxo] },
          );

          expect(settledAvailable(state)).toEqual([otherSettledUtxo]);
        });

        it('leaves out an output known only from an in-flight transaction', () => {
          const state = buildState([
            {
              txId: sweepTxId,
              consumedInputs: [],
              producedOutputs: [sweepOutput(0, sourceAddress, 3_000_000n)],
            },
          ]);

          expect(settledAvailable(state)).toEqual([settledUtxo]);
        });

        it('keeps a settled output an in-flight transaction also produces as the settled tuple', () => {
          const settledOutput = sweepOutput(0, sourceAddress, 3_000_000n);
          const state = buildState(
            [
              {
                txId: sweepTxId,
                consumedInputs: spendOfSettledUtxo,
                producedOutputs: [sweepOutput(0, sourceAddress, 3_000_000n)],
              },
            ],
            { settled: [settledUtxo, settledOutput] },
          );

          const [kept] = settledAvailable(state);
          expect(settledAvailable(state)).toHaveLength(1);
          expect(kept).toBe(
            selectors.cardanoContext.selectAccountUtxos(state)[
              sourceAccountId
            ][1],
          );
        });

        it('ignores an in-flight transaction of another network', () => {
          const state = buildState([
            {
              txId: sweepTxId,
              chainId: Cardano.ChainIds.Preview,
              consumedInputs: spendOfSettledUtxo,
            },
          ]);

          expect(settledAvailable(state)).toBe(
            selectors.cardanoContext.selectAccountUtxos(state)[sourceAccountId],
          );
        });
      });

      describe('selectAvailableAccountUtxos', () => {
        it('returns the settled set itself when nothing is reserved or in flight', () => {
          const state = buildState([]);

          const result =
            selectors.cardanoContext.selectAvailableAccountUtxos(state);

          expect(result[sourceAccountId]).toBe(
            selectors.cardanoContext.selectAccountUtxos(state)[sourceAccountId],
          );
        });

        it('returns the settled set itself while only another network has transactions in flight', () => {
          const state = buildState([
            {
              txId: sweepTxId,
              chainId: Cardano.ChainIds.Preview,
              consumedInputs: spendOfSettledUtxo,
            },
          ]);

          expect(
            selectors.cardanoContext.selectAvailableAccountUtxos(state)[
              sourceAccountId
            ],
          ).toBe(
            selectors.cardanoContext.selectAccountUtxos(state)[sourceAccountId],
          );
        });

        it('leaves out a settled UTxO an in-flight transaction spends', () => {
          const state = buildState([
            { txId: sweepTxId, consumedInputs: spendOfSettledUtxo },
          ]);

          const result =
            selectors.cardanoContext.selectAvailableAccountUtxos(state);

          expect(result[sourceAccountId]).toEqual([]);
        });

        it('offers the outputs an in-flight transaction pays to an own address, and no others', () => {
          const change = sweepOutput(1, sourceAddress, 6_800_000n);
          const state = buildState([
            {
              txId: sweepTxId,
              consumedInputs: spendOfSettledUtxo,
              producedOutputs: [
                sweepOutput(0, foreignAddress, 3_000_000n),
                change,
              ],
            },
          ]);

          const result =
            selectors.cardanoContext.selectAvailableAccountUtxos(state);

          expect(result[sourceAccountId]).toEqual([change]);
        });

        it.each([
          ['a confirmed activity', ActivityType.Send, []],
          ['a Pending activity', ActivityType.Pending, [settledUtxo]],
        ])(
          'uses only confirmed spent-input evidence from %s, never its outputs',
          (_, type, expected) => {
            const state = buildState([], {
              activities: {
                [sourceAccountId]: [
                  {
                    accountId: sourceAccountId,
                    activityId: String(sweepTxId),
                    timestamp: Timestamp(0),
                    tokenBalanceChanges: [],
                    type,
                    blockchainSpecific: Serializable.to({
                      Cardano: {
                        consumedInputs: spendOfSettledUtxo,
                        producedOutputs: [
                          sweepOutput(0, sourceAddress, 9_800_000n),
                        ],
                      },
                    }) as unknown,
                  },
                ],
              },
            });

            const result =
              selectors.cardanoContext.selectAvailableAccountUtxos(state);

            expect(result[sourceAccountId]).toEqual(expected);
          },
        );

        it('applies an in-flight transaction on every account of its network and on no account of another', () => {
          // The same outpoint settled on both networks, under the same keys.
          const change = sweepOutput(1, sourceAddress, 6_800_000n);
          const credit = sweepOutput(0, destinationAddress, 3_000_000n);
          const state = buildState(
            [
              {
                txId: sweepTxId,
                consumedInputs: spendOfSettledUtxo,
                producedOutputs: [credit, change],
              },
            ],
            { previewSettled: [settledUtxo] },
          );

          const available =
            selectors.cardanoContext.selectAvailableAccountUtxos(state);
          const held =
            selectors.cardanoContext.selectAccountUtxosWithInFlight(state);

          expect(available[sourceAccountId]).toEqual([change]);
          expect(held[destinationAccountId]).toEqual([credit]);
          expect(available[previewAccountId]).toEqual([settledUtxo]);
          expect(held[previewAccountId]).toEqual([settledUtxo]);
        });

        it.each(['parent first', 'child first'])(
          'keeps the change a child spends out whichever is recorded first (%s)',
          order => {
            const change = sweepOutput(0, sourceAddress, 9_800_000n);
            const childChange = outputOf(
              childTxId,
              0,
              sourceAddress,
              9_600_000n,
            );
            const parent = {
              txId: sweepTxId,
              consumedInputs: spendOfSettledUtxo,
              producedOutputs: [change],
            };
            const child = {
              txId: childTxId,
              consumedInputs: [{ txId: sweepTxId, index: 0 }],
              producedOutputs: [childChange],
            };
            const state = buildState(
              order === 'parent first' ? [parent, child] : [child, parent],
            );

            expect(
              selectors.cardanoContext.selectAvailableAccountUtxos(state)[
                sourceAccountId
              ],
            ).toEqual([childChange]);
          },
        );

        describe('with reserved collateral', () => {
          const collateral = sweepOutput(0, sourceAddress, 5_000_000n);
          // The sweep's collateral output has settled and the collateral flow
          // has reserved it, while the sweep is still in flight.
          const settledCollateralState = () =>
            buildState(
              [
                {
                  txId: sweepTxId,
                  consumedInputs: spendOfSettledUtxo,
                  producedOutputs: [collateral],
                },
              ],
              { settled: [collateral], reserved: [collateral] },
            );

          it('leaves out a reserved UTxO that an in-flight transaction produces', () => {
            const result = selectors.cardanoContext.selectAvailableAccountUtxos(
              settledCollateralState(),
            );

            expect(result[sourceAccountId]).toEqual([]);
          });

          it('leaves out a reserved outpoint known only as an in-flight output', () => {
            const change = sweepOutput(1, sourceAddress, 4_800_000n);
            const state = buildState(
              [
                {
                  txId: sweepTxId,
                  consumedInputs: spendOfSettledUtxo,
                  producedOutputs: [collateral, change],
                },
              ],
              { reserved: [collateral] },
            );

            const result =
              selectors.cardanoContext.selectAvailableAccountUtxos(state);

            expect(result[sourceAccountId]).toEqual([change]);
          });

          it('still counts the reserved UTxO in the balance view', () => {
            const result =
              selectors.cardanoContext.selectAccountUtxosWithInFlight(
                settledCollateralState(),
              );

            expect(result[sourceAccountId]).toEqual([collateral]);
          });

          it('keeps a reserved settled output that an in-flight transaction produces out of the settled available set', () => {
            const result =
              selectors.cardanoContext.selectSettledAvailableAccountUtxos(
                settledCollateralState(),
              );

            expect(result[sourceAccountId]).toEqual([]);
          });

          describe('selectSettledAccountUnspendableUtxos', () => {
            const settledCollateral = outputOf(
              settledTxId,
              1,
              sourceAddress,
              5_000_000n,
            );
            const spendOfSettledCollateral = [{ txId: settledTxId, index: 1 }];
            const nameableFor = (...args: Parameters<typeof buildState>) => {
              const state = buildState(...args);
              return {
                nameable:
                  selectors.cardanoContext.selectSettledAccountUnspendableUtxos(
                    state,
                  ),
                reserved:
                  selectors.cardanoContext.selectAccountUnspendableUtxos(state),
              };
            };

            it('returns the reserved array itself when every reserved UTxO is settled and no in-flight transaction spends it', () => {
              const { nameable, reserved } = nameableFor(
                [{ txId: sweepTxId, consumedInputs: spendOfSettledUtxo }],
                {
                  settled: [settledUtxo, settledCollateral],
                  reserved: [settledCollateral],
                },
              );

              expect(nameable[sourceAccountId]).toBe(reserved[sourceAccountId]);
            });

            it('leaves out a reserved outpoint known only as an in-flight output', () => {
              const { nameable } = nameableFor(
                [
                  {
                    txId: sweepTxId,
                    consumedInputs: spendOfSettledUtxo,
                    producedOutputs: [collateral],
                  },
                ],
                { reserved: [collateral] },
              );

              expect(nameable[sourceAccountId]).toEqual([]);
            });

            it('leaves out a reserved settled UTxO that an in-flight transaction spends', () => {
              const { nameable } = nameableFor(
                [{ txId: sweepTxId, consumedInputs: spendOfSettledCollateral }],
                {
                  settled: [settledUtxo, settledCollateral],
                  reserved: [settledCollateral],
                },
              );

              expect(nameable[sourceAccountId]).toEqual([]);
            });

            it('ignores an in-flight transaction of another network that spends the reserved UTxO', () => {
              const { nameable, reserved } = nameableFor(
                [
                  {
                    txId: sweepTxId,
                    chainId: Cardano.ChainIds.Preview,
                    consumedInputs: spendOfSettledCollateral,
                  },
                ],
                {
                  settled: [settledUtxo, settledCollateral],
                  reserved: [settledCollateral],
                },
              );

              expect(nameable[sourceAccountId]).toBe(reserved[sourceAccountId]);
            });

            it('returns one shared empty map when nothing is reserved', () => {
              const idle = nameableFor([]).nameable;
              const inFlight = nameableFor([
                { txId: sweepTxId, consumedInputs: spendOfSettledUtxo },
              ]).nameable;

              expect(idle).toEqual({});
              expect(inFlight).toBe(idle);
            });
          });
        });
      });
    });

    describe('selectStakingStatus', () => {
      const testWalletId = WalletId('test-wallet');
      const preprodNetworkMagic = Cardano.NetworkMagics.Preprod;
      const previewNetworkMagic = Cardano.NetworkMagics.Preview;

      type SelectStakingStatusState = Parameters<
        typeof selectors.cardanoContext.selectStakingStatus
      >[0];

      const createWalletWithAccounts = (
        walletId: WalletId,
        accounts: Array<{ accountId: AccountId; networkMagic: number }>,
      ): WalletEntity =>
        ({
          walletId,
          metadata: { name: 'Test Wallet', order: 0 },
          type: WalletType.InMemory,
          blockchainSpecific: {},
          accounts: accounts.map(({ accountId, networkMagic }) => ({
            accountId,
            walletId,
            accountType: 'InMemory',
            blockchainName: 'Cardano',
            networkType: 'testnet' as const,
            blockchainNetworkId: CardanoNetworkId(networkMagic),
            metadata: { name: 'Account' },
            blockchainSpecific: {},
          })),
        } as unknown as WalletEntity);

      const createStateWithNetwork = (
        rewardAccountDetails: AccountRewardAccountDetailsMap,
        {
          networkType = 'testnet' as NetworkType,
          walletAccounts = Object.keys(rewardAccountDetails).map(accountId => {
            const parts = String(accountId).split('-');
            const networkMagic = Number(parts[parts.length - 1]);
            return { accountId: AccountId(accountId), networkMagic };
          }),
          hasEverSynced = true,
        }: {
          networkType?: NetworkType;
          walletAccounts?: Array<{
            accountId: AccountId;
            networkMagic: number;
          }>;
          hasEverSynced?: boolean;
        } = {},
      ) => {
        const walletsEntities: Record<string, WalletEntity> =
          walletAccounts.length > 0
            ? {
                [String(testWalletId)]: createWalletWithAccounts(
                  testWalletId,
                  walletAccounts,
                ),
              }
            : {};
        const syncStatusByAccount: Record<string, unknown> = {};
        if (hasEverSynced && walletAccounts.length > 0) {
          syncStatusByAccount[String(walletAccounts[0].accountId)] = {
            lastSuccessfulSync: 1_000_000,
          };
        }
        return {
          cardanoContext: {
            ...initialState,
            rewardAccountDetails:
              Serializable.to<AccountRewardAccountDetailsMap>(
                rewardAccountDetails,
              ),
          },
          network: {
            networkType,
            blockchainNetworks: {
              Cardano: {
                mainnet: CardanoNetworkId(Cardano.NetworkMagics.Mainnet),
                testnet: CardanoNetworkId(preprodNetworkMagic),
              },
            },
          },
          wallets: {
            ids: Object.keys(walletsEntities),
            entities: walletsEntities,
          },
          sync: { syncStatusByAccount },
        } as unknown as SelectStakingStatusState;
      };

      it('returns loading status when there are no reward account details', () => {
        const state = createStateWithNetwork(
          {} as AccountRewardAccountDetailsMap,
        );

        const result = selectors.cardanoContext.selectStakingStatus(state);

        expect(result.totalRewardsSum.toString()).toBe('0');
        expect(result.totalStakedAmount.toString()).toBe('0');
        expect(result.totalUnstakedAmount.toString()).toBe('0');
        expect(result.stakingStatus).toBe('loading');
      });

      it('returns loading status when accounts exist but sync has not completed', () => {
        const accountId = CardanoAccountId(
          testWalletId,
          0,
          preprodNetworkMagic,
        );

        const state = createStateWithNetwork(
          {} as AccountRewardAccountDetailsMap,
          {
            walletAccounts: [{ accountId, networkMagic: preprodNetworkMagic }],
            hasEverSynced: false,
          },
        );

        const result = selectors.cardanoContext.selectStakingStatus(state);

        expect(result.totalRewardsSum.toString()).toBe('0');
        expect(result.totalStakedAmount.toString()).toBe('0');
        expect(result.totalUnstakedAmount.toString()).toBe('0');
        expect(result.stakingStatus).toBe('loading');
      });

      it('returns staked status with zeros when accounts exist and sync completed but no reward details', () => {
        const accountId = CardanoAccountId(
          testWalletId,
          0,
          preprodNetworkMagic,
        );

        const state = createStateWithNetwork(
          {} as AccountRewardAccountDetailsMap,
          {
            walletAccounts: [{ accountId, networkMagic: preprodNetworkMagic }],
            hasEverSynced: true,
          },
        );

        const result = selectors.cardanoContext.selectStakingStatus(state);

        expect(result.totalRewardsSum.toString()).toBe('0');
        expect(result.totalStakedAmount.toString()).toBe('0');
        expect(result.totalUnstakedAmount.toString()).toBe('0');
        expect(result.stakingStatus).toBe('staked');
      });

      it('returns loading status when there are no visible accounts', () => {
        const accountId = CardanoAccountId(
          testWalletId,
          0,
          preprodNetworkMagic,
        );
        const rewardAccountDetails: AccountRewardAccountDetailsMap = {
          [accountId]: {
            rewardAccountInfo: {
              isActive: true,
              isRegistered: true,
              rewardsSum: BigNumber(0n),
              controlledAmount: BigNumber(10_000_000n),
              withdrawableAmount: BigNumber(0n),
            },
          },
        };

        const state = createStateWithNetwork(rewardAccountDetails, {
          walletAccounts: [],
        });

        const result = selectors.cardanoContext.selectStakingStatus(state);

        expect(result.stakingStatus).toBe('loading');
      });

      it('returns staked status when any account is actively staking', () => {
        const accountId = CardanoAccountId(
          testWalletId,
          0,
          preprodNetworkMagic,
        );
        const rewardAccountDetails: AccountRewardAccountDetailsMap = {
          [accountId]: {
            rewardAccountInfo: {
              isActive: true,
              isRegistered: true,
              rewardsSum: BigNumber(0n),
              controlledAmount: BigNumber(10_000_000n),
              withdrawableAmount: BigNumber(0n),
            },
          },
        };

        const state = createStateWithNetwork(rewardAccountDetails);

        const result = selectors.cardanoContext.selectStakingStatus(state);

        expect(result.totalRewardsSum.toString()).toBe('0');
        expect(result.totalStakedAmount.toString()).toBe('10000000');
        expect(result.totalUnstakedAmount.toString()).toBe('0');
        expect(result.stakingStatus).toBe('staked');
      });

      it('returns staked status when no accounts are active but rewards have been earned', () => {
        const accountId = CardanoAccountId(
          testWalletId,
          0,
          preprodNetworkMagic,
        );
        const rewardAccountDetails: AccountRewardAccountDetailsMap = {
          [accountId]: {
            rewardAccountInfo: {
              isActive: false,
              isRegistered: false,
              rewardsSum: BigNumber(1_000_000n),
              controlledAmount: BigNumber(10_000_000n),
              withdrawableAmount: BigNumber(0n),
            },
          },
        };

        const state = createStateWithNetwork(rewardAccountDetails);

        const result = selectors.cardanoContext.selectStakingStatus(state);

        expect(result.totalRewardsSum.toString()).toBe('1000000');
        expect(result.totalStakedAmount.toString()).toBe('0');
        expect(result.totalUnstakedAmount.toString()).toBe('10000000');
        expect(result.stakingStatus).toBe('staked');
      });

      it('returns unstaked status when no accounts are active and no rewards earned', () => {
        const accountId = CardanoAccountId(
          testWalletId,
          0,
          preprodNetworkMagic,
        );
        const rewardAccountDetails: AccountRewardAccountDetailsMap = {
          [accountId]: {
            rewardAccountInfo: {
              isActive: false,
              isRegistered: false,
              rewardsSum: BigNumber(0n),
              controlledAmount: BigNumber(10_000_000n),
              withdrawableAmount: BigNumber(0n),
            },
          },
        };

        const state = createStateWithNetwork(rewardAccountDetails);

        const result = selectors.cardanoContext.selectStakingStatus(state);

        expect(result.totalRewardsSum.toString()).toBe('0');
        expect(result.totalStakedAmount.toString()).toBe('0');
        expect(result.totalUnstakedAmount.toString()).toBe('10000000');
        expect(result.stakingStatus).toBe('unstaked');
      });

      it('returns staking totals from multiple accounts with mixed active states', () => {
        const accountId1 = CardanoAccountId(
          testWalletId,
          0,
          preprodNetworkMagic,
        );
        const accountId2 = CardanoAccountId(
          testWalletId,
          1,
          preprodNetworkMagic,
        );
        const rewardAccountDetails: AccountRewardAccountDetailsMap = {
          [accountId1]: {
            rewardAccountInfo: {
              isActive: true,
              isRegistered: true,
              rewardsSum: BigNumber(1_000_000n),
              controlledAmount: BigNumber(10_000_000n),
              withdrawableAmount: BigNumber(0n),
            },
          },
          [accountId2]: {
            rewardAccountInfo: {
              isActive: false,
              isRegistered: false,
              rewardsSum: BigNumber(3_000_000n),
              controlledAmount: BigNumber(30_000_000n),
              withdrawableAmount: BigNumber(0n),
            },
          },
        };

        const state = createStateWithNetwork(rewardAccountDetails);

        const result = selectors.cardanoContext.selectStakingStatus(state);

        // 1_000_000 + 3_000_000 = 4_000_000
        expect(result.totalRewardsSum.toString()).toBe('4000000');
        // Only accountId1 is active: 10_000_000
        expect(result.totalStakedAmount.toString()).toBe('10000000');
        // accountId2: 30_000_000
        expect(result.totalUnstakedAmount.toString()).toBe('30000000');
        // Has active account, so status is staked
        expect(result.stakingStatus).toBe('staked');
      });

      it('filters out accounts from different networks', () => {
        const preprodAccountId = CardanoAccountId(
          testWalletId,
          0,
          preprodNetworkMagic,
        );
        const previewAccountId = CardanoAccountId(
          testWalletId,
          1,
          previewNetworkMagic,
        );
        const rewardAccountDetails: AccountRewardAccountDetailsMap = {
          [preprodAccountId]: {
            rewardAccountInfo: {
              isActive: true,
              isRegistered: true,
              rewardsSum: BigNumber(1_000_000n),
              controlledAmount: BigNumber(10_000_000n),
              withdrawableAmount: BigNumber(0n),
            },
          },
          [previewAccountId]: {
            rewardAccountInfo: {
              isActive: true,
              isRegistered: true,
              rewardsSum: BigNumber(5_000_000n),
              controlledAmount: BigNumber(50_000_000n),
              withdrawableAmount: BigNumber(0n),
            },
          },
        };

        const state = createStateWithNetwork(rewardAccountDetails);

        const result = selectors.cardanoContext.selectStakingStatus(state);

        // Only preprod account should be included (testnet uses preprod)
        expect(result.totalRewardsSum.toString()).toBe('1000000');
        expect(result.totalStakedAmount.toString()).toBe('10000000');
        expect(result.totalUnstakedAmount.toString()).toBe('0');
        expect(result.stakingStatus).toBe('staked');
      });

      it('returns loading status when all accounts are filtered out due to different network', () => {
        // Only preview accounts exist in reward details and wallet; current network is preprod (testnet)
        const previewAccountId = CardanoAccountId(
          testWalletId,
          0,
          previewNetworkMagic,
        );
        const rewardAccountDetails: AccountRewardAccountDetailsMap = {
          [previewAccountId]: {
            rewardAccountInfo: {
              isActive: true,
              isRegistered: true,
              rewardsSum: BigNumber(1_000_000n),
              controlledAmount: BigNumber(10_000_000n),
              withdrawableAmount: BigNumber(0n),
            },
          },
        };

        const state = createStateWithNetwork(rewardAccountDetails, {
          walletAccounts: [
            { accountId: previewAccountId, networkMagic: previewNetworkMagic },
          ],
        });

        const result = selectors.cardanoContext.selectStakingStatus(state);

        // Should return loading, not unstaked, when all accounts are filtered out (preview not visible when preprod selected)
        expect(result.totalRewardsSum.toString()).toBe('0');
        expect(result.totalStakedAmount.toString()).toBe('0');
        expect(result.totalUnstakedAmount.toString()).toBe('0');
        expect(result.stakingStatus).toBe('loading');
      });
    });

    describe('selectDelegationActivities', () => {
      const accountId = AccountId('test1');
      const rewardAccount = CardanoRewardAccount(
        'stake_test1uqrw9tjymlm8wrwq7jk68n6v7fs9qz8z0tkdkve26dylmfc2ux2hj',
      );

      const networkState: NetworkSliceState = {
        networkType: 'testnet' as const,
        initialNetworkType: 'testnet' as const,
        blockchainNetworks: {
          Cardano: { mainnet: testNetwork, testnet: testNetwork },
        },
        testnetOptions: {},
      };

      const createActivity = (
        activityId: string,
        type: ActivityType,
        timestamp: number,
      ): Activity => ({
        accountId,
        activityId,
        type,
        timestamp: Timestamp(timestamp),
        tokenBalanceChanges: [
          {
            tokenId: TokenId('lovelace'),
            amount: BigNumber(BigInt(1000000)),
          },
        ],
      });

      it('should return empty activities when no data exists', () => {
        const result = selectors.cardanoContext.selectDelegationActivities(
          { cardanoContext: initialState, network: networkState },
          { accountId, rewardAccount },
        );

        expect(result.activities).toEqual([]);
        expect(result.isLoadingActivities).toBe(false);
      });

      it('should return activities from delegationActivities when history is loaded', () => {
        const activities = [
          createActivity('activity1', ActivityType.Delegation, 1000),
          createActivity('activity2', ActivityType.Registration, 2000),
          createActivity('activity3', ActivityType.Withdrawal, 3000),
        ];

        const delegationEntry = {
          activeEpoch: Cardano.EpochNo(100),
          txHash: Cardano.TransactionId(
            '80be2d8820b8946037764fcba8177a3eb1cae94bf8993def14dda20cb89390c2',
          ),
          amount: BigNumber(BigInt(1000000)),
          poolId: Cardano.PoolId(
            'pool1h8yl5mkyrfmfls2x9fu9mls3ry6egnw4q6efg34xr37zc243gkf',
          ),
        };
        const registrationEntry = {
          txHash: Cardano.TransactionId(
            '6e812e6da32276e76e7e73e7f15248c15ae24e7bb4e2aca1d985e20aaabc6d67',
          ),
          action: 'registered' as const,
        };
        const withdrawalEntry = {
          txHash: Cardano.TransactionId(
            'f0e1d2c3b4a5968778695a4b3c2d1e0f00112233445566778899aabbccddeeff',
          ),
          amount: BigNumber(BigInt(2000000)),
        };

        const mockEraSummaries: EraSummary[] = [
          {
            parameters: {
              epochLength: 432000,
              slotLength: 1 as Milliseconds,
            },
            start: {
              slot: 0,
              time: new Date(0),
            },
          },
        ];

        const state: CardanoContextSliceState = {
          ...initialState,
          accountDelegationsHistory: {
            [accountId]: {
              [rewardAccount]: [
                delegationEntry,
                registrationEntry,
                withdrawalEntry,
              ],
            },
          },
          delegationActivities: {
            [accountId]: {
              [rewardAccount]: activities,
            },
          },
          networkInfo: {
            [testNetwork]: {
              eraSummaries: Serializable.to(mockEraSummaries),
            },
          },
        };

        const result = selectors.cardanoContext.selectDelegationActivities(
          { cardanoContext: state, network: networkState },
          { accountId, rewardAccount },
        );

        expect(result.activities).toHaveLength(3);
        expect(result.isLoadingActivities).toBe(false);
      });

      it('should indicate loading when history entries are more than activities', () => {
        const activities = Array.from({ length: 5 }, (_, index) =>
          createActivity(
            `activity${index}`,
            ActivityType.Delegation,
            1000 + index,
          ),
        );

        const historyEntries = Array.from({ length: 10 }, (_, index) => ({
          activeEpoch: Cardano.EpochNo(100 + index),
          txHash: Cardano.TransactionId(
            `80be2d8820b8946037764fcba8177a3eb1cae94bf8993def14dda20cb893${String(
              index,
            ).padStart(2, '0')}00`,
          ),
          amount: BigNumber(BigInt(1000000)),
          poolId: Cardano.PoolId(
            'pool1h8yl5mkyrfmfls2x9fu9mls3ry6egnw4q6efg34xr37zc243gkf',
          ),
        }));

        const state: CardanoContextSliceState = {
          ...initialState,
          accountDelegationsHistory: {
            [accountId]: {
              [rewardAccount]: historyEntries,
            },
          },
          delegationActivities: {
            [accountId]: {
              [rewardAccount]: activities,
            },
          },
        };

        const result = selectors.cardanoContext.selectDelegationActivities(
          { cardanoContext: state, network: networkState },
          { accountId, rewardAccount },
        );

        // History has 10 entries but only 5 activities, so still loading
        // Activities are not returned when isLoadingActivities is true
        expect(result.activities).toHaveLength(0);
        expect(result.isLoadingActivities).toBe(true);
      });

      it('should not indicate loading when history and activities have same length', () => {
        const activities = [
          createActivity('activity1', ActivityType.Delegation, 1000),
        ];

        const delegationEntry = {
          activeEpoch: Cardano.EpochNo(100),
          txHash: Cardano.TransactionId(
            '80be2d8820b8946037764fcba8177a3eb1cae94bf8993def14dda20cb89390c2',
          ),
          amount: BigNumber(BigInt(1000000)),
          poolId: Cardano.PoolId(
            'pool1h8yl5mkyrfmfls2x9fu9mls3ry6egnw4q6efg34xr37zc243gkf',
          ),
        };

        const state: CardanoContextSliceState = {
          ...initialState,
          accountDelegationsHistory: {
            [accountId]: {
              [rewardAccount]: [delegationEntry],
            },
          },
          delegationActivities: {
            [accountId]: {
              [rewardAccount]: activities,
            },
          },
        };

        const result = selectors.cardanoContext.selectDelegationActivities(
          { cardanoContext: state, network: networkState },
          { accountId, rewardAccount },
        );

        // History has 1 entry and 1 activity, so not loading
        expect(result.isLoadingActivities).toBe(false);
      });

      it('should return all activities regardless of history length', () => {
        const activities = Array.from({ length: 30 }, (_, index) =>
          createActivity(
            `activity${index}`,
            ActivityType.Delegation,
            1000 + index,
          ),
        );

        const historyEntries = Array.from({ length: 20 }, (_, index) => ({
          activeEpoch: Cardano.EpochNo(100 + index),
          txHash: Cardano.TransactionId(
            `80be2d8820b8946037764fcba8177a3eb1cae94bf8993def14dda20cb893${String(
              index,
            ).padStart(2, '0')}00`,
          ),
          amount: BigNumber(BigInt(1000000)),
          poolId: Cardano.PoolId(
            'pool1h8yl5mkyrfmfls2x9fu9mls3ry6egnw4q6efg34xr37zc243gkf',
          ),
        }));

        const state: CardanoContextSliceState = {
          ...initialState,
          accountDelegationsHistory: {
            [accountId]: {
              [rewardAccount]: historyEntries,
            },
          },
          delegationActivities: {
            [accountId]: {
              [rewardAccount]: activities,
            },
          },
        };

        const result = selectors.cardanoContext.selectDelegationActivities(
          { cardanoContext: state, network: networkState },
          { accountId, rewardAccount },
        );

        // History has 20 entries but 30 activities, so still loading
        // Activities are not returned when isLoadingActivities is true
        expect(result.activities).toHaveLength(0);
        expect(result.isLoadingActivities).toBe(true);
      });

      it('should merge rewards with activities when eraSummaries are available', () => {
        const activities = [
          createActivity('activity1', ActivityType.Delegation, 2000),
        ];

        const delegationEntry = {
          activeEpoch: Cardano.EpochNo(100),
          txHash: Cardano.TransactionId(
            '80be2d8820b8946037764fcba8177a3eb1cae94bf8993def14dda20cb89390c2',
          ),
          amount: BigNumber(BigInt(1000000)),
          poolId: Cardano.PoolId(
            'pool1h8yl5mkyrfmfls2x9fu9mls3ry6egnw4q6efg34xr37zc243gkf',
          ),
        };

        const mockEraSummaries: EraSummary[] = [
          {
            parameters: {
              epochLength: 432000,
              slotLength: 1 as Milliseconds,
            },
            start: {
              slot: 0,
              time: new Date(0),
            },
          },
        ];

        const mockRewards: Reward[] = [
          {
            epoch: Cardano.EpochNo(100),
            rewards: BigNumber(BigInt(5000000)),
            poolId: Cardano.PoolId(
              'pool1h8yl5mkyrfmfls2x9fu9mls3ry6egnw4q6efg34xr37zc243gkf',
            ),
          },
        ];

        const state: CardanoContextSliceState = {
          ...initialState,
          accountDelegationsHistory: {
            [accountId]: {
              [rewardAccount]: [delegationEntry],
            },
          },
          delegationActivities: {
            [accountId]: {
              [rewardAccount]: activities,
            },
          },
          accountRewardsHistory: {
            [accountId]: {
              [rewardAccount]: mockRewards,
            },
          },
          networkInfo: {
            [testNetwork]: {
              eraSummaries: Serializable.to(mockEraSummaries),
            },
          },
        };

        const result = selectors.cardanoContext.selectDelegationActivities(
          { cardanoContext: state, network: networkState },
          { accountId, rewardAccount },
        );

        // Should have activities plus rewards merged
        expect(result.activities.length).toBeGreaterThanOrEqual(1);
        expect(result.isLoadingActivities).toBe(false);
      });

      it('should not merge rewards with activities when isLoadingActivities is true', () => {
        const activities = [
          createActivity('activity1', ActivityType.Delegation, 2000),
        ];

        const delegationEntry1 = {
          activeEpoch: Cardano.EpochNo(100),
          txHash: Cardano.TransactionId(
            '80be2d8820b8946037764fcba8177a3eb1cae94bf8993def14dda20cb89390c2',
          ),
          amount: BigNumber(BigInt(1000000)),
          poolId: Cardano.PoolId(
            'pool1h8yl5mkyrfmfls2x9fu9mls3ry6egnw4q6efg34xr37zc243gkf',
          ),
        };

        const delegationEntry2 = {
          activeEpoch: Cardano.EpochNo(101),
          txHash: Cardano.TransactionId(
            '90be2d8820b8946037764fcba8177a3eb1cae94bf8993def14dda20cb89390c3',
          ),
          amount: BigNumber(BigInt(2000000)),
          poolId: Cardano.PoolId(
            'pool1h8yl5mkyrfmfls2x9fu9mls3ry6egnw4q6efg34xr37zc243gkf',
          ),
        };

        const mockEraSummaries: EraSummary[] = [
          {
            parameters: {
              epochLength: 432000,
              slotLength: 1 as Milliseconds,
            },
            start: {
              slot: 0,
              time: new Date(0),
            },
          },
        ];

        const mockRewards: Reward[] = [
          {
            epoch: Cardano.EpochNo(100),
            rewards: BigNumber(BigInt(5000000)),
            poolId: Cardano.PoolId(
              'pool1h8yl5mkyrfmfls2x9fu9mls3ry6egnw4q6efg34xr37zc243gkf',
            ),
          },
        ];

        const state: CardanoContextSliceState = {
          ...initialState,
          accountDelegationsHistory: {
            [accountId]: {
              [rewardAccount]: [delegationEntry1, delegationEntry2], // 2 entries
            },
          },
          delegationActivities: {
            [accountId]: {
              [rewardAccount]: activities, // Only 1 activity (still loading)
            },
          },
          accountRewardsHistory: {
            [accountId]: {
              [rewardAccount]: mockRewards,
            },
          },
          networkInfo: {
            [testNetwork]: {
              eraSummaries: Serializable.to(mockEraSummaries),
            },
          },
        };

        const result = selectors.cardanoContext.selectDelegationActivities(
          { cardanoContext: state, network: networkState },
          { accountId, rewardAccount },
        );

        // Should have no activities when isLoadingActivities is true
        // (activities are only returned when eraSummaries && !isLoadingActivities)
        expect(result.activities.length).toBe(0);
        expect(result.isLoadingActivities).toBe(true);
        // Verify no reward activities were added
        expect(
          result.activities.some(
            activity => activity.type === ActivityType.Rewards,
          ),
        ).toBe(false);
      });
    });
  });

  describe('retrySyncRound', () => {
    it('should be a trigger action that does not modify state', () => {
      const stateBefore = { ...initialState };
      const stateAfter = reducers.cardanoContext(
        stateBefore,
        actions.cardanoContext.retrySyncRound(),
      );

      expect(stateAfter).toEqual(stateBefore);
    });

    it('should create action without payload', () => {
      const action = actions.cardanoContext.retrySyncRound();

      expect(action.type).toBe('cardanoContext/retrySyncRound');
      expect(action.payload).toBeUndefined();
    });
  });

  describe('requestManualAddressDiscovery', () => {
    const testAccountId = AccountId('test-account');

    it('is a trigger action that does not modify state', () => {
      const stateBefore = { ...initialState };
      const stateAfter = reducers.cardanoContext(
        stateBefore,
        actions.cardanoContext.requestManualAddressDiscovery({
          accountId: testAccountId,
        }),
      );
      expect(stateAfter).toEqual(stateBefore);
    });

    it('carries the accountId payload', () => {
      const action = actions.cardanoContext.requestManualAddressDiscovery({
        accountId: testAccountId,
      });
      expect(action.type).toBe('cardanoContext/requestManualAddressDiscovery');
      expect(action.payload).toEqual({ accountId: testAccountId });
    });
  });

  describe('manual HD sync selectors', () => {
    const testAccountId = AccountId('test-account');
    const thoroughOpId = `${testAccountId}-tip-hash-address-discovery-thorough`;
    const standardOpId = `${testAccountId}-tip-hash-address-discovery`;

    const stateWithSync = (
      operations: Record<
        string,
        {
          operationId: string;
          status: 'Completed' | 'Failed' | 'InProgress' | 'Pending';
        }
      >,
    ) =>
      ({
        cardanoContext: initialState,
        sync: {
          syncStatusByAccount: {
            [testAccountId]: {
              pendingSync: {
                startedAt: Timestamp(1),
                operations,
              },
            },
          },
        },
      } as unknown as Parameters<
        typeof selectors.cardanoContext.selectIsManualHdSyncInProgress
      >[0]);

    describe('selectIsManualHdSyncInProgress', () => {
      it('returns true when a thorough op is Pending', () => {
        const state = stateWithSync({
          [thoroughOpId]: { operationId: thoroughOpId, status: 'Pending' },
        });
        expect(
          selectors.cardanoContext.selectIsManualHdSyncInProgress(
            state,
            testAccountId,
          ),
        ).toBe(true);
      });

      it('returns true when a thorough op is InProgress', () => {
        const state = stateWithSync({
          [thoroughOpId]: { operationId: thoroughOpId, status: 'InProgress' },
        });
        expect(
          selectors.cardanoContext.selectIsManualHdSyncInProgress(
            state,
            testAccountId,
          ),
        ).toBe(true);
      });

      it('returns false when only a standard ADDRESS_DISCOVERY op is pending', () => {
        const state = stateWithSync({
          [standardOpId]: { operationId: standardOpId, status: 'Pending' },
        });
        expect(
          selectors.cardanoContext.selectIsManualHdSyncInProgress(
            state,
            testAccountId,
          ),
        ).toBe(false);
      });

      it('returns false when the thorough op is Completed', () => {
        const state = stateWithSync({
          [thoroughOpId]: { operationId: thoroughOpId, status: 'Completed' },
        });
        expect(
          selectors.cardanoContext.selectIsManualHdSyncInProgress(
            state,
            testAccountId,
          ),
        ).toBe(false);
      });

      it('returns false when the account has no pendingSync', () => {
        const state = {
          cardanoContext: initialState,
          sync: { syncStatusByAccount: {} },
        } as unknown as Parameters<
          typeof selectors.cardanoContext.selectIsManualHdSyncInProgress
        >[0];
        expect(
          selectors.cardanoContext.selectIsManualHdSyncInProgress(
            state,
            testAccountId,
          ),
        ).toBe(false);
      });
    });

    describe('selectIsAddressDiscoveryInProgress', () => {
      it('returns true when a thorough op is Pending', () => {
        const state = stateWithSync({
          [thoroughOpId]: { operationId: thoroughOpId, status: 'Pending' },
        });
        expect(
          selectors.cardanoContext.selectIsAddressDiscoveryInProgress(
            state,
            testAccountId,
          ),
        ).toBe(true);
      });

      it('returns true when a standard ADDRESS_DISCOVERY op is Pending', () => {
        const state = stateWithSync({
          [standardOpId]: { operationId: standardOpId, status: 'Pending' },
        });
        expect(
          selectors.cardanoContext.selectIsAddressDiscoveryInProgress(
            state,
            testAccountId,
          ),
        ).toBe(true);
      });

      it('returns true when a standard ADDRESS_DISCOVERY op is InProgress', () => {
        const state = stateWithSync({
          [standardOpId]: { operationId: standardOpId, status: 'InProgress' },
        });
        expect(
          selectors.cardanoContext.selectIsAddressDiscoveryInProgress(
            state,
            testAccountId,
          ),
        ).toBe(true);
      });

      it('returns false when only a TRANSACTION_POLLING op is pending', () => {
        const txpOpId = `${testAccountId}-tip-hash-transaction-polling`;
        const state = stateWithSync({
          [txpOpId]: { operationId: txpOpId, status: 'InProgress' },
        });
        expect(
          selectors.cardanoContext.selectIsAddressDiscoveryInProgress(
            state,
            testAccountId,
          ),
        ).toBe(false);
      });

      it('returns false when the discovery op is Completed', () => {
        const state = stateWithSync({
          [standardOpId]: { operationId: standardOpId, status: 'Completed' },
        });
        expect(
          selectors.cardanoContext.selectIsAddressDiscoveryInProgress(
            state,
            testAccountId,
          ),
        ).toBe(false);
      });

      it('returns false when the account has no pendingSync', () => {
        const state = {
          cardanoContext: initialState,
          sync: { syncStatusByAccount: {} },
        } as unknown as Parameters<
          typeof selectors.cardanoContext.selectIsAddressDiscoveryInProgress
        >[0];
        expect(
          selectors.cardanoContext.selectIsAddressDiscoveryInProgress(
            state,
            testAccountId,
          ),
        ).toBe(false);
      });
    });

    describe('selectManualHdSyncTerminalStatus', () => {
      it('returns "Completed" when the thorough op reached Completed', () => {
        const state = stateWithSync({
          [thoroughOpId]: { operationId: thoroughOpId, status: 'Completed' },
        });
        expect(
          selectors.cardanoContext.selectManualHdSyncTerminalStatus(
            state,
            testAccountId,
          ),
        ).toBe('Completed');
      });

      it('returns "Failed" when the thorough op reached Failed', () => {
        const state = stateWithSync({
          [thoroughOpId]: { operationId: thoroughOpId, status: 'Failed' },
        });
        expect(
          selectors.cardanoContext.selectManualHdSyncTerminalStatus(
            state,
            testAccountId,
          ),
        ).toBe('Failed');
      });

      it('returns undefined while the thorough op is still InProgress', () => {
        const state = stateWithSync({
          [thoroughOpId]: { operationId: thoroughOpId, status: 'InProgress' },
        });
        expect(
          selectors.cardanoContext.selectManualHdSyncTerminalStatus(
            state,
            testAccountId,
          ),
        ).toBeUndefined();
      });

      it('ignores terminal status on a standard ADDRESS_DISCOVERY op', () => {
        const state = stateWithSync({
          [standardOpId]: { operationId: standardOpId, status: 'Completed' },
        });
        expect(
          selectors.cardanoContext.selectManualHdSyncTerminalStatus(
            state,
            testAccountId,
          ),
        ).toBeUndefined();
      });
    });

    describe('selectAccountIdInManualHdSync', () => {
      it('returns the accountId while a thorough op is Pending', () => {
        const state = stateWithSync({
          [thoroughOpId]: { operationId: thoroughOpId, status: 'Pending' },
        });
        expect(
          selectors.cardanoContext.selectAccountIdInManualHdSync(state),
        ).toBe(testAccountId);
      });

      it('returns the accountId while a thorough op is InProgress', () => {
        const state = stateWithSync({
          [thoroughOpId]: { operationId: thoroughOpId, status: 'InProgress' },
        });
        expect(
          selectors.cardanoContext.selectAccountIdInManualHdSync(state),
        ).toBe(testAccountId);
      });

      it('still returns the accountId after the thorough op reaches Completed but before pendingSync clears', () => {
        const state = stateWithSync({
          [thoroughOpId]: { operationId: thoroughOpId, status: 'Completed' },
        });
        expect(
          selectors.cardanoContext.selectAccountIdInManualHdSync(state),
        ).toBe(testAccountId);
      });

      it('returns undefined when only a standard ADDRESS_DISCOVERY op is pending', () => {
        const state = stateWithSync({
          [standardOpId]: { operationId: standardOpId, status: 'Pending' },
        });
        expect(
          selectors.cardanoContext.selectAccountIdInManualHdSync(state),
        ).toBeUndefined();
      });

      it('returns undefined when no account has pendingSync', () => {
        const state = {
          cardanoContext: initialState,
          sync: { syncStatusByAccount: {} },
        } as unknown as Parameters<
          typeof selectors.cardanoContext.selectAccountIdInManualHdSync
        >[0];
        expect(
          selectors.cardanoContext.selectAccountIdInManualHdSync(state),
        ).toBeUndefined();
      });
    });
  });

  describe('selectActiveNetworkHasSyncFailure', () => {
    const accountId1 = AccountId('cardano-active-1');
    const accountId2 = AccountId('cardano-active-2');

    const account = (accountId: AccountId): AnyAccount =>
      ({ accountId } as AnyAccount);

    const syncFailure = (accountId: AccountId): Failure => ({
      failureId: CardanoSyncFailureId(accountId),
      message: 'sync.error.cardano-sync-round-failed' as TranslationKey,
    });

    it('returns true when an active-network account has a Cardano sync failure', () => {
      const accounts = [account(accountId1), account(accountId2)];
      const failures: Record<FailureId, Failure> = {
        [CardanoSyncFailureId(accountId2)]: syncFailure(accountId2),
      };

      expect(
        selectors.cardanoContext.selectActiveNetworkHasSyncFailure.resultFunc(
          accounts,
          failures,
        ),
      ).toBe(true);
    });

    it('returns false when no active-network account has a Cardano sync failure', () => {
      const accounts = [account(accountId1)];
      const failures: Record<FailureId, Failure> = {};

      expect(
        selectors.cardanoContext.selectActiveNetworkHasSyncFailure.resultFunc(
          accounts,
          failures,
        ),
      ).toBe(false);
    });

    it('returns false when only a non-active-network account has a failure', () => {
      // The selector receives only active-network accounts, so a failure for
      // an account on another network (accountId2, absent from `accounts`)
      // must not count.
      const accounts = [account(accountId1)];
      const failures: Record<FailureId, Failure> = {
        [CardanoSyncFailureId(accountId2)]: syncFailure(accountId2),
      };

      expect(
        selectors.cardanoContext.selectActiveNetworkHasSyncFailure.resultFunc(
          accounts,
          failures,
        ),
      ).toBe(false);
    });
  });
});

describe('wallet sync reset', () => {
  const accountId = AccountId('reset-target');
  const otherId = AccountId('other-account');

  it.each(['Pending', 'InProgress', 'Completed', 'Failed'] as const)(
    'selects reset operations and suppresses discovery outcomes (%s)',
    status => {
      const operation = {
        operationId: 'tip-wallet-reset',
        status,
        startedAt: Timestamp(0),
        description: 'sync.operation.address-discovery' as const,
      };
      const statuses = {
        [accountId]: {
          pendingSync: {
            startedAt: Timestamp(0),
            operations: { reset: operation },
          },
        },
      } as Parameters<
        typeof selectors.cardanoContext.selectWalletSyncResetOperation.resultFunc
      >[0];
      expect(
        selectors.cardanoContext.selectWalletSyncResetOperation.resultFunc(
          statuses,
          accountId,
        ),
      ).toBe(operation);
      expect(
        selectors.cardanoContext.selectWalletSyncResetOperation.resultFunc(
          statuses,
          otherId,
        ),
      ).toBeUndefined();
      expect(
        selectors.cardanoContext.selectAccountIdInManualHdSync.resultFunc(
          statuses,
        ),
      ).toBe(accountId);
      expect(
        selectors.cardanoContext.selectIsManualHdSyncInProgress.resultFunc(
          statuses,
          accountId,
        ),
      ).toBe(status === 'Pending' || status === 'InProgress');
      expect(
        selectors.cardanoContext.selectIsManualHdSyncInProgress.resultFunc(
          statuses,
          otherId,
        ),
      ).toBe(false);
      expect(
        selectors.cardanoContext.selectManualHdSyncTerminalStatus.resultFunc(
          statuses,
          accountId,
        ),
      ).toBeUndefined();
    },
  );

  it('does not select an ordinary operation as a reset', () => {
    const statuses = {
      [accountId]: {
        pendingSync: {
          startedAt: Timestamp(0),
          operations: {
            polling: {
              operationId: 'tip-transaction-polling',
              status: 'Pending' as const,
              startedAt: Timestamp(0),
              description: 'sync.operation.address-discovery' as const,
            },
          },
        },
      },
    };
    expect(
      selectors.cardanoContext.selectWalletSyncResetOperation.resultFunc(
        statuses,
        accountId,
      ),
    ).toBeUndefined();
  });

  it('guards unavailable accounts and pending transactions only for the requested account', () => {
    const account = threeAccountCardanoWalletAccounts[0];
    const guard =
      selectors.cardanoContext.selectWalletSyncResetBlockedReason.resultFunc;
    expect(guard(undefined, {}, {})).toBe('unavailable');
    expect(
      guard({ ...account, blockchainName: 'Bitcoin' } as AnyAccount, {}, {}),
    ).toBe('unavailable');
    const pending = { [account.accountId]: [{}] } as Parameters<
      typeof guard
    >[1];
    expect(guard(account, pending, {})).toBe('pending-transactions');
    expect(
      guard(threeAccountCardanoWalletAccounts[1], pending, {}),
    ).toBeUndefined();
  });

  it.each(['Pending', 'InProgress', 'Completed', 'Failed'] as const)(
    'guards only active operations for the requested account (%s)',
    status => {
      const account = threeAccountCardanoWalletAccounts[0];
      const guard =
        selectors.cardanoContext.selectWalletSyncResetBlockedReason.resultFunc;
      const statuses = {
        [account.accountId]: {
          pendingSync: {
            startedAt: Timestamp(0),
            operations: {
              operation: {
                operationId: 'round-wallet-reset',
                status,
                startedAt: Timestamp(0),
                description: 'sync.operation.address-discovery' as const,
              },
            },
          },
        },
      } as Parameters<typeof guard>[2];
      expect(guard(account, {}, statuses)).toBe(
        status === 'Pending' || status === 'InProgress' ? 'syncing' : undefined,
      );
      expect(
        guard(threeAccountCardanoWalletAccounts[1], {}, statuses),
      ).toBeUndefined();
    },
  );

  it('preserves the stable SDK selectors resultFunc calling conventions', () => {
    expect(
      selectors.cardanoContext.selectAccountIdInManualHdSync.resultFunc({}),
    ).toBeUndefined();
    expect(
      selectors.cardanoContext.selectManualHdSyncTerminalStatus.resultFunc(
        {},
        accountId,
      ),
    ).toBeUndefined();
  });

  it('clears derived state only for the requested account and preserves security and network state', () => {
    const initial = reducers.cardanoContext(undefined, { type: 'init' });
    const utxos = {
      [accountId]: { utxos: Serializable.to([] as Cardano.Utxo[]) },
      [otherId]: { utxos: Serializable.to([] as Cardano.Utxo[]) },
    };
    const state = {
      ...initial,
      accountUtxos: utxos,
      accountTransactionHistory: { [accountId]: {}, [otherId]: {} },
      accountRewardsHistory: { [accountId]: {}, [otherId]: {} },
      securityScanByAccount: { [accountId]: { scannedAt: 1, exploits: [] } },
    };
    const next = reducers.cardanoContext(
      state,
      actions.cardanoContext.resetWalletSyncState({ accountId }),
    );
    expect(next.accountUtxos[accountId]).toBe(state.accountUtxos[accountId]);
    expect(next.accountUnspendableUtxos).toBe(state.accountUnspendableUtxos);
    expect(next.accountTransactionHistory[accountId]).toBeUndefined();
    expect(next.accountRewardsHistory[accountId]).toBeUndefined();
    expect(next.accountUtxos[otherId]).toBe(state.accountUtxos[otherId]);
    expect(next.accountTransactionHistory[otherId]).toBe(
      state.accountTransactionHistory[otherId],
    );
    expect(next.securityScanByAccount).toBe(state.securityScanByAccount);
    expect(next.networkInfo).toBe(state.networkInfo);
  });
});
