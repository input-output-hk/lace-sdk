import { reconstructHydraHeadFunds } from './funds';
import { getHydraHeadStateTokenName } from './registry';

import type { HydraHeadHistoryLimits } from './constants';
import type {
  HydraAccountHead,
  HydraHeadFunds,
  HydraHeadHistoryTx,
} from './types';

/**
 * The unit of the head's state token, which the head UTxO holds and whose
 * transactions make up the head's history.
 */
export const getHydraHeadStateTokenUnit = ({
  headId,
  version,
}: Pick<HydraAccountHead, 'headId' | 'version'>): string =>
  headId + getHydraHeadStateTokenName(version);

/**
 * Where reading a head's history goes on from a kept one. History on chain
 * does not change, so the listing starts at the page holding the last kept
 * transaction and overlaps the kept history by at least one transaction,
 * which `continuesHydraHeadHistory` checks.
 *
 * @param keptLength - Transactions of the history kept so far.
 * @param pageSize - Transactions per page of the listing.
 * @param limits - Where the read stops.
 * @returns the page to list from, the transactions before it and how many
 * transactions are listed at most from it, or undefined when the kept
 * history holds `maxTransactionsPerHead` transactions and is read no further
 */
export const getHydraHeadHistoryWindow = (
  keptLength: number,
  pageSize: number,
  { maxTransactionsPerHead }: HydraHeadHistoryLimits,
): { page: number; skipped: number; remaining: number } | undefined => {
  if (keptLength >= maxTransactionsPerHead) return undefined;
  const page = keptLength === 0 ? 1 : Math.ceil(keptLength / pageSize);
  const skipped = (page - 1) * pageSize;
  return { page, skipped, remaining: maxTransactionsPerHead - skipped };
};

/**
 * True when a listing that skips the first `skipped` transactions of the
 * history continues the kept history. A rollback that replaced a kept
 * transaction makes it false, and the history is then listed and read again
 * from its start.
 */
export const continuesHydraHeadHistory = (
  keptTxIds: readonly string[],
  listedTxIds: readonly string[],
  skipped: number,
): boolean =>
  keptTxIds.slice(skipped).every((txId, index) => listedTxIds[index] === txId);

/**
 * How many spent inputs of a history were produced outside it, such as
 * deposits and commits, which `maxResolvedInputsPerHead` bounds.
 *
 * @param outRefKey - The output reference of an input or output, as a key.
 */
export const countHydraHeadHistoryOutsideInputs = <U>(
  history: readonly { inputs: readonly U[]; outputs: readonly U[] }[],
  outRefKey: (utxo: U) => string,
): number => {
  const produced = new Set<string>();
  let outside = 0;
  for (const { inputs, outputs } of history) {
    outside += inputs.filter(input => !produced.has(outRefKey(input))).length;
    for (const output of outputs) produced.add(outRefKey(output));
  }
  return outside;
};

/**
 * What the head absorbed for the account's keys and paid back to them, or
 * undefined unless the history ends with the transaction that produced the
 * head UTxO found at the validator. The history listing and the UTxO set
 * can briefly disagree while the provider indexes a new block, and a
 * history missing its newest step would give a wrong figure.
 */
export const getHydraHeadAccountFunds = (
  head: Pick<HydraAccountHead, 'headId' | 'outpoint'>,
  history: readonly HydraHeadHistoryTx[] | undefined,
  paymentKeyHashes: readonly string[],
): HydraHeadFunds | undefined =>
  history?.at(-1)?.txId === head.outpoint.txId
    ? reconstructHydraHeadFunds(head.headId, history, paymentKeyHashes)
    : undefined;
