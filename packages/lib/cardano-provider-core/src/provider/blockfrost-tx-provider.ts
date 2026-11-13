import { Cardano } from '@lace-lib/cardano-core';
import { isNotFoundError } from '@lace-lib/util-provider';

import { BlockfrostProvider } from '../blockfrost-provider';

import type { Responses } from '@blockfrost/blockfrost-js';
import type { CardanoTransactionInclusion } from '@lace-contract/cardano-context';

/**
 * Fetches transaction details by id via Blockfrost `txs/{hash}`.
 *
 * Throws `ProviderError` on failure. A 404 (transaction not seen by the node /
 * dropped from mempool) surfaces as `ProviderError` with
 * `reason === ProviderFailure.NotFound`; consumers can detect it via
 * `isNotFoundError` from `@lace-lib/util-provider`.
 */
export class BlockfrostTxProvider extends BlockfrostProvider {
  public async getTransaction(
    txId: Cardano.TransactionId,
  ): Promise<Responses['tx_content']> {
    return this.request<Responses['tx_content']>(`txs/${txId}`);
  }
}

/**
 * Where the chain included a transaction, from Blockfrost `txs/{hash}`, or
 * `null` when Blockfrost answers 404: it has never seen the transaction, or
 * dropped it from its mempool.
 *
 * @throws `ProviderError` on any other failure
 */
export const getTransactionInclusion = async (
  txProvider: BlockfrostTxProvider,
  txId: Cardano.TransactionId,
): Promise<CardanoTransactionInclusion | null> => {
  try {
    const content = await txProvider.getTransaction(txId);
    return {
      blockHash: Cardano.BlockId(content.block),
      blockHeight: Cardano.BlockNo(content.block_height),
      slot: Cardano.Slot(content.slot),
      txIndex: Cardano.TxIndex(content.index),
      isValid: content.valid_contract,
    };
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
};
