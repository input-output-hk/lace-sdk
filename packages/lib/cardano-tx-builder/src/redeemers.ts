import { Cardano, Serialization } from '@lace-lib/cardano-core';

import { compareTxIns } from './serialization';

import type * as Crypto from '@lace-lib/cardano-crypto';

/**
 * Thrown when the transaction runs a Plutus script for a purpose, such as
 * spending an input at the script's address, but carries no redeemer for
 * that purpose. The ledger refuses such a transaction.
 */
export class MissingRedeemerError extends Error {
  public constructor(
    purpose: Cardano.RedeemerPurpose,
    index: number,
    scriptHash: string,
  ) {
    super(
      `The ${purpose} purpose at index ${index} needs a redeemer for the Plutus script ${scriptHash}, but the transaction carries none`,
    );
    this.name = 'MissingRedeemerError';
  }
}

/**
 * Thrown when the transaction carries a redeemer for a purpose, such as
 * spending an input at a script's address, whose script is not a Plutus
 * script the transaction attaches or its spent or reference inputs carry.
 * The ledger refuses such a transaction, since no Plutus script runs the
 * redeemer.
 */
export class ExtraneousRedeemerError extends Error {
  public constructor(
    purpose: Cardano.RedeemerPurpose,
    index: number,
    scriptHash: string,
  ) {
    super(
      `The ${purpose} redeemer at index ${index} runs the script ${scriptHash}, but the transaction provides no Plutus script with that hash`,
    );
    this.name = 'ExtraneousRedeemerError';
  }
}

/**
 * Thrown when the transaction spends, with a redeemer, an output locked by
 * a datum hash without the datum that hashes to it among the datums it
 * carries. The script could not read its datum, and the ledger refuses the
 * transaction for a missing required datum.
 */
export class MissingDatumError extends Error {
  public constructor(
    /** The input that spends the output, as `${txId}#${index}`. */
    readonly input: string,
    readonly datumHash: Cardano.DatumHash,
  ) {
    super(
      `The input ${input} is locked by the datum hash ${datumHash}, but the transaction carries no datum with that hash; pass the datum with its spend redeemer or add it with addDatum`,
    );
    this.name = 'MissingDatumError';
  }
}

/**
 * Thrown when a required top level guard carries a datum its credential
 * does not take, or lacks one it needs. The ledger refuses such a guard: a
 * Plutus script guard must carry a datum, and a key hash or native script
 * guard must not. A script guard whose script the transaction does not
 * provide is not checked, as the ledger does not check it either.
 */
export class MalformedGuardDatumError extends Error {
  public constructor(
    readonly guard: Cardano.Credential,
    /** The script of a script hash guard, absent for a key hash guard. */
    readonly script?: Cardano.Script,
    /** The sub transaction that requires the guard, when it is already built. */
    readonly subTransactionId?: Cardano.TransactionId,
  ) {
    const requirer = subTransactionId
      ? `Sub transaction ${subTransactionId}`
      : 'The sub transaction';
    const problem = !script
      ? 'with a datum, but a key hash guard takes none'
      : Cardano.isPlutusScript(script)
      ? 'without a datum, but a Plutus script guard needs one'
      : 'with a datum, but a native script guard takes none';
    super(`${requirer} requires the top level guard ${guard.hash} ${problem}`);
    this.name = 'MalformedGuardDatumError';
  }
}

/**
 * The redeemers a builder holds, keyed by what they authorize, with the
 * certificates and guards whose order gives their redeemers an index.
 */
export interface RedeemerSources {
  /** Spend redeemers keyed by `${txId}#${index}`. */
  spendRedeemers: ReadonlyMap<string, Cardano.PlutusData>;
  /** Mint redeemers keyed by policy id. */
  mintRedeemers: ReadonlyMap<Cardano.PolicyId, Cardano.PlutusData>;
  /** The certificates, in the order the body lists them. */
  certificates: readonly Cardano.Certificate[];
  /** Certificate redeemers keyed by their entry in `certificates`. */
  certificateRedeemers: ReadonlyMap<Cardano.Certificate, Cardano.PlutusData>;
  /** Withdrawal redeemers keyed by reward account. */
  withdrawalRedeemers: ReadonlyMap<Cardano.RewardAccount, Cardano.PlutusData>;
  /** Guards keyed by {@link guardKey}, in the order they were added. */
  guards: ReadonlyMap<string, Cardano.Credential>;
  /** Guarding redeemers keyed by {@link guardKey}. */
  guardRedeemers: ReadonlyMap<string, Cardano.PlutusData>;
}

/**
 * The key a builder holds a redeemer under: the input it spends as
 * `${txId}#${index}`, its policy id, its certificate, its reward account
 * or its guard's {@link guardKey}.
 */
export type RedeemerKey = Cardano.Certificate | string;

/**
 * A purpose of the transaction a script must authorize, at the index its
 * redeemer takes, and whether the builder holds a redeemer for it.
 */
export interface ScriptPurpose {
  purpose: Cardano.RedeemerPurpose;
  index: number;
  scriptHash: string;
  isRedeemed: boolean;
}

/** Hex comparator matching `@cardano-sdk/tx-construction`'s `compareHex`. */
const compareHex = (a: string, b: string): number =>
  a === b ? 0 : a < b ? -1 : 1;

/**
 * The reward-account payment credential hash, used to canonically order script
 * withdrawals (mirrors `@cardano-sdk/tx-construction`'s `rewardAccountCredential`).
 */
const rewardAccountCredentialHash = (
  rewardAccount: Cardano.RewardAccount,
): string =>
  Cardano.Address.fromBech32(rewardAccount).asReward()?.getPaymentCredential()
    .hash ?? '';

/**
 * The reward accounts `body` withdraws from whose credential is a script
 * hash, in the ledger's order: by script hash. The ledger orders every
 * script reward account before the key reward accounts, so a script
 * withdrawal's redeemer index is its position here.
 */
const scriptRewardAccounts = (
  body: Pick<Cardano.TxBody, 'withdrawals'>,
): Cardano.RewardAccount[] =>
  (body.withdrawals ?? [])
    .map(withdrawal => withdrawal.stakeAddress)
    .filter(
      rewardAccount =>
        Cardano.Address.fromBech32(rewardAccount)
          .asReward()
          ?.getPaymentCredential().type === Cardano.CredentialType.ScriptHash,
    )
    .sort((a, b) =>
      compareHex(
        rewardAccountCredentialHash(a),
        rewardAccountCredentialHash(b),
      ),
    );

/** The distinct policy ids `body` mints or burns under, sorted. */
const mintPolicyIds = (
  body: Pick<Cardano.TxBody, 'mint'>,
): Cardano.PolicyId[] =>
  [
    ...new Set([...(body.mint?.keys() ?? [])].map(Cardano.AssetId.getPolicyId)),
  ].sort(compareHex);

/** Identifies an input or a UTxO by the transaction that created it and its index. */
export const utxoRefKey = ([{ txId, index }]: Cardano.Utxo): string =>
  `${txId}#${index}`;

/** Identifies a guard by its credential type and hash. */
export const guardKey = ({ type, hash }: Cardano.Credential): string =>
  `${type}:${hash}`;

/** The script hash an address's payment credential holds, if it is a script. */
export const paymentScriptHash = (
  address: Cardano.PaymentAddress,
): string | undefined => {
  const payment = Cardano.Address.fromString(address)?.getProps().paymentPart;
  return payment?.type === Cardano.CredentialType.ScriptHash
    ? payment.hash
    : undefined;
};

/** The Plutus scripts the outputs of `utxos` carry. */
export const carriedPlutusScripts = (
  utxos: readonly Cardano.Utxo[],
): Cardano.PlutusScript[] =>
  utxos.flatMap(([, { scriptReference }]) =>
    scriptReference?.__type === Cardano.ScriptType.Plutus
      ? [scriptReference]
      : [],
  );

/** The hashes of `scripts`. */
export const scriptHashes = (scripts: readonly Cardano.Script[]): Set<string> =>
  new Set(scripts.map(script => Serialization.Script.fromCore(script).hash()));

/** The number of redeemers `sources` holds. */
export const redeemerCount = (sources: RedeemerSources): number =>
  sources.spendRedeemers.size +
  sources.mintRedeemers.size +
  sources.certificateRedeemers.size +
  sources.withdrawalRedeemers.size +
  sources.guardRedeemers.size;

/**
 * Records `guard` in `guards`, keeping the position of a guard added again,
 * and its guarding redeemer in `guardRedeemers`.
 *
 * @param sources - The guards, in the order they were added, and the
 *   guarding redeemers.
 * @param guard - The key hash or script hash credential to require.
 * @param redeemer - Guarding redeemer for a Plutus script hash `guard`.
 * @throws If `redeemer` is given for a key hash guard, or the guard already
 *   has a redeemer.
 */
export const recordGuard = (
  {
    guards,
    guardRedeemers,
  }: {
    guards: Map<string, Cardano.Credential>;
    guardRedeemers: Map<string, Cardano.PlutusData>;
  },
  guard: Cardano.Credential,
  redeemer: Cardano.PlutusData | undefined,
): void => {
  const key = guardKey(guard);
  if (
    redeemer !== undefined &&
    guard.type !== Cardano.CredentialType.ScriptHash
  ) {
    throw new Error(
      `Guarding redeemer requires a script hash guard, got key hash ${guard.hash}`,
    );
  }
  if (redeemer !== undefined && guardRedeemers.has(key)) {
    throw new Error(`Guard ${guard.hash} already has a redeemer`);
  }
  if (!guards.has(key)) {
    guards.set(key, { type: guard.type, hash: guard.hash });
  }
  if (redeemer !== undefined) guardRedeemers.set(key, redeemer);
};

/** The scripts the outputs of `utxos` carry, native and Plutus. */
export const carriedScripts = (
  utxos: readonly Cardano.Utxo[],
): Cardano.Script[] =>
  utxos.flatMap(([, { scriptReference }]) =>
    scriptReference ? [scriptReference] : [],
  );

/**
 * The ledger requires a required top level guard to carry a datum when its
 * credential is a Plutus script hash, and no datum when it is a key hash or
 * a native script hash. A script hash guard whose script is not among
 * `scripts` is not checked, as the ledger does not check it either.
 *
 * @param guards - The required top level guards.
 * @param scripts - The scripts the transaction provides.
 * @param subTransactionId - The sub transaction that requires the guards,
 *   when it is already built.
 * @throws `MalformedGuardDatumError` For the first guard whose datum does
 *   not fit its credential.
 */
export const assertGuardDatums = (
  guards: Iterable<Cardano.RequiredTopLevelGuardEntry>,
  scripts: readonly Cardano.Script[],
  subTransactionId?: Cardano.TransactionId,
): void => {
  const scriptsByHash = new Map(
    scripts.map(script => [
      Serialization.Script.fromCore(script).hash(),
      script,
    ]),
  );
  for (const { credential, datum } of guards) {
    const hasDatum = datum !== null && datum !== undefined;
    if (credential.type === Cardano.CredentialType.KeyHash) {
      if (hasDatum) {
        throw new MalformedGuardDatumError(
          credential,
          undefined,
          subTransactionId,
        );
      }
      continue;
    }
    const script = scriptsByHash.get(credential.hash);
    if (script && Cardano.isPlutusScript(script) !== hasDatum) {
      throw new MalformedGuardDatumError(credential, script, subTransactionId);
    }
  }
};

/**
 * Writes `guards` on `body`: as required signers while every guard is a key
 * hash, and in the credential form once one is a script hash.
 *
 * @param body - The body to write the guards on.
 * @param guards - The guards, in the order they were added.
 */
export const applyGuards = (
  body: Pick<Cardano.TxBody, 'guards' | 'requiredExtraSignatures'>,
  guards: ReadonlyMap<string, Cardano.Credential>,
): void => {
  const credentials = [...guards.values()];
  if (credentials.length === 0) return;
  const keyHashes = credentials.flatMap(({ type, hash }) =>
    type === Cardano.CredentialType.KeyHash
      ? [hash as unknown as Crypto.Ed25519KeyHashHex]
      : [],
  );
  if (keyHashes.length === credentials.length) {
    body.requiredExtraSignatures = keyHashes;
  } else {
    body.guards = credentials;
  }
};

/**
 * The credential that must witness `certificate`, when the ledger requires
 * one: the stake credential of a stake certificate, the DRep credential of a
 * DRep certificate and the cold credential of a committee certificate. A
 * legacy stake registration, a pool certificate and the pre-Conway genesis
 * delegation and MIR certificates have no credential a script witnesses, so
 * they take no redeemer.
 *
 * @param certificate - The certificate.
 * @returns The witnessing credential, or `undefined` when there is none.
 */
export const certificateWitnessCredential = (
  certificate: Cardano.Certificate,
): Cardano.Credential | undefined => {
  switch (certificate.__typename) {
    case Cardano.CertificateType.StakeDeregistration:
    case Cardano.CertificateType.StakeDelegation:
    case Cardano.CertificateType.Registration:
    case Cardano.CertificateType.Unregistration:
    case Cardano.CertificateType.VoteDelegation:
    case Cardano.CertificateType.StakeVoteDelegation:
    case Cardano.CertificateType.StakeRegistrationDelegation:
    case Cardano.CertificateType.VoteRegistrationDelegation:
    case Cardano.CertificateType.StakeVoteRegistrationDelegation:
      return certificate.stakeCredential;
    case Cardano.CertificateType.RegisterDelegateRepresentative:
    case Cardano.CertificateType.UnregisterDelegateRepresentative:
    case Cardano.CertificateType.UpdateDelegateRepresentative:
      return certificate.dRepCredential;
    case Cardano.CertificateType.AuthorizeCommitteeHot:
    case Cardano.CertificateType.ResignCommitteeCold:
      return certificate.coldCredential;
    case Cardano.CertificateType.StakeRegistration:
    case Cardano.CertificateType.PoolRegistration:
    case Cardano.CertificateType.PoolRetirement:
    case Cardano.CertificateType.GenesisKeyDelegation:
    case Cardano.CertificateType.MIR:
      return undefined;
  }
};

/**
 * The purposes of `body` a script must authorize, in the order the ledger
 * lists them: spent inputs at a script address, mint policies,
 * withdrawals from a script reward account, certificates of a script
 * credential and script hash guards, each at the index its redeemer takes.
 *
 * @param sources - The redeemers the builder holds.
 * @param body - The body whose purposes to list.
 * @param spent - UTxOs that resolve the inputs `body` spends.
 * @returns The purposes, in the ledger's order.
 */
export const scriptPurposes = (
  sources: RedeemerSources,
  body: Pick<Cardano.TxBody, 'inputs' | 'mint' | 'withdrawals'>,
  spent: readonly Cardano.Utxo[],
): ScriptPurpose[] => {
  const purposes: ScriptPurpose[] = [];

  for (const [index, input] of [...body.inputs].sort(compareTxIns).entries()) {
    const key = `${input.txId}#${input.index}`;
    const output = spent.find(utxo => utxoRefKey(utxo) === key)?.[1];
    const scriptHash = output && paymentScriptHash(output.address);
    if (scriptHash) {
      purposes.push({
        purpose: Cardano.RedeemerPurpose.spend,
        index,
        scriptHash,
        isRedeemed: sources.spendRedeemers.has(key),
      });
    }
  }

  for (const [index, policyId] of mintPolicyIds(body).entries()) {
    purposes.push({
      purpose: Cardano.RedeemerPurpose.mint,
      index,
      scriptHash: policyId,
      isRedeemed: sources.mintRedeemers.has(policyId),
    });
  }

  for (const [index, rewardAccount] of scriptRewardAccounts(body).entries()) {
    purposes.push({
      purpose: Cardano.RedeemerPurpose.withdrawal,
      index,
      scriptHash: rewardAccountCredentialHash(rewardAccount),
      isRedeemed: sources.withdrawalRedeemers.has(rewardAccount),
    });
  }

  for (const [index, certificate] of sources.certificates.entries()) {
    const credential = certificateWitnessCredential(certificate);
    if (credential?.type === Cardano.CredentialType.ScriptHash) {
      purposes.push({
        purpose: Cardano.RedeemerPurpose.certificate,
        index,
        scriptHash: credential.hash,
        isRedeemed: sources.certificateRedeemers.has(certificate),
      });
    }
  }

  for (const [index, [key, guard]] of [...sources.guards].entries()) {
    if (guard.type === Cardano.CredentialType.ScriptHash) {
      purposes.push({
        purpose: Cardano.RedeemerPurpose.guarding,
        index,
        scriptHash: guard.hash,
        isRedeemed: sources.guardRedeemers.has(key),
      });
    }
  }

  return purposes;
};

/**
 * The ledger requires a redeemer for every purpose that runs a Plutus
 * script, and a Plutus script for every redeemer, so a builder refuses a
 * transaction that lacks either.
 *
 * @param purposes - The purposes of the transaction, see {@link scriptPurposes}.
 * @param plutusHashes - The hashes of the Plutus scripts the transaction
 *   attaches or its inputs carry.
 * @throws `ExtraneousRedeemerError` For the first purpose with a redeemer
 *   whose script is not among `plutusHashes`.
 * @throws `MissingRedeemerError` For the first purpose that runs a script
 *   among `plutusHashes` without a redeemer.
 */
export const assertRedeemersMatchPlutusScripts = (
  purposes: readonly ScriptPurpose[],
  plutusHashes: ReadonlySet<string>,
): void => {
  const extraneous = purposes.find(
    ({ scriptHash, isRedeemed }) => isRedeemed && !plutusHashes.has(scriptHash),
  );
  if (extraneous) {
    throw new ExtraneousRedeemerError(
      extraneous.purpose,
      extraneous.index,
      extraneous.scriptHash,
    );
  }
  const missing = purposes.find(
    ({ scriptHash, isRedeemed }) => !isRedeemed && plutusHashes.has(scriptHash),
  );
  if (missing) {
    throw new MissingRedeemerError(
      missing.purpose,
      missing.index,
      missing.scriptHash,
    );
  }
};

/**
 * Adds `datum` to the datums a witness set carries, unless a datum with the
 * same hash is already among them, so the witness set holds each datum once.
 *
 * @param datums - The datums the witness set carries, in the order added.
 * @param datum - The datum to add.
 */
export const recordDatum = (
  datums: Cardano.PlutusData[],
  datum: Cardano.PlutusData,
): void => {
  const hash = Serialization.PlutusData.fromCore(datum).hash();
  if (
    !datums.some(
      carried => Serialization.PlutusData.fromCore(carried).hash() === hash,
    )
  ) {
    datums.push(datum);
  }
};

/**
 * Every output the transaction spends with a redeemer whose datum is a hash
 * needs a datum that hashes to it among the datums the transaction carries,
 * as the script reads its datum from them.
 *
 * @param spendRedeemers - Spend redeemers keyed by `${txId}#${index}`.
 * @param spent - UTxOs that resolve the spent inputs.
 * @param datums - The datums the transaction carries.
 * @throws `MissingDatumError` For the first such output without its datum,
 *   in the order the redeemers were added.
 */
export const assertSpentDatumsProvided = (
  spendRedeemers: ReadonlyMap<string, Cardano.PlutusData>,
  spent: readonly Cardano.Utxo[],
  datums: readonly Cardano.PlutusData[],
): void => {
  const provided = new Set(
    datums.map(datum => Serialization.PlutusData.fromCore(datum).hash()),
  );
  for (const key of spendRedeemers.keys()) {
    const datumHash = spent.find(utxo => utxoRefKey(utxo) === key)?.[1]
      .datumHash;
    if (datumHash && !provided.has(datumHash)) {
      throw new MissingDatumError(key, datumHash);
    }
  }
};

/**
 * The hashes of the scripts the redeemers run: the spent inputs' payment
 * scripts, the mint policies, the script credentials of the withdrawals
 * and certificates, and the guards with a guarding redeemer.
 *
 * @param sources - The redeemers the builder holds.
 * @param spent - UTxOs that resolve the spent inputs.
 * @returns The script hashes.
 */
export const redeemedScriptHashes = (
  sources: RedeemerSources,
  spent: readonly Cardano.Utxo[],
): Set<string> => {
  const hashes = new Set<string>(sources.mintRedeemers.keys());
  for (const key of sources.guardRedeemers.keys()) {
    hashes.add((sources.guards.get(key) as Cardano.Credential).hash);
  }
  for (const rewardAccount of sources.withdrawalRedeemers.keys()) {
    hashes.add(Cardano.RewardAccount.toHash(rewardAccount));
  }
  for (const certificate of sources.certificateRedeemers.keys()) {
    const credential = certificateWitnessCredential(certificate);
    if (credential) hashes.add(credential.hash);
  }
  for (const key of sources.spendRedeemers.keys()) {
    const output = spent.find(utxo => utxoRefKey(utxo) === key)?.[1];
    const scriptHash = output && paymentScriptHash(output.address);
    if (scriptHash) hashes.add(scriptHash);
  }
  return hashes;
};

/**
 * The languages the script data hash covers, as the ledger counts them:
 * every attached Plutus script runs, and a script a spent or reference input
 * carries counts only when a redeemer runs it.
 *
 * @param attached - The scripts the witness set attaches.
 * @param provided - The Plutus scripts the inputs carry.
 * @param redeemed - The hashes of the scripts the redeemers run, see {@link redeemedScriptHashes}.
 * @returns The languages, each once.
 */
export const scriptDataLanguages = (
  attached: readonly Cardano.Script[],
  provided: readonly Cardano.PlutusScript[],
  redeemed: ReadonlySet<string>,
): Cardano.PlutusLanguageVersion[] => {
  const languages = new Set(
    attached.filter(Cardano.isPlutusScript).map(({ version }) => version),
  );
  for (const script of provided) {
    if (redeemed.has(Serialization.Script.fromCore(script).hash())) {
      languages.add(script.version);
    }
  }
  return [...languages];
};

/**
 * Indexes the redeemers canonically over `body`, mirroring
 * `@cardano-sdk/tx-construction`'s `assignCanonicalIndices`:
 * - spend: index = position of the input in the input set, in the
 *   order the transaction is written in (transaction id, then index),
 * - mint: index = position of the policy id in the deduped, hex-sorted mint
 *   policies,
 * - certificate: index = position of the certificate in the body
 *   certificate list, counting every certificate,
 * - withdrawal: index = position of the reward account among every
 *   withdrawal from a script reward account, sorted by script hash, which
 *   the ledger orders before the key reward accounts,
 * - guarding: index = position of the guard among every guard, in the
 *   order they were added, key hash guards included.
 *
 * @param sources - The redeemers the builder holds.
 * @param body - The body the redeemers authorize.
 * @param executionUnits - The execution units of a redeemer, given its
 *   purpose, its index and the key `sources` holds it under.
 * @throws If a redeemer's input, policy, certificate or reward account is
 *   not part of `body`.
 * @returns The redeemers, spend first, then mint, certificate, withdrawal
 *   and guarding.
 */
export const indexRedeemers = (
  sources: RedeemerSources,
  body: Pick<
    Cardano.TxBody,
    'certificates' | 'inputs' | 'mint' | 'withdrawals'
  >,
  executionUnits: (
    purpose: Cardano.RedeemerPurpose,
    index: number,
    key: RedeemerKey,
  ) => Cardano.ExUnits,
): Cardano.Redeemer[] => {
  const redeemers: Cardano.Redeemer[] = [];
  const redeemerAt = (
    purpose: Cardano.RedeemerPurpose,
    index: number,
    [key, data]: [RedeemerKey, Cardano.PlutusData],
  ): Cardano.Redeemer => ({
    index,
    purpose,
    data,
    executionUnits: executionUnits(purpose, index, key),
  });

  const sortedInputs = [...body.inputs].sort(compareTxIns);
  for (const [key, data] of sources.spendRedeemers) {
    const index = sortedInputs.findIndex(
      input => `${input.txId}#${input.index}` === key,
    );
    if (index < 0) {
      throw new Error(`Spend redeemer input not found in transaction: ${key}`);
    }
    redeemers.push(
      redeemerAt(Cardano.RedeemerPurpose.spend, index, [key, data]),
    );
  }

  const policyIds = mintPolicyIds(body);
  for (const [policyId, data] of sources.mintRedeemers) {
    const index = policyIds.indexOf(policyId);
    if (index < 0) {
      throw new Error(
        `Mint redeemer policy not present in transaction mint: ${policyId}`,
      );
    }
    redeemers.push(
      redeemerAt(Cardano.RedeemerPurpose.mint, index, [policyId, data]),
    );
  }

  const bodyCertificates = body.certificates ?? [];
  for (const [certificate, data] of sources.certificateRedeemers) {
    const index = sources.certificates.indexOf(certificate);
    if (bodyCertificates[index]?.__typename !== certificate.__typename) {
      throw new Error(
        `Certificate redeemer not present in transaction certificates: ${certificate.__typename}#${index}`,
      );
    }
    redeemers.push(
      redeemerAt(Cardano.RedeemerPurpose.certificate, index, [
        certificate,
        data,
      ]),
    );
  }

  const withdrawalAccounts = scriptRewardAccounts(body);
  for (const [rewardAccount, data] of sources.withdrawalRedeemers) {
    const index = withdrawalAccounts.indexOf(rewardAccount);
    if (index < 0) {
      throw new Error(
        `Withdrawal redeemer not present in transaction withdrawals: ${rewardAccount}`,
      );
    }
    redeemers.push(
      redeemerAt(Cardano.RedeemerPurpose.withdrawal, index, [
        rewardAccount,
        data,
      ]),
    );
  }

  const guardKeys = [...sources.guards.keys()];
  for (const [key, data] of sources.guardRedeemers) {
    redeemers.push(
      redeemerAt(Cardano.RedeemerPurpose.guarding, guardKeys.indexOf(key), [
        key,
        data,
      ]),
    );
  }

  return redeemers;
};
