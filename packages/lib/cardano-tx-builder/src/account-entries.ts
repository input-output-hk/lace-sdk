import { Serialization } from '@lace-lib/cardano-core';

import type { Cardano } from '@lace-lib/cardano-core';

/**
 * The largest amount a direct deposit, or the sum of the direct deposits to
 * one reward account, may hold: the largest signed 64-bit integer.
 */
const MAX_DIRECT_DEPOSIT = 9_223_372_036_854_775_807n;

/**
 * The direct deposits and account balance intervals a builder holds, each
 * keyed by reward account.
 */
export interface AccountEntries {
  /** Direct deposits, each the sum of the deposits to its reward account. */
  directDeposits: ReadonlyMap<Cardano.RewardAccount, Cardano.Lovelace>;
  /** Account balance intervals, the last one added for each reward account. */
  accountBalanceIntervals: ReadonlyMap<
    Cardano.RewardAccount,
    Cardano.AccountBalanceInterval
  >;
  /** Starting account balance intervals, the last one added for each reward account. */
  startingAccountBalanceIntervals?: ReadonlyMap<
    Cardano.RewardAccount,
    Cardano.AccountBalanceInterval
  >;
}

/**
 * Adds `amount` to the direct deposit `directDeposits` holds for
 * `rewardAccount`.
 *
 * @param directDeposits - Direct deposits keyed by reward account.
 * @param rewardAccount - The reward account to deposit into.
 * @param amount - The lovelace to deposit.
 * @throws If `amount` is not greater than zero, or it, or the sum of the
 *   deposits to `rewardAccount`, exceeds the largest signed 64-bit integer.
 */
export const accumulateDirectDeposit = (
  directDeposits: Map<Cardano.RewardAccount, Cardano.Lovelace>,
  rewardAccount: Cardano.RewardAccount,
  amount: Cardano.Lovelace,
): void => {
  if (amount <= 0n) {
    throw new Error(
      `Direct deposit to ${rewardAccount} must be greater than zero, got ${amount}`,
    );
  }
  if (amount > MAX_DIRECT_DEPOSIT) {
    throw new Error(
      `Direct deposit to ${rewardAccount} exceeds the maximum of ${MAX_DIRECT_DEPOSIT} lovelace, got ${amount}`,
    );
  }
  const total = (directDeposits.get(rewardAccount) ?? 0n) + amount;
  if (total > MAX_DIRECT_DEPOSIT) {
    throw new Error(
      `Direct deposits to ${rewardAccount} add up to ${total} lovelace, more than the maximum of ${MAX_DIRECT_DEPOSIT}`,
    );
  }
  directDeposits.set(rewardAccount, total);
};

/**
 * Checks an account balance interval as the body writes it.
 *
 * @param interval - The range or exact balance, in lovelace.
 * @throws If `interval` has neither bound nor an exact balance, or an exact
 *   balance together with a bound.
 * @returns The interval as the body writes it.
 */
export const accountBalanceInterval = (
  interval: Cardano.AccountBalanceInterval,
): Cardano.AccountBalanceInterval =>
  Serialization.AccountBalanceInterval.fromCore(interval).toCore();

/**
 * Writes the direct deposits and the account balance intervals on `body`.
 * Serialization sorts each of them by reward account.
 *
 * @param body - The body to write them on.
 * @param entries - The direct deposits and intervals.
 */
export const applyAccountEntries = (
  body: Pick<
    Cardano.TxBody,
    | 'accountBalanceIntervals'
    | 'directDeposits'
    | 'startingAccountBalanceIntervals'
  >,
  {
    directDeposits,
    accountBalanceIntervals,
    startingAccountBalanceIntervals,
  }: AccountEntries,
): void => {
  if (directDeposits.size > 0) {
    body.directDeposits = [...directDeposits].map(
      ([stakeAddress, quantity]) => ({ stakeAddress, quantity }),
    );
  }
  if (accountBalanceIntervals.size > 0) {
    body.accountBalanceIntervals = [...accountBalanceIntervals].map(
      ([rewardAccount, interval]) => ({ rewardAccount, interval }),
    );
  }
  if (
    startingAccountBalanceIntervals &&
    startingAccountBalanceIntervals.size > 0
  ) {
    body.startingAccountBalanceIntervals = [
      ...startingAccountBalanceIntervals,
    ].map(([rewardAccount, interval]) => ({ rewardAccount, interval }));
  }
};
