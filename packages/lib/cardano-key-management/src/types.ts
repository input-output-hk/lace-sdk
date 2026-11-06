import { HD_WALLET_CIP_ID, MULTISIG_CIP_ID } from '@lace-lib/cardano-core';

import type { Cip30SignDataRequest, Cip8SignDataContext } from './cip8';
import type {
  Cardano,
  HandleResolution,
  Serialization,
} from '@lace-lib/cardano-core';
import type * as Crypto from '@lace-lib/cardano-crypto';
import type { Cip30DataSignature } from '@lace-lib/cardano-dapp-connector';
import type { HexBlob, OpaqueString, Shutdown } from '@lace-lib/cardano-util';
import type { Logger } from 'ts-log';
import type { Runtime } from 'webextension-polyfill';
export type MessageSender = Runtime.MessageSender;

export interface SignBlobResult {
  publicKey: Crypto.Ed25519PublicKeyHex;
  signature: Crypto.Ed25519SignatureHex;
}

export enum CardanoKeyConst {
  PURPOSE = 1852,
  COIN_TYPE = 1815,
}

export enum Cip1852PathLevelIndexes {
  PURPOSE = 0,
  COIN_TYPE = 1,
  ACCOUNT = 2,
  ROLE = 3,
  // address
  INDEX = 4,
}

export enum KeyAgentType {
  InMemory = 'InMemory',
  Ledger = 'Ledger',
  Trezor = 'Trezor',
}

export enum KeyRole {
  External = 0,
  Internal = 1,
  Stake = 2,
  DRep = 3,
}

export enum KeyPurpose {
  STANDARD = HD_WALLET_CIP_ID,
  MULTI_SIG = MULTISIG_CIP_ID,
}

/** Master key generation algorithms supported by Trezor devices */
export type MasterKeyGeneration = 'ICARUS_TREZOR' | 'ICARUS' | 'LEDGER';

export interface AccountKeyDerivationPath {
  role: KeyRole;
  index: number;
}
/** Internal = change address & External = receipt address */
export enum AddressType {
  /** Change address */
  Internal = 1,
  /** Receipt address */
  External = 0,
}

export enum DeviceType {
  Ledger = 'Ledger',
}

export enum CommunicationType {
  Web = 'web',
  Node = 'node',
}

/**
 * Pluggable passphrase-based encryption for secrets at rest (e.g. the root
 * private key). `encrypt` and `decrypt` are inverses for a given passphrase.
 * Defaults to EMIP-003 when not provided to a key agent.
 */
export interface PassphraseEncryption {
  encrypt: (data: Uint8Array, passphrase: Uint8Array) => Promise<Uint8Array>;
  decrypt: (
    encrypted: Uint8Array,
    passphrase: Uint8Array,
  ) => Promise<Uint8Array>;
}

export interface KeyAgentDependencies {
  logger: Logger;
  bip32Ed25519: Crypto.Bip32Ed25519;
  /** Overrides root private key encryption at rest. Defaults to EMIP-003. */
  rootPrivateKeyEncryption?: PassphraseEncryption;
}

export interface AccountAddressDerivationPath {
  type: AddressType;
  index: number;
}

export interface GroupedAddress {
  type: AddressType;
  index: number;
  networkId: Cardano.NetworkId;
  accountIndex: number;
  address: Cardano.PaymentAddress;
  rewardAccount: Cardano.RewardAccount;
  stakeKeyDerivationPath?: AccountKeyDerivationPath;
}

export interface TrezorConfig {
  communicationType: CommunicationType;
  silentMode?: boolean;
  lazyLoad?: boolean;
  manifest: {
    email: string;
    appUrl: string;
  };
  /** When set to true, Trezor automatically handle passphrase entry by forcing it to occur on the device */
  shouldHandlePassphrase?: boolean;
  /** Master key generation algorithm to use. Defaults to Trezor's default if not specified */
  derivationType?: MasterKeyGeneration;
}

export interface SerializableKeyAgentDataBase {
  chainId: Cardano.ChainId;
  accountIndex: number;
  extendedAccountPublicKey: Crypto.Bip32PublicKeyHex;
  purpose?: KeyPurpose;
}

export interface SerializableInMemoryKeyAgentData
  extends SerializableKeyAgentDataBase {
  __typename: KeyAgentType.InMemory;
  encryptedRootPrivateKeyBytes: number[];
}

export interface SerializableLedgerKeyAgentData
  extends SerializableKeyAgentDataBase {
  __typename: KeyAgentType.Ledger;
  communicationType: CommunicationType;
}

export interface SerializableTrezorKeyAgentData
  extends SerializableKeyAgentDataBase {
  __typename: KeyAgentType.Trezor;
  trezorConfig: TrezorConfig;
}

export type SerializableKeyAgentData =
  | SerializableInMemoryKeyAgentData
  | SerializableLedgerKeyAgentData
  | SerializableTrezorKeyAgentData;

export interface KeyPair {
  skey: Crypto.Bip32PrivateKeyHex;
  vkey: Crypto.Bip32PublicKeyHex;
}

export interface Ed25519KeyPair {
  skey: Crypto.Ed25519PrivateExtendedKeyHex | Crypto.Ed25519PrivateNormalKeyHex;
  vkey: Crypto.Ed25519PublicKeyHex;
}

/**
 * @returns passphrase used to decrypt root private key
 */
export type GetPassphrase = (noCache?: true) => Promise<Uint8Array>;

export type TxInId = OpaqueString<'TxInId'>;
export const TxInId = ({ txId, index }: Cardano.TxIn) =>
  `${txId}_${index}` as TxInId;

export type TxInKeyPathMap = Partial<Record<TxInId, AccountKeyDerivationPath>>;

/** The address of the output each input spends, by input. */
export type SpentOutputAddressMap = Partial<
  Record<TxInId, Cardano.PaymentAddress>
>;
export type RewardAccountKeyPathMap = Partial<
  Record<Cardano.RewardAccount, AccountKeyDerivationPath>
>;
export type KeyHashKeyPathMap = Partial<
  Record<Crypto.Ed25519KeyHashHex, AccountKeyDerivationPath>
>;

/** The result of the transaction signer signing operation. */
export type TransactionSignerResult = {
  /** The public key matching the private key that generate the signature. */
  pubKey: Crypto.Ed25519PublicKeyHex;

  /** The transaction signature. */
  signature: Crypto.Ed25519SignatureHex;
};

/** Produces a Ed25519Signature of a transaction. */
export interface TransactionSigner {
  /**
   * Sings a transaction.
   *
   * @param txBody The transaction to be signed.
   * @returns A Ed25519 transaction signature.
   */
  sign(txBody: Serialization.TransactionBody): Promise<TransactionSignerResult>;
}

export interface SignTransactionOptions {
  additionalKeyPaths?: AccountKeyDerivationPath[];
  extraSigners?: TransactionSigner[];
  stubSign?: boolean;
}

/** Options for signing a sub transaction. */
export interface SignSubTransactionOptions {
  /** Key paths to sign with besides the ones the sub transaction body needs. */
  additionalKeyPaths?: AccountKeyDerivationPath[];
}

export interface SignTransactionContext {
  txInKeyPathMap: TxInKeyPathMap;
  knownAddresses: GroupedAddress[];
  handleResolutions?: HandleResolution[];
  dRepKeyHashHex?: Crypto.Ed25519KeyHashHex;
  sender?: MessageSender;
  /**
   * Scripts whose required keys the signer signs with, such as native scripts
   * read from reference inputs. Witnessers also consider the native scripts the
   * transaction or sub transaction carries in its witness set, so a script
   * passed here and carried as well is signed for once. A native script counts
   * only when the body needs it: it locks an input the body spends, or its
   * hash names a withdrawal, certificate, voter or guard credential, a minting
   * policy, or a guard a sub transaction requires of the top level. While the
   * body spends an input in neither `txInKeyPathMap` nor
   * `spentOutputAddresses`, any script may lock it, so every one counts.
   */
  scripts?: Cardano.Script[];
  /**
   * The address of the output each input spends, which tells the native
   * script that locks it. `util.createSpentOutputAddresses` builds it.
   */
  spentOutputAddresses?: SpentOutputAddressMap;
}

export type SignDataContext = Cip8SignDataContext & { sender?: MessageSender };

export interface KeyAgent {
  get chainId(): Cardano.ChainId;
  get accountIndex(): number;
  get serializableData(): SerializableKeyAgentData;
  get extendedAccountPublicKey(): Crypto.Bip32PublicKeyHex;
  get bip32Ed25519(): Crypto.Bip32Ed25519;
  get purpose(): KeyPurpose | undefined;

  /**
   * @throws AuthenticationError
   */
  signBlob(
    derivationPath: AccountKeyDerivationPath,
    blob: HexBlob,
  ): Promise<SignBlobResult>;

  /**
   * @throws AuthenticationError
   */
  signCip8Data(request: Cip8SignDataContext): Promise<Cip30DataSignature>;

  /**
   * Signs a transaction body with the own keys it needs and the keys required
   * by the native scripts it needs in `context.scripts` or in the witness sets
   * of its sub transactions. A body does not carry its own witness set, so
   * callers holding the whole transaction pass its native scripts there, as
   * {@link Witnesser.witness} does.
   *
   * @param txBody The transaction body to sign.
   * @param context The signing context.
   * @param options Additional key paths and extra signers.
   * @returns The signatures by public key.
   * @throws AuthenticationError
   */
  signTransaction(
    txBody: Serialization.TransactionBody,
    context: SignTransactionContext,
    options?: SignTransactionOptions,
  ): Promise<Cardano.Signatures>;

  /**
   * Signs the id of a sub transaction (CIP-0118 nested transactions), the
   * hash of its body, with the own keys its body needs: those of the inputs
   * it spends, withdrawals, certificates, votes, required signers and key
   * hash guards, and of the native scripts in its witness set or the
   * context. Native scripts read from reference inputs are not seen;
   * callers pass them through `context.scripts`. The enclosing transaction
   * carries a sub transaction byte for byte, so its parties sign it before
   * it is batched.
   *
   * @param subTransaction The sub transaction to sign.
   * @param context The signing context, with the key paths of the inputs the
   *   sub transaction spends.
   * @param options Additional key paths to sign with.
   * @returns The signatures by public key.
   * @throws AuthenticationError
   * @throws NotImplementedError If the key agent cannot sign sub
   *   transactions, as hardware devices cannot.
   */
  signSubTransaction(
    subTransaction: Serialization.SubTransaction,
    context: SignTransactionContext,
    options?: SignSubTransactionOptions,
  ): Promise<Cardano.Signatures>;
  /**
   * @throws AuthenticationError
   */
  derivePublicKey(
    derivationPath: AccountKeyDerivationPath,
  ): Promise<Crypto.Ed25519PublicKeyHex>;

  /**
   * Derives an address from the given payment key and stake key derivation path.
   *
   * @param paymentKeyDerivationPath The payment key derivation path.
   * @param stakeKeyDerivationIndex The stake key index. This field is optional. If not provided it defaults to index 0.
   * @param pure If set to true, the key agent will derive a new address without mutating its internal state.
   */
  deriveAddress(
    paymentKeyDerivationPath: AccountAddressDerivationPath,
    stakeKeyDerivationIndex: number,
  ): Promise<GroupedAddress>;
  /**
   * @throws AuthenticationError
   */
  exportRootPrivateKey(): Promise<Crypto.Bip32PrivateKeyHex>;
}

export type AsyncKeyAgent = Pick<
  KeyAgent,
  | 'deriveAddress'
  | 'derivePublicKey'
  | 'signBlob'
  | 'signCip8Data'
  | 'signSubTransaction'
  | 'signTransaction'
> &
  Shutdown & {
    getChainId(): Promise<Cardano.ChainId>;
    getBip32Ed25519(): Promise<Crypto.Bip32Ed25519>;
    getExtendedAccountPublicKey(): Promise<Crypto.Bip32PublicKeyHex>;
    getAccountIndex(): Promise<number>;
  };

export type WitnessOptions = SignTransactionOptions;

export interface WitnessedTx {
  cbor: Serialization.TxCBOR;
  tx: Cardano.Tx;
  context: {
    handleResolutions: HandleResolution[];
  };
}

/** A sub transaction with the vkey witnesses of its signers. */
export interface WitnessedSubTransaction {
  /** The sub transaction CBOR, its body bytes as they were given. */
  cbor: HexBlob;
  /** The sub transaction id, the hash of its body, that the witnesses sign. */
  id: Cardano.TransactionId;
}

/** Interface for an entity capable of generating witness data for a transaction. */
export interface Witnesser {
  /**
   * Generates the witness data for a given transaction, signing for the
   * native scripts it carries in its witness set as well as those in
   * `context.scripts`, each key once.
   *
   * @param transaction The transaction along with its hash for which the witness data is to be generated.
   * @param context The witness sign transaction context
   * @param options Optional additional parameters that may influence how the witness data is generated.
   * @returns A promise that resolves to the transaction with the generated witness data.
   */
  witness(
    transaction: Serialization.Transaction,
    context: SignTransactionContext,
    options?: WitnessOptions,
  ): Promise<WitnessedTx>;

  /**
   * Signs a sub transaction (CIP-0118 nested transactions) and adds the
   * signatures to the vkey witnesses it already carries, such as those of
   * other parties. Its body bytes, and so its id, stay as they were.
   *
   * A sub transaction must be signed before it is batched: the enclosing
   * transaction carries it byte for byte, so signing it afterwards would
   * change the batch.
   *
   * @param subTransaction The sub transaction to sign.
   * @param context The witness sign transaction context, with the key paths
   *   of the inputs the sub transaction spends.
   * @param options Additional key paths to sign with.
   * @returns A promise that resolves to the signed sub transaction.
   * @throws NotImplementedError If the key agent cannot sign sub
   *   transactions, as hardware devices cannot.
   */
  witnessSubTransaction(
    subTransaction: Serialization.SubTransaction,
    context: SignTransactionContext,
    options?: SignSubTransactionOptions,
  ): Promise<WitnessedSubTransaction>;

  /**
   * @throws AuthenticationError
   */
  signData(props: Cip30SignDataRequest): Promise<Cip30DataSignature>;
}
