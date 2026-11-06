import * as Crypto from '@lace-lib/cardano-crypto';
import uniqBy from 'lodash/uniqBy.js';

import { cip30signData } from './cip8';
import { emip3decrypt, emip3encrypt } from './emip3';
import * as errors from './errors';
import { KeyAgentBase } from './KeyAgentBase';
import { KeyAgentType, KeyPurpose } from './types';
import {
  DREP_KEY_DERIVATION_PATH,
  deriveAccountPrivateKey,
  harden,
  joinMnemonicWords,
  mnemonicWordsToEntropy,
  ownSignatureKeyPaths,
  validateMnemonic,
} from './util';
import { signingScripts } from './util/signingScripts';

import type { Cip8SignDataContext } from './cip8';
import type {
  AccountKeyDerivationPath,
  GetPassphrase,
  KeyAgent,
  KeyAgentDependencies,
  KeyPair,
  PassphraseEncryption,
  SerializableInMemoryKeyAgentData,
  SignBlobResult,
  SignSubTransactionOptions,
  SignTransactionContext,
  SignTransactionOptions,
} from './types';
import type { SignableTxBody } from './util';
import type { Cardano, Serialization } from '@lace-lib/cardano-core';
import type { Cip30DataSignature } from '@lace-lib/cardano-dapp-connector';
import type { HexBlob } from '@lace-lib/cardano-util';

const defaultRootPrivateKeyEncryption: PassphraseEncryption = {
  decrypt: emip3decrypt,
  encrypt: emip3encrypt,
};

export interface InMemoryKeyAgentProps
  extends Omit<SerializableInMemoryKeyAgentData, '__typename'> {
  getPassphrase: GetPassphrase;
}

export interface FromBip39MnemonicWordsProps {
  chainId: Cardano.ChainId;
  mnemonicWords: string[];
  mnemonic2ndFactorPassphrase?: string;
  getPassphrase: GetPassphrase;
  accountIndex?: number;
  purpose?: KeyPurpose;
}

const getPassphraseRethrowTypedError = async (getPassphrase: GetPassphrase) => {
  try {
    return await getPassphrase();
  } catch (error) {
    throw new errors.AuthenticationError('Failed to enter passphrase', error);
  }
};

export class InMemoryKeyAgent extends KeyAgentBase implements KeyAgent {
  readonly #getPassphrase: GetPassphrase;
  readonly #rootPrivateKeyEncryption: PassphraseEncryption;

  constructor(
    { getPassphrase, ...serializableData }: InMemoryKeyAgentProps,
    dependencies: KeyAgentDependencies,
  ) {
    super(
      { ...serializableData, __typename: KeyAgentType.InMemory },
      dependencies,
    );
    this.#getPassphrase = getPassphrase;
    this.#rootPrivateKeyEncryption =
      dependencies.rootPrivateKeyEncryption ?? defaultRootPrivateKeyEncryption;
  }

  async signBlob(
    { index, role: type }: AccountKeyDerivationPath,
    blob: HexBlob,
  ): Promise<SignBlobResult> {
    const rootPrivateKey = await this.#decryptRootPrivateKey();
    const accountKey = await deriveAccountPrivateKey({
      accountIndex: this.accountIndex,
      bip32Ed25519: this.bip32Ed25519,
      purpose: this.purpose,
      rootPrivateKey,
    });

    const bip32SigningKey = this.bip32Ed25519.derivePrivateKey(accountKey, [
      type,
      index,
    ]);
    const signingKey = this.bip32Ed25519.getRawPrivateKey(bip32SigningKey);
    const signature = this.bip32Ed25519.sign(signingKey, blob);
    const publicKey = this.bip32Ed25519.getPublicKey(signingKey);

    return { publicKey, signature };
  }

  async signCip8Data(
    context: Cip8SignDataContext,
  ): Promise<Cip30DataSignature> {
    return await cip30signData(this, context);
  }

  // To export mnemonic, get entropy by reversing this:

  // rootPrivateKey = CML.Bip32PrivateKey.from_bip39_entropy(entropy, EMPTY_PASSPHRASE);

  // https://github.com/Emurgo/cardano-serialization-lib/blob/f817a033ade7a2255591d7c6444fa4f9ffbcf061/rust/src/chain_crypto/derive.rs#L30-L38
  async exportRootPrivateKey(): Promise<Crypto.Bip32PrivateKeyHex> {
    return await this.#decryptRootPrivateKey(true);
  }

  /**
   * @throws AuthenticationError
   */
  static async fromBip39MnemonicWords(
    {
      chainId,
      getPassphrase,
      mnemonicWords,
      mnemonic2ndFactorPassphrase = '',
      accountIndex = 0,
      purpose = KeyPurpose.STANDARD,
    }: FromBip39MnemonicWordsProps,
    dependencies: KeyAgentDependencies,
  ): Promise<InMemoryKeyAgent> {
    const mnemonic = joinMnemonicWords(mnemonicWords);
    const validMnemonic = validateMnemonic(mnemonic);
    if (!validMnemonic) throw new errors.InvalidMnemonicError();
    const entropy = Buffer.from(mnemonicWordsToEntropy(mnemonicWords), 'hex');
    const rootPrivateKey = dependencies.bip32Ed25519.fromBip39Entropy(
      entropy,
      mnemonic2ndFactorPassphrase,
    );
    const passphrase = await getPassphraseRethrowTypedError(getPassphrase);
    const rootPrivateKeyEncryption =
      dependencies.rootPrivateKeyEncryption ?? defaultRootPrivateKeyEncryption;
    const encryptedRootPrivateKey = await rootPrivateKeyEncryption.encrypt(
      Buffer.from(rootPrivateKey, 'hex'),
      passphrase,
    );
    const accountPrivateKey = await deriveAccountPrivateKey({
      accountIndex,
      bip32Ed25519: dependencies.bip32Ed25519,
      purpose,
      rootPrivateKey,
    });

    const extendedAccountPublicKey =
      await dependencies.bip32Ed25519.getBip32PublicKey(accountPrivateKey);

    return new InMemoryKeyAgent(
      {
        accountIndex,
        chainId,
        encryptedRootPrivateKeyBytes: [...encryptedRootPrivateKey],
        extendedAccountPublicKey,
        getPassphrase,
        purpose,
      },
      dependencies,
    );
  }

  async signTransaction(
    txBody: Serialization.TransactionBody,
    context: SignTransactionContext,
    { additionalKeyPaths = [] }: SignTransactionOptions = {},
  ): Promise<Cardano.Signatures> {
    // Possible optimization is casting strings to OpaqueString types directly and skipping validation
    const blob = txBody.hash() as unknown as HexBlob;
    return this.#signWithOwnKeys(
      blob,
      txBody.toCore(),
      context,
      context.scripts,
      additionalKeyPaths,
    );
  }

  /**
   * Signs the id of a sub transaction, the hash of its body, with the own
   * keys its body needs and the keys required by the native scripts in its
   * witness set or the context. Native scripts read from reference inputs
   * are not seen; callers pass them through `context.scripts`. Its bytes
   * stay as they were.
   *
   * @param subTransaction The sub transaction to sign.
   * @param context The signing context.
   * @param options Additional key paths to sign with.
   * @returns The signatures by public key.
   */
  async signSubTransaction(
    subTransaction: Serialization.SubTransaction,
    context: SignTransactionContext,
    { additionalKeyPaths = [] }: SignSubTransactionOptions = {},
  ): Promise<Cardano.Signatures> {
    const blob = subTransaction.getId() as unknown as HexBlob;
    const { body, witness } = subTransaction.toCore();
    return this.#signWithOwnKeys(
      blob,
      body,
      context,
      signingScripts(context.scripts, witness.scripts),
      additionalKeyPaths,
    );
  }

  /**
   * Signs a blob with every own key a transaction or sub transaction body
   * needs and with the additional key paths.
   *
   * @param blob The id to sign.
   * @param body The body whose own signers are looked up.
   * @param context The signing context.
   * @param scripts The native scripts whose required keys are looked up.
   * @param additionalKeyPaths Key paths to sign with besides the body's.
   * @returns The signatures by public key.
   */
  async #signWithOwnKeys(
    blob: HexBlob,
    body: SignableTxBody,
    {
      txInKeyPathMap,
      knownAddresses,
      spentOutputAddresses,
    }: SignTransactionContext,
    scripts: Cardano.Script[] | undefined,
    additionalKeyPaths: AccountKeyDerivationPath[],
  ): Promise<Cardano.Signatures> {
    const dRepKeyHash = (
      await Crypto.Ed25519PublicKey.fromHex(
        await this.derivePublicKey(DREP_KEY_DERIVATION_PATH),
      ).hash()
    ).hex();
    const derivationPaths = ownSignatureKeyPaths(
      body,
      knownAddresses,
      txInKeyPathMap,
      dRepKeyHash,
      scripts,
      spentOutputAddresses,
    );
    const keyPaths = uniqBy(
      [...derivationPaths, ...additionalKeyPaths],
      ({ role, index }) => `${role}.${index}`,
    );
    // TODO:
    // if (keyPaths.length === 0) {
    //   throw new ProofGenerationError();
    // }
    return new Map<Crypto.Ed25519PublicKeyHex, Crypto.Ed25519SignatureHex>(
      await Promise.all(
        keyPaths.map(async ({ role, index }) => {
          const { publicKey, signature } = await this.signBlob(
            { index, role },
            blob,
          );
          return [publicKey, signature] as const;
        }),
      ),
    );
  }

  /** Based on root private key */
  async exportExtendedKeyPair(derivationPath: number[]): Promise<KeyPair> {
    const rootPrivateKey = await this.exportRootPrivateKey();
    const hardenedIndices = derivationPath.map((index: number) =>
      harden(index),
    );
    const childKey = await this.bip32Ed25519.derivePrivateKey(
      rootPrivateKey,
      hardenedIndices,
    );

    return {
      skey: childKey,
      vkey: this.bip32Ed25519.getBip32PublicKey(childKey),
    };
  }

  async #decryptRootPrivateKey(noCache?: true) {
    const passphrase = await getPassphraseRethrowTypedError(() =>
      this.#getPassphrase(noCache),
    );
    let decryptedRootKeyBytes: Uint8Array;

    try {
      decryptedRootKeyBytes = await this.#rootPrivateKeyEncryption.decrypt(
        new Uint8Array(
          (
            this.serializableData as SerializableInMemoryKeyAgentData
          ).encryptedRootPrivateKeyBytes,
        ),
        passphrase,
      );
    } catch (error) {
      throw new errors.AuthenticationError(
        'Failed to decrypt root private key',
        error,
      );
    }
    return Crypto.Bip32PrivateKeyHex(
      Buffer.from(decryptedRootKeyBytes).toString('hex'),
    );
  }
}
