import { Serialization } from '@lace-lib/cardano-core';
import { blake2b } from '@lace-lib/cardano-crypto';

import type { Cardano } from '@lace-lib/cardano-core';
import type { Hash32ByteBase16 } from '@lace-lib/cardano-crypto';

/** The CBOR tag of auxiliary data in the Alonzo form. */
const ALONZO_AUXILIARY_DATA_TAG = 259;

/** Hex comparator, which orders hashes as the ledger orders their bytes, whatever their case. */
const compareHex = (a: string, b: string): number => {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return left === right ? 0 : left < right ? -1 : 1;
};

/**
 * Orders transaction inputs as the ledger orders the sets that hold them:
 * by transaction id, then by output index.
 *
 * @param a - The first input.
 * @param b - The second input.
 * @returns A negative number when `a` comes first, positive when `b` does, zero when equal.
 */
export const compareTxIns = (a: Cardano.TxIn, b: Cardano.TxIn): number =>
  compareHex(a.txId, b.txId) || a.index - b.index;

/**
 * Sorts transaction inputs in the ledger's set order.
 *
 * @param inputs - The inputs to sort.
 * @returns A sorted copy of the inputs.
 */
const sortTxIns = <T extends Cardano.TxIn>(inputs: readonly T[]): T[] =>
  [...inputs].sort(compareTxIns);

/**
 * The inputs and reference inputs of `body` in the ledger's set order.
 *
 * @param body - The body whose input sets to sort.
 * @returns The sorted inputs and, when `body` has them, reference inputs.
 */
const sortedInputSets = ({
  inputs,
  referenceInputs,
}: Pick<Cardano.TxBody, 'inputs' | 'referenceInputs'>): Pick<
  Cardano.TxBody,
  'inputs' | 'referenceInputs'
> => ({
  inputs: sortTxIns(inputs),
  ...(referenceInputs && { referenceInputs: sortTxIns(referenceInputs) }),
});

/**
 * Serializes an output in the post-Alonzo map form, the canonical form the
 * cardano-c transaction builder writes every output in, whether or not it
 * carries a datum or a script.
 *
 * @param output - The output to serialize.
 * @returns The output, written as a map.
 */
export const serializeTransactionOutput = (
  output: Cardano.TxOut,
): Serialization.TransactionOutput => {
  const serialized = Serialization.TransactionOutput.fromCore(output);
  if (serialized.isBabbageOutput()) return serialized;

  const datumHash = serialized.datum()?.asDataHash();
  const writer = new Serialization.CborWriter();
  writer.writeStartMap(datumHash ? 3 : 2);
  writer.writeInt(0n);
  writer.writeByteString(Buffer.from(serialized.address().toBytes(), 'hex'));
  writer.writeInt(1n);
  writer.writeEncodedValue(Buffer.from(serialized.amount().toCbor(), 'hex'));
  if (datumHash) {
    writer.writeInt(2n);
    writer.writeStartArray(2);
    writer.writeInt(0n);
    writer.writeByteString(Buffer.from(datumHash, 'hex'));
  }
  return Serialization.TransactionOutput.fromCbor(writer.encodeAsHex());
};

/**
 * Serializes auxiliary data in the Alonzo form, a map under tag 259, the
 * canonical form the cardano-c transaction builder writes it in, even when
 * it holds metadata alone.
 *
 * @param auxiliaryData - The auxiliary data to serialize.
 * @returns The auxiliary data, written in the tagged form.
 */
export const serializeAuxiliaryData = (
  auxiliaryData: Cardano.AuxiliaryData,
): Serialization.AuxiliaryData => {
  const serialized = Serialization.AuxiliaryData.fromCore(auxiliaryData);
  const reader = new Serialization.CborReader(serialized.toCbor());
  if (reader.peekState() === Serialization.CborReaderState.Tag) {
    return serialized;
  }

  const metadata = serialized.metadata();
  const nativeScripts = serialized.nativeScripts() ?? [];
  const writer = new Serialization.CborWriter();
  writer.writeTag(ALONZO_AUXILIARY_DATA_TAG);
  writer.writeStartMap(nativeScripts.length > 0 ? 2 : 1);
  writer.writeInt(0n);
  writer.writeEncodedValue(Buffer.from(metadata!.toCbor(), 'hex'));
  if (nativeScripts.length > 0) {
    writer.writeInt(1n);
    writer.writeStartArray(nativeScripts.length);
    for (const script of nativeScripts) {
      writer.writeEncodedValue(Buffer.from(script.toCbor(), 'hex'));
    }
  }
  return Serialization.AuxiliaryData.fromCbor(writer.encodeAsHex());
};

/**
 * Hashes auxiliary data as {@link serializeAuxiliaryData} writes it, the
 * hash the transaction body commits to.
 *
 * @param auxiliaryData - The auxiliary data to hash.
 * @returns Its hash, or `undefined` without auxiliary data.
 */
export const auxiliaryDataHash = (
  auxiliaryData: Cardano.AuxiliaryData | undefined,
): Hash32ByteBase16 | undefined =>
  auxiliaryData
    ? blake2b.hash<Hash32ByteBase16>(
        serializeAuxiliaryData(auxiliaryData).toCbor(),
        32,
      )
    : undefined;

/**
 * Serializes a transaction in the canonical form the cardano-c transaction
 * builder writes: inputs, collateral inputs and reference inputs in set
 * order, every output and the collateral return in the map form, and
 * auxiliary data in the tagged form. It always writes the transaction as
 * valid, with `isValid` set to true.
 *
 * Sub transactions given in `subTransactions` are written with the bytes
 * they carry, in the order given, in place of any the body of `tx` holds.
 * A sub transaction decoded from CBOR so keeps its encoding, and with it its
 * id and the signatures over that id, which writing it again from its core
 * form could change.
 *
 * @param tx - The transaction to serialize.
 * @param subTransactions - The sub transactions the body carries, as encoded.
 * @returns The serialized transaction.
 */
export const serializeTransaction = (
  tx: Cardano.Tx,
  subTransactions: readonly Serialization.SubTransaction[] = [],
): Serialization.Transaction => {
  const { body } = tx;
  const serializedBody = Serialization.TransactionBody.fromCore({
    ...body,
    ...sortedInputSets(body),
    ...(body.collaterals && { collaterals: sortTxIns(body.collaterals) }),
  });
  serializedBody.setOutputs(body.outputs.map(serializeTransactionOutput));
  if (body.collateralReturn) {
    serializedBody.setCollateralReturn(
      serializeTransactionOutput(body.collateralReturn),
    );
  }
  if (subTransactions.length > 0) {
    const subTransactionSet = Serialization.CborSet.fromCore(
      [],
      Serialization.SubTransaction.fromCore,
    );
    subTransactionSet.setValues([...subTransactions]);
    serializedBody.setSubTransactions(subTransactionSet);
  }
  return new Serialization.Transaction(
    serializedBody,
    Serialization.TransactionWitnessSet.fromCore(tx.witness),
    tx.auxiliaryData && serializeAuxiliaryData(tx.auxiliaryData),
  );
};

/**
 * Serializes a sub transaction in the canonical form the cardano-c sub
 * transaction builder writes: inputs and reference inputs in set order,
 * every output in the map form, and auxiliary data in the tagged form.
 *
 * @param subTransaction - The sub transaction to serialize.
 * @returns The serialized sub transaction.
 */
export const serializeSubTransaction = (
  subTransaction: Cardano.SubTransaction,
): Serialization.SubTransaction => {
  const { body } = subTransaction;
  const serializedBody = Serialization.SubTransactionBody.fromCore({
    ...body,
    ...sortedInputSets(body),
  });
  serializedBody.setOutputs(body.outputs.map(serializeTransactionOutput));
  return new Serialization.SubTransaction(
    serializedBody,
    Serialization.TransactionWitnessSet.fromCore(subTransaction.witness),
    subTransaction.auxiliaryData &&
      serializeAuxiliaryData(subTransaction.auxiliaryData),
  );
};
