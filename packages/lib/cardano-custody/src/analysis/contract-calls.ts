import { Cardano } from '@lace-lib/cardano-core';

import { SUPPORTED_CUSTODY_CONTRACT_VERSIONS } from '../contract-version';
import { decodeContractData } from '../contracts/blueprint-data';

import { versionOfPolicy } from './account-inspection';
import { isKnownCustodyLogic } from './outputs';
import { checkScriptDataHash, scriptDataOf } from './script-data-hash';
import { isSameOutpoint } from './transaction-checks';
import {
  isContractScriptOutput,
  paymentCredentialOf,
  redeemerData,
} from './transaction-facts';
import { policyIdOf } from './value';

import type { CardanoContractPin } from '../contracts';
import type { CustodyExternalOutput } from './inspect';
import type { CustodyAccountHashes, OutputView } from './outputs';
import type { CustodyContractLocation, CustodyRefusal } from './refusals';
import type { InputView, TransactionFacts } from './transaction-facts';
import type {
  CardanoContractSchema,
  DecodedContractData,
} from '../contracts/blueprint-data';
import type { Serialization } from '@lace-lib/cardano-core';

/**
 * Data of a called contract as consent shows it: decoded against the
 * schema the contract's pin gives, or raw where no schema applies.
 */
export type CustodyContractData =
  | { readonly kind: 'decoded'; readonly value: DecodedContractData }
  | { readonly kind: 'raw'; readonly data: Cardano.PlutusData };

/** A datum: its data, or only its hash where the transaction carries no preimage. */
export type CustodyContractDatum =
  | CustodyContractData
  | { readonly kind: 'hash'; readonly hash: Cardano.DatumHash };

/** A UTxO of another contract the transaction spends. */
export interface CustodyContractSpend {
  readonly input: Cardano.TxIn;
  /**
   * The script that locks it, its payment credential. Rests on the caller's
   * resolution of the input, which nothing checks against the chain.
   */
  readonly scriptHash: string;
  /**
   * The label of the contract's pin; absent when inspected without pins.
   * Rests on the caller's resolution of the input, as the pin is chosen by
   * the script hash.
   */
  readonly label?: string;
  /** Rests on the caller's resolution of the input, which nothing checks against the chain. */
  readonly value: Cardano.Value;
  /** Absent for a script that takes none, such as a native script. */
  readonly redeemer?: CustodyContractData;
  /**
   * Rests on the caller's resolution of the input: an inline datum is the
   * caller's, and a witness preimage is bound only to the datum hash the
   * caller resolves.
   */
  readonly datum?: CustodyContractDatum;
}

/** What the transaction mints and burns under another contract's policy. */
export interface CustodyContractMint {
  readonly policyId: Cardano.PolicyId;
  /** The label of the contract's pin; absent when inspected without pins. */
  readonly label?: string;
  /** Minted positive and burned negative, by lower-case asset id. */
  readonly assets: ReadonlyMap<Cardano.AssetId, bigint>;
  /** Absent for a policy that takes none, such as a native script. */
  readonly redeemer?: CustodyContractData;
}

/**
 * A UTxO outside every custody account the transaction reads without
 * spending. Apart from its outpoint, it rests on the caller's resolution,
 * which nothing checks against the chain.
 */
export interface CustodyContractReferenceInput {
  readonly input: Cardano.TxIn;
  /** As the caller resolves it. */
  readonly address: string;
  /** As the caller resolves it. */
  readonly value: Cardano.Value;
  /** The hash of the reference script the caller resolves it to carry, if any. */
  readonly referenceScriptHash?: string;
}

/** What an allowed contract call does to other contracts, for consent to show. */
export interface CustodyContractCalls {
  /** In the ledger's input order. */
  readonly spends: readonly CustodyContractSpend[];
  /** In policy id order. */
  readonly mints: readonly CustodyContractMint[];
  /**
   * Reference inputs outside every custody account, other than the
   * contract's parked scripts, in the body's order.
   */
  readonly referenceInputs: readonly CustodyContractReferenceInput[];
}

/** A reading of contract data, with the refusals it raised. */
interface ContractRead<T> {
  readonly value: T;
  readonly refusals: readonly CustodyRefusal[];
}

/** Whether two hex hashes are equal, ignoring case. */
const sameHash = (a: string, b: string): boolean =>
  a.toLowerCase() === b.toLowerCase();

/** The pin that names a script, if any; pins are checked to be unique first. */
const pinOf = (
  pins: readonly CardanoContractPin[],
  scriptHash: string,
): CardanoContractPin | undefined =>
  pins.find(pin => sameHash(pin.scriptHash, scriptHash));

/**
 * Two pins naming one script leave no single schema to decode its data
 * against, so the caller's pins are refused whole.
 */
export const checkContractPins = (
  pins: readonly CardanoContractPin[],
): CustodyRefusal[] => {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const { scriptHash } of pins) {
    const key = scriptHash.toLowerCase();
    if (seen.has(key)) repeated.add(key);
    seen.add(key);
  }
  return [...repeated].map(
    (scriptHash): CustodyRefusal => ({
      code: 'custody-context-mismatch',
      reason: 'duplicate-contract-pin',
      scriptHash,
    }),
  );
};

/**
 * The attached Plutus scripts other than the account validator, a known
 * logic or the stake script of an account the transaction operates.
 */
const foreignAttachedScriptsOf = (
  facts: TransactionFacts,
  operated: readonly CustodyAccountHashes[],
): string[] => {
  const ownScripts = new Set<string>([
    ...SUPPORTED_CUSTODY_CONTRACT_VERSIONS.map(
      version => version.accountValidatorHash,
    ),
    ...operated.map(({ stakeScriptHash }) => stakeScriptHash),
  ]);
  return [...facts.witnessPlutusScriptHashes].filter(
    hash => !ownScripts.has(hash) && !isKnownCustodyLogic(hash),
  );
};

/**
 * Outside a contract call, an owner operation runs only custody scripts:
 * it spends no UTxO another script locks and attaches no Plutus script but
 * the account validator, a known logic or the stake script of an account
 * it operates. A grant spend refuses foreign inputs by its own rule,
 * `grant-spend-foreign-input`, and every script a foreign attached script
 * could run with it, so it is not checked here.
 */
export const checkForeignScripts = (
  facts: TransactionFacts,
  operated: readonly CustodyAccountHashes[],
): CustodyRefusal[] => [
  ...facts.inputs
    .filter(({ output }) => isContractScriptOutput(output))
    .map(
      ({ input }): CustodyRefusal => ({
        code: 'custody-unsupported-operation',
        reason: 'foreign-script-input',
        input,
      }),
    ),
  ...foreignAttachedScriptsOf(facts, operated).map(
    (scriptHash): CustodyRefusal => ({
      code: 'custody-unsupported-operation',
      reason: 'foreign-attached-script',
      scriptHash,
    }),
  ),
];

/** The datum an output carries: inline, or the witness preimage of its hash. */
const datumDataOf = (
  txOut: Cardano.TxOut,
  facts: TransactionFacts,
): Cardano.PlutusData | undefined =>
  txOut.datum ??
  (txOut.datumHash === undefined
    ? undefined
    : facts.witnessDatums.get(txOut.datumHash.toLowerCase()));

/** An output's datum as raw data, or its hash where no preimage is known. */
const rawDatumOf = (
  txOut: Cardano.TxOut,
  data: Cardano.PlutusData | undefined,
): CustodyContractDatum | undefined => {
  if (data !== undefined) return { kind: 'raw', data };
  return txOut.datumHash === undefined
    ? undefined
    : { kind: 'hash', hash: txOut.datumHash };
};

/** Where a pinned contract's data is read, for its refusals to name. */
interface DataSite {
  readonly location: CustodyContractLocation;
  readonly scriptHash: string;
  readonly data: 'datum' | 'redeemer';
}

/** The transaction a call is read from, and the caller's pins if any. */
interface CallScope {
  readonly facts: TransactionFacts;
  readonly pins: readonly CardanoContractPin[] | undefined;
}

/**
 * Data decoded against a schema of a pin, or a `contract-data-mismatch`
 * refusal when it does not decode or is missing.
 */
const decodePinned = (
  [schema, { definitions }]: readonly [
    CardanoContractSchema,
    CardanoContractPin,
  ],
  data: Cardano.PlutusData | undefined,
  site: DataSite,
): ContractRead<CustodyContractData | undefined> => {
  const mismatch = (path: string, expected: string): CustodyRefusal => ({
    code: 'custody-unsupported-operation',
    reason: 'contract-data-mismatch',
    ...site,
    path,
    expected,
  });
  if (data === undefined) {
    return { value: undefined, refusals: [mismatch('', `a ${site.data}`)] };
  }
  const decoded = decodeContractData(schema, definitions, data);
  return decoded.ok
    ? { value: { kind: 'decoded', value: decoded.value }, refusals: [] }
    : {
        value: undefined,
        refusals: [mismatch(decoded.error.path, decoded.error.expected)],
      };
};

/** The refusal for a called script no pin names. */
const unknownContract = (
  location: CustodyContractLocation,
  scriptHash: string,
): CustodyRefusal => ({
  code: 'custody-unsupported-operation',
  reason: 'unknown-contract',
  location,
  scriptHash,
});

/** Contract data shown raw, or nothing when absent. */
const rawOf = (
  data: Cardano.PlutusData | undefined,
): CustodyContractData | undefined =>
  data === undefined ? undefined : { kind: 'raw', data };

/**
 * One spent UTxO of another contract. With pins, its script must have a
 * spend pin, its redeemer must decode against the pin, and so must its
 * datum where the pin gives a datum schema; a pin without one leaves the
 * datum unchecked and shown raw.
 */
const readSpend = (
  [index, { input, output }]: readonly [number, InputView],
  { facts, pins }: CallScope,
): ContractRead<CustodyContractSpend | undefined> => {
  const scriptHash = paymentCredentialOf(output)?.hash ?? '';
  const { txOut } = output;
  const redeemer = redeemerData(facts, Cardano.RedeemerPurpose.spend, index);
  const datum = datumDataOf(txOut, facts);
  const rawDatum = rawDatumOf(txOut, datum);
  const unchecked = {
    input,
    scriptHash,
    value: txOut.value,
    ...(redeemer === undefined ? {} : { redeemer: rawOf(redeemer) }),
    ...(rawDatum ? { datum: rawDatum } : {}),
  };
  if (!pins) return { value: unchecked, refusals: [] };

  const location: CustodyContractLocation = { kind: 'input', input };
  const pin = pinOf(pins, scriptHash);
  if (!pin?.spend) {
    return {
      value: undefined,
      refusals: [unknownContract(location, scriptHash)],
    };
  }
  const site = { location, scriptHash };
  const redeemerRead = decodePinned([pin.spend.redeemer, pin], redeemer, {
    ...site,
    data: 'redeemer',
  });
  const datumRead = pin.spend.datum
    ? decodePinned([pin.spend.datum, pin], datum, { ...site, data: 'datum' })
    : { value: rawDatum, refusals: [] };
  return {
    value: {
      ...unchecked,
      label: pin.label,
      ...(redeemerRead.value ? { redeemer: redeemerRead.value } : {}),
      ...(datumRead.value ? { datum: datumRead.value } : {}),
    },
    refusals: [...redeemerRead.refusals, ...datumRead.refusals],
  };
};

/**
 * What the transaction mints and burns under one policy of another
 * contract. With pins, the policy must have a mint pin and its redeemer
 * must decode against it.
 */
const readMint = (
  [policyId, assets]: readonly [
    Cardano.PolicyId,
    ReadonlyMap<Cardano.AssetId, bigint>,
  ],
  { facts, pins }: CallScope,
): ContractRead<CustodyContractMint | undefined> => {
  const redeemer = redeemerData(
    facts,
    Cardano.RedeemerPurpose.mint,
    facts.mintPolicies.indexOf(policyId),
  );
  const unchecked = {
    policyId,
    assets,
    ...(redeemer === undefined ? {} : { redeemer: rawOf(redeemer) }),
  };
  if (!pins) return { value: unchecked, refusals: [] };

  const location: CustodyContractLocation = { kind: 'mint', policyId };
  const pin = pinOf(pins, policyId);
  if (!pin?.mint) {
    return {
      value: undefined,
      refusals: [unknownContract(location, policyId)],
    };
  }
  const redeemerRead = decodePinned([pin.mint.redeemer, pin], redeemer, {
    location,
    scriptHash: policyId,
    data: 'redeemer',
  });
  return {
    value: {
      ...unchecked,
      label: pin.label,
      ...(redeemerRead.value ? { redeemer: redeemerRead.value } : {}),
    },
    refusals: redeemerRead.refusals,
  };
};

/** The mint of every policy outside the custody contract, by policy id. */
const foreignMintsOf = (
  facts: TransactionFacts,
): Map<Cardano.PolicyId, Map<Cardano.AssetId, bigint>> => {
  const byPolicy = new Map<Cardano.PolicyId, Map<Cardano.AssetId, bigint>>();
  for (const [assetId, quantity] of facts.mint) {
    const policyId = policyIdOf(assetId) as Cardano.PolicyId;
    if (versionOfPolicy(policyId)) continue;
    const assets = byPolicy.get(policyId) ?? new Map<Cardano.AssetId, bigint>();
    byPolicy.set(policyId, assets.set(assetId, quantity));
  }
  return byPolicy;
};

/** Whether an input is where a supported contract version parks its scripts. */
const isParkedScript = (
  input: Cardano.TxIn,
  networkMagic: Cardano.NetworkMagic,
): boolean =>
  SUPPORTED_CUSTODY_CONTRACT_VERSIONS.some(version =>
    (version.referenceScripts[networkMagic] ?? []).some(({ txIn }) =>
      isSameOutpoint(txIn, input),
    ),
  );

/**
 * What an allowed contract call does to other contracts: the UTxOs of
 * other scripts it spends, what it mints under other policies and the
 * reference inputs it reads. Without pins every call is reported raw.
 * With pins, each spent script and each policy must be pinned for that
 * use, and its redeemers and datums must decode against the pin, else the
 * call is refused as `unknown-contract` or `contract-data-mismatch`.
 */
export const readContractCalls = (
  facts: TransactionFacts,
  pins: readonly CardanoContractPin[] | undefined,
  networkMagic: Cardano.NetworkMagic,
): ContractRead<CustodyContractCalls> => {
  const scope = { facts, pins };
  const spends = [...facts.inputs.entries()]
    .filter(([, { output }]) => isContractScriptOutput(output))
    .map(entry => readSpend(entry, scope));
  const mints = [...foreignMintsOf(facts)]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(entry => readMint(entry, scope));
  const reads = [...spends, ...mints];
  return {
    value: {
      spends: spends.flatMap(({ value }) => (value ? [value] : [])),
      mints: mints.flatMap(({ value }) => (value ? [value] : [])),
      referenceInputs: facts.referenceInputs
        .filter(
          ({ input, output }) =>
            output.addressClass.kind === 'other' &&
            !isParkedScript(input, networkMagic),
        )
        .map(({ input, output }) => ({
          input,
          address: output.txOut.address,
          value: output.txOut.value,
          ...(output.referenceScriptHash === undefined
            ? {}
            : { referenceScriptHash: output.referenceScriptHash }),
        })),
    },
    refusals: reads.flatMap(({ refusals }) => refusals),
  };
};

/**
 * Whether the transaction runs or reads another contract: it spends a UTxO
 * another script locks, mints under another policy, attaches a Plutus
 * script outside the custody contract or reads a reference input outside
 * every custody account other than the contract's parked scripts.
 */
export const isCallingContracts = (
  facts: TransactionFacts,
  operated: readonly CustodyAccountHashes[],
  networkMagic: Cardano.NetworkMagic,
): boolean =>
  facts.inputs.some(({ output }) => isContractScriptOutput(output)) ||
  foreignMintsOf(facts).size > 0 ||
  foreignAttachedScriptsOf(facts, operated).length > 0 ||
  facts.referenceInputs.some(
    ({ input, output }) =>
      output.addressClass.kind === 'other' &&
      !isParkedScript(input, networkMagic),
  );

/**
 * Consent to a pinned call shows the redeemers and witness datums decoded,
 * and only the body's script data hash binds them to what the device
 * signs, so the hash is recomputed under the caller's cost models, over
 * the languages of every attached script and every reference script the
 * caller resolves. A signer that binds every transaction runs it for any
 * body that declares a hash. Wrong cost models can only make it fail to
 * match.
 */
export const checkScriptDataBinding = (
  transaction: Serialization.Transaction,
  facts: TransactionFacts,
  costModels: Cardano.CostModels | undefined,
): CustodyRefusal[] => {
  if (!costModels) {
    return [
      { code: 'custody-unsupported-operation', reason: 'missing-cost-models' },
    ];
  }
  const problem = checkScriptDataHash(
    facts.body.scriptIntegrityHash,
    scriptDataOf(
      transaction,
      [...facts.inputs, ...facts.referenceInputs].map(
        ({ output }) => output.txOut,
      ),
    ),
    costModels,
  );
  return problem ? [{ code: 'custody-unsupported-operation', ...problem }] : [];
};

/**
 * One output outside every custody account, with the datum it carries.
 * An output paid to a script with a spend pin that gives a datum schema
 * must carry a datum, inline or as a hash with its preimage in the witness
 * set, that decodes against it: a datum hash alone would leave consent
 * nothing to show. Every other datum is shown raw, or as its hash without
 * a preimage.
 */
const readExternalOutput = (
  [outputIndex, view]: readonly [number, OutputView],
  facts: TransactionFacts,
  pins: readonly CardanoContractPin[],
): ContractRead<CustodyExternalOutput> => {
  const { txOut } = view;
  const credential = paymentCredentialOf(view);
  const pin =
    credential?.type === Cardano.CredentialType.ScriptHash
      ? pinOf(pins, credential.hash)
      : undefined;
  const data = datumDataOf(txOut, facts);
  const output = {
    outputIndex,
    address: txOut.address,
    value: txOut.value,
    ...(pin ? { label: pin.label } : {}),
  };
  if (pin?.spend?.datum && credential) {
    const read = decodePinned([pin.spend.datum, pin], data, {
      location: { kind: 'output', index: outputIndex },
      scriptHash: credential.hash,
      data: 'datum',
    });
    return {
      value: { ...output, ...(read.value ? { datum: read.value } : {}) },
      refusals: read.refusals,
    };
  }
  const datum = rawDatumOf(txOut, data);
  return { value: { ...output, ...(datum ? { datum } : {}) }, refusals: [] };
};

/** The outputs outside every custody address, in body order, with their datums. */
export const readExternalOutputs = (
  facts: TransactionFacts,
  pins: readonly CardanoContractPin[],
): ContractRead<CustodyExternalOutput[]> => {
  const reads = facts.outputs.flatMap((view, outputIndex) =>
    view.addressClass.kind === 'other'
      ? [readExternalOutput([outputIndex, view], facts, pins)]
      : [],
  );
  return {
    value: reads.map(({ value }) => value),
    refusals: reads.flatMap(({ refusals }) => refusals),
  };
};
