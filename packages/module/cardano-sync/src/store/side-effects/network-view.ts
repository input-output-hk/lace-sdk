import { ActivityType } from '@lace-contract/activities';
import { isCardanoAccount } from '@lace-contract/cardano-context';

import type { Activity } from '@lace-contract/activities';
import type {
  CardanoAccountAddressHistoryMap,
  CardanoNetworkId,
  CardanoWalletAccount,
} from '@lace-contract/cardano-context';
import type { AccountId, AnyWallet } from '@lace-contract/wallet-repo';

/** The Cardano accounts of every wallet, by network. */
export const cardanoAccountsByNetwork = (
  wallets: readonly AnyWallet[],
): Map<CardanoNetworkId, CardanoWalletAccount[]> => {
  const accountsByNetwork = new Map<CardanoNetworkId, CardanoWalletAccount[]>();
  for (const { accounts } of wallets) {
    for (const account of accounts) {
      if (!isCardanoAccount(account)) continue;
      const networkId = account.blockchainNetworkId as CardanoNetworkId;
      accountsByNetwork.set(networkId, [
        ...(accountsByNetwork.get(networkId) ?? []),
        account,
      ]);
    }
  }
  return accountsByNetwork;
};

/** What the Cardano accounts of one network show. */
export type NetworkView = {
  /** Every Cardano account on the network, of every kind. */
  accountIds: AccountId[];
  /**
   * The transactions an account's history or non-Pending activity shows. A
   * synced UTxO under a transaction's ID proves nothing: a host that serves
   * the UTxOs can list the outputs of a transaction it brokered before the
   * transaction lands.
   */
  shownTxIds: Set<string>;
  /** The Pending activities of every account on the network, by their ID. */
  pendingRows: Map<string, Activity[]>;
};

export const networkViewOf = (
  accounts: readonly CardanoWalletAccount[],
  {
    historyByAccount,
    activitiesByAccount,
  }: {
    historyByAccount: CardanoAccountAddressHistoryMap;
    activitiesByAccount: Partial<Record<AccountId, Activity[]>>;
  },
): NetworkView => {
  const view: NetworkView = {
    accountIds: accounts.map(({ accountId }) => accountId),
    shownTxIds: new Set(),
    pendingRows: new Map(),
  };
  for (const { accountId } of accounts) {
    for (const { transactionHistory } of Object.values(
      historyByAccount[accountId] ?? {},
    )) {
      for (const { txId } of transactionHistory) view.shownTxIds.add(txId);
    }
    for (const activity of activitiesByAccount[accountId] ?? []) {
      if (activity.type !== ActivityType.Pending) {
        view.shownTxIds.add(activity.activityId);
        continue;
      }
      const rows = view.pendingRows.get(activity.activityId) ?? [];
      rows.push(activity);
      view.pendingRows.set(activity.activityId, rows);
    }
  }
  return view;
};
