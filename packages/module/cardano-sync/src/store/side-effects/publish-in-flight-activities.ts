import { whileActive } from '@lace-contract/wallet-active-state';
import isEqual from 'lodash/isEqual';
import {
  combineLatest,
  EMPTY,
  from,
  map,
  mergeMap,
  scan,
  switchMap,
} from 'rxjs';

import { inFlightPendingActivities } from './in-flight-pending-activities';

import type { CardanoSyncAction, SideEffect } from '../../module';
import type { Activity } from '@lace-contract/activities';
import type { AnyAddress } from '@lace-contract/addresses';
import type {
  AccountUtxoMap,
  DecodedInFlightTransaction,
  InFlightTransactionKey,
} from '@lace-contract/cardano-context';
import type { AccountId, AnyWallet } from '@lace-contract/wallet-repo';

type WalletState = [
  inFlight: Readonly<
    Record<InFlightTransactionKey, DecodedInFlightTransaction>
  >,
  ownershipUtxos: AccountUtxoMap,
  allAddresses: AnyAddress[],
  activitiesByAccount: Partial<Record<AccountId, Activity[]>>,
  wallets: readonly AnyWallet[],
];

type Publication = {
  /** Last derived rows, including publications not yet reduced into state. */
  published: ReadonlyMap<
    InFlightTransactionKey,
    ReadonlyMap<AccountId, Activity>
  >;
  rows: Activity[];
};

const NOTHING_PUBLISHED: Publication = { published: new Map(), rows: [] };

/**
 * Emits changed derivations only. A burst can deliver states that predate the
 * last publication, so deduplication cannot rely on stored rows alone.
 */
const publish =
  (logger: Parameters<SideEffect>[2]['logger']) =>
  (
    { published }: Publication,
    [
      inFlight,
      ownershipUtxos,
      allAddresses,
      activitiesByAccount,
      wallets,
    ]: WalletState,
  ): Publication => {
    const next = new Map<
      InFlightTransactionKey,
      ReadonlyMap<AccountId, Activity>
    >();
    const rows: Activity[] = [];
    for (const [key, entry] of Object.entries(inFlight) as [
      InFlightTransactionKey,
      DecodedInFlightTransaction,
    ][]) {
      const byAccount = new Map(published.get(key));
      for (const row of inFlightPendingActivities({
        entry,
        wallets,
        allAddresses,
        ownershipUtxos,
        activitiesByAccount,
        logger,
      })) {
        if (isEqual(byAccount.get(row.accountId), row)) continue;
        byAccount.set(row.accountId, row);
        rows.push(row);
      }
      if (byAccount.size > 0) next.set(key, byAccount);
    }
    return { published: next, rows };
  };

/**
 * Adds the Pending activity of every in-flight Cardano transaction to each
 * own account once the wallet can tell the transaction touches it, whatever
 * recorded the entry. A writer adds rows only for the accounts it attributes
 * the transaction to when it records. This covers the rest: another own
 * account the transaction pays, and an account whose input becomes known
 * later, such as the output of a transaction recorded after it or a UTxO the
 * account's synced set lists only after a refetch.
 *
 * Ownership changes publish provisional balance evidence. `activities.addActivities`
 * unions that evidence with the stored row, so shrinking ownership and delayed
 * publications cannot erase resolved amounts. Confirmed and feature rows stay
 * protected, including rows that arrive between derivation and reduction.
 * Unchanged derivations are suppressed before the previous publication lands.
 *
 * It subscribes to the wallet state only while an entry exists, and it
 * derives no row for an entry the reconcile side effect removed: that side
 * effect removes the entry before the rows. A row derived in the macrotask
 * before the removal applies can still land after it;
 * `expirePendingActivitiesWithoutEntry` removes it later. `whileActive`
 * (ADR 29) keeps it off while the wallet is locked.
 */
export const publishInFlightActivities: SideEffect = (
  _,
  {
    cardanoContext: {
      selectInFlightTransactions$,
      selectCollateralOwnershipUtxos$,
    },
    addresses: { selectAllAddresses$ },
    activities: { selectAllMap$ },
    wallets: { selectAll$ },
  },
  { actions, logger, isWalletActive$ },
) =>
  selectInFlightTransactions$.pipe(
    switchMap(inFlight =>
      Object.keys(inFlight).length === 0
        ? EMPTY
        : combineLatest([
            selectCollateralOwnershipUtxos$,
            selectAllAddresses$,
            selectAllMap$,
            selectAll$,
          ]).pipe(map((state): WalletState => [inFlight, ...state])),
    ),
    scan(publish(logger), NOTHING_PUBLISHED),
    mergeMap(({ rows }) =>
      from<CardanoSyncAction[]>(
        rows.map(row =>
          actions.activities.addActivities({
            accountId: row.accountId,
            activities: [row],
          }),
        ),
      ),
    ),
    whileActive(isWalletActive$),
  );
