import { Cardano, Serialization } from '@lace-lib/cardano-core';
import {
  compareRequestedGrantScope,
  CUSTODY_MAX_GRANT_BATCH,
  detectCustodyEffects,
  inspectCustodyTransaction,
  parseCustodyRequestedGrantScope,
} from '@lace-lib/cardano-custody';
import { SLOT_CONFIG_NETWORK } from '@lace-lib/cardano-tx-builder';

import { customCardanoSlotConfig } from '../custom-networks';
import { outpointKey } from '../util';

import {
  CardanoCustodyRequestRefusedError,
  parseCustodyDevice,
  parseCustodyGrantUtxos,
  parseCustodyUtxo,
  readCustodyGrantUtxos,
  readCustodyRecordIdentity,
} from './custody-request-context';
import {
  isRecord,
  MalformedRequestError,
  parseArray,
  parseChainId,
  parseString,
} from './request-parsing';

import type { CardanoCustodyRequestDevice } from './custody-request-context';
import type {
  CardanoContractPin,
  CustodyAccountIdentity,
  CustodyAccountInspection,
  CustodyContractCalls,
  CustodyEffects,
  CustodyGrant,
  CustodyGrantUtxo,
  CustodyRefusal,
  CustodyRequestedGrantScope,
  CustodySlotToPosixMs,
  CustodyTransactionInspection,
} from '@lace-lib/cardano-custody';

export { CardanoCustodyRequestRefusedError } from './custody-request-context';
export type { CardanoCustodyRefusalCode } from './custody-request-context';

/** The protocol payload of `cardano-custody-public-key`, unread. */
export type CardanoCustodyPublicKeyPayload = { chainId: unknown };

/** The protocol payload of `sign-cardano-custody-tx`, unread. */
export type SignCardanoCustodyTxPayload = {
  serializedTx: unknown;
  chainId: unknown;
  device: unknown;
  resolvedInputs: unknown;
  accountRecord: unknown;
  requestedScopes?: unknown;
  grantUtxos?: unknown;
  metadataMeanings?: unknown;
  costModels?: unknown;
};

/**
 * The protocol's cost models as a sign request carries them: each cost
 * model by its Plutus language version in decimal, `0` for Plutus V1.
 */
export type SerializedCardanoCustodyCostModels = Record<string, number[]>;

/** Everything a checked custody sign request names, read from its bytes and context. */
export type CardanoCustodySignRequestCheck = {
  /** The transaction whose body hash the device signs. */
  transaction: Serialization.Transaction;
  txId: Cardano.TransactionId;
  chainId: Cardano.ChainId;
  /** The account the record names, re-derived from its creator key. */
  identity: CustodyAccountIdentity;
  device: CardanoCustodyRequestDevice;
  inspection: CustodyTransactionInspection;
  /** The record's account: the only custody account the transaction operates. */
  account: CustodyAccountInspection;
  /**
   * The grants the app declared the transaction issues, a replacement among
   * them; absent when it declared none, in which case no comparison was
   * made.
   */
  requestedScopes?: readonly CustodyRequestedGrantScope[];
  /**
   * The grant UTxOs of the account the app reported, in slot order, each
   * checked to be in the shape of a grant UTxO of the account; absent when it
   * reported none. The chain was not asked, so whether a grant still exists,
   * and what a revoked slot's grant was, rest on the app.
   */
  grantUtxos?: readonly CustodyGrantUtxo[];
  /**
   * What the app says the metadata under each label is, for labels the
   * transaction carries; absent when it says nothing. The chain was not
   * asked: consent shows each as reported by the app.
   */
  metadataMeanings?: ReadonlyMap<bigint, string>;
  /**
   * What the transaction does to the pinned contracts it calls; absent for
   * a transaction that calls none. The redeemers and datums are bound to
   * the body by its script data hash. The spent contract UTxOs, and so the
   * pins chosen by their script hashes and their datums, and the reference
   * inputs rest on the app's resolutions.
   */
  contractCalls?: CustodyContractCalls;
  /** The outputs the app resolved every input, reference input and collateral input to. */
  resolvedInputs: readonly Cardano.Utxo[];
};

type CheckCardanoCustodySignRequestOptions = {
  /** POSIX milliseconds: a grant issued with an expiry at or before it is refused. */
  now: number;
  /**
   * The other contracts an owner transaction may call, from the signer's
   * own build or the app that is its consent surface; never from the
   * request. Empty refuses every call.
   */
  contractPins: readonly CardanoContractPin[];
};

/** The slot configuration of a public or registered custom network. */
const slotConfigOf = (networkMagic: Cardano.NetworkMagic) =>
  SLOT_CONFIG_NETWORK[networkMagic as Cardano.NetworkMagics] ??
  customCardanoSlotConfig(networkMagic);

/**
 * The chain a custody request names. Its network id must be the one its
 * magic implies, because custody identities keep only the magic, and the
 * signer must know the network's slot length, to read validity bounds and
 * grant expiries as time. Anything else is malformed.
 */
export const parseCardanoCustodyChainId = (value: unknown): Cardano.ChainId => {
  const chainId = parseChainId(value);
  const impliedNetworkId =
    (chainId.networkMagic as Cardano.NetworkMagics) ===
    Cardano.NetworkMagics.Mainnet
      ? Cardano.NetworkId.Mainnet
      : Cardano.NetworkId.Testnet;
  if (
    chainId.networkId !== impliedNetworkId ||
    slotConfigOf(chainId.networkMagic) === undefined
  ) {
    throw new MalformedRequestError('chainId');
  }
  return chainId;
};

/** POSIX milliseconds at which a slot starts, from the network's slot configuration. */
const slotToPosixMsOn = (
  networkMagic: Cardano.NetworkMagic,
): CustodySlotToPosixMs => {
  const config = slotConfigOf(networkMagic);
  if (!config) throw new MalformedRequestError('chainId');
  return slot => config.zeroTime + (slot - config.zeroSlot) * config.slotLength;
};

/**
 * Decodes the transaction and every body and witness field the checks read,
 * so a decoding failure is reported as malformed rather than surfacing from
 * inside a check.
 */
const parseTransaction = (value: unknown): Serialization.Transaction => {
  const text = parseString(value, 'serializedTx');
  try {
    const transaction = Serialization.Transaction.fromCbor(
      Serialization.TxCBOR(text),
    );
    transaction.toCore();
    return transaction;
  } catch {
    throw new MalformedRequestError('serializedTx');
  }
};

/**
 * The grants the app declares, in the requested scope shape. Each must be a
 * JSON object, no slot may be declared twice, and no transaction issues more
 * than a batch.
 */
const parseRequestedScopes = (
  value: unknown,
): CustodyRequestedGrantScope[] | undefined => {
  if (value === undefined) return undefined;
  const items = parseArray<unknown>(value, 'requestedScopes');
  if (items.length > CUSTODY_MAX_GRANT_BATCH) {
    throw new MalformedRequestError('requestedScopes');
  }
  const scopes = items.map(item => {
    const parsed = isRecord(item)
      ? parseCustodyRequestedGrantScope(item)
      : undefined;
    if (!parsed?.ok) throw new MalformedRequestError('requestedScopes');
    return parsed.value;
  });
  if (new Set(scopes.map(({ slot }) => slot)).size !== scopes.length) {
    throw new MalformedRequestError('requestedScopes');
  }
  return scopes;
};

const METADATA_LABEL = /^(?:0|[1-9]\d*)$/;
// 2^64 - 1 as a literal: `**` on BigInt breaks transpilers that lower it to Math.pow.
const MAX_METADATA_LABEL = 18_446_744_073_709_551_615n;
/** The longest meaning consent shows for one label. */
const MAX_METADATA_MEANING_LENGTH = 200;

/**
 * The meanings the app reports, by metadata label: a JSON object whose keys
 * are decimal 64-bit unsigned labels and whose values are non-empty text
 * of at most 200 characters. Undefined when it reports none.
 */
const parseMetadataMeanings = (
  value: unknown,
): ReadonlyMap<bigint, string> | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new MalformedRequestError('metadataMeanings');
  const meanings = new Map<bigint, string>();
  for (const [key, meaning] of Object.entries(value)) {
    if (
      !METADATA_LABEL.test(key) ||
      BigInt(key) > MAX_METADATA_LABEL ||
      typeof meaning !== 'string' ||
      meaning.length === 0 ||
      meaning.length > MAX_METADATA_MEANING_LENGTH
    ) {
      throw new MalformedRequestError('metadataMeanings');
    }
    meanings.set(BigInt(key), meaning);
  }
  return meanings.size === 0 ? undefined : meanings;
};

/** Cost model entries a request may carry for one language; the ledger's are far fewer. */
const MAX_COST_MODEL_LENGTH = 1024;

/** The Plutus language versions a sign request may give cost models for, in decimal. */
const PLUTUS_LANGUAGES: ReadonlySet<string> = new Set(
  Object.values(Cardano.PlutusLanguageVersion)
    .filter((version): version is number => typeof version === 'number')
    .map(String),
);

/** The cost models in the shape a sign request carries them. */
export const serializeCardanoCustodyCostModels = (
  costModels: Cardano.CostModels,
): SerializedCardanoCustodyCostModels =>
  Object.fromEntries(
    [...costModels].map(([language, costs]) => [String(language), [...costs]]),
  );

/**
 * The cost models the app reports: a JSON object whose keys are known
 * Plutus language versions in decimal and whose values are lists of safe
 * integers. They need not be trusted, since wrong ones only make the
 * script data hash fail to match. Undefined when it reports none.
 */
const parseCostModels = (value: unknown): Cardano.CostModels | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new MalformedRequestError('costModels');
  const costModels: Cardano.CostModels = new Map();
  for (const [language, costs] of Object.entries(value)) {
    if (
      !PLUTUS_LANGUAGES.has(language) ||
      !Array.isArray(costs) ||
      costs.length > MAX_COST_MODEL_LENGTH ||
      !costs.every(cost => Number.isSafeInteger(cost))
    ) {
      throw new MalformedRequestError('costModels');
    }
    costModels.set(
      Number(language) as Cardano.PlutusLanguageVersion,
      costs as number[],
    );
  }
  return costModels;
};

/** Every label the app gives a meaning must be one the transaction carries. */
const checkMetadataMeanings = (
  meanings: ReadonlyMap<bigint, string> | undefined,
  metadata: Cardano.TxMetadata | undefined,
): void => {
  for (const label of meanings?.keys() ?? []) {
    if (!metadata?.has(label)) {
      throw new CardanoCustodyRequestRefusedError(
        'custody-context-mismatch',
        'metadata-label-not-carried',
        { label },
      );
    }
  }
};

type NetworkEvidence = Cardano.NetworkId | 'unreadable';

const evidenceOfAddress = (address: string): NetworkEvidence =>
  Cardano.Address.fromString(address)?.getNetworkId() ?? 'unreadable';

/**
 * Every network id the body states. Outpoints and bare credentials carry no
 * network; every address and reward account does, and the body may state
 * its network outright. A sub-transaction is walked too, since the witness
 * over the parent covers it.
 */
const networkEvidenceOf = (
  body: Cardano.SubTransactionBody | Cardano.TxBody,
): NetworkEvidence[] => [
  ...(body.networkId === undefined ? [] : [body.networkId]),
  ...body.outputs.map(({ address }) => evidenceOfAddress(address)),
  ...('collateralReturn' in body && body.collateralReturn
    ? [evidenceOfAddress(body.collateralReturn.address)]
    : []),
  ...[...(body.withdrawals ?? []), ...(body.directDeposits ?? [])].map(
    ({ stakeAddress }) => evidenceOfAddress(stakeAddress),
  ),
  ...(body.proposalProcedures ?? []).flatMap(
    ({ rewardAccount, governanceAction }) => [
      evidenceOfAddress(rewardAccount),
      ...(governanceAction.__typename ===
      Cardano.GovernanceActionType.treasury_withdrawals_action
        ? [...governanceAction.withdrawals].map(withdrawal =>
            evidenceOfAddress(withdrawal.rewardAccount),
          )
        : []),
    ],
  ),
  ...(body.certificates ?? []).flatMap(certificate =>
    certificate.__typename === Cardano.CertificateType.PoolRegistration
      ? [evidenceOfAddress(certificate.poolParameters.rewardAccount)]
      : [],
  ),
  ...('subTransactions' in body
    ? (body.subTransactions ?? []).flatMap(sub => networkEvidenceOf(sub.body))
    : []),
];

/**
 * The body must name the request's network wherever it names one, and must
 * name it somewhere: a custody transaction always pays its control output,
 * so a body with no network-bearing element is not one the signer reads.
 */
const checkBodyNetwork = (
  body: Cardano.TxBody,
  networkId: Cardano.NetworkId,
): void => {
  const evidence = networkEvidenceOf(body);
  if (evidence.includes('unreadable')) {
    throw new MalformedRequestError('serializedTx');
  }
  if (evidence.length === 0) {
    throw new CardanoCustodyRequestRefusedError(
      'network-mismatch',
      'no-network-evidence',
    );
  }
  if (evidence.some(stated => stated !== networkId)) {
    throw new CardanoCustodyRequestRefusedError(
      'network-mismatch',
      'body-network',
    );
  }
};

const refusalOf = (refusal: CustodyRefusal) =>
  new CardanoCustodyRequestRefusedError(refusal.code, refusal.reason, refusal);

/** The grants the transaction issues, read from the datums of their grant outputs. */
const writtenGrantsOf = (account: CustodyAccountInspection): CustodyGrant[] =>
  account.issuedGrants.map(({ grant }) => grant);

/**
 * The declared grants must be exactly the grants the transaction issues,
 * field by field. A replacement issues its grant in a new slot, which is the
 * slot to declare; the revoked slot writes no grant. It is a consistency
 * check between two things the same caller supplies, not authentication: it
 * catches an app that encodes a scope other than the one it meant to ask for.
 */
const checkRequestedScopes = (
  requested: readonly CustodyRequestedGrantScope[] | undefined,
  account: CustodyAccountInspection,
  chainId: Cardano.ChainId,
): void => {
  if (requested === undefined) return;
  const written = writtenGrantsOf(account);
  for (const scope of requested) {
    const grant = written.find(({ slot }) => slot === scope.slot);
    if (!grant) {
      throw new CardanoCustodyRequestRefusedError(
        'custody-scope-mismatch',
        'grant-not-written',
        { slot: scope.slot },
      );
    }
    const fields = compareRequestedGrantScope(scope, grant, chainId);
    if (fields.length > 0) {
      throw new CardanoCustodyRequestRefusedError(
        'custody-scope-mismatch',
        'field-mismatch',
        { slot: scope.slot, fields },
      );
    }
  }
  const undeclared = written.find(
    grant => !requested.some(({ slot }) => slot === grant.slot),
  );
  if (undeclared) {
    throw new CardanoCustodyRequestRefusedError(
      'custody-scope-mismatch',
      'undeclared-grant',
      { slot: undeclared.slot },
    );
  }
};

/**
 * The reference inputs a transaction may read: the UTxOs that park its
 * account's contract scripts on the request's network and, when it calls
 * pinned contracts, the reference inputs inspection reports as part of the
 * call.
 */
const allowedReferenceInputsOf = (
  { contractVersion }: CustodyAccountIdentity,
  { networkMagic }: Cardano.ChainId,
  contractCalls: CustodyContractCalls | undefined,
): Cardano.TxIn[] => [
  ...(contractVersion.referenceScripts[networkMagic] ?? []).map(
    ({ txIn }) => txIn,
  ),
  ...(contractCalls?.referenceInputs ?? []).map(({ input }) => input),
];

/**
 * The transaction may reference nothing but the allowed reference inputs.
 * Inspection also admits a reference input that carries no script, which a
 * grant spend needs for the control UTxO; this check signs no grant spend,
 * so it reads nothing else.
 */
const checkReferenceInputs = (
  transaction: Serialization.Transaction,
  allowed: readonly Cardano.TxIn[],
): void => {
  const allowedKeys = new Set(
    allowed.map(candidate => outpointKey(candidate).toLowerCase()),
  );
  for (const { txId, index } of transaction.body().toCore().referenceInputs ??
    []) {
    const input = { txId, index };
    if (!allowedKeys.has(outpointKey(input).toLowerCase())) {
      throw new CardanoCustodyRequestRefusedError(
        'custody-unsupported-operation',
        'foreign-reference-input',
        { input },
      );
    }
  }
};

/**
 * The refusals that show a transaction running another contract: it spends
 * a UTxO another script locks, or mints under another policy.
 */
const CONTRACT_CALL_REFUSALS: ReadonlySet<CustodyRefusal['reason']> = new Set([
  'foreign-mint',
  'foreign-script-input',
]);

type RequestInspection = ReturnType<typeof inspectCustodyTransaction>;

/** The inspection options of a request, with the pins and cost models a call is held to. */
type RequestInspectionOptions = Parameters<
  typeof inspectCustodyTransaction
>[2] & {
  contractPins: readonly CardanoContractPin[];
  costModels: Cardano.CostModels | undefined;
};

/**
 * Inspects the transaction as an owner operation, held to `contractPins`
 * and with the witness set bound to the body under the cost models the
 * app reports. One that runs no other contract is inspected without
 * contract calls, so its refusals stay those of a plain owner operation,
 * while a payment it makes to a pinned contract is still named and its
 * datum decoded. One that spends a UTxO another script locks, or mints
 * under another policy, is inspected again as a contract call.
 */
const inspectRequest = (
  transaction: Serialization.Transaction,
  resolvedInputs: readonly Cardano.Utxo[],
  { costModels, ...options }: RequestInspectionOptions,
): RequestInspection => {
  const bound = {
    ...options,
    bindScriptData: true,
    ...(costModels ? { costModels } : {}),
  };
  const plain = inspectCustodyTransaction(transaction, resolvedInputs, bound);
  if (
    plain.ok ||
    !plain.error.refusals.some(({ reason }) =>
      CONTRACT_CALL_REFUSALS.has(reason),
    )
  ) {
    return plain;
  }
  return inspectCustodyTransaction(transaction, resolvedInputs, {
    ...bound,
    allowContractCall: true,
  });
};

/**
 * Checks a `sign-cardano-custody-tx` request and reads everything consent
 * shows from it, refusing on the first failure in this order: a malformed
 * payload, transaction, resolution, requested scope, grant UTxO, metadata
 * meaning, cost model or device key (`malformed-request`); a body that
 * names another network than `chainId` (`network-mismatch`); an account
 * record that does not re-derive or names an unknown contract version; a
 * reported grant UTxO that is not in the shape of a grant UTxO of the
 * account, or that the
 * request reports twice or resolves otherwise (`custody-context-mismatch`
 * or `custody-malformed-datum`); then every rule of
 * `inspectCustodyTransaction`, with the device key derived from the request's
 * account public key at the requested index as the signing device; a
 * reference input other than a UTxO that parks the account's contract
 * scripts on the network or one a pinned call reads
 * (`custody-unsupported-operation`, `foreign-reference-input`); then the
 * requested scopes (`custody-scope-mismatch`); and last a reported
 * metadata meaning for a label the transaction does not carry
 * (`custody-context-mismatch`,
 * `metadata-label-not-carried`). Grant spends are always refused: the
 * passkey is never a grantee.
 *
 * An owner operation that spends a UTxO another script locks, or mints
 * under another policy, is a contract call. It is signed only when every
 * called script is one of `contractPins`, with redeemers and datums that
 * decode against the pin (`unknown-contract`, `contract-data-mismatch`),
 * when it leaves the account's control state as it was
 * (`contract-call-with-state-change`), and when the body's script data hash
 * binds that data under the cost models the app reports
 * (`missing-cost-models`, `script-data-hash-mismatch`). Pins are never read
 * from the request.
 *
 * Every transaction whose body declares a script data hash, call or not,
 * must declare the one the witness set it was sent hashes to under the
 * cost models the app reports (`missing-cost-models`,
 * `script-data-hash-mismatch`). The device signs the body alone, so
 * without it an app could resolve a Plutus script input as a key input and
 * leave its redeemer and script out of the request, to add them back
 * before it submits. With the redeemers bound, such an input is refused as
 * `redeemer-on-key-input` or `foreign-script-input`. A native-script
 * input, or a key-address input the device signature alone satisfies,
 * carries no redeemer, so outside a chain-checked call it rests on the
 * app's resolution, which the Fee payer section labels as reported by the
 * app. A payment to a
 * pinned contract is named by its pin, with its datum decoded
 * (`contract-data-mismatch` when it does not decode).
 *
 * The hosted signer runs it to describe the request and again on the exact
 * bytes before its ceremony, so a path that skips the description never
 * obtains a witness. The context is the caller's and is not checked against
 * the chain.
 *
 * @throws `MalformedRequestError` When a field cannot be read.
 * @throws `CardanoCustodyRequestRefusedError` When a rule refuses the request.
 */
export const checkCardanoCustodySignRequest = async (
  payload: unknown,
  { now, contractPins }: CheckCardanoCustodySignRequestOptions,
): Promise<CardanoCustodySignRequestCheck> => {
  if (!isRecord(payload)) throw new MalformedRequestError('payload');
  const transaction = parseTransaction(payload.serializedTx);
  const chainId = parseCardanoCustodyChainId(payload.chainId);
  const resolvedInputs = parseArray<unknown>(
    payload.resolvedInputs,
    'resolvedInputs',
  ).map(value => parseCustodyUtxo(value, 'resolvedInputs'));
  if (payload.accountRecord === undefined) {
    throw new MalformedRequestError('accountRecord');
  }
  const requestedScopes = parseRequestedScopes(payload.requestedScopes);
  const reportedGrantUtxos = parseCustodyGrantUtxos(payload.grantUtxos);
  const metadataMeanings = parseMetadataMeanings(payload.metadataMeanings);
  const costModels = parseCostModels(payload.costModels);
  const device = await parseCustodyDevice(payload.device);

  checkBodyNetwork(transaction.body().toCore(), chainId.networkId);
  const identity = readCustodyRecordIdentity(payload.accountRecord, chainId);
  const grantUtxos =
    reportedGrantUtxos &&
    readCustodyGrantUtxos(reportedGrantUtxos, identity, resolvedInputs);
  const inspected = inspectRequest(transaction, resolvedInputs, {
    chainId,
    now,
    slotToPosixMs: slotToPosixMsOn(chainId.networkMagic),
    accountRecord: payload.accountRecord,
    deviceKeyHash: device.keyHash,
    contractPins,
    costModels,
  });
  if (!inspected.ok) throw refusalOf(inspected.error.refusals[0]);
  const account = inspected.value.accounts.find(
    candidate =>
      candidate.accountValidatorHash ===
        identity.contractVersion.accountValidatorHash &&
      candidate.stakeScriptHash === identity.stakeScriptHash,
  );
  if (!account) {
    // Inspection with a record refuses a transaction that leaves the
    // record's account untouched, so this guards a broken invariant.
    throw new CardanoCustodyRequestRefusedError(
      'custody-context-mismatch',
      'account-not-operated',
    );
  }
  const { contractCalls } = inspected.value;
  checkReferenceInputs(
    transaction,
    allowedReferenceInputsOf(identity, chainId, contractCalls),
  );
  checkRequestedScopes(requestedScopes, account, chainId);
  checkMetadataMeanings(metadataMeanings, inspected.value.metadata);

  return {
    transaction,
    txId: transaction.getId(),
    chainId,
    identity,
    device,
    inspection: inspected.value,
    account,
    ...(requestedScopes === undefined ? {} : { requestedScopes }),
    ...(grantUtxos === undefined ? {} : { grantUtxos }),
    ...(metadataMeanings === undefined ? {} : { metadataMeanings }),
    ...(contractCalls === undefined ? {} : { contractCalls }),
    resolvedInputs,
  };
};

/**
 * Checks a transaction sent through the ordinary `sign-cardano-tx` kind for
 * custody effects, from its bytes alone. Anything that operates a custody
 * account is refused with `custody-request-required`: the ordinary consent
 * shows no datum and no spent input, so a state rewrite would read as a
 * plain payment. A datum-free payment to the account validator that no
 * redeemer can ever spend is refused with `custody-locked-output`, the code
 * the custody kind gives it too, because no kind signs it. Returns the
 * effects found, so a deposit can be named as one.
 *
 * @throws `MalformedRequestError` When the transaction cannot be decoded.
 * @throws `CardanoCustodyRequestRefusedError` When it touches a custody account.
 */
export const checkOrdinaryCardanoTransaction = (
  serializedTx: string,
): CustodyEffects => {
  let effects: CustodyEffects;
  try {
    effects = detectCustodyEffects(
      Serialization.Transaction.fromCbor(Serialization.TxCBOR(serializedTx)),
    );
  } catch {
    throw new MalformedRequestError('serializedTx');
  }
  // Operating an account is reported first: the dApp must choose the custody
  // kind before that kind can report the locked output as well.
  const operating = effects.reasons.find(
    ({ kind }) => kind !== 'deposit' && kind !== 'unspendable-output',
  );
  if (operating) {
    throw new CardanoCustodyRequestRefusedError(
      'custody-request-required',
      operating.kind,
      effects.reasons,
    );
  }
  const locked = effects.reasons.find(
    ({ kind }) => kind === 'unspendable-output',
  );
  if (locked) {
    throw new CardanoCustodyRequestRefusedError(
      'custody-locked-output',
      locked.kind,
      effects.reasons,
    );
  }
  return effects;
};
