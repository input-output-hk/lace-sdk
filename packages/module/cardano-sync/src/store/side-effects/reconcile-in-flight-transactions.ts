import {
  CardanoNetworkId,
  UTXO_SYNC_CONFIRMATION_DEPTH,
} from '@lace-contract/cardano-context';
import { whileActive } from '@lace-contract/wallet-active-state';
import { combineLatest, from, map, mergeMap } from 'rxjs';

import { cardanoAccountsByNetwork, networkViewOf } from './network-view';

import type { NetworkView } from './network-view';
import type { CardanoSyncAction, SideEffect } from '../../module';
import type { Activity } from '@lace-contract/activities';
import type {
  AccountUtxoMap,
  CardanoAccountAddressHistoryMap,
  CardanoNetworkInfo,
  CardanoWalletAccount,
  DecodedInFlightTransaction,
  InFlightTransactionKey,
} from '@lace-contract/cardano-context';
import type { AccountId, AnyWallet } from '@lace-contract/wallet-repo';
import type { Cardano } from '@lace-lib/cardano-core';

/** Whether a slot is past a transaction's upper validity bound by the depth. */
const isPastBound = (
  { invalidHereafter }: DecodedInFlightTransaction,
  slot: Cardano.Slot | undefined,
): boolean =>
  invalidHereafter !== undefined &&
  slot !== undefined &&
  slot > invalidHereafter + UTXO_SYNC_CONFIRMATION_DEPTH;

/** Whether the provider answered that the chain holds the transaction. */
const isLookedUpOnChain = ({ lookup }: DecodedInFlightTransaction): boolean =>
  lookup !== undefined && lookup.inclusion !== null;

/**
 * Whether the provider, asked once the tip of the transaction's network was
 * past its upper validity bound by the depth the wallet allows its provider
 * to lag, answered that the chain does not hold the transaction. The
 * transaction can then no longer be included anywhere on the network.
 */
const isLookedUpAbsent = (entry: DecodedInFlightTransaction): boolean =>
  entry.lookup !== undefined &&
  entry.lookup.inclusion === null &&
  isPastBound(entry, entry.lookup.tipSlot);

const outpointKey = ({ txId, index }: Cardano.TxIn): string =>
  `${txId}#${index}`;

/** A {@link NetworkView} with the outpoints of every account's synced UTxOs. */
type SettlementView = NetworkView & { settledOutpoints: Set<string> };

const settlementViewOf = (
  accounts: readonly CardanoWalletAccount[],
  {
    utxosByAccount,
    ...state
  }: {
    utxosByAccount: AccountUtxoMap;
    historyByAccount: CardanoAccountAddressHistoryMap;
    activitiesByAccount: Partial<Record<AccountId, Activity[]>>;
  },
): SettlementView => {
  const settledOutpoints = new Set<string>();
  for (const { accountId } of accounts) {
    for (const [input] of utxosByAccount[accountId] ?? []) {
      settledOutpoints.add(outpointKey(input));
    }
  }
  return { ...networkViewOf(accounts, state), settledOutpoints };
};

type Reconciliation = {
  /** The entries of transactions that settled or can no longer settle. */
  keys: InFlightTransactionKey[];
  /** The Pending activities of the transactions that can no longer settle. */
  rows: { accountId: AccountId; activityIds: string[] }[];
};

const NOTHING_TO_RECONCILE: Reconciliation = { keys: [], rows: [] };

const findReconciliation = ({
  inFlight,
  wallets,
  networkInfo,
  ...state
}: {
  inFlight: Readonly<
    Record<InFlightTransactionKey, DecodedInFlightTransaction>
  >;
  wallets: readonly AnyWallet[];
  networkInfo: Partial<Record<CardanoNetworkId, CardanoNetworkInfo>>;
  utxosByAccount: AccountUtxoMap;
  historyByAccount: CardanoAccountAddressHistoryMap;
  activitiesByAccount: Partial<Record<AccountId, Activity[]>>;
}): Reconciliation => {
  const entries = Object.entries(inFlight) as [
    InFlightTransactionKey,
    DecodedInFlightTransaction,
  ][];
  if (entries.length === 0) return NOTHING_TO_RECONCILE;

  const networkOf = (entry: DecodedInFlightTransaction) =>
    CardanoNetworkId(entry.chainId.networkMagic);
  const accountsByNetwork = cardanoAccountsByNetwork(wallets);
  const views = new Map<CardanoNetworkId, SettlementView>();
  const viewOf = (networkId: CardanoNetworkId): SettlementView => {
    let view = views.get(networkId);
    if (!view) {
      view = settlementViewOf(accountsByNetwork.get(networkId) ?? [], state);
      views.set(networkId, view);
    }
    return view;
  };

  const settled = new Set<InFlightTransactionKey>();
  const expired = new Set<InFlightTransactionKey>();
  const shown = new Set<InFlightTransactionKey>();
  /** The entries that spend an output of an entry, by the entry's key. */
  const children = new Map<
    InFlightTransactionKey,
    Set<InFlightTransactionKey>
  >();
  for (const [key, entry] of entries) {
    const networkId = networkOf(entry);
    const view = viewOf(networkId);
    for (const input of entry.effects.consumedInputs) {
      const parent: InFlightTransactionKey = `${networkId}:${input.txId}`;
      if (!inFlight[parent]) continue;
      const dependents = children.get(parent) ?? new Set();
      dependents.add(key);
      children.set(parent, dependents);
    }
    if (view.shownTxIds.has(entry.txId) || isLookedUpOnChain(entry)) {
      shown.add(key);
      // Kept until the synced UTxOs stop listing what it spends, so its
      // inputs are not offered again before the UTxO refetch.
      const isReflected = !entry.effects.consumedInputs.some(input =>
        view.settledOutpoints.has(outpointKey(input)),
      );
      if (isReflected) settled.add(key);
      continue;
    }
    // Where no account can show the transaction, the network's tip past the
    // bound is enough; elsewhere only the provider's answer is.
    const canNoLongerSettle =
      isLookedUpAbsent(entry) ||
      (view.accountIds.length === 0 &&
        isPastBound(entry, networkInfo[networkId]?.tip?.slot));
    if (canNoLongerSettle) expired.add(key);
  }

  // A child cannot settle if its parent never did, whatever its own bound. A
  // child its network shows settles by its own entry. Set iteration visits
  // the descendants it adds too.
  for (const key of expired) {
    for (const child of children.get(key) ?? []) {
      if (!shown.has(child)) expired.add(child);
    }
  }
  // An entry that stays offers its outputs that no entry spends, and synced
  // UTxOs from before it list none of them, so a child's absent input proves
  // nothing: the child stays with it, transitively.
  const kept = new Set(
    entries
      .map(([key]) => key)
      .filter(key => !settled.has(key) && !expired.has(key)),
  );
  for (const key of kept) {
    for (const child of children.get(key) ?? []) {
      if (settled.delete(child)) kept.add(child);
    }
  }
  if (settled.size === 0 && expired.size === 0) return NOTHING_TO_RECONCILE;

  const rowsByAccount = new Map<AccountId, string[]>();
  for (const key of expired) {
    const entry = inFlight[key];
    const rows = viewOf(networkOf(entry)).pendingRows.get(entry.txId);
    for (const { accountId } of rows ?? []) {
      rowsByAccount.set(accountId, [
        ...(rowsByAccount.get(accountId) ?? []),
        entry.txId,
      ]);
    }
  }
  return {
    keys: [...settled, ...expired],
    rows: [...rowsByAccount].map(([accountId, activityIds]) => ({
      accountId,
      activityIds,
    })),
  };
};

/**
 * Removes the entry of an in-flight Cardano transaction once it settled or
 * can no longer settle, so the in-flight views stop applying it, and drops
 * the Pending activities of a transaction that can no longer settle.
 *
 * Settled: an account on the transaction's network shows it in its history
 * or a non-Pending activity, or the provider answered that the chain holds
 * it; no account on the network still lists an input it spends among its
 * synced UTxOs; and no entry whose outputs it spends stays. Until the UTxO
 * refetch reflects the spend the entry stays, so its inputs are not offered
 * again. An entry that stays offers its outputs that no entry spends, and
 * synced UTxOs from before it list none of them, so a transaction that spends
 * one stays with it, transitively. The confirmed activity replaces the
 * Pending one by ID, so settlement removes no activity.
 *
 * Can no longer settle: the network shows nothing of it, and the provider,
 * asked once the network's stored tip was past the upper validity bound by
 * `UTXO_SYNC_CONFIRMATION_DEPTH`, answered that the chain does not hold it
 * (`lookup`, which `lookUpInFlightTransactions` records). On a network with
 * no Cardano account nothing can show the transaction or reads its
 * reservation, so the network's own tip past the bound by that depth is
 * enough, which is how the entries of a removed wallet go. An expired
 * transaction takes every in-flight transaction that spends its outputs and
 * that its network does not show with it, transitively; that is how an entry
 * without a bound expires otherwise. The Pending activities with the IDs of
 * the expired transactions go with them, from every account that holds one.
 *
 * It reads state only; the lookup side effect makes the provider call.
 * `whileActive` (ADR 29) keeps it off while the wallet is locked, and the
 * stored lookups decide on unlock. The rules' residual exposures are in
 * `packages/module/cardano-sync/docs/in-flight-transactions.md`.
 */
export const reconcileInFlightTransactions: SideEffect = (
  _,
  {
    cardanoContext: {
      selectInFlightTransactions$,
      selectAccountUtxos$,
      selectAccountTransactionHistory$,
      selectAllNetworkInfo$,
    },
    activities: { selectAllMap$ },
    wallets: { selectAll$ },
  },
  { actions, isWalletActive$ },
) =>
  combineLatest([
    selectInFlightTransactions$,
    selectAccountUtxos$,
    selectAccountTransactionHistory$,
    selectAllMap$,
    selectAll$,
    selectAllNetworkInfo$,
  ]).pipe(
    map(
      ([
        inFlight,
        utxosByAccount,
        historyByAccount,
        activitiesByAccount,
        wallets,
        networkInfo,
      ]) =>
        findReconciliation({
          inFlight,
          wallets,
          networkInfo,
          utxosByAccount,
          historyByAccount,
          activitiesByAccount,
        }),
    ),
    mergeMap(({ keys, rows }) =>
      from<CardanoSyncAction[]>([
        ...(keys.length > 0
          ? [actions.cardanoContext.removeInFlightTransactions({ keys })]
          : []),
        ...rows.map(row => actions.activities.removeActivities(row)),
      ]),
    ),
    whileActive(isWalletActive$),
  );
