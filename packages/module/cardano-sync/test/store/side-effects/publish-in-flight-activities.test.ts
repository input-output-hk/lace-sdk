import { activitiesActions, ActivityType } from '@lace-contract/activities';
import { activitiesReducers } from '@lace-contract/activities/src/store/slice';
import {
  cardanoContextActions,
  CardanoNetworkId,
  CardanoPaymentAddress,
  inFlightTransactionOf,
  LOVELACE_TOKEN_ID,
  pendingActivityOf,
} from '@lace-contract/cardano-context';
import {
  cardanoCustodyAccount,
  custodyAddress,
} from '@lace-contract/cardano-context/test/custody-mocks';
import {
  cardanoAccount0Addr,
  cardanoAccount1Addr,
  previewAccountCardanoWalletAccounts,
  threeAccountCardanoWallet,
  threeAccountCardanoWalletAccounts,
} from '@lace-contract/cardano-context/test/mocks';
import { Cardano, Serialization } from '@lace-lib/cardano-core';
import { BigNumber, HexBytes, Timestamp } from '@lace-lib/util';
import { testSideEffect } from '@lace-lib/util-dev';
import { ReplaySubject, tap } from 'rxjs';
import { dummyLogger } from 'ts-log';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { publishInFlightActivities } from '../../../src/store/side-effects/publish-in-flight-activities';

import type { Activity } from '@lace-contract/activities';
import type { AnyAddress } from '@lace-contract/addresses';
import type * as CardanoContext from '@lace-contract/cardano-context';
import type {
  AccountUtxoMap,
  CardanoTxId,
  DecodedInFlightTransaction,
  InFlightTransactionKey,
} from '@lace-contract/cardano-context';
import type {
  AccountId,
  AnyAccount,
  AnyWallet,
} from '@lace-contract/wallet-repo';
import type { Logger } from 'ts-log';

vi.mock('@lace-contract/cardano-context', async importOriginal => {
  const actual = await importOriginal<typeof CardanoContext>();
  return { ...actual, pendingActivityOf: vi.fn(actual.pendingActivityOf) };
});

const actions = { ...cardanoContextActions, ...activitiesActions };

const [KEY_A, KEY_B] = threeAccountCardanoWalletAccounts;
const [PREVIEW_ACCOUNT] = previewAccountCardanoWalletAccounts;
const ADDRESS_A = Cardano.PaymentAddress(cardanoAccount0Addr.address);
const ADDRESS_B = Cardano.PaymentAddress(cardanoAccount1Addr.address);
const FOREIGN_ADDRESS = Cardano.PaymentAddress(
  'addr_test1vqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqd9tg5t',
);

/** When the provider accepted the transactions, long before the test runs. */
const SUBMITTED_AT = 10_000;
const NOW = 1_000_000;

const TX = Cardano.TransactionId('d1'.repeat(32));
const PREVIOUS_TX = Cardano.TransactionId('39'.repeat(32));
const input = (index: number): Cardano.TxIn => ({ txId: PREVIOUS_TX, index });

const utxoAt = (
  txIn: Cardano.TxIn,
  address: Cardano.PaymentAddress,
  coins: bigint,
): Cardano.Utxo => [
  { ...txIn, address },
  { address, value: { coins } },
];

const addressEntry = (
  accountId: AccountId,
  address: Cardano.PaymentAddress,
  { networkId, networkMagic } = Cardano.ChainIds.Preprod,
): AnyAddress => ({
  address: CardanoPaymentAddress(address),
  accountId,
  blockchainName: 'Cardano',
  name: address.slice(-6),
  data: { networkId, networkMagic },
});

/**
 * An in-flight entry that spends `consumedInputs` and pays `payments`, by
 * default on Preprod.
 */
const entry = ({
  consumedInputs,
  payments = [],
  chainId = Cardano.ChainIds.Preprod,
}: {
  consumedInputs: Cardano.TxIn[];
  payments?: [Cardano.PaymentAddress, bigint][];
  chainId?: Cardano.ChainId;
}): DecodedInFlightTransaction => ({
  chainId,
  txId: TX as CardanoTxId,
  effects: {
    consumedInputs,
    producedOutputs: payments.map(([address, coins], index) =>
      utxoAt({ txId: TX, index }, address, coins),
    ),
  },
  invalidHereafter: Cardano.Slot(1_000),
  submittedAt: Timestamp(SUBMITTED_AT),
});

const inFlightOf = (...entries: DecodedInFlightTransaction[]) =>
  Object.fromEntries(
    entries.map(item => [
      `${CardanoNetworkId(item.chainId.networkMagic)}:${item.txId}`,
      item,
    ]),
  ) as Record<InFlightTransactionKey, DecodedInFlightTransaction>;

/** The Pending display row of `TX` on an account, recorded at `SUBMITTED_AT`. */
const pendingRow = (
  accountId: AccountId,
  lovelace: bigint,
  id: Cardano.TransactionId = TX,
): Activity => ({
  accountId,
  activityId: String(id),
  timestamp: Timestamp(SUBMITTED_AT),
  tokenBalanceChanges: [
    { tokenId: LOVELACE_TOKEN_ID, amount: BigNumber(lovelace) },
  ],
  type: ActivityType.Pending,
});

const added = (row: Activity) =>
  actions.activities.addActivities({
    accountId: row.accountId,
    activities: [
      { ...row, provisional: expect.any(Object) as Activity['provisional'] },
    ],
  });

/**
 * A state stream whose frames count from the start of the test, the latest
 * value replayed to each subscriber, as the store's state observables do.
 */
type Timeline<T> = { marble: string; values: Record<string, T> };

const constant = <T>(value: T): Timeline<T> => ({
  marble: 'a',
  values: { a: value },
});

/** Account A spends the input; account B holds an unrelated UTxO. */
const SPENT_BY_A: AccountUtxoMap = {
  [KEY_A.accountId]: [utxoAt(input(0), ADDRESS_A, 10_000_000n)],
  [KEY_B.accountId]: [utxoAt(input(1), ADDRESS_B, 5_000_000n)],
};

const ADDRESSES = [
  addressEntry(KEY_A.accountId, ADDRESS_A),
  addressEntry(KEY_B.accountId, ADDRESS_B),
];

/** Runs the side effect over the wallet state below and expects `expected`. */
const expectPublication = ({
  accounts,
  inFlight,
  ownership = constant({}),
  addresses = constant(ADDRESSES),
  activities = constant({}),
  isWalletActive = constant(true),
  logger = dummyLogger,
  expected,
  values = {},
}: {
  accounts: AnyAccount[];
  inFlight: Timeline<
    Record<InFlightTransactionKey, DecodedInFlightTransaction>
  >;
  ownership?: Timeline<AccountUtxoMap>;
  addresses?: Timeline<AnyAddress[]>;
  activities?: Timeline<Record<AccountId, Activity[]>>;
  isWalletActive?: Timeline<boolean>;
  logger?: Logger;
  expected: string;
  values?: Record<string, unknown>;
}) => {
  const emitted: ReturnType<typeof actions.activities.addActivities>[] = [];
  testSideEffect(
    publishInFlightActivities,
    ({ hot, cold, expectObservable }) => {
      const replayed = <T>({ marble, values: frames }: Timeline<T>) => {
        const latest = new ReplaySubject<T>(1);
        hot(marble, frames).subscribe(latest);
        return latest;
      };
      return {
        actionObservables: {},
        stateObservables: {
          cardanoContext: {
            selectInFlightTransactions$: replayed(inFlight),
            selectCollateralOwnershipUtxos$: replayed(ownership),
          },
          addresses: { selectAllAddresses$: replayed(addresses) },
          activities: { selectAllMap$: replayed(activities) },
          wallets: {
            selectAll$: cold('a', {
              a: [{ ...threeAccountCardanoWallet, accounts } as AnyWallet],
            }),
          },
        },
        dependencies: {
          actions,
          logger,
          isWalletActive$: replayed(isWalletActive),
        },
        assertion: sideEffect$ => {
          expectObservable(
            sideEffect$.pipe(
              tap(action => {
                if (actions.activities.addActivities.match(action))
                  emitted.push(action);
              }),
            ),
            '^---------!',
          ).toBe(expected, values);
        },
      };
    },
  );
  return emitted;
};

describe('publishInFlightActivities', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('publishes the Pending activity of an account once its ownership set holds an input the transaction spends, with the time the transaction was submitted', () => {
    expectPublication({
      accounts: [KEY_A, KEY_B],
      inFlight: constant(
        inFlightOf(
          entry({
            consumedInputs: [input(0)],
            payments: [[FOREIGN_ADDRESS, 9_800_000n]],
          }),
        ),
      ),
      ownership: {
        marble: 'a-b',
        values: {
          a: { [KEY_B.accountId]: SPENT_BY_A[KEY_B.accountId] },
          b: SPENT_BY_A,
        },
      },
      expected: '--a',
      values: { a: added(pendingRow(KEY_A.accountId, -10_000_000n)) },
    });
  });

  it('publishes the Pending activity of an own account the transaction only pays', () => {
    expectPublication({
      accounts: [KEY_A, KEY_B],
      inFlight: constant(
        inFlightOf(
          entry({
            consumedInputs: [input(0)],
            payments: [[ADDRESS_B, 9_800_000n]],
          }),
        ),
      ),
      ownership: constant(SPENT_BY_A),
      expected: '(ab)',
      values: {
        a: added(pendingRow(KEY_A.accountId, -10_000_000n)),
        b: added(pendingRow(KEY_B.accountId, 9_800_000n)),
      },
    });
  });

  it('recomputes a child that pays its own change when the parent input becomes owned, even before the previous publication lands', () => {
    const child = entry({
      consumedInputs: [input(0)],
      payments: [[ADDRESS_A, 9_600_000n]],
    });
    const provisional = {
      ...pendingRow(KEY_A.accountId, 9_600_000n),
      provisional: {
        [`output:${TX}#0`]: pendingRow(KEY_A.accountId, 9_600_000n)
          .tokenBalanceChanges,
      },
    };
    expectPublication({
      accounts: [KEY_A],
      inFlight: constant(inFlightOf(child)),
      ownership: {
        marble: 'a-b-c',
        values: {
          a: {},
          b: { [KEY_A.accountId]: [utxoAt(input(0), ADDRESS_A, 9_800_000n)] },
          c: { [KEY_A.accountId]: [utxoAt(input(0), ADDRESS_A, 9_800_000n)] },
        },
      },
      activities: {
        marble: 'a--b',
        values: { a: {}, b: { [KEY_A.accountId]: [provisional] } },
      },
      expected: 'a-b',
      values: {
        a: added(pendingRow(KEY_A.accountId, 9_600_000n)),
        b: added(pendingRow(KEY_A.accountId, -200_000n)),
      },
    });
  });

  it('refreshes a persisted provisional row once ownership resolves', () => {
    const provisional = {
      ...pendingRow(KEY_A.accountId, 9_600_000n),
      provisional: {
        [`output:${TX}#0`]: pendingRow(KEY_A.accountId, 9_600_000n)
          .tokenBalanceChanges,
      },
    };
    expectPublication({
      accounts: [KEY_A],
      inFlight: constant(
        inFlightOf(
          entry({
            consumedInputs: [input(0)],
            payments: [[ADDRESS_A, 9_600_000n]],
          }),
        ),
      ),
      ownership: constant({
        [KEY_A.accountId]: [utxoAt(input(0), ADDRESS_A, 9_800_000n)],
      }),
      activities: constant({ [KEY_A.accountId]: [provisional] }),
      expected: 'a',
      values: { a: added(pendingRow(KEY_A.accountId, -200_000n)) },
    });
  });

  it('emits nothing when the stored provisional row already matches ownership', () => {
    expectPublication({
      accounts: [KEY_A],
      inFlight: constant(inFlightOf(entry({ consumedInputs: [input(0)] }))),
      ownership: constant(SPENT_BY_A),
      activities: constant({
        [KEY_A.accountId]: [
          {
            ...pendingRow(KEY_A.accountId, -10_000_000n),
            provisional: {
              [`input:${PREVIOUS_TX}#0`]: pendingRow(
                KEY_A.accountId,
                -10_000_000n,
              ).tokenBalanceChanges,
            },
          },
        ],
      }),
      expected: '',
    });
  });

  it('retains the child input amount when the parent leaves ownership, even when publications reduce in reverse order', () => {
    const emitted = expectPublication({
      accounts: [KEY_A],
      inFlight: constant(
        inFlightOf(
          entry({
            consumedInputs: [input(0)],
            payments: [[ADDRESS_A, 9_600_000n]],
          }),
        ),
      ),
      ownership: {
        marble: 'a-b',
        values: {
          a: { [KEY_A.accountId]: [utxoAt(input(0), ADDRESS_A, 9_800_000n)] },
          b: {},
        },
      },
      expected: 'a-b',
      values: {
        a: added(pendingRow(KEY_A.accountId, -200_000n)),
        b: added(pendingRow(KEY_A.accountId, 9_600_000n)),
      },
    });
    for (const publications of [emitted, [...emitted].reverse()]) {
      const state = publications.reduce(
        activitiesReducers.activities,
        activitiesReducers.activities(undefined, { type: 'init' }),
      );
      expect(state.activities[KEY_A.accountId][0]).toStrictEqual({
        ...pendingRow(KEY_A.accountId, -200_000n),
        provisional: {
          [`output:${TX}#0`]: pendingRow(KEY_A.accountId, 9_600_000n)
            .tokenBalanceChanges,
          [`input:${PREVIOUS_TX}#0`]: pendingRow(KEY_A.accountId, -9_800_000n)
            .tokenBalanceChanges,
        },
      });
    }
  });

  it.each([
    {
      name: 'a resolved input disappears',
      firstAmount: 9_800_000n,
      laterAmount: 0n,
    },
    {
      name: 'another input resolves after the first disappears',
      firstAmount: 4_800_000n,
      laterAmount: 5_000_000n,
    },
  ])(
    'retains persisted partial evidence when $name',
    ({ firstAmount, laterAmount }) => {
      const persisted = JSON.parse(
        JSON.stringify({
          ...pendingRow(KEY_A.accountId, 9_600_000n - firstAmount),
          provisional: {
            [`output:${TX}#0`]: pendingRow(KEY_A.accountId, 9_600_000n)
              .tokenBalanceChanges,
            [`input:${PREVIOUS_TX}#0`]: pendingRow(
              KEY_A.accountId,
              -firstAmount,
            ).tokenBalanceChanges,
          },
        }),
      ) as Activity;
      const emitted = expectPublication({
        accounts: [KEY_A],
        inFlight: constant(
          inFlightOf(
            entry({
              consumedInputs: [input(0), input(1)],
              payments: [[ADDRESS_A, 9_600_000n]],
            }),
          ),
        ),
        ownership: constant({
          [KEY_A.accountId]:
            laterAmount > 0n ? [utxoAt(input(1), ADDRESS_A, laterAmount)] : [],
        }),
        activities: constant({ [KEY_A.accountId]: [persisted] }),
        expected: 'a',
        values: {
          a: added(pendingRow(KEY_A.accountId, 9_600_000n - laterAmount)),
        },
      });
      const restored = {
        ...activitiesReducers.activities(undefined, { type: 'init' }),
        activities: { [KEY_A.accountId]: [persisted] },
      };
      const state = emitted.reduce(activitiesReducers.activities, restored);
      expect(
        state.activities[KEY_A.accountId][0].tokenBalanceChanges,
      ).toStrictEqual(
        pendingRow(KEY_A.accountId, -200_000n).tokenBalanceChanges,
      );
      expect(state.activities[KEY_A.accountId][0].provisional).toMatchObject(
        persisted.provisional!,
      );
    },
  );

  it.each([
    { type: ActivityType.Send, provisional: {} },
    {
      type: ActivityType.Pending,
      provisional: {},
      blockchainSpecific: { Cardano: { custom: 'feature metadata' } },
    },
  ])('preserves confirmed and enriched provisional rows: %j', attributes => {
    expectPublication({
      accounts: [KEY_A],
      inFlight: constant(inFlightOf(entry({ consumedInputs: [input(0)] }))),
      ownership: constant(SPENT_BY_A),
      activities: constant({
        [KEY_A.accountId]: [
          { ...pendingRow(KEY_A.accountId, 42n), ...attributes },
        ],
      }),
      expected: '',
    });
  });

  it('publishes nothing for an account the transaction does not touch', () => {
    expectPublication({
      accounts: [KEY_A, KEY_B],
      inFlight: constant(
        inFlightOf(
          entry({
            consumedInputs: [input(0)],
            payments: [[FOREIGN_ADDRESS, 9_800_000n]],
          }),
        ),
      ),
      ownership: constant(SPENT_BY_A),
      expected: 'a',
      values: { a: added(pendingRow(KEY_A.accountId, -10_000_000n)) },
    });
  });

  it.each([ActivityType.Pending, ActivityType.Send, ActivityType.Receive])(
    'skips an account that already holds an activity with the transaction ID, of type %s',
    type => {
      expectPublication({
        accounts: [KEY_A, KEY_B],
        inFlight: constant(
          inFlightOf(
            entry({
              consumedInputs: [input(0)],
              payments: [[ADDRESS_B, 9_800_000n]],
            }),
          ),
        ),
        ownership: constant(SPENT_BY_A),
        activities: constant({
          [KEY_A.accountId]: [
            { ...pendingRow(KEY_A.accountId, -200_000n), type },
          ],
        }),
        expected: 'a',
        values: { a: added(pendingRow(KEY_B.accountId, 9_800_000n)) },
      });
    },
  );

  it('publishes to an account of a kind a feature adds, as to any account', () => {
    // The feature's own row, written after it, replaces this one by ID.
    expectPublication({
      accounts: [KEY_A, cardanoCustodyAccount],
      inFlight: constant(
        inFlightOf(
          entry({
            consumedInputs: [input(0), input(2)],
            payments: [[custodyAddress, 2_000_000n]],
          }),
        ),
      ),
      ownership: constant({
        [KEY_A.accountId]: SPENT_BY_A[KEY_A.accountId],
        [cardanoCustodyAccount.accountId]: [
          utxoAt(input(2), custodyAddress, 3_000_000n),
        ],
      }),
      addresses: constant([
        addressEntry(KEY_A.accountId, ADDRESS_A),
        addressEntry(cardanoCustodyAccount.accountId, custodyAddress),
      ]),
      expected: '(ab)',
      values: {
        a: added(pendingRow(KEY_A.accountId, -10_000_000n)),
        b: added(pendingRow(cardanoCustodyAccount.accountId, -1_000_000n)),
      },
    });
  });

  it('publishes an entry only for the accounts on its network', () => {
    const previewAddress = Cardano.PaymentAddress(
      'addr_test1vz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerspjrlsz',
    );
    expectPublication({
      accounts: [KEY_A, PREVIEW_ACCOUNT],
      inFlight: constant(
        inFlightOf(
          entry({
            consumedInputs: [input(0)],
            payments: [
              [ADDRESS_A, 1_000_000n],
              [previewAddress, 8_800_000n],
            ],
            chainId: Cardano.ChainIds.Preview,
          }),
        ),
      ),
      // Preview and Preprod share address encodings, and both accounts list
      // the outpoint.
      ownership: constant({
        [KEY_A.accountId]: SPENT_BY_A[KEY_A.accountId],
        [PREVIEW_ACCOUNT.accountId]: [
          utxoAt(input(0), previewAddress, 10_000_000n),
        ],
      }),
      addresses: constant([
        addressEntry(KEY_A.accountId, ADDRESS_A),
        addressEntry(
          PREVIEW_ACCOUNT.accountId,
          previewAddress,
          Cardano.ChainIds.Preview,
        ),
      ]),
      expected: 'a',
      values: { a: added(pendingRow(PREVIEW_ACCOUNT.accountId, -1_200_000n)) },
    });
  });

  it('emits nothing and reads no wallet state while no entry exists', () => {
    testSideEffect(
      publishInFlightActivities,
      ({ cold, expectObservable, expectSubscriptions }) => {
        const ownership$ = cold('a-b', { a: {}, b: SPENT_BY_A });
        const addresses$ = cold('a', { a: ADDRESSES });
        const activities$ = cold('a-b', { a: {}, b: {} });
        const wallets$ = cold('a', {
          a: [{ ...threeAccountCardanoWallet, accounts: [KEY_A] } as AnyWallet],
        });
        return {
          actionObservables: {},
          stateObservables: {
            cardanoContext: {
              selectInFlightTransactions$: cold('a-a', { a: inFlightOf() }),
              selectCollateralOwnershipUtxos$: ownership$,
            },
            addresses: { selectAllAddresses$: addresses$ },
            activities: { selectAllMap$: activities$ },
            wallets: { selectAll$: wallets$ },
          },
          dependencies: {
            actions,
            logger: dummyLogger,
            isWalletActive$: cold('a', { a: true }),
          },
          assertion: sideEffect$ => {
            expectObservable(sideEffect$).toBe('');
            for (const state$ of [
              ownership$,
              addresses$,
              activities$,
              wallets$,
            ])
              expectSubscriptions(state$.subscriptions).toBe([]);
          },
        };
      },
    );
  });

  it('emits each row once while a burst of state changes delivers states that do not show it yet', () => {
    const withoutRow = {};
    expectPublication({
      accounts: [KEY_A, KEY_B],
      inFlight: constant(
        inFlightOf(
          entry({
            consumedInputs: [input(0)],
            payments: [[FOREIGN_ADDRESS, 9_800_000n]],
          }),
        ),
      ),
      ownership: {
        marble: 'a-b-c',
        values: { a: SPENT_BY_A, b: { ...SPENT_BY_A }, c: { ...SPENT_BY_A } },
      },
      addresses: {
        marble: 'a-b-c',
        values: { a: ADDRESSES, b: [...ADDRESSES], c: [...ADDRESSES] },
      },
      activities: {
        marble: 'a-b-c',
        values: { a: withoutRow, b: { ...withoutRow }, c: { ...withoutRow } },
      },
      expected: 'a',
      values: { a: added(pendingRow(KEY_A.accountId, -10_000_000n)) },
    });
  });

  it.each([
    { removed: 'the entry, then the row', inFlight: 'a-b', activities: 'ab-c' },
    { removed: 'the row, then the entry', inFlight: 'a--b', activities: 'abc' },
  ])(
    'does not publish again once the reconcile removed $removed',
    ({ inFlight, activities }) => {
      const published = pendingRow(KEY_A.accountId, -10_000_000n);
      expectPublication({
        accounts: [KEY_A],
        inFlight: {
          marble: inFlight,
          values: {
            a: inFlightOf(entry({ consumedInputs: [input(0)] })),
            b: inFlightOf(),
          },
        },
        ownership: constant(SPENT_BY_A),
        activities: {
          marble: activities,
          values: { a: {}, b: { [KEY_A.accountId]: [published] }, c: {} },
        },
        expected: 'a',
        values: { a: added(published) },
      });
    },
  );

  it('publishes once the wallet is unlocked', () => {
    expectPublication({
      accounts: [KEY_A],
      inFlight: constant(inFlightOf(entry({ consumedInputs: [input(0)] }))),
      ownership: constant(SPENT_BY_A),
      isWalletActive: { marble: 'f-t', values: { f: false, t: true } },
      expected: '--a',
      values: { a: added(pendingRow(KEY_A.accountId, -10_000_000n)) },
    });
  });

  it('logs and skips an account whose Pending activity cannot be derived', () => {
    const error = new Error('underivable');
    vi.mocked(pendingActivityOf).mockImplementationOnce(() => {
      throw error;
    });
    const logger = { ...dummyLogger, warn: vi.fn() };
    expectPublication({
      accounts: [KEY_A, KEY_B],
      inFlight: constant(
        inFlightOf(
          entry({
            consumedInputs: [input(0)],
            payments: [[ADDRESS_B, 9_800_000n]],
          }),
        ),
      ),
      ownership: constant(SPENT_BY_A),
      logger,
      expected: 'a',
      values: { a: added(pendingRow(KEY_B.accountId, 9_800_000n)) },
    });
    expect(logger.warn).toHaveBeenCalledWith(
      '[cardano-sync] could not derive the pending activity of a submitted transaction',
      { txId: TX, accountId: KEY_A.accountId, error },
    );
  });

  describe('for a transaction a tx-executor flow records without a row of its own', () => {
    const FEE = 180_000n;
    const DEPOSIT = 2_000_000n;
    const REWARDS = 5_000_000n;
    const PAYMENT = 3_000_000n;
    const POOL_ID = Cardano.PoolId(
      'pool1pu5jlj4q9w9jlxeu370a3c9myx47md5j5m2str0naunn2q3lkdy',
    );
    const ABSTAIN: Cardano.DelegateRepresentative = {
      __typename: 'AlwaysAbstain',
    };
    const stakeCredential = Cardano.Address.fromBech32(ADDRESS_A)
      .asBase()!
      .getStakeCredential();

    /**
     * What the flow builds from the account's input: its certificates, a
     * withdrawal of the account's rewards, a payment to another wallet, and
     * the change to the account's address that balances them.
     */
    const signedTx = ({
      certificates = [],
      deposit = 0n,
      refund = 0n,
      withdrawal = 0n,
      payment = 0n,
    }: {
      certificates?: Cardano.Certificate[];
      deposit?: bigint;
      refund?: bigint;
      withdrawal?: bigint;
      payment?: bigint;
    }) =>
      HexBytes(
        Serialization.Transaction.fromCore({
          id: Cardano.TransactionId('0'.repeat(64)),
          body: {
            inputs: [input(0)],
            outputs: [
              ...(payment > 0n
                ? [{ address: FOREIGN_ADDRESS, value: { coins: payment } }]
                : []),
              {
                address: ADDRESS_A,
                value: {
                  coins:
                    10_000_000n - FEE - deposit + refund + withdrawal - payment,
                },
              },
            ],
            fee: FEE,
            certificates,
            ...(withdrawal > 0n && {
              withdrawals: [
                {
                  stakeAddress: Cardano.RewardAccount.fromCredential(
                    stakeCredential,
                    Cardano.NetworkId.Testnet,
                  ),
                  quantity: withdrawal,
                },
              ],
            }),
            validityInterval: { invalidHereafter: Cardano.Slot(1_000) },
          },
          witness: { signatures: new Map() },
        }).toCbor(),
      );

    it.each([
      {
        flow: 'vote delegation that registers the stake key',
        serializedTx: signedTx({
          certificates: [
            {
              __typename: Cardano.CertificateType.VoteRegistrationDelegation,
              dRep: ABSTAIN,
              stakeCredential,
              deposit: DEPOSIT,
            },
          ],
          deposit: DEPOSIT,
        }),
        change: -(FEE + DEPOSIT),
      },
      {
        flow: 'vote delegation of a registered stake key',
        serializedTx: signedTx({
          certificates: [
            {
              __typename: Cardano.CertificateType.VoteDelegation,
              dRep: ABSTAIN,
              stakeCredential,
            },
          ],
        }),
        change: -FEE,
      },
      {
        flow: 'stake delegation that registers the stake key',
        serializedTx: signedTx({
          certificates: [
            {
              __typename: Cardano.CertificateType.StakeRegistrationDelegation,
              poolId: POOL_ID,
              stakeCredential,
              deposit: DEPOSIT,
            },
          ],
          deposit: DEPOSIT,
        }),
        change: -(FEE + DEPOSIT),
      },
      {
        flow: 'earn-rewards transaction that registers the stake key',
        serializedTx: signedTx({
          certificates: [
            {
              __typename:
                Cardano.CertificateType.StakeVoteRegistrationDelegation,
              poolId: POOL_ID,
              dRep: ABSTAIN,
              stakeCredential,
              deposit: DEPOSIT,
            },
          ],
          deposit: DEPOSIT,
        }),
        change: -(FEE + DEPOSIT),
      },
      {
        flow: 'stake deregistration that withdraws the rewards',
        serializedTx: signedTx({
          certificates: [
            {
              __typename: Cardano.CertificateType.Unregistration,
              stakeCredential,
              deposit: DEPOSIT,
            },
          ],
          refund: DEPOSIT,
          withdrawal: REWARDS,
        }),
        change: DEPOSIT + REWARDS - FEE,
      },
      {
        flow: 'Composer transaction that pays another wallet',
        serializedTx: signedTx({ payment: PAYMENT }),
        change: -(FEE + PAYMENT),
      },
    ])(
      'gives the account a Pending activity whose one lovelace change is the net of the fee, deposits, refunds, withdrawals and payments, for a $flow',
      ({ serializedTx, change }) => {
        const recorded = inFlightTransactionOf({
          serializedTx,
          chainId: Cardano.ChainIds.Preprod,
          submittedAt: Timestamp(SUBMITTED_AT),
        });
        expectPublication({
          accounts: [KEY_A, KEY_B],
          inFlight: constant(inFlightOf(recorded)),
          ownership: constant(SPENT_BY_A),
          expected: 'a',
          values: {
            a: added(pendingRow(KEY_A.accountId, change, recorded.txId)),
          },
        });
      },
    );
  });
});
