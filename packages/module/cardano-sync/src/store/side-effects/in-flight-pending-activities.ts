import { ActivityType } from '@lace-contract/activities';
import {
  CardanoNetworkId,
  groupCardanoAddressesByAccount,
  isCardanoAccount,
  pendingActivityOf,
} from '@lace-contract/cardano-context';
import isEqual from 'lodash/isEqual';

import type { SideEffect } from '../../module';
import type { Activity } from '@lace-contract/activities';
import type { AnyAddress } from '@lace-contract/addresses';
import type {
  AccountUtxoMap,
  CardanoPaymentAddress,
  DecodedInFlightTransaction,
} from '@lace-contract/cardano-context';
import type {
  AccountId,
  AnyAccount,
  AnyWallet,
} from '@lace-contract/wallet-repo';
import type { Cardano } from '@lace-lib/cardano-core';

const outpointKey = ({ txId, index }: Cardano.TxIn): string =>
  `${txId}#${index}`;

/**
 * The Pending activities of an in-flight transaction for the accounts on its
 * network that the wallet can tell it touches: the account's ownership set
 * holds an input it spends, or an output pays one of the account's
 * addresses. Each carries the time the transaction was submitted.
 *
 * Derived rows carry immutable balance contributions per owned input and output.
 * The reducer unions evidence rather than forgetting inputs ownership no longer
 * lists, including when older publications arrive after newer ones.
 * Confirmed rows and feature rows (including enriched provisional rows) stay.
 * Callers use `activities.addActivities` to enforce the same protection when
 * delayed actions reach the reducer. Underivable rows are logged and skipped.
 */
export const inFlightPendingActivities = ({
  entry: { chainId, txId, effects, submittedAt },
  wallets,
  allAddresses,
  ownershipUtxos,
  activitiesByAccount,
  logger,
}: {
  entry: DecodedInFlightTransaction;
  wallets: readonly AnyWallet[];
  allAddresses: AnyAddress[];
  ownershipUtxos: AccountUtxoMap;
  activitiesByAccount: Partial<Record<AccountId, Activity[]>>;
  logger: Parameters<SideEffect>[2]['logger'];
}): Activity[] => {
  const networkId = CardanoNetworkId(chainId.networkMagic);
  const addressesByAccount = groupCardanoAddressesByAccount(
    allAddresses,
    chainId,
  );
  const activities: Activity[] = [];
  for (const account of wallets.flatMap<AnyAccount>(
    wallet => wallet.accounts,
  )) {
    if (
      !isCardanoAccount(account) ||
      account.blockchainNetworkId !== networkId
    ) {
      continue;
    }
    const { accountId } = account;
    const held = (activitiesByAccount[accountId] ?? []).find(
      activity => activity.activityId === txId,
    );
    if (
      held &&
      (!held.provisional ||
        held.type !== ActivityType.Pending ||
        held.blockchainSpecific !== undefined)
    )
      continue;
    try {
      const params = {
        txId,
        accountId,
        accountAddresses: (addressesByAccount[accountId] ?? []).map(
          ({ address }) => address as unknown as CardanoPaymentAddress,
        ),
        accountUtxos: ownershipUtxos[accountId] ?? [],
        timestamp: submittedAt,
      };
      const activity = pendingActivityOf({ ...params, effects });
      if (activity) {
        const provisional: NonNullable<Activity['provisional']> = {};
        for (const output of effects.producedOutputs) {
          const row = pendingActivityOf({
            ...params,
            accountUtxos: [],
            effects: { consumedInputs: [], producedOutputs: [output] },
          });
          if (row)
            provisional[`output:${outpointKey(output[0])}`] =
              row.tokenBalanceChanges;
        }
        const byOutpoint = new Map(
          params.accountUtxos.map(utxo => [outpointKey(utxo[0]), utxo]),
        );
        for (const input of effects.consumedInputs) {
          const utxo = byOutpoint.get(outpointKey(input));
          if (!utxo) continue;
          const row = pendingActivityOf({
            ...params,
            accountUtxos: [utxo],
            effects: { consumedInputs: [input], producedOutputs: [] },
          });
          if (row)
            provisional[`input:${outpointKey(input)}`] =
              row.tokenBalanceChanges;
        }
        const derived = { ...activity, provisional };
        if (!isEqual(held, derived)) activities.push(derived);
      }
    } catch (error) {
      logger.warn(
        '[cardano-sync] could not derive the pending activity of a submitted transaction',
        { txId, accountId, error },
      );
    }
  }
  return activities;
};
