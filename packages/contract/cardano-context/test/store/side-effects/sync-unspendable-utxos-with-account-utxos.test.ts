import { AccountId, WalletType } from '@lace-contract/wallet-repo';
import { Cardano } from '@lace-lib/cardano-core';
import { testSideEffect } from '@lace-lib/util-dev';
import { describe, expect, it } from 'vitest';

import { CardanoNetworkId } from '../../../src';
import { syncUnspendableUtxosWithAccountUtxos } from '../../../src/store/side-effects/sync-unspendable-utxos-with-account-utxos';
import {
  cardanoContextActions,
  cardanoContextReducers,
  cardanoContextSelectors,
  initialState,
} from '../../../src/store/slice';
import { recordInFlight } from '../../in-flight-mocks';
import { utxo1, utxo2 } from '../../mocks';

import type { CardanoContextSliceState } from '../../../src/store/slice';
import type {
  AccountUtxoMap,
  AccountUnspendableUtxoMap,
} from '../../../src/types';

const actions = {
  ...cardanoContextActions,
};

const accountId = AccountId('test-account-1');

/** The state the ownership view reads: one Preprod account at `utxo1`'s address. */
const stateOf = (cardanoContext: CardanoContextSliceState) =>
  ({
    cardanoContext,
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
    typeof cardanoContextSelectors.cardanoContext.selectCollateralOwnershipUtxos
  >[0]);

describe('syncUnspendableUtxosWithAccountUtxos', () => {
  it('preserves reserved collateral through reset and refresh, then removes it only when spent', () => {
    const reducer = cardanoContextReducers.cardanoContext;
    const selectors = cardanoContextSelectors.cardanoContext;
    const funded = reducer(
      undefined,
      actions.cardanoContext.setAccountUtxos({
        accountId,
        utxos: [utxo1, utxo2],
      }),
    );
    const reserved = reducer(
      funded,
      actions.cardanoContext.setAccountUnspendableUtxos({
        accountId,
        utxos: [utxo1],
      }),
    );
    const reset = reducer(
      reserved,
      actions.cardanoContext.resetWalletSyncState({ accountId }),
    );
    const refreshed = reducer(
      reset,
      actions.cardanoContext.setAccountUtxos({ accountId, utxos: [utxo1] }),
    );
    const spent = reducer(
      refreshed,
      actions.cardanoContext.setAccountUtxos({ accountId, utxos: [] }),
    );
    expect(
      selectors.selectAccountUnspendableUtxos({ cardanoContext: reset }),
    ).toEqual({ [accountId]: [utxo1] });

    testSideEffect(
      syncUnspendableUtxosWithAccountUtxos,
      ({ cold, expectObservable }) => ({
        stateObservables: {
          cardanoContext: {
            selectCollateralOwnershipUtxos$: cold('a-b-c-d', {
              a: selectors.selectCollateralOwnershipUtxos(stateOf(reserved)),
              b: selectors.selectCollateralOwnershipUtxos(stateOf(reset)),
              c: selectors.selectCollateralOwnershipUtxos(stateOf(refreshed)),
              d: selectors.selectCollateralOwnershipUtxos(stateOf(spent)),
            }),
            selectAccountUnspendableUtxos$: cold('a', {
              a: selectors.selectAccountUnspendableUtxos({
                cardanoContext: reset,
              }),
            }),
          },
        },
        dependencies: { actions },
        assertion: sideEffect$ => {
          expectObservable(sideEffect$).toBe('------a', {
            a: actions.cardanoContext.setAccountUnspendableUtxos({
              accountId,
              utxos: [],
            }),
          });
        },
      }),
    );
  });

  describe('a reservation of an output an in-flight transaction pays to the account', () => {
    const settled = cardanoContextReducers.cardanoContext(
      initialState,
      actions.cardanoContext.setAccountUtxos({ accountId, utxos: [utxo1] }),
    );
    // The collateral flow's transaction spends utxo1 and pays utxo2.
    const inFlight = recordInFlight(settled, {
      txId: utxo2[0].txId,
      consumedInputs: [utxo1[0]],
      producedOutputs: [utxo2],
    });
    const ownershipOf = (cardanoContext: CardanoContextSliceState) =>
      cardanoContextSelectors.cardanoContext.selectCollateralOwnershipUtxos(
        stateOf(cardanoContext),
      );

    it('keeps the reservation while the entry pays it and once the settled set lists it', () => {
      const settlement = cardanoContextReducers.cardanoContext(
        initialState,
        actions.cardanoContext.setAccountUtxos({ accountId, utxos: [utxo2] }),
      );

      testSideEffect(
        syncUnspendableUtxosWithAccountUtxos,
        ({ cold, expectObservable }) => ({
          stateObservables: {
            cardanoContext: {
              selectCollateralOwnershipUtxos$: cold('a-b', {
                a: ownershipOf(inFlight),
                b: ownershipOf(settlement),
              }),
              selectAccountUnspendableUtxos$: cold('a', {
                a: { [accountId]: [utxo2] },
              }),
            },
          },
          dependencies: { actions },
          assertion: sideEffect$ => {
            expectObservable(sideEffect$).toBe('---');
          },
        }),
      );
    });

    it('drops the reservation once the entry is removed and the settled set lacks the output', () => {
      testSideEffect(
        syncUnspendableUtxosWithAccountUtxos,
        ({ cold, expectObservable }) => ({
          stateObservables: {
            cardanoContext: {
              selectCollateralOwnershipUtxos$: cold('a-b', {
                a: ownershipOf(inFlight),
                b: ownershipOf(settled),
              }),
              selectAccountUnspendableUtxos$: cold('a', {
                a: { [accountId]: [utxo2] },
              }),
            },
          },
          dependencies: { actions },
          assertion: sideEffect$ => {
            expectObservable(sideEffect$).toBe('--a', {
              a: actions.cardanoContext.setAccountUnspendableUtxos({
                accountId,
                utxos: [],
              }),
            });
          },
        }),
      );
    });
  });

  it('dispatches setAccountUnspendableUtxos when the account no longer owns some reserved UTxOs', () => {
    testSideEffect(
      syncUnspendableUtxosWithAccountUtxos,
      ({ cold, expectObservable }) => {
        const selectCollateralOwnershipUtxos$ = cold<AccountUtxoMap>('a', {
          a: { [accountId]: [utxo1] },
        });
        const selectAccountUnspendableUtxos$ = cold<AccountUnspendableUtxoMap>(
          'a',
          {
            a: { [accountId]: [utxo1, utxo2] },
          },
        );

        return {
          stateObservables: {
            cardanoContext: {
              selectCollateralOwnershipUtxos$,
              selectAccountUnspendableUtxos$,
            },
          },
          dependencies: { actions },
          assertion: sideEffect$ => {
            expectObservable(sideEffect$).toBe('a', {
              a: actions.cardanoContext.setAccountUnspendableUtxos({
                accountId,
                utxos: [utxo1],
              }),
            });
          },
        };
      },
    );
  });

  it('does not dispatch when the account still owns every reserved UTxO', () => {
    testSideEffect(
      syncUnspendableUtxosWithAccountUtxos,
      ({ cold, expectObservable }) => {
        const selectCollateralOwnershipUtxos$ = cold<AccountUtxoMap>('a', {
          a: { [accountId]: [utxo1, utxo2] },
        });
        const selectAccountUnspendableUtxos$ = cold<AccountUnspendableUtxoMap>(
          'a',
          {
            a: { [accountId]: [utxo1, utxo2] },
          },
        );

        return {
          stateObservables: {
            cardanoContext: {
              selectCollateralOwnershipUtxos$,
              selectAccountUnspendableUtxos$,
            },
          },
          dependencies: { actions },
          assertion: sideEffect$ => {
            expectObservable(sideEffect$).toBe('-');
          },
        };
      },
    );
  });

  it('does not dispatch when accountUnspendableUtxos is empty', () => {
    testSideEffect(
      syncUnspendableUtxosWithAccountUtxos,
      ({ cold, expectObservable }) => {
        const selectCollateralOwnershipUtxos$ = cold<AccountUtxoMap>('a', {
          a: { [accountId]: [utxo1] },
        });
        const selectAccountUnspendableUtxos$ = cold<AccountUnspendableUtxoMap>(
          'a',
          {
            a: {},
          },
        );

        return {
          stateObservables: {
            cardanoContext: {
              selectCollateralOwnershipUtxos$,
              selectAccountUnspendableUtxos$,
            },
          },
          dependencies: { actions },
          assertion: sideEffect$ => {
            expectObservable(sideEffect$).toBe('-');
          },
        };
      },
    );
  });

  it('dispatches setAccountUnspendableUtxos with empty array when the account owns none of its reserved UTxOs', () => {
    testSideEffect(
      syncUnspendableUtxosWithAccountUtxos,
      ({ cold, expectObservable }) => {
        const selectCollateralOwnershipUtxos$ = cold<AccountUtxoMap>('a', {
          a: { [accountId]: [] },
        });
        const selectAccountUnspendableUtxos$ = cold<AccountUnspendableUtxoMap>(
          'a',
          {
            a: { [accountId]: [utxo1, utxo2] },
          },
        );

        return {
          stateObservables: {
            cardanoContext: {
              selectCollateralOwnershipUtxos$,
              selectAccountUnspendableUtxos$,
            },
          },
          dependencies: { actions },
          assertion: sideEffect$ => {
            expectObservable(sideEffect$).toBe('a', {
              a: actions.cardanoContext.setAccountUnspendableUtxos({
                accountId,
                utxos: [],
              }),
            });
          },
        };
      },
    );
  });
});
