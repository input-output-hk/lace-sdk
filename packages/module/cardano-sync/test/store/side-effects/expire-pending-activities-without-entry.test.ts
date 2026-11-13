import { activitiesActions, ActivityType } from '@lace-contract/activities';
import { activitiesReducers } from '@lace-contract/activities/src/store/slice';
import {
  CardanoNetworkId,
  CardanoPaymentAddress,
  UNBOUNDED_IN_FLIGHT_SLOTS,
  UTXO_SYNC_CONFIRMATION_DEPTH,
} from '@lace-contract/cardano-context';
import { cardanoCustodyAccount } from '@lace-contract/cardano-context/test/custody-mocks';
import {
  previewAccountCardanoWalletAccounts,
  threeAccountCardanoWallet,
  threeAccountCardanoWalletAccounts,
} from '@lace-contract/cardano-context/test/mocks';
import { AccountId } from '@lace-contract/wallet-repo';
import {
  Cardano,
  ProviderError,
  ProviderFailure,
} from '@lace-lib/cardano-core';
import { Err, Ok, Timestamp } from '@lace-lib/util';
import { testSideEffect } from '@lace-lib/util-dev';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { expirePendingActivitiesWithoutEntry } from '../../../src/store/side-effects/expire-pending-activities-without-entry';

import type { Activity } from '@lace-contract/activities';
import type {
  CardanoAccountAddressHistoryMap,
  CardanoNetworkInfo,
  CardanoProviderDependencies,
  CardanoTransactionHistoryItem,
  CardanoTransactionInclusion,
  InFlightTransaction,
  InFlightTransactionKey,
} from '@lace-contract/cardano-context';
import type { AnyAccount, AnyWallet } from '@lace-contract/wallet-repo';
import type { Result } from '@lace-lib/util';
import type { Observable } from 'rxjs';
import type { Logger } from 'ts-log';

const actions = activitiesActions;

const [KEY_A, KEY_B] = threeAccountCardanoWalletAccounts;
const [PREVIEW_ACCOUNT] = previewAccountCardanoWalletAccounts;
const CUSTODY = cardanoCustodyAccount;
const BITCOIN_ACCOUNT = {
  ...KEY_A,
  accountId: AccountId('bitcoin-account'),
  blockchainName: 'Bitcoin',
} as unknown as AnyAccount;

const PREPROD = CardanoNetworkId(Cardano.ChainIds.Preprod.networkMagic);
const PREVIEW = CardanoNetworkId(Cardano.ChainIds.Preview.networkMagic);

/** When the Pending activities were written. */
const SUBMITTED_AT = 10_000;
/** The age past which the provider is asked about an activity without a bound. */
const GRACE_MS =
  (UNBOUNDED_IN_FLIGHT_SLOTS + UTXO_SYNC_CONFIRMATION_DEPTH) * 1000;
const AT_GRACE = SUBMITTED_AT + GRACE_MS;

const BOUND = 1_000;
/** The last tip slot at which the provider is not asked about a bounded activity. */
const AT_DEPTH = BOUND + UTXO_SYNC_CONFIRMATION_DEPTH;
const PAST = AT_DEPTH + 1;

const txId = (byte: string) => Cardano.TransactionId(byte.repeat(32));
const TX = txId('d1');
const OTHER_TX = txId('d2');

const ADDRESS = CardanoPaymentAddress(
  'addr_test1vz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerspjrlsz',
);

const INCLUSION: CardanoTransactionInclusion = {
  blockHash: Cardano.BlockId('ab'.repeat(32)),
  blockHeight: Cardano.BlockNo(42),
  slot: Cardano.Slot(BOUND - 10),
  txIndex: Cardano.TxIndex(3),
  isValid: true,
};

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

/** A custody operation's Pending row, which records the transaction's bound. */
const custodyRow = (id: Cardano.TransactionId): Activity =>
  pendingRow(CUSTODY.accountId, id, {
    Cardano: {
      custody: {
        invalidHereafter: Cardano.Slot(BOUND),
        operation: 'owner-spend',
        status: 'pending',
      },
    },
  });

const confirmedRow = (accountId: AccountId, id: Cardano.TransactionId) => ({
  ...pendingRow(accountId, id),
  type: ActivityType.Send,
});

const historyItem = (id: Cardano.TransactionId) =>
  ({
    txId: id,
    blockNumber: 1,
    txIndex: 0,
    blockTime: Timestamp(0),
  } as unknown as CardanoTransactionHistoryItem);

const tipAt = (slot: number): Cardano.Tip => ({
  slot: Cardano.Slot(slot),
  blockNo: Cardano.BlockNo(slot),
  hash: Cardano.BlockId(slot.toString(16).padStart(64, '0')),
});

const preprodTipAt = (
  slot: number,
): Partial<Record<CardanoNetworkId, CardanoNetworkInfo>> => ({
  [PREPROD]: { tip: tipAt(slot) },
});

const rowsRemoved = (accountId: AccountId, ...ids: Cardano.TransactionId[]) =>
  actions.activities.removeActivities({
    accountId,
    activityIds: ids,
    onlyPending: true,
  });

type Answer = Result<CardanoTransactionInclusion | null, ProviderError>;

const unavailable = Err<ProviderError>(
  new ProviderError(ProviderFailure.Unhealthy),
);

type Timeline<T> = { marble: string; values: Record<string, T> };

const constant = <T>(value: T): Timeline<T> => ({
  marble: 'a',
  values: { a: value },
});

const isTimeline = <T>(value: T | Timeline<T>): value is Timeline<T> =>
  typeof value === 'object' &&
  value !== null &&
  'marble' in value &&
  'values' in value;

const timelineOf = <T>(value: T | Timeline<T>): Timeline<T> =>
  isTimeline(value) ? value : constant(value);

/** What the selector of the Pending activities returns for these activities. */
const pendingOf = (
  activitiesByAccount: Record<AccountId, Activity[]>,
): Record<AccountId, Activity[]> => {
  const pending: Record<AccountId, Activity[]> = {};
  for (const [accountId, rows] of Object.entries(activitiesByAccount) as [
    AccountId,
    Activity[],
  ][]) {
    const pendingRows = rows.filter(
      ({ type }) => type === ActivityType.Pending,
    );
    if (pendingRows.length > 0) pending[accountId] = pendingRows;
  }
  return pending;
};

/**
 * Runs the side effect over the wallet state below, with the provider
 * answering each request as `answer` does, and expects `expected`. Returns
 * the provider mock and the logger.
 */
const expectSweep = ({
  accounts,
  activities,
  inFlight = {},
  history = {},
  networkInfo = preprodTipAt(PAST),
  answer = '-a|',
  answers = { a: Ok(null) },
  isWalletActive = 't',
  expected,
  values = {},
}: {
  accounts: AnyAccount[];
  activities:
    | Record<AccountId, Activity[]>
    | Timeline<Record<AccountId, Activity[]>>;
  inFlight?: Partial<Record<InFlightTransactionKey, InFlightTransaction>>;
  history?: CardanoAccountAddressHistoryMap;
  networkInfo?:
    | Partial<Record<CardanoNetworkId, CardanoNetworkInfo>>
    | Timeline<Partial<Record<CardanoNetworkId, CardanoNetworkInfo>>>;
  answer?: string;
  answers?: Record<string, Answer>;
  isWalletActive?: string;
  expected: string;
  values?: Record<string, unknown>;
}) => {
  const checkTransaction =
    vi.fn<CardanoProviderDependencies['cardanoProvider']['checkTransaction']>();
  const logger = { warn: vi.fn() } as unknown as Logger;
  const activitiesTimeline = timelineOf(activities);
  const networkInfoTimeline = timelineOf(networkInfo);
  testSideEffect(
    expirePendingActivitiesWithoutEntry,
    ({ cold, expectObservable }) => {
      // Each request subscribes anew, so each answers `answer` after its start.
      const answer$ = cold(answer, answers) as Observable<Answer>;
      checkTransaction.mockReturnValue(answer$);
      return {
        actionObservables: {},
        stateObservables: {
          activities: {
            selectAllMap$: cold(
              activitiesTimeline.marble,
              activitiesTimeline.values,
            ),
            selectPendingActivitiesByAccount$: cold(
              activitiesTimeline.marble,
              Object.fromEntries(
                Object.entries(activitiesTimeline.values).map(
                  ([frame, value]) => [frame, pendingOf(value)],
                ),
              ),
            ),
          },
          cardanoContext: {
            selectInFlightTransactionsRaw$: cold('a', { a: inFlight }),
            selectAccountTransactionHistory$: cold('a', { a: history }),
            selectAllNetworkInfo$: cold(
              networkInfoTimeline.marble,
              networkInfoTimeline.values,
            ),
          },
          wallets: {
            selectAll$: cold('a', {
              a: [{ ...threeAccountCardanoWallet, accounts } as AnyWallet],
            }),
          },
        },
        dependencies: {
          actions,
          cardanoProvider: {
            checkTransaction,
          } as unknown as CardanoProviderDependencies['cardanoProvider'],
          logger,
          isWalletActive$: cold(isWalletActive, { t: true, f: false }),
        },
        assertion: sideEffect$ => {
          expectObservable(sideEffect$, '^---------!').toBe(expected, values);
        },
      };
    },
  );
  return { checkTransaction, logger };
};

describe('expirePendingActivitiesWithoutEntry', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(AT_GRACE + 1);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('removes a Pending activity older than the grace once the provider does not hold its transaction', () => {
    const { checkTransaction } = expectSweep({
      accounts: [KEY_A],
      activities: { [KEY_A.accountId]: [pendingRow(KEY_A.accountId, TX)] },
      expected: '-a',
      values: { a: rowsRemoved(KEY_A.accountId, TX) },
    });

    expect(checkTransaction).toHaveBeenCalledTimes(1);
    expect(checkTransaction).toHaveBeenCalledWith(TX, {
      chainId: Cardano.ChainIds.Preprod,
    });
  });

  it('asks nothing about a Pending activity inside the grace', () => {
    vi.setSystemTime(AT_GRACE);
    const { checkTransaction } = expectSweep({
      accounts: [KEY_A],
      activities: { [KEY_A.accountId]: [pendingRow(KEY_A.accountId, TX)] },
      expected: '',
    });

    expect(checkTransaction).not.toHaveBeenCalled();
  });

  it.each(['sdk-row', '', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64)])(
    'never looks up or expires a non-transaction activity id: %s',
    activityId => {
      const { checkTransaction } = expectSweep({
        accounts: [KEY_A],
        activities: {
          [KEY_A.accountId]: [
            { ...pendingRow(KEY_A.accountId, TX), activityId },
          ],
        },
        networkInfo: {
          marble: 'a--b',
          values: { a: preprodTipAt(PAST), b: preprodTipAt(PAST + 20) },
        },
        expected: '',
      });
      expect(checkTransaction).not.toHaveBeenCalled();
    },
  );

  it('accepts a transaction id containing uppercase hexadecimal characters', () => {
    const id = Cardano.TransactionId('AB'.repeat(32));
    const { checkTransaction } = expectSweep({
      accounts: [KEY_A],
      activities: { [KEY_A.accountId]: [pendingRow(KEY_A.accountId, id)] },
      expected: '-a',
      values: { a: rowsRemoved(KEY_A.accountId, id) },
    });
    expect(checkTransaction).toHaveBeenCalledWith(id, {
      chainId: Cardano.ChainIds.Preprod,
    });
  });

  it('preserves a row confirmed during a delayed not-found lookup when the removal reaches the reducer', () => {
    const confirmed = confirmedRow(KEY_A.accountId, TX);
    const removal = rowsRemoved(KEY_A.accountId, TX);
    const { checkTransaction } = expectSweep({
      accounts: [KEY_A, KEY_B],
      activities: {
        marble: 'a-b',
        values: {
          a: {
            [KEY_A.accountId]: [pendingRow(KEY_A.accountId, TX)],
            [KEY_B.accountId]: [pendingRow(KEY_B.accountId, TX)],
          },
          b: {
            [KEY_A.accountId]: [confirmed],
            [KEY_B.accountId]: [pendingRow(KEY_B.accountId, TX)],
          },
        },
      },
      answer: '----a|',
      expected: '----(ab)',
      values: { a: removal, b: rowsRemoved(KEY_B.accountId, TX) },
    });
    const state = activitiesReducers.activities(
      undefined,
      actions.activities.upsertActivities({
        accountId: KEY_A.accountId,
        activities: [confirmed],
      }),
    );
    expect(activitiesReducers.activities(state, removal)).toBe(state);
    expect(checkTransaction).toHaveBeenCalledTimes(1);
  });

  it('waits for the grace from the newest Pending activity of the transaction', () => {
    const { checkTransaction } = expectSweep({
      accounts: [KEY_A, KEY_B],
      activities: {
        [KEY_A.accountId]: [pendingRow(KEY_A.accountId, TX)],
        [KEY_B.accountId]: [
          {
            ...pendingRow(KEY_B.accountId, TX),
            timestamp: Timestamp(SUBMITTED_AT + 1),
          },
        ],
      },
      expected: '',
    });

    expect(checkTransaction).not.toHaveBeenCalled();
  });

  it('asks nothing while an account of the network shows the transaction in its history or a non-Pending activity', () => {
    const { checkTransaction } = expectSweep({
      accounts: [KEY_A, KEY_B],
      activities: {
        [KEY_A.accountId]: [
          pendingRow(KEY_A.accountId, TX),
          pendingRow(KEY_A.accountId, OTHER_TX),
        ],
        [KEY_B.accountId]: [confirmedRow(KEY_B.accountId, OTHER_TX)],
      },
      history: {
        [KEY_B.accountId]: {
          [ADDRESS]: {
            hasLoadedOldestEntry: true,
            transactionHistory: [historyItem(TX)],
          },
        },
      },
      expected: '',
    });

    expect(checkTransaction).not.toHaveBeenCalled();
  });

  it('never touches a Pending activity whose transaction has an in-flight entry', () => {
    const { checkTransaction } = expectSweep({
      accounts: [KEY_A],
      activities: { [KEY_A.accountId]: [pendingRow(KEY_A.accountId, TX)] },
      inFlight: {
        [`${PREPROD}:${TX}`]: {} as InFlightTransaction,
      },
      expected: '',
    });

    expect(checkTransaction).not.toHaveBeenCalled();
  });

  it('never touches a Pending activity of an account of another chain', () => {
    const { checkTransaction } = expectSweep({
      accounts: [KEY_A, BITCOIN_ACCOUNT],
      activities: {
        [BITCOIN_ACCOUNT.accountId]: [
          pendingRow(BITCOIN_ACCOUNT.accountId, TX),
        ],
      },
      expected: '',
    });

    expect(checkTransaction).not.toHaveBeenCalled();
  });

  it('asks nothing on a network without a stored tip', () => {
    const { checkTransaction } = expectSweep({
      accounts: [PREVIEW_ACCOUNT],
      activities: {
        [PREVIEW_ACCOUNT.accountId]: [
          pendingRow(PREVIEW_ACCOUNT.accountId, TX),
        ],
      },
      expected: '',
    });

    expect(checkTransaction).not.toHaveBeenCalled();
  });

  it('keeps the activity of a transaction the provider holds, and asks about it once while the wallet stays active', () => {
    const { checkTransaction } = expectSweep({
      accounts: [KEY_A],
      activities: { [KEY_A.accountId]: [pendingRow(KEY_A.accountId, TX)] },
      networkInfo: {
        marble: 'a--b',
        values: { a: preprodTipAt(PAST), b: preprodTipAt(PAST + 20) },
      },
      answers: { a: Ok(INCLUSION) },
      expected: '',
    });

    expect(checkTransaction).toHaveBeenCalledTimes(1);
  });

  it("waits for the network's tip to pass the bound a custody activity records by the depth, then asks and removes it", () => {
    vi.setSystemTime(SUBMITTED_AT);
    const { checkTransaction } = expectSweep({
      accounts: [KEY_A, CUSTODY],
      activities: { [CUSTODY.accountId]: [custodyRow(TX)] },
      networkInfo: {
        marble: 'a--b',
        values: { a: preprodTipAt(AT_DEPTH), b: preprodTipAt(PAST) },
      },
      expected: '----a',
      values: { a: rowsRemoved(CUSTODY.accountId, TX) },
    });

    expect(checkTransaction).toHaveBeenCalledTimes(1);
  });

  it("waits for the custody activity's bound although another account's activity of the transaction is past the grace", () => {
    const { checkTransaction } = expectSweep({
      accounts: [KEY_A, CUSTODY],
      activities: {
        [KEY_A.accountId]: [pendingRow(KEY_A.accountId, TX)],
        [CUSTODY.accountId]: [custodyRow(TX)],
      },
      networkInfo: preprodTipAt(AT_DEPTH),
      expected: '',
    });

    expect(checkTransaction).not.toHaveBeenCalled();
  });

  it("removes the transaction's Pending activities from every account of its network, one action per account, asking each network's provider", () => {
    const { checkTransaction } = expectSweep({
      accounts: [KEY_A, KEY_B, PREVIEW_ACCOUNT],
      activities: {
        [KEY_A.accountId]: [pendingRow(KEY_A.accountId, TX)],
        [KEY_B.accountId]: [pendingRow(KEY_B.accountId, TX)],
        [PREVIEW_ACCOUNT.accountId]: [
          pendingRow(PREVIEW_ACCOUNT.accountId, TX),
        ],
      },
      networkInfo: {
        ...preprodTipAt(PAST),
        [PREVIEW]: { tip: tipAt(PAST) },
      },
      expected: '-(abc)',
      values: {
        a: rowsRemoved(KEY_A.accountId, TX),
        b: rowsRemoved(KEY_B.accountId, TX),
        c: rowsRemoved(PREVIEW_ACCOUNT.accountId, TX),
      },
    });

    expect(checkTransaction).toHaveBeenCalledTimes(2);
    expect(checkTransaction).toHaveBeenCalledWith(TX, {
      chainId: Cardano.ChainIds.Preprod,
    });
    expect(checkTransaction).toHaveBeenCalledWith(TX, {
      chainId: Cardano.ChainIds.Preview,
    });
  });

  it('asks again only once the tip moves after a request the provider could not answer', () => {
    const row = pendingRow(KEY_A.accountId, TX);
    const { checkTransaction, logger } = expectSweep({
      accounts: [KEY_A],
      activities: {
        marble: 'a-b',
        values: {
          a: { [KEY_A.accountId]: [row] },
          b: { [KEY_A.accountId]: [row] },
        },
      },
      networkInfo: {
        marble: 'a---b',
        values: { a: preprodTipAt(PAST), b: preprodTipAt(PAST + 20) },
      },
      answers: { a: unavailable },
      expected: '',
    });

    expect(checkTransaction).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('asks a request that fails by throwing again at the next tip', () => {
    const { checkTransaction, logger } = expectSweep({
      accounts: [KEY_A],
      activities: { [KEY_A.accountId]: [pendingRow(KEY_A.accountId, TX)] },
      answer: '#',
      expected: '',
    });

    expect(checkTransaction).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('asks nothing while the wallet is locked', () => {
    const { checkTransaction } = expectSweep({
      accounts: [KEY_A],
      activities: { [KEY_A.accountId]: [pendingRow(KEY_A.accountId, TX)] },
      isWalletActive: 'f',
      expected: '',
    });

    expect(checkTransaction).not.toHaveBeenCalled();
  });
});
