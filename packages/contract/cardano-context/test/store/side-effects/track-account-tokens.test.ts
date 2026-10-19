import { Cardano, Serialization } from '@cardano-sdk/core';
import { Hash32ByteBase16 } from '@cardano-sdk/crypto';
import { HexBlob } from '@cardano-sdk/util';
import { TokenId } from '@lace-contract/tokens';
import { tokensActions } from '@lace-contract/tokens';
import { classifyCustodyAccountUtxos } from '@lace-lib/cardano-custody';
import { BigNumber } from '@lace-lib/util';
import { testSideEffect } from '@lace-lib/util-dev';
import { describe, it } from 'vitest';

import { CardanoPaymentAddress } from '../../../src';
import { LOVELACE_TOKEN_ID } from '../../../src/const';
import { trackAccountTokens } from '../../../src/store/side-effects/track-account-tokens';
import {
  cardanoCustodyAccount,
  controlUtxo,
  custodyAddress,
  custodyGrant,
  custodyLovelaceScope,
  custodyState,
  custodyUtxo,
  grantUtxo,
} from '../../custody-mocks';
import {
  cardanoAccount0Addr,
  cardanoAccount2Addr1,
  cardanoAccount2Addr2,
  threeAccountCardanoWalletAccounts,
} from '../../mocks';

import type { CardanoCustodyAccountState } from '../../../src';
import type {
  AccountRewardAccountDetailsMap,
  AccountUtxoMap,
  CardanoBip32AccountProps,
  CardanoCustodyAccountProps,
  CardanoMultiSigAccountProps,
} from '../../../src/types';
import type { AccountId, AnyAccount } from '@lace-contract/wallet-repo';

type CardanoAccount = AnyAccount<
  CardanoBip32AccountProps,
  CardanoBip32AccountProps,
  CardanoMultiSigAccountProps,
  CardanoCustodyAccountProps
>;

const actions = {
  ...tokensActions,
};

type AccountTokensByAddress = Parameters<
  typeof actions.tokens.setAccountTokens
>[0]['byAddress'];

const account0 = threeAccountCardanoWalletAccounts[0];
const account2 = threeAccountCardanoWalletAccounts[2];

const assetId = Cardano.AssetId(
  '659f2917fb63f12b33667463ee575eeac1845bbc736b9c0bbc40ba8254534c41',
);

describe('trackAccountTokens', () => {
  it('computes and aggregates tokens from multiple utxos across addresses', () => {
    testSideEffect(trackAccountTokens, ({ cold, expectObservable }) => {
      // Account2 has 2 addresses with multiple UTXOs containing coins and assets
      const utxos: Cardano.Utxo[] = [
        // First address: 2 UTXOs
        [
          {
            address: Cardano.PaymentAddress(cardanoAccount2Addr1.address),
            txId: Cardano.TransactionId(
              '39a7a284c2a0948189dc45dec670211cd4d72f7b66c5726c08d9b3df11e44d58',
            ),
            index: 0,
          },
          {
            address: Cardano.PaymentAddress(cardanoAccount2Addr1.address),
            value: {
              coins: 3_000_000n,
              assets: new Map([[assetId, 100n]]),
            },
          },
        ],
        [
          {
            address: Cardano.PaymentAddress(cardanoAccount2Addr1.address),
            txId: Cardano.TransactionId(
              '4c4e67bafa15e742c13c592b65c8f74c769cd7d9af04c848099672d1ba391b49',
            ),
            index: 1,
          },
          {
            address: Cardano.PaymentAddress(cardanoAccount2Addr1.address),
            value: {
              coins: 2_000_000n,
              assets: new Map([[assetId, 50n]]),
            },
          },
        ],
        // Second address: 1 UTXO
        [
          {
            address: Cardano.PaymentAddress(cardanoAccount2Addr2.address),
            txId: Cardano.TransactionId(
              '5555555555555555555555555555555555555555555555555555555555555555',
            ),
            index: 0,
          },
          {
            address: Cardano.PaymentAddress(cardanoAccount2Addr2.address),
            value: {
              coins: 1_000_000n,
              assets: new Map(),
            },
          },
        ],
      ];

      const selectActiveCardanoAccounts$ = cold<CardanoAccount[]>('a', {
        a: [account2],
      });

      const selectAccountUtxosWithInFlight$ = cold<AccountUtxoMap>('a', {
        a: { [account2.accountId]: utxos },
      });

      const selectRewardAccountDetails$ = cold<AccountRewardAccountDetailsMap>(
        'a',
        { a: {} },
      );

      return {
        stateObservables: {
          cardanoContext: {
            selectActiveCardanoAccounts$,
            selectAccountUtxosWithInFlight$,
            selectRewardAccountDetails$,
          },
        },
        dependencies: { actions },
        assertion: sideEffect$ => {
          expectObservable(sideEffect$).toBe('a', {
            a: actions.tokens.setAccountTokens({
              blockchainName: 'Cardano',
              accountId: account2.accountId,
              byAddress: [
                {
                  address: cardanoAccount2Addr1.address,
                  tokens: [
                    {
                      tokenId: LOVELACE_TOKEN_ID,
                      available: BigNumber(5_000_000n), // 3M + 2M aggregated
                      pending: BigNumber(0n),
                    },
                    {
                      tokenId: TokenId(assetId),
                      available: BigNumber(150n), // 100 + 50 aggregated
                      pending: BigNumber(0n),
                    },
                  ],
                },
                {
                  address: cardanoAccount2Addr2.address,
                  tokens: [
                    {
                      tokenId: LOVELACE_TOKEN_ID,
                      available: BigNumber(1_000_000n),
                      pending: BigNumber(0n),
                    },
                  ],
                },
              ],
            }),
          });
        },
      };
    });
  });

  it('emits new tokens when account utxos change', () => {
    testSideEffect(trackAccountTokens, ({ cold, expectObservable }) => {
      const utxosInitial: Cardano.Utxo[] = [
        [
          {
            address: Cardano.PaymentAddress(cardanoAccount0Addr.address),
            txId: Cardano.TransactionId(
              '39a7a284c2a0948189dc45dec670211cd4d72f7b66c5726c08d9b3df11e44d58',
            ),
            index: 0,
          },
          {
            address: Cardano.PaymentAddress(cardanoAccount0Addr.address),
            value: { coins: 5_000_000n, assets: new Map() },
          },
        ],
      ];

      const utxosUpdated: Cardano.Utxo[] = [
        [
          {
            address: Cardano.PaymentAddress(cardanoAccount0Addr.address),
            txId: Cardano.TransactionId(
              '4c4e67bafa15e742c13c592b65c8f74c769cd7d9af04c848099672d1ba391b49',
            ),
            index: 0,
          },
          {
            address: Cardano.PaymentAddress(cardanoAccount0Addr.address),
            value: { coins: 10_000_000n, assets: new Map() },
          },
        ],
      ];

      const selectActiveCardanoAccounts$ = cold<CardanoAccount[]>('a', {
        a: [account0],
      });

      const selectAccountUtxosWithInFlight$ = cold<AccountUtxoMap>('a--b', {
        a: { [account0.accountId]: utxosInitial },
        b: { [account0.accountId]: utxosUpdated },
      });

      const selectRewardAccountDetails$ = cold<AccountRewardAccountDetailsMap>(
        'a',
        { a: {} },
      );

      return {
        stateObservables: {
          cardanoContext: {
            selectActiveCardanoAccounts$,
            selectAccountUtxosWithInFlight$,
            selectRewardAccountDetails$,
          },
        },
        dependencies: { actions },
        assertion: sideEffect$ => {
          expectObservable(sideEffect$).toBe('a--b', {
            a: actions.tokens.setAccountTokens({
              blockchainName: 'Cardano',
              accountId: account0.accountId,
              byAddress: [
                {
                  address: cardanoAccount0Addr.address,
                  tokens: [
                    {
                      tokenId: LOVELACE_TOKEN_ID,
                      available: BigNumber(5_000_000n),
                      pending: BigNumber(0n),
                    },
                  ],
                },
              ],
            }),
            b: actions.tokens.setAccountTokens({
              blockchainName: 'Cardano',
              accountId: account0.accountId,
              byAddress: [
                {
                  address: cardanoAccount0Addr.address,
                  tokens: [
                    {
                      tokenId: LOVELACE_TOKEN_ID,
                      available: BigNumber(10_000_000n),
                      pending: BigNumber(0n),
                    },
                  ],
                },
              ],
            }),
          });
        },
      };
    });
  });

  it('includes withdrawable reward amount in ADA for first address', () => {
    testSideEffect(trackAccountTokens, ({ cold, expectObservable }) => {
      const utxos: Cardano.Utxo[] = [
        [
          {
            address: Cardano.PaymentAddress(cardanoAccount0Addr.address),
            txId: Cardano.TransactionId(
              '39a7a284c2a0948189dc45dec670211cd4d72f7b66c5726c08d9b3df11e44d58',
            ),
            index: 0,
          },
          {
            address: Cardano.PaymentAddress(cardanoAccount0Addr.address),
            value: { coins: 5_000_000n, assets: new Map() },
          },
        ],
      ];

      const selectActiveCardanoAccounts$ = cold<CardanoAccount[]>('a', {
        a: [account0],
      });

      const selectAccountUtxosWithInFlight$ = cold<AccountUtxoMap>('a', {
        a: { [account0.accountId]: utxos },
      });

      const selectRewardAccountDetails$ = cold<AccountRewardAccountDetailsMap>(
        'a',
        {
          a: {
            [account0.accountId]: {
              rewardAccountInfo: {
                rewardsSum: BigNumber(2_000_000n),
                isActive: true,
                isRegistered: true,
                controlledAmount: BigNumber(10_000_000n),
                withdrawableAmount: BigNumber(2_000_000n), // used for ADA balance
              },
            },
          },
        },
      );

      return {
        stateObservables: {
          cardanoContext: {
            selectActiveCardanoAccounts$,
            selectAccountUtxosWithInFlight$,
            selectRewardAccountDetails$,
          },
        },
        dependencies: { actions },
        assertion: sideEffect$ => {
          expectObservable(sideEffect$).toBe('a', {
            a: actions.tokens.setAccountTokens({
              blockchainName: 'Cardano',
              accountId: account0.accountId,
              byAddress: [
                {
                  address: cardanoAccount0Addr.address,
                  tokens: [
                    {
                      tokenId: LOVELACE_TOKEN_ID,
                      available: BigNumber(7_000_000n), // 5M utxo + 2M withdrawable
                      pending: BigNumber(0n),
                    },
                  ],
                },
              ],
            }),
          });
        },
      };
    });
  });

  it('emits empty byAddress when account has no utxos', () => {
    testSideEffect(trackAccountTokens, ({ cold, expectObservable }) => {
      const selectActiveCardanoAccounts$ = cold<CardanoAccount[]>('a', {
        a: [account0],
      });

      const selectAccountUtxosWithInFlight$ = cold<AccountUtxoMap>('a', {
        a: { [account0.accountId]: [] },
      });

      const selectRewardAccountDetails$ = cold<AccountRewardAccountDetailsMap>(
        'a',
        { a: {} },
      );

      return {
        stateObservables: {
          cardanoContext: {
            selectActiveCardanoAccounts$,
            selectAccountUtxosWithInFlight$,
            selectRewardAccountDetails$,
          },
        },
        dependencies: { actions },
        assertion: sideEffect$ => {
          expectObservable(sideEffect$).toBe('a', {
            a: actions.tokens.setAccountTokens({
              blockchainName: 'Cardano',
              accountId: account0.accountId,
              byAddress: [],
            }),
          });
        },
      };
    });
  });

  describe('custody accounts', () => {
    const custodyAccountId = cardanoCustodyAccount.accountId;
    const control = controlUtxo(1);
    const fund = custodyUtxo(2, {
      value: { coins: 4_000_000n, assets: new Map([[assetId, 3n]]) },
    });
    const otherFund = custodyUtxo(3, { coins: 1_000_000n });
    const referenceScriptFund = custodyUtxo(9, {
      value: { coins: 6_000_000n, assets: new Map([[assetId, 4n]]) },
      scriptReference: {
        __type: Cardano.ScriptType.Native,
        kind: Cardano.NativeScriptKind.RequireAnyOf,
        scripts: [],
      },
    });
    const stranded = custodyUtxo(4, {
      coins: 9_000_000n,
      datumHash: Hash32ByteBase16('dd'.repeat(32)),
    });
    const ownReserve = custodyUtxo(6, {
      coins: 2_000_000n,
      datum: Serialization.PlutusData.fromCbor(HexBlob('d87980')).toCore(),
    });
    const foreignReserve = custodyUtxo(7, {
      value: { coins: 1_500_000n, assets: new Map([[assetId, 2n]]) },
      datum: 42n,
    });
    const grant = grantUtxo(
      8,
      custodyGrant(0n, 'a1', custodyLovelaceScope(1_800_000_000_000n)),
      3_000_000n,
    );

    const holdings = {
      funds: [fund, otherFund, referenceScriptFund],
      reserves: { own: [ownReserve], foreign: [foreignReserve] },
      grants: classifyCustodyAccountUtxos(
        cardanoCustodyAccount.blockchainSpecific,
        [grant],
      ).grants,
      grantLockedLovelace: 3_000_000n,
      stranded: [stranded],
      anomalies: [],
      withdrawableRewards: 500_000n,
    };
    const live: CardanoCustodyAccountState = {
      ...holdings,
      status: 'live',
      controlUtxo: control,
      state: custodyState,
      controlMinimumLovelace: 1_586_080n,
      controlHeadroomLovelace: 1_413_920n,
      currentDeviceListed: true,
    };

    const custodyTokens = (byAddress: AccountTokensByAddress) =>
      actions.tokens.setAccountTokens({
        blockchainName: 'Cardano',
        accountId: custodyAccountId,
        byAddress,
      });
    const liveCustodyTokens = custodyTokens([
      {
        address: CardanoPaymentAddress(custodyAddress),
        tokens: [
          {
            tokenId: LOVELACE_TOKEN_ID,
            available: BigNumber(7_500_000n),
            pending: BigNumber(0n),
          },
          {
            tokenId: TokenId(assetId),
            available: BigNumber(3n),
            pending: BigNumber(0n),
          },
        ],
      },
    ]);

    it('counts plain funds without a reference script, own reserves and withdrawable rewards, never foreign reserves, the control or grant lovelace, stranded deposits or account tokens', () => {
      testSideEffect(trackAccountTokens, ({ cold, expectObservable }) => ({
        stateObservables: {
          cardanoContext: {
            selectActiveCardanoAccounts$: cold<CardanoAccount[]>('a', {
              a: [cardanoCustodyAccount],
            }),
            selectCardanoCustodyAccountState$: cold('a', {
              a: (accountId: AccountId) =>
                accountId === custodyAccountId ? live : undefined,
            }),
          },
        },
        dependencies: { actions },
        assertion: sideEffect$ => {
          expectObservable(sideEffect$).toBe('a', { a: liveCustodyTokens });
        },
      }));
    });

    it('holds nothing spendable while the account is not created, invalid or not yet synced', () => {
      testSideEffect(trackAccountTokens, ({ cold, expectObservable }) => {
        const notCreated: CardanoCustodyAccountState = {
          ...holdings,
          status: 'notCreated',
        };
        const invalid: CardanoCustodyAccountState = {
          ...holdings,
          status: 'invalid',
          reason: { code: 'multiple-control-utxos' },
          controlUtxos: [control, controlUtxo(5)],
        };
        return {
          stateObservables: {
            cardanoContext: {
              selectActiveCardanoAccounts$: cold<CardanoAccount[]>('a', {
                a: [cardanoCustodyAccount],
              }),
              selectCardanoCustodyAccountState$: cold('abcd', {
                a: () => undefined,
                b: () => notCreated,
                c: () => invalid,
                d: () => live,
              }),
            },
          },
          dependencies: { actions },
          assertion: sideEffect$ => {
            expectObservable(sideEffect$).toBe('abcd', {
              a: custodyTokens([]),
              b: custodyTokens([]),
              c: custodyTokens([]),
              d: liveCustodyTokens,
            });
          },
        };
      });
    });

    it('emits again only when the classification changes', () => {
      testSideEffect(trackAccountTokens, ({ cold, expectObservable }) => {
        const notCreated: CardanoCustodyAccountState = {
          ...holdings,
          status: 'notCreated',
        };
        return {
          stateObservables: {
            cardanoContext: {
              selectActiveCardanoAccounts$: cold<CardanoAccount[]>('a', {
                a: [cardanoCustodyAccount],
              }),
              selectCardanoCustodyAccountState$: cold('ab', {
                a: () => notCreated,
                b: () => notCreated,
              }),
            },
          },
          dependencies: { actions },
          assertion: sideEffect$ => {
            expectObservable(sideEffect$).toBe('a', { a: custodyTokens([]) });
          },
        };
      });
    });

    it('keeps tracking key accounts by their UTxOs next to a custody account', () => {
      testSideEffect(trackAccountTokens, ({ cold, expectObservable }) => {
        const keyUtxo: Cardano.Utxo = [
          {
            address: Cardano.PaymentAddress(cardanoAccount0Addr.address),
            txId: Cardano.TransactionId('ab'.repeat(32)),
            index: 0,
          },
          {
            address: Cardano.PaymentAddress(cardanoAccount0Addr.address),
            value: { coins: 2_000_000n },
          },
        ];
        return {
          stateObservables: {
            cardanoContext: {
              selectActiveCardanoAccounts$: cold<CardanoAccount[]>('a', {
                a: [account0, cardanoCustodyAccount],
              }),
              selectAccountUtxosWithInFlight$: cold<AccountUtxoMap>('a', {
                a: {
                  [account0.accountId]: [keyUtxo],
                  [custodyAccountId]: [control, fund],
                },
              }),
              selectRewardAccountDetails$: cold<AccountRewardAccountDetailsMap>(
                'a',
                { a: {} },
              ),
              selectCardanoCustodyAccountState$: cold('a', {
                a: () => live,
              }),
            },
          },
          dependencies: { actions },
          assertion: sideEffect$ => {
            expectObservable(sideEffect$).toBe('(ab)', {
              a: actions.tokens.setAccountTokens({
                blockchainName: 'Cardano',
                accountId: account0.accountId,
                byAddress: [
                  {
                    address: cardanoAccount0Addr.address,
                    tokens: [
                      {
                        tokenId: LOVELACE_TOKEN_ID,
                        available: BigNumber(2_000_000n),
                        pending: BigNumber(0n),
                      },
                    ],
                  },
                ],
              }),
              b: liveCustodyTokens,
            });
          },
        };
      });
    });
  });
});
