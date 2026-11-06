// copied from Lace v1
// https://github.com/input-output-hk/lace/blob/27873f3b5dd8ec0e6926a5dd1653986a97ac81e8/packages/cardano/src/wallet/lib/blockfrost-input-resolver.ts#L27

import { isNotFoundError } from '@lace-lib/util-provider';

import { BlockfrostProvider } from '../blockfrost-provider';
import { BlockfrostToCardanoSDK } from '../blockfrost-to-cardano-sdk';

import type { Responses } from '@blockfrost/blockfrost-js';
import type { Cardano } from '@lace-lib/cardano-core';
import type { HttpClient } from '@lace-lib/util-provider';
import type { Logger } from 'ts-log';

/**
 * A resolver class to fetch and resolve transaction inputs using Blockfrost API.
 */
export class BlockfrostInputResolverProvider
  extends BlockfrostProvider
  implements Cardano.InputResolver
{
  /**
   * Constructs a new BlockfrostInputResolverProvider.
   *
   * @param client - The Blockfrost client instance to interact with the Blockfrost API.
   * @param logger - The logger instance to log messages to.
   */
  public constructor(client: HttpClient, logger: Logger) {
    super(client, logger);
  }

  /**
   * Resolves a transaction input (`Cardano.TxIn`) to its corresponding output (`Cardano.TxOut`).
   * The output carries no reference script, as Blockfrost lists only its hash,
   * so it cannot price or run a reference script on its own.
   *
   * @param input - The transaction input to resolve, including its transaction ID and index.
   * @returns A promise that resolves to the corresponding `Cardano.TxOut` if found, or `null` if not.
   */
  public async resolveInput(
    input: Cardano.TxIn,
  ): Promise<Cardano.TxOut | null> {
    this.logger.debug(`Resolving input ${input.txId}#${input.index}`);

    const out = await this.fetchTxOut(input);
    if (!out) return null;

    return out;
  }

  /**
   * Fetches the outputs of a transaction, keyed by output index, so that every
   * input spending one of them resolves from a single request. The outputs
   * carry no reference script, as Blockfrost lists only its hash.
   *
   * @param txId - The id of the transaction whose outputs are fetched.
   * @returns A promise that resolves to the outputs, or `null` if the transaction is not found.
   */
  public async resolveTransactionOutputs(
    txId: Cardano.TransactionId,
  ): Promise<Map<number, Cardano.TxOut> | null> {
    let response;

    try {
      response = await this.request<Responses['tx_content_utxo']>(
        `txs/${txId}/utxos`,
      );
    } catch (error: unknown) {
      this.logger.error(`Failed to fetch transaction ${txId}`, error);

      if (isNotFoundError(error)) {
        return null;
      }

      throw error;
    }

    return new Map(
      response.outputs.map(blockfrostUTxO => [
        blockfrostUTxO.output_index,
        BlockfrostToCardanoSDK.txOut(blockfrostUTxO),
      ]),
    );
  }

  /**
   * Fetches the transaction output (`Cardano.TxOut`) for a given transaction input (`Cardano.TxIn`).
   *
   * @param txIn - The transaction input to fetch the output for.
   * @returns A promise that resolves to the corresponding `Cardano.TxOut` if found, or `null` if not.
   */
  private async fetchTxOut(txIn: Cardano.TxIn): Promise<Cardano.TxOut | null> {
    const outputs = await this.resolveTransactionOutputs(txIn.txId);
    if (!outputs) return null;

    const coreTxOut = outputs.get(txIn.index);
    if (!coreTxOut) {
      this.logger.error(`Failed to resolve input ${txIn.txId}#${txIn.index}`);
      return null;
    }

    this.logger.debug(
      `Resolved input ${txIn.txId}#${txIn.index} from Blockfrost`,
    );
    return coreTxOut;
  }
}
