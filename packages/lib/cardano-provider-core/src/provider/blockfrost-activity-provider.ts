/* eslint-disable max-params */

import {
  Cardano,
  ProviderError,
  ProviderFailure,
  Serialization,
  createBatchInputResolver,
} from '@lace-lib/cardano-core';
import { Err, Ok, Timestamp } from '@lace-lib/util';
import { isNotFoundError } from '@lace-lib/util-provider';
import {
  catchError,
  defer,
  forkJoin,
  from,
  map,
  mergeMap,
  type Observable,
  of,
} from 'rxjs';

import { BlockfrostProvider } from '../blockfrost-provider';
import { BlockfrostToCardanoSDK } from '../blockfrost-to-cardano-sdk';
import { MAX_TRANSACTION_DEPTH, isCborWithinLimits } from '../cbor-limits';

import { BlockfrostInputResolverProvider } from './blockfrost-input-resolver-provider';
import { BlockfrostTxProvider } from './blockfrost-tx-provider';

import type { Responses } from '@blockfrost/blockfrost-js';
import type {
  CardanoPaymentAddress,
  CardanoTransactionHistoryItem,
  ExtendedTxDetails,
  GetAssetTransactionHistoryProps,
} from '@lace-contract/cardano-context';
import type { Result } from '@lace-lib/util';
import type { HttpClient } from '@lace-lib/util-provider';
import type { Logger } from 'ts-log';

type BlockfrostAddressTxList = Responses['address_transactions_content'];

/**
 * A transaction decoded from its CBOR together with the ids of its sub transactions in batch
 * order, each the hash of the sub transaction body bytes as they appear on chain.
 */
interface DecodedTx {
  /** The transaction in its core form. */
  tx: Cardano.Tx;
  /** The id of each sub transaction, in batch order. */
  subTransactionIds: Cardano.TransactionId[];
}

/**
 * Provider responsible for fetching transaction history and details.
 */
export class BlockfrostActivityProvider extends BlockfrostProvider {
  readonly #txProvider: BlockfrostTxProvider;
  readonly #inputResolver: BlockfrostInputResolverProvider;

  /**
   * @param client - Blockfrost HTTP client
   * @param logger - Logger
   * @param txProvider - Fetches the transaction details
   * @param inputResolver - Fetches the outputs of the transactions that produced
   * the sub transaction inputs Blockfrost does not list among the transaction utxos
   */
  public constructor(
    client: HttpClient,
    logger: Logger,
    txProvider: BlockfrostTxProvider = new BlockfrostTxProvider(client, logger),
    inputResolver: BlockfrostInputResolverProvider = new BlockfrostInputResolverProvider(
      client,
      logger,
    ),
  ) {
    super(client, logger);
    this.#txProvider = txProvider;
    this.#inputResolver = inputResolver;
  }

  /**
   * Fetches the transaction history for a Cardano address.
   *
   * @param address - Cardano payment address to fetch transaction history for
   * @param numberOfItems - How many history items should be fetched (order: newer → older)
   * @param startAtBlock - At which block (inclusive) should it start
   * @param startAtIndex - At which index (inclusive) should it start
   * @returns Observable with Result containing the history items or an error
   */
  public getAddressTransactionHistory({
    address,
    numberOfItems,
    startAtBlock,
    startAtIndex,
    endAtBlock,
    endAtIndex,
    order = 'desc',
  }: {
    address: CardanoPaymentAddress;
    numberOfItems: number;
    startAtBlock?: Cardano.BlockNo;
    startAtIndex?: Cardano.TxIndex;
    endAtBlock?: Cardano.BlockNo;
    endAtIndex?: Cardano.TxIndex;
    order?: 'asc' | 'desc';
  }): Observable<Result<CardanoTransactionHistoryItem[], ProviderError>> {
    const fromIndexParameter =
      startAtIndex !== undefined ? `:${startAtIndex}` : '';
    const toIndexParameter = endAtIndex !== undefined ? `:${endAtIndex}` : '';
    const optionalFromParameter =
      startAtBlock !== undefined
        ? `&to=${startAtBlock}${fromIndexParameter}`
        : '';
    const optionalToParameter =
      endAtBlock !== undefined ? `&from=${endAtBlock}${toIndexParameter}` : '';
    return from(
      this.request<BlockfrostAddressTxList>(
        `addresses/${address}/transactions?count=${numberOfItems}&order=${order}${optionalFromParameter}${optionalToParameter}`,
      ),
    ).pipe(
      map(addressTxHistory =>
        Ok(
          addressTxHistory.map(item => ({
            txId: Cardano.TransactionId(item.tx_hash),
            txIndex: Cardano.TxIndex(item.tx_index),
            blockNumber: Cardano.BlockNo(item.block_height),
            blockTime: Timestamp(item.block_time * 1000), // BF returns it in seconds, we want milliseconds
          })),
        ),
      ),
      catchError(error => {
        // Blockfrost returns 404 for any address that has not yet had any
        // on-chain activity. This is not a fetch failure — it simply means
        // there are no transactions for this address yet. Treating it as an
        // error would fail the per-account transaction-polling sync round,
        // and the next tip change would re-enqueue the same failing op,
        // creating an infinite failure loop for fresh / unused addresses.
        if (isNotFoundError(error)) {
          return of(Ok<CardanoTransactionHistoryItem[]>([]));
        }
        return of(Err(error as ProviderError));
      }),
    );
  }

  /**
   * Fetches every transaction that minted, burned or moved an asset, oldest
   * first, paging until exhausted or until `maxPages` pages were read. Each
   * read starts on subscription, so a caller's retry re-requests.
   *
   * Blockfrost returns 404 for an asset that never existed; that is a valid
   * empty history here, not an error.
   *
   * `assetId` is the hex policy id followed by the hex asset name, `page`
   * the Blockfrost page to start from (default 1), `pageSize` the number
   * of transactions per Blockfrost page (default 100) and `maxPages` the
   * pages read at most (default unbounded).
   */
  public getAssetTransactionHistory({
    assetId,
    page = 1,
    pageSize = 100,
    maxPages,
  }: GetAssetTransactionHistoryProps): Observable<
    Result<CardanoTransactionHistoryItem[], ProviderError>
  > {
    return defer(async () =>
      this.paginatedRequests<Responses['asset_transactions']>({
        endpoint: `assets/${assetId}/transactions?order=asc`,
        page,
        pageSize,
        maxPages,
      }),
    ).pipe(
      map(items =>
        Ok(
          items.map(item => ({
            txId: Cardano.TransactionId(item.tx_hash),
            txIndex: Cardano.TxIndex(item.tx_index),
            blockNumber: Cardano.BlockNo(item.block_height),
            blockTime: Timestamp(item.block_time * 1000),
          })),
        ),
      ),
      catchError(error =>
        isNotFoundError(error)
          ? of(Ok<CardanoTransactionHistoryItem[]>([]))
          : of(Err(error as ProviderError)),
      ),
    );
  }

  /**
   * Fetches transaction details, cbor and utxos to build a Cardano.HydratedTx
   * which is returned inside a tuple together with the tx details which holds
   * additional info not stored in the HydratedTx.
   *
   * The sub transactions of a Dijkstra batch carry their ids and their inputs
   * and reference inputs carry the address of the output they spend or
   * reference. Those outputs are looked up in the batch itself first, then in
   * the inputs Blockfrost lists for the transaction and last in the
   * transaction that produced them. The details fail when one cannot be
   * found.
   *
   * @param txId - Cardano.TransactionId
   */
  public getTransactionDetails(
    txId: Cardano.TransactionId,
  ): Observable<Result<ExtendedTxDetails, ProviderError>> {
    // Fetch all tx details in parallel and fail if any request fails
    return forkJoin([
      from(this.#txProvider.getTransaction(txId)),
      this.#fetchTxFromCbor(txId),
      this.#fetchUtxos(txId),
    ]).pipe(
      mergeMap(async ([txDetails, decodedTx, blockFrostUtxos]) => {
        const blockfrostTxCBOR = decodedTx.tx;
        // We can't use txFromCBOR.body.inputs since it misses HydratedTxIn.address
        const { inputs, outputs, collaterals } =
          BlockfrostToCardanoSDK.transactionUtxos(
            blockFrostUtxos,
            blockfrostTxCBOR,
          );

        const inputSource: Cardano.InputSource = txDetails.valid_contract
          ? Cardano.InputSource.inputs
          : Cardano.InputSource.collaterals;

        const body: Cardano.HydratedTxBody = {
          ...(inputSource === Cardano.InputSource.collaterals
            ? {
                collateralReturn: outputs.length > 0 ? outputs[0] : undefined,
                collaterals: inputs,
                fee: BigInt(0),
                inputs: [],
                outputs: [],
                totalCollateral: blockfrostTxCBOR.body.fee,
              }
            : {
                collateralReturn:
                  blockfrostTxCBOR.body.collateralReturn ?? undefined,
                collaterals,
                fee: blockfrostTxCBOR.body.fee,
                inputs,
                outputs,
              }),
          certificates: blockfrostTxCBOR.body.certificates ?? [],
          directDeposits: blockfrostTxCBOR.body.directDeposits,
          donation: blockfrostTxCBOR.body.donation,
          guards: blockfrostTxCBOR.body.guards,
          mint: blockfrostTxCBOR.body.mint
            ? new Map([...blockfrostTxCBOR.body.mint].sort())
            : undefined,
          proposalProcedures: blockfrostTxCBOR.body.proposalProcedures,
          validityInterval: blockfrostTxCBOR.body.validityInterval
            ? blockfrostTxCBOR.body.validityInterval
            : { invalidBefore: undefined, invalidHereafter: undefined },
          votingProcedures: blockfrostTxCBOR.body.votingProcedures,
          withdrawals: blockfrostTxCBOR.body.withdrawals,
          ...(blockfrostTxCBOR.body.requiredTopLevelGuards && {
            requiredTopLevelGuards:
              blockfrostTxCBOR.body.requiredTopLevelGuards,
          }),
          ...(blockfrostTxCBOR.body.accountBalanceIntervals && {
            accountBalanceIntervals:
              blockfrostTxCBOR.body.accountBalanceIntervals,
          }),
          ...(blockfrostTxCBOR.body.startingAccountBalanceIntervals && {
            startingAccountBalanceIntervals:
              blockfrostTxCBOR.body.startingAccountBalanceIntervals,
          }),
          ...(blockfrostTxCBOR.body.subTransactions && {
            subTransactions: await this.#hydrateSubTransactions(
              decodedTx,
              blockFrostUtxos,
            ),
          }),
        };
        const hydratedTx: Cardano.HydratedTx = {
          auxiliaryData: blockfrostTxCBOR.auxiliaryData,
          blockHeader: {
            blockNo: Cardano.BlockNo(txDetails.block_height),
            hash: Cardano.BlockId(txDetails.block),
            slot: Cardano.Slot(txDetails.slot),
          },
          body,
          id: txId,
          index: txDetails.index,
          inputSource,
          txSize: 0,
          witness: blockfrostTxCBOR.witness,
        };
        return Ok({
          ...hydratedTx,
          blockTime: txDetails.block_time,
        } satisfies ExtendedTxDetails);
      }),
      catchError(error => of(Err(error))),
    );
  }

  /**
   * The transaction decoded from its CBOR. A transaction that is larger or
   * nests deeper than the decoders are allowed is refused before any
   * decoding: the decoder's cost grows with the square of the nesting, so
   * a transaction of someone else's making, such as the init of a head that
   * looks like one of the account's, could otherwise stall every reader of
   * its details with deeply nested metadata.
   */
  #fetchTxFromCbor(txId: Cardano.TransactionId): Observable<DecodedTx> {
    return from(
      this.request<Responses['tx_content_cbor']>(`txs/${txId}/cbor`),
    ).pipe(
      map(({ cbor }) => {
        if (!isCborWithinLimits(cbor, MAX_TRANSACTION_DEPTH)) {
          throw new ProviderError(
            ProviderFailure.InvalidResponse,
            undefined,
            `Transaction ${txId} is larger or nests deeper than can be decoded`,
          );
        }
        const transaction = Serialization.Transaction.fromCbor(
          Serialization.TxCBOR(cbor),
        );
        return {
          subTransactionIds:
            transaction
              .body()
              .subTransactions()
              ?.values()
              .map(subTransaction => subTransaction.getId()) ?? [],
          tx: transaction.toCore(),
        };
      }),
    );
  }

  /**
   * The sub transactions of a batch, each with its id and with the address of
   * the output every input and reference input spends or references.
   *
   * @param decodedTx - The batch transaction and its sub transaction ids
   * @param blockFrostUtxos - The utxos Blockfrost lists for the batch transaction
   * @throws `ProviderError` when an input cannot be resolved
   */
  async #hydrateSubTransactions(
    { tx, subTransactionIds }: DecodedTx,
    blockFrostUtxos: Responses['tx_content_utxo'],
  ): Promise<Cardano.HydratedSubTransaction[]> {
    const subTransactions = (tx.body.subTransactions ?? []).map(
      (subTransaction, index) => ({
        ...subTransaction,
        id: subTransactionIds[index],
      }),
    );
    const producerOutputs = new Map<
      Cardano.TransactionId,
      Promise<Map<number, Cardano.TxOut> | null>
    >();
    const resolver = createBatchInputResolver(
      { ...tx, body: { ...tx.body, subTransactions } },
      {
        resolveInput: async txIn => {
          const listed = blockFrostUtxos.inputs.find(
            input =>
              input.tx_hash === txIn.txId && input.output_index === txIn.index,
          );
          if (listed) return BlockfrostToCardanoSDK.txOut(listed);
          if (!producerOutputs.has(txIn.txId)) {
            producerOutputs.set(
              txIn.txId,
              this.#inputResolver.resolveTransactionOutputs(txIn.txId),
            );
          }
          const outputs = await producerOutputs.get(txIn.txId);
          return outputs?.get(txIn.index) ?? null;
        },
      },
    );

    /**
     * Pairs each input with the address of the output it spends or references.
     *
     * @throws `ProviderError` when an input cannot be resolved
     */
    const hydrateInputs = async (inputs: Cardano.TxIn[]) =>
      Promise.all(
        inputs.map(async (txIn): Promise<Cardano.HydratedTxIn> => {
          const txOut = await resolver.resolveInput(txIn);
          if (!txOut) {
            throw new ProviderError(
              ProviderFailure.NotFound,
              undefined,
              `Input ${txIn.txId}#${txIn.index} of transaction ${tx.id} could not be resolved`,
            );
          }
          return { address: txOut.address, index: txIn.index, txId: txIn.txId };
        }),
      );

    return Promise.all(
      subTransactions.map(
        async ({ body: { inputs, referenceInputs, ...body }, ...rest }) => ({
          ...rest,
          body: {
            ...body,
            inputs: await hydrateInputs(inputs),
            ...(referenceInputs && {
              referenceInputs: await hydrateInputs(referenceInputs),
            }),
          },
        }),
      ),
    );
  }

  #fetchUtxos(
    txId: Cardano.TransactionId,
  ): Observable<Responses['tx_content_utxo']> {
    return from(
      this.request<Responses['tx_content_utxo']>(`txs/${txId}/utxos`),
    );
  }
}
