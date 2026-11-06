import {
  coalesceValueQuantities,
  subtractValueQuantities,
} from '@lace-lib/cardano-core';

import { registeredPoolIds, transactionImplicitCoin } from './implicit-coin';

import type { Cardano, Serialization } from '@lace-lib/cardano-core';

/** The protocol parameters {@link subTransactionImbalance} prices certificate deposits with. */
export type SubTransactionImbalanceProtocolParameters = Pick<
  Cardano.ProtocolParameters,
  'poolDeposit' | 'stakeKeyDeposit'
>;

/** Identifies an input by the transaction that created its output and its index. */
export const inputKey = ({ txId, index }: Cardano.TxIn): string =>
  `${txId}#${index}`;

/**
 * The UTxO of `utxos` that `input` spends or references.
 *
 * @param utxos - The resolved UTxOs to search.
 * @param input - The input to resolve.
 * @returns The UTxO, or `undefined` when `utxos` does not resolve the input.
 */
export const findUtxo = (
  utxos: readonly Cardano.Utxo[],
  input: Cardano.TxIn,
): Cardano.Utxo | undefined => {
  const key = inputKey(input);
  return utxos.find(([txIn]) => inputKey(txIn) === key);
};

/**
 * The value a sub transaction consumes minus the value it produces. It
 * consumes the outputs its inputs spend, its withdrawals, the deposits its
 * certificates reclaim and the assets it mints; it produces its outputs,
 * the deposits of its certificates and proposals, its donation, its direct
 * deposits and the assets it burns. A sub transaction pays no fee, so the
 * transaction that carries it balances this value: a positive imbalance is
 * value the sub transaction leaves to the batch, a negative one value it
 * takes from it. A registration of a pool already registered on chain
 * updates its parameters and takes no pool deposit.
 *
 * @param subTransaction - The sub transaction.
 * @param resolvedUtxos - UTxOs that resolve every input it spends.
 * @param protocolParameters - The deposits of certificates that carry none,
 *   with the pools already registered on chain in `registeredPools`.
 * @throws If `resolvedUtxos` does not resolve an input it spends.
 * @returns The imbalance, in lovelace and assets, either of which may be negative.
 */
export const subTransactionImbalance = (
  subTransaction: Serialization.SubTransaction,
  resolvedUtxos: readonly Cardano.Utxo[],
  protocolParameters: SubTransactionImbalanceProtocolParameters & {
    registeredPools?: ReadonlySet<Cardano.PoolId>;
  },
): Cardano.Value => {
  const body = subTransaction.body().toCore();
  const spent = body.inputs.map(input => {
    const utxo = findUtxo(resolvedUtxos, input);
    if (!utxo) {
      throw new Error(
        `Sub transaction ${subTransaction.getId()} spends an input that is not resolved: ${inputKey(
          input,
        )}`,
      );
    }
    return utxo[1].value;
  });
  const { withdrawals, reclaimDeposit, deposit } = transactionImplicitCoin(
    protocolParameters,
    body,
    protocolParameters.registeredPools,
  );
  const directDeposits = (body.directDeposits ?? []).reduce(
    (total, { quantity }) => total + quantity,
    0n,
  );
  const consumed = coalesceValueQuantities([
    ...spent,
    {
      coins: (withdrawals ?? 0n) + (reclaimDeposit ?? 0n),
      assets: body.mint,
    },
  ]);
  const produced = coalesceValueQuantities([
    ...body.outputs.map(({ value }) => value),
    { coins: (deposit ?? 0n) + (body.donation ?? 0n) + directDeposits },
  ]);
  return subtractValueQuantities([consumed, produced]);
};

/**
 * The pool deposit `protocolParameters` charge for a pool registration.
 *
 * @param protocolParameters - The protocol parameters.
 * @returns The pool deposit, zero when the parameters carry none.
 */
const poolDepositOf = ({
  poolDeposit,
}: SubTransactionImbalanceProtocolParameters): Cardano.Lovelace =>
  BigInt(poolDeposit ?? 0);

/**
 * The ids of the pools `subTransaction` registers that are not registered
 * on chain yet, read from its body.
 *
 * @param subTransaction - The sub transaction.
 * @param registeredPools - The pools already registered on chain.
 * @returns The ids of the new pools it registers.
 */
const subTransactionPoolIds = (
  subTransaction: Serialization.SubTransaction,
  registeredPools: ReadonlySet<Cardano.PoolId>,
): Cardano.PoolId[] =>
  [...registeredPoolIds(subTransaction.body().toCore().certificates)].filter(
    poolId => !registeredPools.has(poolId),
  );

/**
 * The pool deposits that adding up the imbalance of each of
 * `subTransactions` charges more than once. The ledger charges the pool
 * deposit once per pool across a batch, so a sub transaction that registers
 * a pool an earlier one registers pays no deposit for it.
 *
 * @param subTransactions - The sub transactions.
 * @param protocolParameters - The protocol parameters supplying the pool deposit.
 * @param registeredPools - The pools already registered on chain, which
 *   none of them is charged for.
 * @returns The pool deposits charged more than once, zero when no pool repeats.
 */
const repeatedSubTransactionPoolDeposits = (
  subTransactions: readonly Serialization.SubTransaction[],
  protocolParameters: SubTransactionImbalanceProtocolParameters,
  registeredPools: ReadonlySet<Cardano.PoolId>,
): Cardano.Lovelace => {
  const chargedPools = new Set<Cardano.PoolId>();
  let repeated = 0n;
  for (const subTransaction of subTransactions) {
    for (const poolId of subTransactionPoolIds(
      subTransaction,
      registeredPools,
    )) {
      if (chargedPools.has(poolId)) repeated += 1n;
      else chargedPools.add(poolId);
    }
  }
  return repeated * poolDepositOf(protocolParameters);
};

/**
 * The pool deposits `body` is charged for pools that one of
 * `subTransactions` registers. The ledger applies the sub transactions
 * before the body, so such a pool is already registered when the body
 * registers it again, and the body pays no deposit for it.
 *
 * @param body - The body of the transaction that carries `subTransactions`.
 * @param subTransactions - The sub transactions.
 * @param protocolParameters - The protocol parameters supplying the pool
 *   deposit, with the pools already registered on chain, which neither the
 *   body nor the sub transactions are charged for, in `registeredPools`.
 * @returns The pool deposits the ledger does not charge `body`, zero without sub transactions.
 */
export const subTransactionPoolDeposits = (
  body: Pick<Cardano.TxBody, 'certificates'>,
  subTransactions: readonly Serialization.SubTransaction[],
  protocolParameters: SubTransactionImbalanceProtocolParameters & {
    registeredPools?: ReadonlySet<Cardano.PoolId>;
  },
): Cardano.Lovelace => {
  const { registeredPools = new Set() } = protocolParameters;
  const subTransactionPools = new Set(
    subTransactions.flatMap(subTransaction =>
      subTransactionPoolIds(subTransaction, registeredPools),
    ),
  );
  const repeated = [...registeredPoolIds(body.certificates)].filter(poolId =>
    subTransactionPools.has(poolId),
  ).length;
  return BigInt(repeated) * poolDepositOf(protocolParameters);
};

/**
 * The sum of the imbalances of `subTransactions`, see
 * {@link subTransactionImbalance}: the value they leave to the transaction
 * that carries them, negative where they take value from it. A pool that
 * several of them register is charged the pool deposit once, as the ledger
 * charges it once per pool across a batch, and a pool already registered on
 * chain is not charged at all.
 *
 * @param subTransactions - The sub transactions.
 * @param resolvedUtxos - UTxOs that resolve every input they spend.
 * @param protocolParameters - The deposits of certificates that carry none,
 *   with the pools already registered on chain in `registeredPools`.
 * @throws If `resolvedUtxos` does not resolve an input one of them spends.
 * @returns The summed imbalance, zero without sub transactions.
 */
export const subTransactionsImbalance = (
  subTransactions: readonly Serialization.SubTransaction[],
  resolvedUtxos: readonly Cardano.Utxo[],
  protocolParameters: SubTransactionImbalanceProtocolParameters & {
    registeredPools?: ReadonlySet<Cardano.PoolId>;
  },
): Cardano.Value =>
  coalesceValueQuantities([
    { coins: 0n },
    ...subTransactions.map(subTransaction =>
      subTransactionImbalance(
        subTransaction,
        resolvedUtxos,
        protocolParameters,
      ),
    ),
    {
      coins: repeatedSubTransactionPoolDeposits(
        subTransactions,
        protocolParameters,
        protocolParameters.registeredPools ?? new Set(),
      ),
    },
  ]);

/**
 * The inputs a sub transaction spends and the ones it references, read from
 * its body.
 *
 * @param subTransaction - The sub transaction.
 * @returns Its spent inputs and its reference inputs.
 */
export const subTransactionInputs = (
  subTransaction: Serialization.SubTransaction,
): { inputs: Cardano.TxIn[]; referenceInputs: Cardano.TxIn[] } => {
  const { inputs, referenceInputs } = subTransaction.body().toCore();
  return { inputs, referenceInputs: referenceInputs ?? [] };
};
