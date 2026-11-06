import { Serialization } from '@lace-lib/cardano-core';

import { executionUnitsFee } from './exact-fees';
import { referenceScriptFee, referenceScriptSize } from './reference-scripts';
import {
  serializeTransaction,
  serializeTransactionOutput,
} from './serialization';
import { subTransactionInputs } from './sub-transactions';

import type { ReferenceScriptFeeProtocolParameters } from './reference-scripts';
import type { Cardano } from '@lace-lib/cardano-core';

/** The protocol parameters {@link minFee} prices a transaction with. */
export type MinFeeProtocolParameters = Pick<
  Cardano.ProtocolParameters,
  'minFeeCoefficient' | 'minFeeConstant' | 'prices'
> &
  ReferenceScriptFeeProtocolParameters;

/**
 * The constant overhead of 160 bytes accounts for the transaction input and the entry in the UTxO map data
 * structure (20 words * 8 bytes).
 */
const MIN_ADA_CONSTANT_OVERHEAD = 160;

/**
 * Serializes the given BigInt to CBOR format.
 *
 * @param bigInt - The BigInt to be serialized.
 */
const serializeBigInt = (bigInt: string) => {
  const writer = new Serialization.CborWriter();

  writer.writeInt(BigInt(bigInt));

  return writer.encode();
};

/**
 * Gets the size in bytes of the given Tx Output, written as the builder writes it.
 *
 * @param output - The output to measure.
 */
const serializeTxOutputSize = (output: Cardano.TxOut) =>
  serializeTransactionOutput(output).toCbor().length / 2;

/**
 * Serializes the given Tx to CBOR format, as the builder writes it.
 *
 * @param tx - The Tx to be serialized.
 * @param subTransactions - The sub transactions its body carries, as encoded.
 */
const serializeTx = (
  tx: Cardano.Tx,
  subTransactions: readonly Serialization.SubTransaction[],
) => Buffer.from(serializeTransaction(tx, subTransactions).toCbor(), 'hex');

/** The script resources a transaction and the sub transactions it carries consume together. */
export type BatchScriptUsage = {
  /** Execution units summed over the redeemers of every level. */
  executionUnits: Cardano.ExUnits;
  /** The number of redeemers across every level. */
  redeemerCount: number;
  /** Reference script bytes summed over the levels, each reading its spent and reference inputs once. */
  referenceScriptSize: number;
};

/** The parts of the top level transaction {@link batchScriptUsage} reads. */
export type BatchScriptUsageTopLevel = {
  /** The inputs it spends. */
  inputs: readonly Cardano.TxIn[];
  /** The inputs it references. */
  referenceInputs?: readonly Cardano.TxIn[];
  /** The redeemers of its witness set. */
  redeemers?: readonly Cardano.Redeemer[];
};

/**
 * Measures the script resources of a transaction and the sub transactions it carries, as the ledger does for the
 * whole batch: the execution units of every level's redeemers, summed, and the reference scripts each level's spent
 * and reference inputs carry, summed over the levels. A level reads an input once, while an output read by several
 * levels counts once for each of them.
 *
 * @param topLevel - The inputs, reference inputs and redeemers of the top level transaction.
 * @param resolvedInputs - The resolved inputs and reference inputs of the transaction and of its sub transactions.
 * @param subTransactions - The sub transactions its body carries.
 * @returns The usage of the whole batch.
 */
export const batchScriptUsage = (
  topLevel: BatchScriptUsageTopLevel,
  resolvedInputs: readonly Cardano.Utxo[],
  subTransactions: readonly Serialization.SubTransaction[],
): BatchScriptUsage => {
  const levels = [
    {
      inputs: [...topLevel.inputs, ...(topLevel.referenceInputs ?? [])],
      redeemers: topLevel.redeemers ?? [],
    },
    ...subTransactions.map(subTransaction => {
      const { inputs, referenceInputs } = subTransactionInputs(subTransaction);
      return {
        inputs: [...inputs, ...referenceInputs],
        redeemers: subTransaction.witnessSet().redeemers()?.toCore() ?? [],
      };
    }),
  ];
  const usage: BatchScriptUsage = {
    executionUnits: { memory: 0, steps: 0 },
    redeemerCount: 0,
    referenceScriptSize: 0,
  };
  for (const level of levels) {
    usage.referenceScriptSize += referenceScriptSize(
      level.inputs,
      resolvedInputs,
    );
    for (const { executionUnits } of level.redeemers) {
      usage.executionUnits.memory += executionUnits.memory;
      usage.executionUnits.steps += executionUnits.steps;
    }
    usage.redeemerCount += level.redeemers.length;
  }
  return usage;
};

/**
 * Gets the minimum fee incurred by the scripts on the transaction and the sub transactions it carries: the reference
 * script bytes of the batch, priced together by {@link referenceScriptFee}, plus the execution units of every level's
 * redeemers, priced together by {@link executionUnitsFee}, both measured by {@link batchScriptUsage}.
 *
 * @param tx - The transaction to compute the min script fee from.
 * @param resolvedInputs - The resolved inputs and reference inputs of the transaction and of its sub transactions.
 * @param pparams - The protocol parameters.
 * @param subTransactions - The sub transactions its body carries, as encoded.
 */
const minScriptFee = (
  tx: Cardano.Tx,
  resolvedInputs: Cardano.Utxo[],
  pparams: MinFeeProtocolParameters,
  subTransactions: readonly Serialization.SubTransaction[],
): bigint => {
  const usage = batchScriptUsage(
    { ...tx.body, redeemers: tx.witness.redeemers },
    resolvedInputs,
    subTransactions,
  );
  const scriptRefFee = referenceScriptFee(usage.referenceScriptSize, pparams);

  if (usage.redeemerCount === 0) return scriptRefFee;

  return executionUnitsFee(usage.executionUnits, pparams.prices) + scriptRefFee;
};

/**
 * Gets the minimum fee incurred by the transaction size.
 *
 * @param tx - The transaction to compute the min fee from.
 * @param subTransactions - The sub transactions its body carries, as encoded.
 * @param pparams - The protocol parameters.
 */
const minNoScriptFee = (
  tx: Cardano.Tx,
  subTransactions: readonly Serialization.SubTransaction[],
  { minFeeConstant, minFeeCoefficient }: MinFeeProtocolParameters,
) => {
  const txSize = serializeTx(tx, subTransactions).length;
  return BigInt(Math.ceil(txSize * minFeeCoefficient + minFeeConstant));
};

/**
 * Gets the minimum ADA amount required to be contained in the given UTXO.
 *
 * Requiring some amount of ADA to be included in every UTXO (where that amount is based on the size of the UTXO,
 * in bytes) limits the maximum total size taken up by UTXO entries on the ledger at any given time. The output is
 * measured in the map form the transaction builder writes every output in, so for an output written by hand in the
 * legacy array form it asks for slightly more than the ledger does.
 *
 * @param output - The UTXO to get the minimum ADA amount.
 * @param coinsPerUtxoByte - parameter used to adjust the maximum possible UTXO size by raising and lowering the min ada
 * required per UTXO.
 */
export const minAdaRequired = (
  output: Cardano.TxOut,
  coinsPerUtxoByte: bigint,
): bigint => {
  const oldCoinSize = serializeBigInt(output.value.coins.toString()).length;

  let latestSize = oldCoinSize;
  let isDone = false;

  while (!isDone) {
    const sizeDiff = latestSize - oldCoinSize;

    const tentativeMinAda =
      BigInt(
        serializeTxOutputSize(output) + MIN_ADA_CONSTANT_OVERHEAD + sizeDiff,
      ) * coinsPerUtxoByte;

    const newCoinSize = serializeBigInt(tentativeMinAda.toString()).length;

    isDone = latestSize === newCoinSize;
    latestSize = newCoinSize;
  }

  const sizeChange = latestSize - oldCoinSize;

  return (
    BigInt(
      serializeTxOutputSize(output) + MIN_ADA_CONSTANT_OVERHEAD + sizeChange,
    ) * coinsPerUtxoByte
  );
};

/**
 * Gets the minimum transaction fee for the given transaction given its size and its execution units budget. The
 * transaction is measured as the transaction builder writes it: outputs as maps and auxiliary data under tag 259. For a
 * transaction written by hand in the legacy forms it slightly overestimates the fee the ledger requires. Execution
 * units and reference scripts are priced in exact rational arithmetic and rounded once each, as the ledger prices them.
 *
 * The size counts the sub transactions in `subTransactions` with the bytes they carry, as the transaction builder
 * writes them, in place of any the body of `tx` holds. The transaction pays the fee of the whole batch, so the
 * execution units of their redeemers and the reference scripts their inputs carry are priced too, as the ledger prices
 * a batch.
 *
 * @param tx - The transaction to compute the min fee from.
 * @param resolvedInputs - The resolved inputs and reference inputs of the transaction and of its sub transactions.
 * @param pparams - The protocol parameters.
 * @param subTransactions - The sub transactions its body carries, as encoded.
 */
export const minFee = (
  tx: Cardano.Tx,
  resolvedInputs: Cardano.Utxo[],
  pparams: MinFeeProtocolParameters,
  subTransactions: readonly Serialization.SubTransaction[] = [],
) =>
  minNoScriptFee(tx, subTransactions, pparams) +
  minScriptFee(tx, resolvedInputs, pparams, subTransactions);
