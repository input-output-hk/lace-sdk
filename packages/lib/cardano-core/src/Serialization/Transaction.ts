import { HexBlob } from '@lace-lib/cardano-util';

import { SerializationError, SerializationFailure } from '../errors';
import { hexToBytes } from '../util/misc';

import { AuxiliaryData } from './AuxiliaryData';
import { CborReader, CborReaderState, CborWriter } from './CBOR';
import { TransactionBody } from './TransactionBody';
import { TransactionWitnessSet } from './TransactionWitnessSet';

import type { DeserializationOptions } from './Common';
import type * as Cardano from '../Cardano';
import type { OpaqueString } from '@lace-lib/cardano-util';

/** The layouts a transaction array is written in. */
enum TxFrame {
  /** `[body, witness set, auxiliary data / nil]`, without the is_valid flag. */
  Shelley,
  /** `[body, witness set, is_valid, auxiliary data / nil]`, the flag before the auxiliary data. */
  Alonzo,
  /** `[body, witness set, auxiliary data / nil, is_valid]`, the flag after the auxiliary data, as a Dijkstra block carries it. */
  Block,
}

/** Transaction serialized as CBOR, encoded as hex string */
export type TxCBOR = HexBlob & OpaqueString<'TxCbor'>;
/** Transaction body serialized as CBOR, encoded as hex string */
export type TxBodyCBOR = HexBlob & OpaqueString<'TxBodyCbor'>;

/**
 * A transaction is a record of value transfer between two or more addresses on the network. It represents a request
 * to modify the state of the blockchain, by transferring a certain amount of ADA or a native asset from one address
 * to another. Each transaction includes inputs and outputs, where the inputs represent the addresses that are sending
 * ADA or the native asset, and the outputs represent the addresses that are receiving ADA or the native asset.
 *
 * To ensure the security and integrity of the Cardano blockchain, each transaction is cryptographically signed using
 * the private key of the sender's address, which proves that the sender has authorized the transaction.
 *
 * Additionally, each transaction on the Cardano blockchain can also carry metadata, which can be used to include
 * additional information about the transaction, such as a description or a reference to a specific product or service.
 */
export class Transaction {
  #body: TransactionBody;
  #witnessSet: TransactionWitnessSet;
  #auxiliaryData: AuxiliaryData | undefined;
  // No public setter: authored transactions always carry true; decode and fromCore preserve it.
  #isValid = true;
  #frame = TxFrame.Alonzo;
  // If the transaction object is constructed from a CBOR byte array, we are going to remember it and use it
  // when the object is re-serialized again to avoid changing the transaction during a round trip serialization.
  // This cache will be invalidated if any of the transaction properties changes after the object has been deserialized.
  #originalBytes: TxCBOR | undefined = undefined;

  /**
   * Initializes a new instance of the Transaction class.
   *
   * @param body Data structure that contains all the elements of the transaction.
   * @param witnessSet Collection of digital signatures that are attached to a transaction to prove that it has been
   * authorized by the appropriate parties, the witness set also contain all required information to satisfy native or
   * plutus script execution requirements, such as Datums, Redeemers and the script itself.
   * @param auxiliaryData Additional information that can be attached to a transaction to provide more context or
   * information about the transaction.
   */
  constructor(
    body: TransactionBody,
    witnessSet: TransactionWitnessSet,
    auxiliaryData?: AuxiliaryData,
  ) {
    this.#body = body;
    this.#witnessSet = witnessSet;
    this.#auxiliaryData = auxiliaryData;
  }

  /**
   * Serializes a transaction into CBOR format.
   *
   * @returns The transaction in CBOR format.
   */
  toCbor(): TxCBOR {
    const writer = new CborWriter();

    if (this.#originalBytes) return this.#originalBytes;

    // CDDL
    // mempool_transaction =
    //   [transaction_body, transaction_witness_set, auxiliary_data / nil]
    //   / [transaction_body, transaction_witness_set, true, auxiliary_data / nil]
    //
    // block_transaction =
    //   [transaction_body, transaction_witness_set, auxiliary_data / nil, bool]
    //
    // is_valid is deprecated in the Dijkstra era; the 4-element grace-period frame is only
    // legal with the literal value true, which stays byte-compatible with Conway consumers.
    // A transaction decoded from a block keeps the block layout, with the flag last.
    writer.writeStartArray(this.#frame === TxFrame.Shelley ? 3 : 4);
    writer.writeEncodedValue(hexToBytes(this.#body.toCbor()));
    writer.writeEncodedValue(hexToBytes(this.#witnessSet.toCbor()));

    if (this.#frame === TxFrame.Alonzo) writer.writeBoolean(this.#isValid);

    if (this.#auxiliaryData) {
      writer.writeEncodedValue(hexToBytes(this.#auxiliaryData.toCbor()));
    } else {
      writer.writeNull();
    }

    if (this.#frame === TxFrame.Block) writer.writeBoolean(this.#isValid);

    return writer.encodeAsHex() as unknown as TxCBOR;
  }

  /**
   * Deserializes the transaction from a CBOR byte array.
   *
   * Accepts a transaction as it is submitted, with or without the is_valid flag before the auxiliary data, and as a
   * Dijkstra block carries it, with the flag after the auxiliary data. An edited transaction is written back in the
   * layout it was read in.
   *
   * @param cbor The CBOR encoded transaction object.
   * @param options Deserialization options forwarded to the body and witness set. See
   * {@link DeserializationOptions} for the checks `strict` adds.
   * @returns The new transaction instance.
   */
  static fromCbor(cbor: TxCBOR, options?: DeserializationOptions): Transaction {
    const reader = new CborReader(cbor as unknown as HexBlob);

    const length = reader.readStartArray();

    if (length !== null && length !== 3 && length !== 4)
      throw new SerializationError(
        SerializationFailure.InvalidType,
        `Transaction frame must be 3 or 4 elements, found ${length}`,
      );

    const bodyBytes = reader.readEncodedValue();
    const body = TransactionBody.fromCbor(
      HexBlob.fromBytes(bodyBytes),
      options,
    );

    const witnessSet = TransactionWitnessSet.fromCbor(
      HexBlob.fromBytes(reader.readEncodedValue()),
      options,
    );

    // The is_valid flag was added in Alonzo; Mary era transactions only have three fields.
    // Alonzo through Conway record false for phase-2 failed transactions, so decode is permissive.
    // A Dijkstra block moves the flag after the auxiliary data, which is never a boolean, so the
    // type of the third element tells the two 4-element layouts apart.
    let frame = TxFrame.Shelley;
    let isValid = true;
    if (length !== 3 && reader.peekState() === CborReaderState.Boolean) {
      frame = TxFrame.Alonzo;
      isValid = reader.readBoolean();
    }

    let auxData;
    if (reader.peekState() === CborReaderState.Null) {
      reader.readNull();
    } else {
      auxData = AuxiliaryData.fromCbor(
        HexBlob.fromBytes(reader.readEncodedValue()),
      );
    }

    if (
      frame === TxFrame.Shelley &&
      (length === 4 ||
        (length === null && reader.peekState() !== CborReaderState.EndArray))
    ) {
      frame = TxFrame.Block;
      isValid = reader.readBoolean();
    }

    if (length === null) reader.readEndArray();

    const tx = new Transaction(body, witnessSet, auxData);

    tx.#isValid = isValid;
    tx.#frame = frame;
    tx.#originalBytes = cbor;

    return tx;
  }

  /**
   * Creates a Core Tx object from the current Transaction object.
   *
   * @returns The Core Tx object.
   */
  toCore(): Cardano.Tx {
    const tx: Cardano.Tx = {
      body: this.#body.toCore(),
      id: this.getId(),
      isValid: this.#isValid,
      witness: this.#witnessSet.toCore(),
    };

    if (this.#auxiliaryData) {
      tx.auxiliaryData = this.#auxiliaryData.toCore();
    }

    return tx;
  }

  /**
   * Creates a transaction object from the given Core Tx object.
   *
   * @param tx The core TX object.
   */
  static fromCore(tx: Cardano.Tx) {
    const transaction = new Transaction(
      TransactionBody.fromCore(tx.body),
      TransactionWitnessSet.fromCore(tx.witness),
      tx.auxiliaryData ? AuxiliaryData.fromCore(tx.auxiliaryData) : undefined,
    );

    if (typeof tx.isValid !== 'undefined') transaction.#isValid = tx.isValid;

    return transaction;
  }

  /**
   * Data structure that contains all key elements of the transaction.
   *
   * @returns A deep clone of the transaction body.
   */
  body(): TransactionBody {
    return TransactionBody.fromCbor(this.#body.toCbor());
  }

  /**
   * Sets the transaction body.
   *
   * @param body The transaction body.
   */
  setBody(body: TransactionBody) {
    this.#body = body;
    this.#originalBytes = undefined;
  }

  /**
   * Collection of digital signatures that are attached to a transaction to prove that it has been authorized by the
   * appropriate parties, the witness set also contain all required information to satisfy native or plutus script
   * execution requirements, such as Datums, Redeemers and the script itself.
   *
   * @returns A deep clone of the transaction witness set.
   */
  witnessSet(): TransactionWitnessSet {
    return TransactionWitnessSet.fromCbor(this.#witnessSet.toCbor());
  }

  /**
   * Sets the witness set of the transaction.
   *
   * @param witnessSet A deep clone of the witness set in this transaction.
   */
  setWitnessSet(witnessSet: TransactionWitnessSet) {
    this.#witnessSet = witnessSet;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the transaction is_valid flag.
   *
   * The flag is deprecated in the Dijkstra era; it has no setter and authored transactions
   * always carry true. Transactions decoded from chain data surface the on-chain value, and a
   * transaction encoded without the flag is valid.
   *
   * @returns The is_valid flag.
   */
  isValid(): boolean {
    return this.#isValid;
  }

  /**
   * Gets the transaction Auxiliary data.
   *
   * @returns A clone of the transaction Auxiliary data (or undefined if the transaction doesnt have auxiliary data).
   */
  auxiliaryData(): AuxiliaryData | undefined {
    if (this.#auxiliaryData) {
      return AuxiliaryData.fromCbor(this.#auxiliaryData.toCbor());
    }

    return undefined;
  }

  /**
   * Sets the transaction auxiliary data.
   *
   * The auxiliary is additional information that can be attached to a transaction to provide more context or
   * information about the transaction.
   *
   * @param auxiliaryData The auxiliary data to be set.
   */
  setAuxiliaryData(auxiliaryData: AuxiliaryData | undefined) {
    this.#auxiliaryData = auxiliaryData;
    this.#originalBytes = undefined;
  }

  /** Computes the transaction id for this transaction. */
  getId(): Cardano.TransactionId {
    return this.#body.hash();
  }

  /** Performs a deep clone of the transaction object. */
  clone(): Transaction {
    const bytes = this.toCbor();
    return Transaction.fromCbor(bytes);
  }
}

/**
 * @param tx Serialized as CBOR, encoded as hex string
 * @throws InvalidStringError
 */
export const TxCBOR = (tx: string): TxCBOR => HexBlob(tx) as unknown as TxCBOR;

/** Serialize transaction to hex-encoded CBOR */
TxCBOR.serialize = (tx: Cardano.Tx): TxCBOR =>
  Transaction.fromCore(tx).toCbor() as unknown as TxCBOR;

/**
 * @param tx Serialized as CBOR, encoded as hex string
 * @throws InvalidStringError
 */
export const TxBodyCBOR = (tx: string): TxBodyCBOR =>
  HexBlob(tx) as unknown as TxBodyCBOR;

/** Extract transaction body CBOR without re-serializing */
TxBodyCBOR.fromTxCBOR = (txCbor: TxCBOR) =>
  Transaction.fromCbor(txCbor).body().toCbor() as unknown as TxBodyCBOR;

export const deserializeTx = ((txBody: Buffer | Uint8Array | string) => {
  const hex =
    txBody instanceof Buffer
      ? txBody.toString('hex')
      : txBody instanceof Uint8Array
      ? Buffer.from(txBody).toString('hex')
      : txBody;

  const transaction = Transaction.fromCbor(TxCBOR(hex));
  return transaction.toCore();
}) as (
  txBody: Buffer | HexBlob | Uint8Array | string,
) => Cardano.Tx<Cardano.TxBody>;

/** Deserialize transaction from hex-encoded CBOR */
TxCBOR.deserialize = (tx: TxCBOR): Cardano.Tx => deserializeTx(tx);
