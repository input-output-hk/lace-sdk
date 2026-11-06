import type { TxOut } from '../Cardano/types/Utxo';
import type { Transaction } from '../Serialization/Transaction';

/** An output a level of a transaction batch pays that no level of the batch spends. */
export interface BatchLeavingOutput {
  /** The output. */
  output: TxOut;
  /** The level that pays the output: 0 for the top level, n for the nth sub transaction. */
  level: number;
}

/**
 * Gets the outputs a transaction batch (CIP-0118) leaves on chain once it lands, in batch order.
 * An output that a level of the batch spends is an intermediate step of the batch, so it is left
 * out. A transaction without sub transactions leaves every output it pays.
 *
 * @param tx The transaction.
 * @returns The outputs the batch leaves, each with the level that pays it.
 */
export const batchLeavingOutputs = (tx: Transaction): BatchLeavingOutput[] => {
  const levels = [
    { body: tx.body().toCore(), id: String(tx.getId()) },
    ...(tx.body().subTransactions()?.values() ?? []).map(subTransaction => ({
      body: subTransaction.body().toCore(),
      id: String(subTransaction.getId()),
    })),
  ];
  const spent = new Set(
    levels.flatMap(({ body }) =>
      body.inputs.map(({ index, txId }) => `${txId}#${index}`),
    ),
  );
  return levels.flatMap(({ body, id }, level) =>
    body.outputs
      .map(output => ({ level, output }))
      .filter((_, index) => !spent.has(`${id}#${index}`)),
  );
};
