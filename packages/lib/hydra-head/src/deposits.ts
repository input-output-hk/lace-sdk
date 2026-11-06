import { Cardano } from '@lace-lib/cardano-core';

import { decodeHydraDepositDatum } from './deposit-datum';
import { isHydraDepositAddress } from './registry';
import {
  isEmptyHydraValue,
  subtractHydraValues,
  sumHydraValues,
  toHydraOutRef,
} from './utxo';

import type {
  HydraAccountDeposit,
  HydraDepositStatus,
  HydraUtxo,
} from './types';

/**
 * The status of a deposit at `now`. The deposit validator accepts a recover
 * only when the transaction validity starts strictly after the deadline, and
 * an absorb only when it ends at or before it, so a deposit is pending up to
 * and including its deadline and recoverable afterwards.
 *
 * @param deadline - Deadline from the deposit datum, in epoch milliseconds.
 * @param now - Instant the status is computed for, in epoch milliseconds.
 */
export const getHydraDepositStatus = (
  deadline: number,
  now: number,
): HydraDepositStatus => (now > deadline ? 'recoverable' : 'pending');

/**
 * Picks the deposits that commit outputs to the account's payment keys out
 * of the UTxOs at the deposit validator addresses. Ownership is decided
 * on the payment key hashes decoded from the committed outputs. A deposit
 * UTxO holds exactly the outputs its datum commits, so anyone could lock a
 * little ada with a datum claiming any amount for any key; the committed
 * values must therefore add up to the value of the UTxO. UTxOs that are not
 * at a deposit address, carry no decodable datum, commit other than what
 * they hold, or commit only outputs of other keys are skipped.
 *
 * @remarks A deposit counts for the account whose keys its datum names, not
 * for whoever paid it, and its head may be a lookalike: rely on it only for
 * a head that passes `isHydraHeadMintingScript`. The value is what was
 * committed to the account's keys, not a balance.
 *
 * @param utxos - UTxOs at the deposit validator addresses.
 * @param ownedPaymentKeyHashes - Hex payment key hashes of the account.
 * @param now - Instant the deposit status is computed for, in epoch
 * milliseconds.
 */
export const findAccountHydraDeposits = (
  utxos: readonly HydraUtxo[],
  ownedPaymentKeyHashes: Iterable<string>,
  now: number,
): HydraAccountDeposit[] => {
  const owned = new Set(ownedPaymentKeyHashes);
  const deposits: HydraAccountDeposit[] = [];
  for (const utxo of utxos) {
    if (!utxo.inlineDatum || !isHydraDepositAddress(utxo.address)) continue;
    const datum = decodeHydraDepositDatum(
      utxo.inlineDatum,
      Cardano.Address.fromBech32(utxo.address).getNetworkId(),
    );
    const ownCommits = datum?.committed.filter(
      ({ paymentKeyHash }) =>
        paymentKeyHash !== undefined && owned.has(paymentKeyHash),
    );
    if (!datum || !ownCommits?.length) continue;
    const uncommitted = subtractHydraValues(
      utxo.value,
      sumHydraValues(datum.committed),
    );
    if (!isEmptyHydraValue(uncommitted)) continue;
    deposits.push({
      outpoint: toHydraOutRef(utxo),
      headId: datum.headId,
      deadline: datum.deadline,
      value: sumHydraValues(ownCommits),
      status: getHydraDepositStatus(datum.deadline, now),
    });
  }
  return deposits;
};
