import { Serialization } from '@lace-lib/cardano-core';

import { withCarriedScripts } from './signingScripts';
import { stubSignTransaction } from './stubSignTransaction';

import type { Cip30SignDataRequest } from '../cip8';
import type {
  AsyncKeyAgent,
  SignSubTransactionOptions,
  SignTransactionContext,
  SignTransactionOptions,
  WitnessOptions,
  WitnessedSubTransaction,
  WitnessedTx,
  Witnesser,
} from '../types';
import type { Cardano } from '@lace-lib/cardano-core';
import type { Cip30DataSignature } from '@lace-lib/cardano-dapp-connector';
import type { HexBlob } from '@lace-lib/cardano-util';

/**
 * Sets a transaction's vkey witnesses and keeps every other byte it was
 * decoded with, so the body and auxiliary data still match the signatures.
 *
 * @param tx - The transaction to witness.
 * @param signatures - The vkey witnesses to carry, by public key.
 * @returns The transaction CBOR with those witnesses.
 */
const withSignatures = (
  tx: Serialization.Transaction,
  signatures: Cardano.Signatures,
): Serialization.TxCBOR => {
  const signed = Serialization.Transaction.fromCbor(tx.toCbor());
  const witnessSet = signed.witnessSet();
  witnessSet.setVkeys(
    Serialization.CborSet.fromCore(
      [...signatures],
      Serialization.VkeyWitness.fromCore,
    ),
  );
  signed.setWitnessSet(witnessSet);
  return signed.toCbor();
};

/**
 * Adds vkey witnesses to a sub transaction, keeping those it already carries
 * and every other byte it was given in, so its body, and so its id, still
 * match the signatures.
 *
 * @param subTransaction - The sub transaction to witness.
 * @param signatures - The vkey witnesses to add, by public key.
 * @returns The sub transaction CBOR with those witnesses.
 */
const withSubTransactionSignatures = (
  subTransaction: Serialization.SubTransaction,
  signatures: Cardano.Signatures,
): HexBlob => {
  const signed = Serialization.SubTransaction.fromCbor(subTransaction.toCbor());
  const witnessSet = signed.witnessSet();
  const vkeys = witnessSet.vkeys();
  const carried = new Set(vkeys?.toCore().map(([publicKey]) => publicKey));
  const added = [...signatures]
    .filter(([publicKey]) => !carried.has(publicKey))
    .map(signature => Serialization.VkeyWitness.fromCore(signature));
  if (added.length === 0) return signed.toCbor();
  if (vkeys) {
    vkeys.setValues([...vkeys.values(), ...added]);
    witnessSet.setVkeys(vkeys);
  } else {
    witnessSet.setVkeys(
      Serialization.CborSet.fromCore(
        added.map(witness => witness.toCore()),
        Serialization.VkeyWitness.fromCore,
      ),
    );
  }
  signed.setWitnessSet(witnessSet);
  return signed.toCbor();
};

/** A witnesser that uses a {@link KeyAgent} to generate witness data for a transaction. */
export class Bip32Ed25519Witnesser implements Witnesser {
  #keyAgent: AsyncKeyAgent;

  constructor(keyAgent: AsyncKeyAgent) {
    this.#keyAgent = keyAgent;
  }

  /**
   * Signs a transaction with the own keys its body needs and the keys
   * required by the native scripts it needs that it carries in its witness
   * set, its sub transactions carry, or the context passes, each signed
   * once. With `stubSign` it adds placeholder witnesses for the same keys
   * instead, to size the transaction.
   *
   * @param tx The transaction to witness.
   * @param context The signing context.
   * @param options Additional key paths, extra signers and stub signing.
   * @returns The transaction with its vkey witnesses.
   */
  async witness(
    tx: Serialization.Transaction,
    context: SignTransactionContext,
    options?: WitnessOptions,
  ): Promise<WitnessedTx> {
    const coreTx = tx.toCore();
    const hash = tx.getId();
    const signingContext = withCarriedScripts(context, coreTx.witness.scripts);
    const signatures =
      options?.stubSign !== undefined && options.stubSign
        ? await stubSignTransaction({
            context: signingContext,
            signTransactionOptions: options,
            txBody: coreTx.body,
          })
        : await Bip32Ed25519Witnesser.getSignatures(
            this.#keyAgent,
            tx.body(),
            signingContext,
            options,
          );

    const transaction = {
      auxiliaryData: coreTx.auxiliaryData,
      body: coreTx.body,
      id: hash,
      isValid: tx.isValid(),
      witness: {
        ...coreTx.witness,
        signatures: new Map([
          ...signatures.entries(),
          ...(coreTx.witness?.signatures?.entries() || []),
        ]),
      },
    };

    return {
      cbor: withSignatures(tx, transaction.witness.signatures),
      context: {
        handleResolutions: context.handleResolutions ?? [],
      },
      tx: transaction,
    };
  }

  async witnessSubTransaction(
    subTransaction: Serialization.SubTransaction,
    context: SignTransactionContext,
    options?: SignSubTransactionOptions,
  ): Promise<WitnessedSubTransaction> {
    const signatures = await this.#keyAgent.signSubTransaction(
      subTransaction,
      context,
      options,
    );

    return {
      cbor: withSubTransactionSignatures(subTransaction, signatures),
      id: subTransaction.getId(),
    };
  }

  async signData(props: Cip30SignDataRequest): Promise<Cip30DataSignature> {
    return this.#keyAgent.signCip8Data(props);
  }

  static async getSignatures(
    keyAgent: AsyncKeyAgent,
    txBody: Serialization.TransactionBody,
    context: SignTransactionContext,
    options?: SignTransactionOptions,
  ): Promise<Cardano.Signatures> {
    const signatures = await keyAgent.signTransaction(txBody, context, options);

    if (options?.extraSigners) {
      for (const extraSigner of options?.extraSigners) {
        const extraSignature = await extraSigner.sign(txBody);
        signatures.set(extraSignature.pubKey, extraSignature.signature);
      }
    }
    return signatures;
  }
}

export const createBip32Ed25519Witnesser = (
  keyAgent: AsyncKeyAgent,
): Bip32Ed25519Witnesser => new Bip32Ed25519Witnesser(keyAgent);
