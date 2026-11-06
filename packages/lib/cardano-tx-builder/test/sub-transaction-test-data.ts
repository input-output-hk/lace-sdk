import { Cardano, Serialization } from '@lace-lib/cardano-core';
import * as Crypto from '@lace-lib/cardano-crypto';
import { HexBlob } from '@lace-lib/cardano-util';

/** The key that signs the sub transactions {@link signedSubTransaction} writes. */
const SIGNING_KEY = Crypto.Ed25519PrivateKey.fromNormalHex(
  Crypto.Ed25519PrivateNormalKeyHex('9b'.repeat(32)),
);

/** A sub transaction written as CBOR, with the id and the key that signed it. */
export interface SignedSubTransaction {
  cbor: HexBlob;
  id: Cardano.TransactionId;
  publicKey: Crypto.Ed25519PublicKey;
}

/**
 * Writes a sub transaction that spends `spent` into one output and signs its
 * id. Its input set, output and vkey witness set are written in the legacy
 * forms, untagged arrays and an array output, which decode fine but which
 * writing the sub transaction again from its core form changes.
 *
 * @param spent - The input the sub transaction spends.
 * @param output - The output it produces, with no assets, datum or script.
 * @returns The signed sub transaction.
 */
export const signedSubTransaction = async (
  spent: Cardano.TxIn,
  output: Cardano.TxOut,
): Promise<SignedSubTransaction> => {
  await Crypto.ready();
  const body = new Serialization.CborWriter();
  body.writeStartMap(2);
  body.writeInt(0n);
  body.writeStartArray(1);
  body.writeStartArray(2);
  body.writeByteString(Buffer.from(spent.txId, 'hex'));
  body.writeInt(BigInt(spent.index));
  body.writeInt(1n);
  body.writeStartArray(1);
  body.writeStartArray(2);
  body.writeByteString(
    Buffer.from(Cardano.Address.fromBech32(output.address).toBytes(), 'hex'),
  );
  body.writeInt(output.value.coins);
  const bodyCbor = body.encodeAsHex();

  const id = Crypto.blake2b.hash<Cardano.TransactionId>(bodyCbor, 32);
  const publicKey = SIGNING_KEY.toPublic();
  const signature = SIGNING_KEY.sign(HexBlob(id));

  const subTransaction = new Serialization.CborWriter();
  subTransaction.writeStartArray(3);
  subTransaction.writeEncodedValue(Buffer.from(bodyCbor, 'hex'));
  subTransaction.writeStartMap(1);
  subTransaction.writeInt(0n);
  subTransaction.writeStartArray(1);
  subTransaction.writeStartArray(2);
  subTransaction.writeByteString(publicKey.bytes());
  subTransaction.writeByteString(signature.bytes());
  subTransaction.writeNull();

  return { cbor: subTransaction.encodeAsHex(), id, publicKey };
};
