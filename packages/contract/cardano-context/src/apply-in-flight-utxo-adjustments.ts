import { BigNumber } from '@lace-lib/util';

import { extractUniqueStakeKeys } from './store/helpers/extract-unique-stake-keys';
import { isCardanoAddress } from './util';

import type {
  AccountRewardAccountDetailsMap,
  CardanoInFlightEffects,
  CardanoPaymentAddress,
  CardanoRewardAccount,
} from './types';
import type { AnyAddress } from '@lace-contract/addresses';
import type { AccountId } from '@lace-contract/wallet-repo';
import type { Cardano } from '@lace-lib/cardano-core';

const outpointKey = (ref: { txId: Cardano.TransactionId; index: number }) =>
  `${ref.txId}#${ref.index}`;

/**
 * Every output the in-flight transactions pay to the account's addresses,
 * deduped by outpoint. Additive only: unlike
 * {@link applyInFlightUtxoAdjustments} it keeps an output another in-flight
 * transaction spends, because an outpoint an own in-flight transaction spends
 * still exists on chain and can still be named as collateral by someone else.
 */
export const ownPendingOutputs = (
  inFlight: readonly CardanoInFlightEffects[],
  accountAddresses: readonly CardanoPaymentAddress[],
): Cardano.Utxo[] => {
  const ownAddresses = new Set<string>(accountAddresses);
  const byOutpoint = new Map<string, Cardano.Utxo>();

  for (const { producedOutputs } of inFlight) {
    for (const utxo of producedOutputs) {
      if (ownAddresses.has(utxo[1].address)) {
        byOutpoint.set(outpointKey(utxo[0]), utxo);
      }
    }
  }

  return [...byOutpoint.values()];
};

/**
 * The account's UTxOs with the in-flight transactions of its network applied:
 * every outpoint any of them spends leaves, and every output any of them pays
 * to the account's addresses joins unless the set already holds its outpoint.
 *
 * Order-free set algebra: the UTxOs no entry spends, plus the own outputs no
 * entry spends that the UTxOs do not hold yet. A transaction recorded before
 * the parent whose change it spends therefore still reserves that change.
 * Returns `utxos` itself when no entry changes it.
 */
export const applyInFlightUtxoAdjustments = (
  utxos: Cardano.Utxo[],
  accountAddresses: readonly CardanoPaymentAddress[],
  inFlight: readonly CardanoInFlightEffects[],
): Cardano.Utxo[] => {
  if (
    !inFlight.some(
      ({ consumedInputs, producedOutputs }) =>
        consumedInputs.length > 0 || producedOutputs.length > 0,
    )
  )
    return utxos;

  const ownAddresses = new Set<string>(accountAddresses);
  const byOutpoint = new Map(utxos.map(utxo => [outpointKey(utxo[0]), utxo]));
  const spent = new Set<string>();
  let isChanged = false;

  for (const { consumedInputs, producedOutputs } of inFlight) {
    for (const input of consumedInputs) spent.add(outpointKey(input));
    for (const utxo of producedOutputs) {
      const key = outpointKey(utxo[0]);
      if (ownAddresses.has(utxo[1].address) && !byOutpoint.has(key)) {
        byOutpoint.set(key, utxo);
        isChanged = true;
      }
    }
  }

  for (const key of spent) isChanged = byOutpoint.delete(key) || isChanged;
  return isChanged ? [...byOutpoint.values()] : utxos;
};

/** Rewards in-flight transactions withdraw, keyed by
 * {@link pendingRewardWithdrawalKey}. */
export type PendingRewardWithdrawals = ReadonlyMap<string, bigint>;

/**
 * Identifies a reward account on one network. Preview and Preprod share
 * reward addresses (both are network id 0), so the address alone would let
 * one network's pending withdrawal affect the other's balance (ADR 11).
 */
export const pendingRewardWithdrawalKey = (
  networkMagic: Cardano.NetworkMagic,
  rewardAccount: Cardano.RewardAccount | CardanoRewardAccount,
): string => `${networkMagic}:${rewardAccount}`;

/** Each account's network, from the first of its addresses that records it. */
const networkMagicByAccount = (
  allAddresses: readonly AnyAddress[],
): Map<string, Cardano.NetworkMagic> => {
  const networks = new Map<string, Cardano.NetworkMagic>();
  for (const address of allAddresses) {
    if (!isCardanoAddress(address) || networks.has(address.accountId)) continue;
    const networkMagic = address.data?.networkMagic;
    if (networkMagic !== undefined)
      networks.set(address.accountId, networkMagic);
  }
  return networks;
};

/**
 * Rewards withdrawn by in-flight transactions, keyed by
 * {@link pendingRewardWithdrawalKey} with each transaction's own network.
 *
 * Read across every in-flight transaction, whichever account pays for it: a
 * transaction can withdraw another own account's rewards (a migration's
 * destination, a dApp transaction funded by another account). Each
 * transaction counts once, because the store holds one entry per transaction
 * per network.
 */
export const pendingRewardWithdrawals = (
  inFlight: readonly {
    chainId: Cardano.ChainId;
    effects: CardanoInFlightEffects;
  }[],
): PendingRewardWithdrawals => {
  const totals = new Map<string, bigint>();
  for (const {
    chainId: { networkMagic },
    effects: { withdrawals = [] },
  } of inFlight) {
    for (const { stakeAddress, quantity } of withdrawals) {
      const key = pendingRewardWithdrawalKey(networkMagic, stakeAddress);
      totals.set(key, (totals.get(key) ?? 0n) + quantity);
    }
  }
  return totals;
};

/**
 * The BALANCE view of each account's reward details: the withdrawable amount
 * minus the rewards in-flight transactions already moved into their outputs,
 * so the ADA balance counts them once. Only the withdrawable amount changes,
 * and never below zero. Never use the result as a withdrawal amount: the
 * ledger only accepts the whole on-chain balance, which a subtracted residual
 * is not.
 *
 * The reward account is the account's first stake key, the one its reward
 * details were fetched for, on the account's own network. Returns `details`
 * itself when nothing changes, and keeps every unaffected account's object.
 */
export const applyPendingRewardWithdrawals = (
  details: AccountRewardAccountDetailsMap,
  pending: PendingRewardWithdrawals,
  allAddresses: readonly AnyAddress[],
): AccountRewardAccountDetailsMap => {
  if (pending.size === 0) return details;
  const networks = networkMagicByAccount(allAddresses);
  let adjusted: AccountRewardAccountDetailsMap | undefined;
  for (const [accountId, accountDetails] of Object.entries(details)) {
    const networkMagic = networks.get(accountId);
    const [stakeKey] = extractUniqueStakeKeys(
      allAddresses
        .filter(isCardanoAddress)
        .filter(address => address.accountId === accountId),
    );
    if (networkMagic === undefined || stakeKey === undefined) continue;
    const reserved = pending.get(
      pendingRewardWithdrawalKey(networkMagic, stakeKey),
    );
    if (!reserved) continue;
    const withdrawable = BigNumber.valueOf(
      accountDetails.rewardAccountInfo.withdrawableAmount,
    );
    const remaining = withdrawable > reserved ? withdrawable - reserved : 0n;
    if (remaining === withdrawable) continue;
    adjusted ??= { ...details };
    adjusted[accountId as AccountId] = {
      ...accountDetails,
      rewardAccountInfo: {
        ...accountDetails.rewardAccountInfo,
        withdrawableAmount: BigNumber(remaining),
      },
    };
  }
  return adjusted ?? details;
};
