import { activitiesReducers } from '@lace-contract/activities/src/store/slice';
import { AccountId, WalletType } from '@lace-contract/wallet-repo';
import { Cardano } from '@lace-lib/cardano-core';
import { testSideEffect } from '@lace-lib/util-dev';
import { afterEach, describe, expect, it } from 'vitest';

import { CardanoNetworkId, pendingRewardWithdrawalKey } from '../../../src';
import {
  cardanoSettledAvailableAccountUtxos$,
  cardanoPendingRewardWithdrawals$,
} from '../../../src/cardano-observables';
import {
  wireSettledAvailableAccountUtxosObservable,
  wirePendingRewardWithdrawalsObservable,
} from '../../../src/store/side-effects';
import {
  cardanoContextActions,
  cardanoContextReducers,
  cardanoContextSelectors,
  initialState,
} from '../../../src/store/slice';
import { recordInFlight } from '../../in-flight-mocks';
import { utxo1, utxo2 } from '../../mocks';

import type { CardanoContextSliceState } from '../../../src/store/slice';

const accountId = AccountId('test-account-1');
const selectors = cardanoContextSelectors.cardanoContext;

/** One Preprod account holding the address `utxo1` and `utxo2` pay. */
const stateOf = (cardanoContext: CardanoContextSliceState) =>
  ({
    cardanoContext,
    activities: activitiesReducers.activities(undefined, { type: 'init' }),
    addresses: {
      addresses: [
        {
          name: 'test',
          address: utxo1[0].address,
          blockchainName: 'Cardano',
          accountId,
        },
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
            {
              accountId,
              walletId: 'wallet',
              accountType: 'InMemory',
              blockchainName: 'Cardano',
              blockchainNetworkId: CardanoNetworkId(
                Cardano.NetworkMagics.Preprod,
              ),
            },
          ],
        },
      },
    },
  } as unknown as Parameters<
    typeof selectors.selectSettledAvailableAccountUtxos
  >[0]);

describe('wireSettledAvailableAccountUtxosObservable', () => {
  afterEach(() => {
    cardanoSettledAvailableAccountUtxos$.next({});
  });

  it('hands builders the settled UTxOs no in-flight transaction spends, not the settled set', () => {
    const settled = cardanoContextReducers.cardanoContext(
      initialState,
      cardanoContextActions.cardanoContext.setAccountUtxos({
        accountId,
        utxos: [utxo1, utxo2],
      }),
    );
    const change: Cardano.Utxo = [
      { ...utxo1[0], txId: Cardano.TransactionId('ab'.repeat(32)), index: 0 },
      utxo1[1],
    ];
    // A transaction still in flight spends utxo1 and pays its change back.
    const state = stateOf(
      recordInFlight(settled, {
        txId: change[0].txId,
        consumedInputs: [utxo1[0]],
        producedOutputs: [change],
      }),
    );

    testSideEffect(
      wireSettledAvailableAccountUtxosObservable,
      ({ cold, expectObservable }) => ({
        stateObservables: {
          cardanoContext: {
            selectAccountUtxos$: cold('a', {
              a: selectors.selectAccountUtxos(state),
            }),
            selectSettledAvailableAccountUtxos$: cold('a', {
              a: selectors.selectSettledAvailableAccountUtxos(state),
            }),
          },
        },
        assertion: sideEffect$ => {
          expectObservable(sideEffect$).toBe('-');
        },
      }),
    );

    expect(cardanoSettledAvailableAccountUtxos$.getValue()).toEqual({
      [accountId]: [utxo2],
    });
  });
});

describe('wirePendingRewardWithdrawalsObservable', () => {
  afterEach(() => {
    cardanoPendingRewardWithdrawals$.next(new Map());
  });

  it('hands builders the rewards in-flight transactions withdraw', () => {
    const rewardAccount = Cardano.RewardAccount(
      'stake_test1up7pvfq8zn4quy45r2g572290p9vf99mr9tn7r9xrgy2l2qdsf58d',
    );
    const state = stateOf(
      recordInFlight(initialState, {
        txId: Cardano.TransactionId('ab'.repeat(32)),
        withdrawals: [{ stakeAddress: rewardAccount, quantity: 5_000_000n }],
      }),
    );

    testSideEffect(
      wirePendingRewardWithdrawalsObservable,
      ({ cold, expectObservable }) => ({
        stateObservables: {
          cardanoContext: {
            selectPendingRewardWithdrawals$: cold('a', {
              a: selectors.selectPendingRewardWithdrawals(state),
            }),
          },
        },
        assertion: sideEffect$ => {
          expectObservable(sideEffect$).toBe('-');
        },
      }),
    );

    expect(cardanoPendingRewardWithdrawals$.getValue()).toEqual(
      new Map([
        [
          pendingRewardWithdrawalKey(
            Cardano.NetworkMagics.Preprod,
            rewardAccount,
          ),
          5_000_000n,
        ],
      ]),
    );
  });
});
