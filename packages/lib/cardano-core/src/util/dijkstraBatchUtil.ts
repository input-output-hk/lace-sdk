import { BigIntMath } from '@lace-lib/cardano-util';

import { coalesceTokenMaps } from '../Asset/util';

import type { Inspector } from './txInspector';
import type {
  Credential,
  InputResolver,
  RewardAccount,
} from '../Cardano/Address';
import type { Lovelace, Tx } from '../Cardano/types';

/**
 * Drops an empty array, so that an optional field merged from several bodies stays absent when
 * none of them carries it.
 *
 * @param items The merged items.
 * @returns The items, or undefined when there are none.
 */
const nonEmpty = <T>(items: T[]): T[] | undefined =>
  items.length > 0 ? items : undefined;

/**
 * Creates an input resolver that resolves inputs against the outputs produced within the given
 * transaction's own batch (CIP-0118): the top level outputs and the outputs of every sub
 * transaction that carries an id. Hydrated sub transactions carry one; sub transactions of a
 * plain `Tx` do not and are skipped.
 *
 * @param tx The batch transaction whose outputs are resolved first.
 * @param fallbackResolver Resolves inputs produced outside the batch. Without one they resolve to null.
 * @returns An input resolver aware of the outputs of the batch.
 */
export const createBatchInputResolver = (
  tx: Tx,
  fallbackResolver?: InputResolver,
): InputResolver => {
  const producers = [
    { id: tx.id, outputs: tx.body.outputs },
    ...(tx.body.subTransactions ?? []).map(subTx => ({
      id: 'id' in subTx ? subTx.id : undefined,
      outputs: subTx.body.outputs,
    })),
  ];

  return {
    resolveInput: async (txIn, options) => {
      const producer = producers.find(
        ({ id }) => id !== undefined && id === txIn.txId,
      );
      if (producer) return producer.outputs[txIn.index] ?? null;
      return fallbackResolver
        ? fallbackResolver.resolveInput(txIn, options)
        : null;
    },
  };
};

/**
 * Merges a CIP-0118 batch into a single flat transaction view for value arithmetic, since no
 * level of a batch balances on its own. Inputs, outputs, mint, certificates, withdrawals, direct
 * deposits and proposal procedures are combined across the top level and every sub transaction,
 * donations are summed, witness scripts are pooled, and the sub transactions are cleared. An
 * intra-batch spend cancels out because both the output it spends and the input spending it stay
 * in the view.
 *
 * Every other field (fee, collateral, validity interval, guards, voting procedures, auxiliary
 * data and the id) is the top level transaction's. The view is meant for inspection only and
 * does not serialize to a valid transaction.
 *
 * @param tx The transaction to merge.
 * @returns The merged view, or the given transaction itself when it carries no sub transactions.
 */
export const toMergedBatchView = <T extends Tx>(tx: T): T => {
  const subTransactions = tx.body.subTransactions;
  if (!subTransactions || subTransactions.length === 0) return tx;

  const bodies = [tx.body, ...subTransactions.map(({ body }) => body)];
  const scripts = [
    ...(tx.witness.scripts ?? []),
    ...subTransactions.flatMap(({ witness }) => witness.scripts ?? []),
  ];

  const donations = bodies.flatMap(({ donation }) =>
    donation === undefined ? [] : [donation],
  );

  return {
    ...tx,
    body: {
      ...tx.body,
      certificates: nonEmpty(
        bodies.flatMap(({ certificates }) => certificates ?? []),
      ),
      directDeposits: nonEmpty(
        bodies.flatMap(({ directDeposits }) => directDeposits ?? []),
      ),
      donation: donations.length > 0 ? BigIntMath.sum(donations) : undefined,
      inputs: bodies.flatMap(({ inputs }) => inputs),
      mint: coalesceTokenMaps(bodies.map(({ mint }) => mint)),
      outputs: bodies.flatMap(({ outputs }) => outputs),
      proposalProcedures: nonEmpty(
        bodies.flatMap(({ proposalProcedures }) => proposalProcedures ?? []),
      ),
      subTransactions: undefined,
      withdrawals: nonEmpty(
        bodies.flatMap(({ withdrawals }) => withdrawals ?? []),
      ),
    },
    witness: { ...tx.witness, scripts: nonEmpty(scripts) },
  } as T;
};

/**
 * Inspects a transaction for direct deposits (Dijkstra body key 25), coin paid straight into
 * reward accounts.
 *
 * @param rewardAccounts Only deposits into these accounts are counted. All are counted when omitted.
 * @returns The total of the matching direct deposits.
 */
export const directDepositsInspector =
  (rewardAccounts?: RewardAccount[]): Inspector<Lovelace> =>
  async tx =>
    BigIntMath.sum(
      (tx.body.directDeposits ?? [])
        .filter(
          ({ stakeAddress }) =>
            !rewardAccounts || rewardAccounts.includes(stakeAddress),
        )
        .map(({ quantity }) => quantity),
    );

/**
 * Inspects a transaction for the guard credentials that must authorize it (Dijkstra body key 14).
 *
 * @returns The guard credentials, or an empty array when the transaction has none.
 */
export const guardsInspector: Inspector<Credential[]> = async tx =>
  tx.body.guards ?? [];
