import {
  UNBOUNDED_IN_FLIGHT_SLOTS,
  UTXO_SYNC_CONFIRMATION_DEPTH,
} from '@lace-contract/cardano-context';
import { whileActive } from '@lace-contract/wallet-active-state';
import {
  EMPTY,
  catchError,
  combineLatest,
  defer,
  distinctUntilChanged,
  from,
  map,
  mergeMap,
  scan,
  switchMap,
} from 'rxjs';

import { extensionActivityValidityBound } from './account-extensions';
import { nextAttempts } from './ask-once-per-tip';
import { cardanoAccountsByNetwork, networkViewOf } from './network-view';

import type { Attempts, TipCandidate } from './ask-once-per-tip';
import type { CardanoSyncAction, SideEffect } from '../../module';
import type { Activity } from '@lace-contract/activities';
import type {
  CardanoAccountAddressHistoryMap,
  CardanoNetworkId,
  CardanoNetworkInfo,
  InFlightTransaction,
  InFlightTransactionKey,
} from '@lace-contract/cardano-context';
import type { AccountId, AnyWallet } from '@lace-contract/wallet-repo';
import type { Cardano } from '@lace-lib/cardano-core';

/**
 * How old a Pending activity without an entry must be before the provider is
 * asked about its transaction. A slot lasts one second on every Cardano
 * network since Shelley, so this mirrors the cut-off an entry without a bound
 * gets: an activity never goes earlier than an entry would.
 */
const PENDING_ACTIVITY_WITHOUT_ENTRY_GRACE_MS =
  (UNBOUNDED_IN_FLIGHT_SLOTS + UTXO_SYNC_CONFIRMATION_DEPTH) * 1000;

/** A transaction whose Pending activities have no entry, due a lookup. */
type Candidate = TipCandidate & {
  txId: Cardano.TransactionId;
  chainId: Cardano.ChainId;
  /** The accounts of the network that hold a Pending activity with its ID. */
  accountIds: AccountId[];
};

/**
 * Whether a transaction its Pending activities show may no longer land, so
 * the provider's answer is proof: its network's stored tip is past the
 * validity bound a feature's activity records by the depth, or, without such
 * a bound, its newest activity is older than the grace.
 */
const isPastBound = (
  rows: Activity[],
  tipSlot: Cardano.Slot,
  now: number,
): boolean => {
  const bounds = rows.flatMap(row => extensionActivityValidityBound(row) ?? []);
  return bounds.length > 0
    ? tipSlot > Math.max(...bounds) + UTXO_SYNC_CONFIRMATION_DEPTH
    : rows.every(
        ({ timestamp }) =>
          now - timestamp > PENDING_ACTIVITY_WITHOUT_ENTRY_GRACE_MS,
      );
};

/**
 * The transactions of the Pending activities on Cardano accounts that no
 * entry holds, that no account of their network shows, and that may no longer
 * land.
 */
const candidatesOf = ({
  inFlight,
  wallets,
  networkInfo,
  now,
  ...state
}: {
  inFlight: Partial<Record<InFlightTransactionKey, InFlightTransaction>>;
  wallets: readonly AnyWallet[];
  networkInfo: Partial<Record<CardanoNetworkId, CardanoNetworkInfo>>;
  historyByAccount: CardanoAccountAddressHistoryMap;
  activitiesByAccount: Partial<Record<AccountId, Activity[]>>;
  now: number;
}): Candidate[] => {
  const candidates: Candidate[] = [];
  for (const [networkId, accounts] of cardanoAccountsByNetwork(wallets)) {
    const tip = networkInfo[networkId]?.tip;
    if (!tip) continue;
    const { shownTxIds, pendingRows } = networkViewOf(accounts, state);
    for (const [txId, rows] of pendingRows) {
      if (!/^[\da-f]{64}$/i.test(txId)) continue;
      const key: InFlightTransactionKey = `${networkId}:${txId}`;
      if (inFlight[key] || shownTxIds.has(txId)) continue;
      if (!isPastBound(rows, tip.slot, now)) continue;
      candidates.push({
        key,
        tipSlot: tip.slot,
        txId: txId as Cardano.TransactionId,
        chainId: accounts[0].blockchainSpecific.chainId,
        accountIds: rows.map(({ accountId }) => accountId),
      });
    }
  }
  return candidates;
};

/**
 * Removes the Pending activities of a Cardano transaction that has no
 * in-flight entry once the provider does not hold it after the transaction
 * could have landed. Such an activity has no entry whose expiry would remove
 * it: one from a build before the in-flight store, one the publisher or the
 * guest's pull lands as its entry expires, a flow's own activity whose bytes
 * the recorder could not decode, and one an SDK app dispatches itself.
 *
 * The provider's answer is the proof, so it is asked only once the
 * transaction may no longer land: once its network's stored tip is past the
 * validity bound a feature's activity records by
 * `UTXO_SYNC_CONFIRMATION_DEPTH`, else once its newest activity is older
 * than the cut-off of an entry without a bound, about two hours. Until then,
 * and while an entry holds the transaction or any account of its network
 * shows it in its history or a non-Pending activity, the activities stay:
 * a flow's activity lands a macrotask before its entry, and a settled
 * entry's activity waits for its own account's history. Each network's
 * provider is asked about its own transactions, the active one or not.
 *
 * A transaction the provider does not hold loses its Pending activity on
 * every account of its network, one `activities.removeActivities` per
 * account. One it holds is not asked about again while the wallet stays
 * active: history replaces its activity. A failed request is asked again once
 * the network's stored tip moves. `whileActive` (ADR 29) stops it while the
 * wallet is locked, and it reads no other state while no account holds a
 * Pending activity.
 */
export const expirePendingActivitiesWithoutEntry: SideEffect = (
  _,
  {
    activities: { selectPendingActivitiesByAccount$, selectAllMap$ },
    cardanoContext: {
      selectInFlightTransactionsRaw$,
      selectAccountTransactionHistory$,
      selectAllNetworkInfo$,
    },
    wallets: { selectAll$ },
  },
  { actions, cardanoProvider: { checkTransaction }, isWalletActive$, logger },
) =>
  defer(() => {
    // One per activation: `whileActive` subscribes anew on each unlock.
    const held = new Set<InFlightTransactionKey>();
    return selectPendingActivitiesByAccount$.pipe(
      map(pendingByAccount => Object.keys(pendingByAccount).length > 0),
      distinctUntilChanged(),
      switchMap(hasPending =>
        hasPending
          ? combineLatest([
              selectInFlightTransactionsRaw$,
              selectAccountTransactionHistory$,
              selectAllMap$,
              selectAll$,
              selectAllNetworkInfo$,
            ])
          : EMPTY,
      ),
      map(
        ([
          inFlight,
          historyByAccount,
          activitiesByAccount,
          wallets,
          networkInfo,
        ]) =>
          candidatesOf({
            inFlight,
            wallets,
            networkInfo,
            historyByAccount,
            activitiesByAccount,
            now: Date.now(),
          }).filter(({ key }) => !held.has(key)),
      ),
      scan<Candidate[], Attempts<Candidate>>(nextAttempts, {
        attempted: new Map(),
        due: [],
      }),
      mergeMap(({ due }) => from(due)),
      mergeMap(({ key, txId, chainId, accountIds }) => {
        const askAgainLater = (error: unknown) => {
          logger.warn(
            `[cardano-sync] the provider did not answer for pending transaction ${key}; asking again at its network's next tip`,
            error,
          );
          return EMPTY;
        };
        return defer(() => checkTransaction(txId, { chainId })).pipe(
          mergeMap(result => {
            if (result.isErr()) return askAgainLater(result.error);
            if (result.value !== null) {
              held.add(key);
              return EMPTY;
            }
            return from<CardanoSyncAction[]>(
              accountIds.map(accountId =>
                actions.activities.removeActivities({
                  accountId,
                  activityIds: [txId],
                  onlyPending: true,
                }),
              ),
            );
          }),
          catchError(askAgainLater),
        );
      }),
    );
  }).pipe(whileActive(isWalletActive$));
