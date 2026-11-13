import { activitiesActions, ActivityType } from '@lace-contract/activities';
import {
  cardanoContextActions,
  CardanoNetworkId,
  CardanoPaymentAddress,
  inFlightTransactionOf,
  UTXO_SYNC_CONFIRMATION_DEPTH,
} from '@lace-contract/cardano-context';
import { cardanoCustodyAccount } from '@lace-contract/cardano-context/test/custody-mocks';
import {
  previewAccountCardanoWalletAccounts,
  threeAccountCardanoWallet,
  threeAccountCardanoWalletAccounts,
} from '@lace-contract/cardano-context/test/mocks';
import { Cardano, Serialization } from '@lace-lib/cardano-core';
import { HexBytes, Timestamp } from '@lace-lib/util';
import { testSideEffect } from '@lace-lib/util-dev';
import { describe, it } from 'vitest';

import { reconcileInFlightTransactions } from '../../../src/store/side-effects/reconcile-in-flight-transactions';

import type { Activity } from '@lace-contract/activities';
import type {
  AccountUtxoMap,
  CardanoAccountAddressHistoryMap,
  CardanoNetworkInfo,
  CardanoTransactionHistoryItem,
  CardanoTxId,
  DecodedInFlightTransaction,
  InFlightTransactionKey,
} from '@lace-contract/cardano-context';
import type {
  AccountId,
  AnyAccount,
  AnyWallet,
} from '@lace-contract/wallet-repo';

const actions = { ...cardanoContextActions, ...activitiesActions };

const [KEY_A, KEY_B] = threeAccountCardanoWalletAccounts;
const [PREVIEW_ACCOUNT] = previewAccountCardanoWalletAccounts;
const CUSTODY = cardanoCustodyAccount;

const BOUND = 1_000;
const EXPIRED_SLOT = BOUND + UTXO_SYNC_CONFIRMATION_DEPTH + 1;
const PREPROD = CardanoNetworkId(Cardano.ChainIds.Preprod.networkMagic);
/** When the provider accepted the transactions. */
const SUBMITTED_AT = 10_000;

const txId = (byte: string) => Cardano.TransactionId(byte.repeat(32));
const TX = txId('d1');
const LATER_TX = txId('d2');
const UNBOUNDED_TX = txId('d3');
const CUSTODY_TX = txId('c1');

const tipAt = (slot: number): Cardano.Tip => ({
  slot: Cardano.Slot(slot),
  blockNo: Cardano.BlockNo(slot),
  hash: Cardano.BlockId(slot.toString(16).padStart(64, '0')),
});

const ADDRESS = CardanoPaymentAddress(
  'addr_test1vz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerspjrlsz',
);
const SECOND_ADDRESS = CardanoPaymentAddress(
  'addr_test1qruygd02feqeue4hkt67vwgn03p04uuv2k34ed25n4rcwt8pa7kgfet22l6w3078tm72c62p4597urnlpw6v6278cpxs8jxykl',
);

const utxoUnder = (id: Cardano.TransactionId, index = 0): Cardano.Utxo => {
  const address = Cardano.PaymentAddress(ADDRESS);
  return [
    { txId: id, index, address },
    { address, value: { coins: 2_000_000n } },
  ];
};

/** A settled UTxO of an own account that the transactions under test spend. */
const OWN_UTXO = utxoUnder(txId('f1'));

/** An in-flight entry on Preprod unless `chainId` names another network. */
const entry = (
  id: Cardano.TransactionId,
  {
    invalidHereafter,
    consumedInputs = [],
    chainId = Cardano.ChainIds.Preprod,
  }: {
    invalidHereafter?: number;
    consumedInputs?: Cardano.TxIn[];
    chainId?: Cardano.ChainId;
  } = {},
): DecodedInFlightTransaction => ({
  chainId,
  txId: id as CardanoTxId,
  effects: { consumedInputs, producedOutputs: [utxoUnder(id)] },
  ...(invalidHereafter !== undefined && {
    invalidHereafter: Cardano.Slot(invalidHereafter),
  }),
  submittedAt: Timestamp(SUBMITTED_AT),
});

/**
 * The entry with the provider's answer, asked with its network's tip at
 * `tipSlot`: it holds the transaction when `isOnChain`, else it does not.
 */
const lookedUp = (
  inFlight: DecodedInFlightTransaction,
  {
    isOnChain,
    tipSlot = EXPIRED_SLOT,
  }: { isOnChain: boolean; tipSlot?: number },
): DecodedInFlightTransaction => ({
  ...inFlight,
  lookup: {
    tipSlot: Cardano.Slot(tipSlot),
    inclusion: isOnChain
      ? {
          blockHash: Cardano.BlockId('ab'.repeat(32)),
          blockHeight: Cardano.BlockNo(2),
          slot: Cardano.Slot(BOUND - 10),
          txIndex: Cardano.TxIndex(0),
          isValid: true,
        }
      : null,
  },
});

const absent = (inFlight: DecodedInFlightTransaction) =>
  lookedUp(inFlight, { isOnChain: false });

const keyOf = ({
  chainId,
  txId: id,
}: DecodedInFlightTransaction): InFlightTransactionKey =>
  `${CardanoNetworkId(chainId.networkMagic)}:${id}`;

const inFlightOf = (...entries: DecodedInFlightTransaction[]) =>
  Object.fromEntries(entries.map(item => [keyOf(item), item])) as Record<
    InFlightTransactionKey,
    DecodedInFlightTransaction
  >;

const boundEntry = entry(TX, { invalidHereafter: BOUND });
const laterEntry = entry(LATER_TX, { invalidHereafter: BOUND + 500 });
const unboundedEntry = entry(UNBOUNDED_TX);

/** The Pending display row of a transaction on an account. */
const pendingRow = (
  accountId: AccountId,
  id: Cardano.TransactionId,
  blockchainSpecific?: Activity['blockchainSpecific'],
): Activity => ({
  accountId,
  activityId: id,
  timestamp: Timestamp(SUBMITTED_AT),
  tokenBalanceChanges: [],
  type: ActivityType.Pending,
  ...(blockchainSpecific === undefined ? {} : { blockchainSpecific }),
});

/** A history entry of a transaction. */
const historyItem = (id: Cardano.TransactionId) =>
  ({
    txId: id,
    blockNumber: 1,
    txIndex: 0,
    blockTime: Timestamp(0),
  } as unknown as CardanoTransactionHistoryItem);

/** One address's stored history. */
const storedAt = (transactionHistory: CardanoTransactionHistoryItem[]) => ({
  hasLoadedOldestEntry: true,
  transactionHistory,
});

const removed = (...entries: DecodedInFlightTransaction[]) =>
  actions.cardanoContext.removeInFlightTransactions({
    keys: entries.map(keyOf),
  });

const rowsRemoved = (accountId: AccountId, ...ids: Cardano.TransactionId[]) =>
  actions.activities.removeActivities({ accountId, activityIds: ids });

type Timeline<T> = { marble: string; values: Record<string, T>; hot?: true };

const constant = <T>(value: T): Timeline<T> => ({
  marble: 'a',
  values: { a: value },
});

/**
 * Runs the side effect over the wallet state below and expects `expected`.
 * Constant state starts at the subscription, as the store's replayed state
 * does; a hot timeline starts a frame late, after the side effect subscribed.
 */
const expectReconciliation = ({
  accounts,
  inFlight,
  networkInfo = {},
  utxos = {},
  history = {},
  activities = {},
  isWalletActive = { marble: 't', values: { t: true } },
  subscription = '^-----!',
  expected,
  values = {},
}: {
  accounts: AnyAccount[];
  inFlight:
    | Record<InFlightTransactionKey, DecodedInFlightTransaction>
    | Timeline<Record<InFlightTransactionKey, DecodedInFlightTransaction>>;
  networkInfo?:
    | Partial<Record<CardanoNetworkId, CardanoNetworkInfo>>
    | Timeline<Partial<Record<CardanoNetworkId, CardanoNetworkInfo>>>;
  utxos?: AccountUtxoMap | Timeline<AccountUtxoMap>;
  history?:
    | CardanoAccountAddressHistoryMap
    | Timeline<CardanoAccountAddressHistoryMap>;
  activities?:
    | Record<AccountId, Activity[]>
    | Timeline<Record<AccountId, Activity[]>>;
  isWalletActive?: Timeline<boolean>;
  subscription?: string;
  expected: string;
  values?: Record<string, unknown>;
}) => {
  const isTimeline = <T>(value: T | Timeline<T>): value is Timeline<T> =>
    typeof value === 'object' &&
    value !== null &&
    'marble' in value &&
    'values' in value;
  testSideEffect(
    reconcileInFlightTransactions,
    ({ cold, hot, expectObservable }) => {
      const stream = <T>(value: T | Timeline<T>) => {
        const timeline = isTimeline(value) ? value : constant(value);
        return (timeline.hot ? hot : cold)(timeline.marble, timeline.values);
      };
      return {
        actionObservables: {},
        stateObservables: {
          wallets: {
            selectAll$: cold('a', {
              a: [{ ...threeAccountCardanoWallet, accounts } as AnyWallet],
            }),
          },
          cardanoContext: {
            selectInFlightTransactions$: stream(inFlight),
            selectAccountUtxos$: stream(utxos),
            selectAccountTransactionHistory$: stream(history),
            selectAllNetworkInfo$: stream(networkInfo),
          },
          activities: { selectAllMap$: stream(activities) },
        },
        dependencies: { actions, isWalletActive$: stream(isWalletActive) },
        assertion: sideEffect$ => {
          expectObservable(sideEffect$, subscription).toBe(expected, values);
        },
      };
    },
  );
};

describe('reconcileInFlightTransactions', () => {
  describe('a transaction that can no longer settle', () => {
    it('is removed with its Pending activity once the provider, asked past its bound by the depth, does not hold it', () => {
      expectReconciliation({
        accounts: [KEY_A],
        inFlight: inFlightOf(absent(boundEntry), laterEntry, unboundedEntry),
        activities: {
          [KEY_A.accountId]: [
            pendingRow(KEY_A.accountId, TX),
            pendingRow(KEY_A.accountId, LATER_TX),
            pendingRow(KEY_A.accountId, UNBOUNDED_TX),
          ],
        },
        expected: '(ab)',
        values: {
          a: removed(boundEntry),
          b: rowsRemoved(KEY_A.accountId, TX),
        },
      });
    });

    it('is kept when the provider was asked with the tip at its bound plus the depth', () => {
      expectReconciliation({
        accounts: [KEY_A],
        inFlight: inFlightOf(
          lookedUp(boundEntry, {
            isOnChain: false,
            tipSlot: BOUND + UTXO_SYNC_CONFIRMATION_DEPTH,
          }),
        ),
        expected: '',
      });
    });

    it("is kept without the provider's answer although the network's tip passed its bound, and removed once the answer lands", () => {
      expectReconciliation({
        accounts: [KEY_A],
        inFlight: {
          marble: 'a--b',
          values: {
            a: inFlightOf(boundEntry),
            b: inFlightOf(absent(boundEntry)),
          },
        },
        networkInfo: { [PREPROD]: { tip: tipAt(EXPIRED_SLOT * 100) } },
        expected: '---a',
        values: { a: removed(boundEntry) },
      });
    });

    it('is kept when its network shows it although the provider did not hold it', () => {
      expectReconciliation({
        accounts: [KEY_A],
        inFlight: inFlightOf(
          absent(
            entry(TX, {
              invalidHereafter: BOUND,
              consumedInputs: [OWN_UTXO[0]],
            }),
          ),
        ),
        history: {
          [KEY_A.accountId]: { [ADDRESS]: storedAt([historyItem(TX)]) },
        },
        utxos: { [KEY_A.accountId]: [OWN_UTXO] },
        expected: '',
      });
    });

    it('is never removed without a bound unless its parent expires', () => {
      expectReconciliation({
        accounts: [KEY_A],
        inFlight: inFlightOf(
          lookedUp(unboundedEntry, {
            isOnChain: false,
            tipSlot: EXPIRED_SLOT * 100,
          }),
        ),
        activities: {
          [KEY_A.accountId]: [pendingRow(KEY_A.accountId, UNBOUNDED_TX)],
        },
        networkInfo: { [PREPROD]: { tip: tipAt(EXPIRED_SLOT * 100) } },
        expected: '',
      });
    });

    it("goes by the provider's answer on a custody account like on any other", () => {
      const custodyEntry = entry(CUSTODY_TX, { invalidHereafter: BOUND });
      const custodyRow = pendingRow(CUSTODY.accountId, CUSTODY_TX, {
        Cardano: {
          custody: {
            invalidHereafter: Cardano.Slot(BOUND),
            operation: 'owner-spend',
            status: 'pending',
          },
        },
      });
      expectReconciliation({
        accounts: [KEY_A, CUSTODY],
        inFlight: inFlightOf(absent(custodyEntry)),
        activities: { [CUSTODY.accountId]: [custodyRow] },
        expected: '(ab)',
        values: {
          a: removed(custodyEntry),
          b: rowsRemoved(CUSTODY.accountId, CUSTODY_TX),
        },
      });
    });

    it('removes the entries of every account in one action and its Pending activities in one action per account', () => {
      const custodyEntry = entry(CUSTODY_TX, { invalidHereafter: BOUND });
      expectReconciliation({
        accounts: [KEY_A, CUSTODY],
        inFlight: inFlightOf(
          absent(boundEntry),
          lookedUp(laterEntry, {
            isOnChain: false,
            tipSlot: EXPIRED_SLOT + 500,
          }),
          absent(custodyEntry),
        ),
        activities: {
          [KEY_A.accountId]: [
            pendingRow(KEY_A.accountId, TX),
            pendingRow(KEY_A.accountId, LATER_TX),
          ],
          [CUSTODY.accountId]: [pendingRow(CUSTODY.accountId, CUSTODY_TX)],
        },
        expected: '(abc)',
        values: {
          a: removed(boundEntry, laterEntry, custodyEntry),
          b: rowsRemoved(KEY_A.accountId, TX, LATER_TX),
          c: rowsRemoved(CUSTODY.accountId, CUSTODY_TX),
        },
      });
    });

    describe('on a network with no Cardano account', () => {
      it("is removed once the network's own tip is past its bound by the depth", () => {
        expectReconciliation({
          accounts: [PREVIEW_ACCOUNT],
          inFlight: inFlightOf(boundEntry),
          networkInfo: {
            marble: 'a--b',
            values: {
              a: {
                [PREPROD]: {
                  tip: tipAt(BOUND + UTXO_SYNC_CONFIRMATION_DEPTH),
                },
              },
              b: { [PREPROD]: { tip: tipAt(EXPIRED_SLOT) } },
            },
          },
          expected: '---a',
          values: { a: removed(boundEntry) },
        });
      });

      it.each([
        [
          'without a bound',
          unboundedEntry,
          { [PREPROD]: { tip: tipAt(EXPIRED_SLOT * 100) } },
        ],
        ['while its network has no tip', boundEntry, {}],
      ])('is kept %s', (_, kept, networkInfo) => {
        expectReconciliation({
          accounts: [],
          inFlight: inFlightOf(kept),
          networkInfo,
          expected: '',
        });
      });
    });
  });

  describe('a transaction that settled', () => {
    const spending = entry(TX, {
      invalidHereafter: BOUND,
      consumedInputs: [OWN_UTXO[0]],
    });
    const pending = { [KEY_A.accountId]: [pendingRow(KEY_A.accountId, TX)] };

    it.each([
      [
        'history',
        {
          history: {
            [KEY_B.accountId]: { [ADDRESS]: storedAt([historyItem(TX)]) },
          },
        },
      ],
      [
        'confirmed activity',
        {
          activities: {
            ...pending,
            [KEY_B.accountId]: [
              { ...pendingRow(KEY_B.accountId, TX), type: ActivityType.Send },
            ],
          },
        },
      ],
    ])(
      'is removed without its Pending activity once an account shows it in its %s and no synced UTxO is one it spends',
      (_, shown) => {
        expectReconciliation({
          accounts: [KEY_A, KEY_B],
          inFlight: inFlightOf(spending),
          activities: pending,
          ...shown,
          expected: 'a',
          values: { a: removed(spending) },
        });
      },
    );

    it('is removed without its Pending activity once the provider holds it and no synced UTxO is one it spends', () => {
      expectReconciliation({
        accounts: [KEY_A],
        inFlight: inFlightOf(lookedUp(spending, { isOnChain: true })),
        activities: pending,
        utxos: {
          marble: 'a--b',
          values: {
            a: { [KEY_A.accountId]: [OWN_UTXO] },
            b: { [KEY_A.accountId]: [] },
          },
        },
        expected: '---a',
        values: { a: removed(spending) },
      });
    });

    it('is not shown by a synced UTxO under its ID, and expires when nothing else shows it', () => {
      // A host that serves the synced UTxOs lists the outputs of a
      // transaction it brokered under the transaction's ID before the
      // transaction lands, and leaves out the inputs it spends.
      expectReconciliation({
        accounts: [KEY_A],
        inFlight: inFlightOf(absent(spending)),
        activities: pending,
        utxos: { [KEY_A.accountId]: [utxoUnder(TX)] },
        expected: '(ab)',
        values: {
          a: removed(spending),
          b: rowsRemoved(KEY_A.accountId, TX),
        },
      });
    });

    it('is kept while the synced UTxOs still list an input it spends, and removed once the refetch drops it', () => {
      expectReconciliation({
        accounts: [KEY_A, KEY_B],
        inFlight: inFlightOf(spending),
        activities: pending,
        history: {
          [KEY_B.accountId]: { [ADDRESS]: storedAt([historyItem(TX)]) },
        },
        utxos: {
          marble: 'a--b',
          values: {
            a: { [KEY_A.accountId]: [OWN_UTXO] },
            b: { [KEY_A.accountId]: [] },
          },
        },
        expected: '---a',
        values: { a: removed(spending) },
      });
    });

    it('flagged isValid false, is removed once the synced UTxOs stop listing its collateral, though they still list its inputs', () => {
      const collateral = utxoUnder(txId('f2'));
      const failing = inFlightTransactionOf({
        serializedTx: HexBytes(
          Serialization.Transaction.fromCore({
            body: {
              inputs: [{ txId: OWN_UTXO[0].txId, index: OWN_UTXO[0].index }],
              outputs: [
                {
                  address: Cardano.PaymentAddress(SECOND_ADDRESS),
                  value: { coins: 1_800_000n },
                },
              ],
              fee: 200_000n,
              collaterals: [
                { txId: collateral[0].txId, index: collateral[0].index },
              ],
            },
            id: Cardano.TransactionId('0'.repeat(64)),
            isValid: false,
            witness: { signatures: new Map() },
          }).toCbor(),
        ),
        chainId: Cardano.ChainIds.Preprod,
        submittedAt: Timestamp(SUBMITTED_AT),
      });
      expectReconciliation({
        accounts: [KEY_A],
        inFlight: inFlightOf(failing),
        history: {
          [KEY_A.accountId]: {
            [ADDRESS]: storedAt([historyItem(failing.txId)]),
          },
        },
        utxos: {
          marble: 'a--b',
          values: {
            a: { [KEY_A.accountId]: [OWN_UTXO, collateral] },
            b: { [KEY_A.accountId]: [OWN_UTXO] },
          },
        },
        expected: '---a',
        values: { a: removed(failing) },
      });
    });

    it('is not shown by an account on another network', () => {
      expectReconciliation({
        accounts: [KEY_A, PREVIEW_ACCOUNT],
        inFlight: inFlightOf(absent(boundEntry)),
        history: {
          [PREVIEW_ACCOUNT.accountId]: {
            [ADDRESS]: storedAt([historyItem(TX)]),
          },
        },
        expected: 'a',
        values: { a: removed(boundEntry) },
      });
    });
  });

  describe('transactions that spend the outputs of an expired parent', () => {
    const parent = entry(TX, {
      invalidHereafter: BOUND,
      consumedInputs: [OWN_UTXO[0]],
    });
    const child = entry(LATER_TX, {
      invalidHereafter: BOUND + 500,
      consumedInputs: [{ txId: TX, index: 0 }],
    });
    const grandchild = entry(UNBOUNDED_TX, {
      consumedInputs: [{ txId: LATER_TX, index: 0 }],
    });

    it.each([false, true])(
      'are removed with later or absent bounds whatever the entry order (reversed: %s)',
      isReversed => {
        const entries = [absent(parent), child, grandchild];
        if (isReversed) entries.reverse();
        expectReconciliation({
          accounts: [KEY_A],
          inFlight: inFlightOf(...entries),
          activities: {
            [KEY_A.accountId]: entries.map(({ txId: id }) =>
              pendingRow(KEY_A.accountId, id),
            ),
          },
          utxos: { [KEY_A.accountId]: [OWN_UTXO] },
          expected: '(ab)',
          values: {
            a: removed(parent, child, grandchild),
            b: rowsRemoved(KEY_A.accountId, TX, LATER_TX, UNBOUNDED_TX),
          },
        });
      },
    );

    it.each(['absent', 'history'] as const)(
      'are followed across accounts on the same network only, when the parent is %s',
      evidence => {
        const previewChild = entry(LATER_TX, {
          invalidHereafter: BOUND + 500,
          consumedInputs: [{ txId: TX, index: 0 }],
          chainId: Cardano.ChainIds.Preview,
        });
        expectReconciliation({
          accounts: [KEY_A, KEY_B, PREVIEW_ACCOUNT],
          inFlight: inFlightOf(absent(parent), child, grandchild, previewChild),
          activities: {
            [KEY_A.accountId]: [
              pendingRow(KEY_A.accountId, TX),
              pendingRow(KEY_A.accountId, UNBOUNDED_TX),
            ],
            [KEY_B.accountId]: [
              pendingRow(KEY_B.accountId, LATER_TX),
              pendingRow(KEY_B.accountId, TX),
            ],
            [PREVIEW_ACCOUNT.accountId]: [
              pendingRow(PREVIEW_ACCOUNT.accountId, LATER_TX),
            ],
          },
          utxos: { [KEY_A.accountId]: [OWN_UTXO] },
          history: {
            [KEY_B.accountId]: {
              [SECOND_ADDRESS]: storedAt(
                evidence === 'history' ? [historyItem(TX)] : [],
              ),
            },
          },
          expected: evidence === 'absent' ? '(abc)' : '',
          values: {
            a: removed(parent, child, grandchild),
            b: rowsRemoved(KEY_A.accountId, TX, UNBOUNDED_TX),
            c: rowsRemoved(KEY_B.accountId, TX, LATER_TX),
          },
        });
      },
    );
  });

  describe('transactions that spend the outputs of an entry that stays', () => {
    const parent = entry(TX, {
      invalidHereafter: BOUND,
      consumedInputs: [OWN_UTXO[0]],
    });
    const child = entry(LATER_TX, {
      invalidHereafter: BOUND + 500,
      consumedInputs: [{ txId: TX, index: 0 }],
    });
    const grandchild = entry(UNBOUNDED_TX, {
      consumedInputs: [{ txId: LATER_TX, index: 0 }],
    });
    const shownBy = (...ids: Cardano.TransactionId[]) => ({
      [KEY_A.accountId]: {
        [ADDRESS]: storedAt(ids.map(id => historyItem(id))),
      },
    });

    it('can reconcile a confirmed child before delayed parent acceptance, while keeping the parent until its original input leaves the synced snapshot', () => {
      expectReconciliation({
        accounts: [KEY_A],
        inFlight: {
          marble: 'a-b-c',
          values: {
            a: inFlightOf(child),
            b: inFlightOf(),
            c: inFlightOf(parent),
          },
        },
        activities: {
          [KEY_A.accountId]: [parent, child].map(item => ({
            ...pendingRow(KEY_A.accountId, item.txId),
            type: ActivityType.Send,
            blockchainSpecific: {
              Cardano: { consumedInputs: item.effects.consumedInputs },
            },
          })),
        },
        utxos: {
          marble: 'a-----b',
          values: {
            a: { [KEY_A.accountId]: [OWN_UTXO] },
            b: { [KEY_A.accountId]: [utxoUnder(LATER_TX)] },
          },
        },
        subscription: '^-------!',
        expected: 'a-----b',
        values: { a: removed(child), b: removed(parent) },
      });
    });

    it('stay while the synced UTxOs predate their shown parent, and go with it once the refetch reflects both', () => {
      expectReconciliation({
        accounts: [KEY_A],
        inFlight: inFlightOf(parent, child),
        history: shownBy(LATER_TX, TX),
        utxos: {
          marble: 'a--b',
          values: {
            a: { [KEY_A.accountId]: [OWN_UTXO] },
            b: { [KEY_A.accountId]: [utxoUnder(LATER_TX)] },
          },
        },
        expected: '---a',
        values: { a: removed(parent, child) },
      });
    });

    it('stay while another account shows them and their parent is not shown yet', () => {
      const keyBHistory = {
        [KEY_B.accountId]: {
          [SECOND_ADDRESS]: storedAt([historyItem(LATER_TX)]),
        },
      };
      expectReconciliation({
        accounts: [KEY_A, KEY_B],
        inFlight: inFlightOf(parent, child),
        history: {
          marble: 'a--b',
          values: {
            a: keyBHistory,
            b: { ...shownBy(LATER_TX, TX), ...keyBHistory },
          },
        },
        utxos: {
          marble: 'a----b',
          values: {
            a: { [KEY_A.accountId]: [OWN_UTXO], [KEY_B.accountId]: [] },
            b: { [KEY_A.accountId]: [], [KEY_B.accountId]: [] },
          },
        },
        subscription: '^-------!',
        expected: '-----a',
        values: { a: removed(parent, child) },
      });
    });

    it('stay at every depth, whatever the entry order', () => {
      expectReconciliation({
        accounts: [KEY_A],
        inFlight: inFlightOf(grandchild, child, parent),
        history: shownBy(UNBOUNDED_TX, LATER_TX, TX),
        utxos: {
          marble: 'a--b',
          values: {
            a: { [KEY_A.accountId]: [OWN_UTXO] },
            b: { [KEY_A.accountId]: [utxoUnder(UNBOUNDED_TX)] },
          },
        },
        expected: '---a',
        values: { a: removed(grandchild, child, parent) },
      });
    });

    it('stay while their unshown parent stays, and go in the pass it expires', () => {
      expectReconciliation({
        accounts: [KEY_A],
        inFlight: inFlightOf(absent(parent), child),
        history: shownBy(LATER_TX),
        expected: 'a',
        values: { a: removed(child, parent) },
      });
    });

    it('do not keep their parent once the synced UTxOs reflect it but still list the change they spend', () => {
      expectReconciliation({
        accounts: [KEY_A],
        inFlight: inFlightOf(parent, child),
        history: shownBy(LATER_TX, TX),
        utxos: { [KEY_A.accountId]: [utxoUnder(TX)] },
        expected: 'a',
        values: { a: removed(parent) },
      });
    });

    it('still expire by their own bound when their network does not show them', () => {
      const boundChild = entry(LATER_TX, {
        invalidHereafter: BOUND,
        consumedInputs: [{ txId: TX, index: 0 }],
      });
      expectReconciliation({
        accounts: [KEY_A],
        inFlight: inFlightOf(parent, absent(boundChild)),
        history: shownBy(TX),
        utxos: { [KEY_A.accountId]: [OWN_UTXO] },
        activities: {
          [KEY_A.accountId]: [pendingRow(KEY_A.accountId, LATER_TX)],
        },
        expected: '(ab)',
        values: {
          a: removed(boundChild),
          b: rowsRemoved(KEY_A.accountId, LATER_TX),
        },
      });
    });
  });

  describe('while the wallet is locked (ADR 29)', () => {
    it('removes nothing while the wallet is inactive', () => {
      expectReconciliation({
        accounts: [KEY_A],
        inFlight: inFlightOf(absent(boundEntry)),
        isWalletActive: { marble: 'f', values: { f: false }, hot: true },
        expected: '',
      });
    });

    it("decides from the stored provider's answer on unlock", () => {
      expectReconciliation({
        accounts: [KEY_A],
        inFlight: inFlightOf(absent(boundEntry)),
        isWalletActive: {
          marble: 'f--t',
          values: { f: false, t: true },
          hot: true,
        },
        expected: '---a',
        values: { a: removed(boundEntry) },
      });
    });
  });
});
