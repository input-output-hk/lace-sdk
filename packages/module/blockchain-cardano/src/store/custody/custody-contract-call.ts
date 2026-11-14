import { outpointKey } from '@lace-contract/cardano-context';
import { Cardano, Serialization } from '@lace-lib/cardano-core';
import {
  addValueDeltas,
  negateValueDelta,
  SUPPORTED_CUSTODY_CONTRACT_VERSIONS,
  valueDeltaOf,
} from '@lace-lib/cardano-custody';

import { failCustodyBuild } from './build-failure';
import { custodyScriptWitnesses, scriptHashOf } from './custody-scripts';

import type { CustodyAccountContext } from './custody-account';
import type { CustodyMint } from './custody-assembly';
import type { CustodyChain } from './custody-chain';
import type { CardanoCustodyContractCall } from '@lace-contract/cardano-context';
import type { CustodyValueDelta } from '@lace-lib/cardano-custody';

/** Refuses the contract call as invalid, saying why. */
const invalidCall = (message: string): never =>
  failCustodyBuild({
    code: 'invalid-operation',
    reason: 'invalid-contract-call',
    message,
  });

/** The script hash of an address's payment credential; undefined for a key or an unreadable address. */
const paymentScriptHashOf = (
  address: Cardano.PaymentAddress,
): string | undefined => {
  const payment = Cardano.Address.fromString(address)?.getProps().paymentPart;
  return payment?.type === Cardano.CredentialType.ScriptHash
    ? payment.hash
    : undefined;
};

/** The account validator hashes of every supported custody contract version. */
const custodyAccountValidatorHashes: ReadonlySet<string> = new Set(
  SUPPORTED_CUSTODY_CONTRACT_VERSIONS.map(
    ({ accountValidatorHash }) => accountValidatorHash,
  ),
);

/** Whether a script is a PlutusV3 script, the only language a call may run. */
const isPlutusV3 = (script: Cardano.Script): boolean =>
  script.__type === Cardano.ScriptType.Plutus &&
  script.version === Cardano.PlutusLanguageVersion.V3;

/**
 * Refuses a script input the call cannot spend: one at a key address or
 * locked by the account validator of any supported custody contract
 * version, which only an account's own redeemers spend, or one whose datum
 * does not fit its UTxO. A UTxO that carries its datum's hash needs that
 * datum; any other takes none.
 */
const checkCallInput = (
  { utxo, datum }: NonNullable<CardanoCustodyContractCall['inputs']>[number],
  inputIndex: number,
): void => {
  const [, output] = utxo;
  const scriptHash = paymentScriptHashOf(output.address);
  if (scriptHash === undefined) {
    return invalidCall(`Input ${inputIndex} is not locked by a script`);
  }
  if (custodyAccountValidatorHashes.has(scriptHash)) {
    invalidCall(`Input ${inputIndex} belongs to a custody account`);
  }
  if (output.datumHash === undefined) {
    if (datum !== undefined) {
      invalidCall(`Input ${inputIndex} carries no datum hash for its datum`);
    }
    return;
  }
  if (
    datum === undefined ||
    Serialization.PlutusData.fromCore(datum).hash() !== output.datumHash
  ) {
    invalidCall(`Input ${inputIndex} needs the datum its hash names`);
  }
};

/**
 * Refuses a call whose scripts or inputs clash with the rest of the
 * transaction: a script that is not PlutusV3, attached or carried as a
 * reference script by an input or reference input of the call; an attached
 * script named twice, one that is a custody contract script, one an input or
 * reference input carries, or one nothing in the call needs; and an input
 * that is the control or a parked custody script.
 */
const checkCallScripts = (
  call: CardanoCustodyContractCall,
  { identity, control }: Pick<CustodyAccountContext, 'control' | 'identity'>,
  chain: Pick<CustodyChain, 'chainId'>,
): void => {
  const { contractVersion } = identity;
  const custodyScripts = [
    contractVersion.accountValidator,
    ...contractVersion.logics.map(({ script }) => script),
  ];
  const parked = custodyScriptWitnesses(
    contractVersion,
    chain,
    custodyScripts,
  ).referenced;
  const custodyHashes = new Set(custodyScripts.map(scriptHashOf));
  const carriers = [
    ...(call.referenceInputs ?? []),
    ...(call.inputs ?? []).map(({ utxo }) => utxo),
  ];
  for (const [input, { scriptReference }] of carriers) {
    if (scriptReference && !isPlutusV3(scriptReference)) {
      invalidCall(
        `UTxO ${outpointKey(input)} carries a script that is not PlutusV3`,
      );
    }
  }
  const carried = new Set(
    carriers.flatMap(([, { scriptReference }]) =>
      scriptReference ? [scriptHashOf(scriptReference)] : [],
    ),
  );
  const needed = new Set<string>([
    ...(call.inputs ?? []).flatMap(({ utxo: [, { address }] }) => {
      const hash = paymentScriptHashOf(address);
      return hash === undefined ? [] : [hash];
    }),
    ...(call.mint ?? []).map(({ policyId }) => policyId as string),
  ]);
  const attached = new Set<string>();
  for (const script of call.scripts ?? []) {
    const hash = scriptHashOf(script);
    if (!isPlutusV3(script)) invalidCall(`Script ${hash} is not PlutusV3`);
    if (attached.has(hash)) invalidCall(`Script ${hash} is attached twice`);
    if (custodyHashes.has(hash)) {
      invalidCall(`Script ${hash} is a custody contract script`);
    }
    if (carried.has(hash)) {
      invalidCall(
        `Script ${hash} is also carried by an input of the transaction`,
      );
    }
    if (!needed.has(hash)) {
      invalidCall(`Script ${hash} is needed by no input or mint of the call`);
    }
    attached.add(hash);
  }
  const read = new Set(
    [control, ...parked].map(([input]) => outpointKey(input)),
  );
  for (const { utxo } of call.inputs ?? []) {
    const key = outpointKey(utxo[0]);
    if (read.has(key)) invalidCall(`UTxO ${key} is both spent and referenced`);
  }
};

/** Where a contract call runs, as its check needs it. */
interface ContractCallSetting extends Pick<CustodyChain, 'chainId'> {
  /** Whether the spend also spends the account's control UTxO, as an owner spend does. */
  readonly isControlSpent?: boolean;
}

/**
 * Checks a spend's contract call before anything is built. It names at
 * least one input, mint, script or reference input; its inputs are other
 * contracts' script UTxOs, never a custody account's, with the datums they
 * need; its mints name distinct policies other than the account's with
 * non-zero quantities; and it names no UTxO twice, nor one of the account's
 * fund, reserve or grant UTxOs, nor its control UTxO when `isControlSpent`,
 * as on an owner spend, so no call outpoint is ever selected, spent or
 * referenced as the account's own.
 *
 * It also refuses a script that is not PlutusV3, attached or carried by an
 * input or reference input of the call, which the sponsor would refuse
 * after evaluation, and what the ledger rejects on submit: a script attached
 * twice, a custody contract script, one an input or reference input of the
 * call carries, or one no input or mint of the call needs, as the witness
 * would be extraneous; and an input that is the control or a parked custody
 * script, which the transaction also references.
 */
export const checkContractCall = (
  call: CardanoCustodyContractCall,
  context: CustodyAccountContext,
  { chainId, isControlSpent = false }: ContractCallSetting,
): void => {
  const { identity, funds, reserves, grants, control } = context;
  const inputs = call.inputs ?? [];
  const isEmpty =
    inputs.length === 0 &&
    (call.mint ?? []).length === 0 &&
    (call.scripts ?? []).length === 0 &&
    (call.referenceInputs ?? []).length === 0;
  if (isEmpty) {
    invalidCall('A contract call names no input, mint, script or reference');
  }
  for (const [inputIndex, input] of inputs.entries()) {
    checkCallInput(input, inputIndex);
  }
  const accountKeys = new Set(
    [
      ...funds,
      ...reserves,
      ...grants.map(({ utxo }) => utxo),
      ...(isControlSpent ? [control] : []),
    ].map(([input]) => outpointKey(input)),
  );
  const named = new Set<string>();
  for (const [input] of [
    ...inputs.map(({ utxo }) => utxo),
    ...(call.referenceInputs ?? []),
  ]) {
    const key = outpointKey(input);
    if (named.has(key)) invalidCall(`UTxO ${key} is named twice`);
    if (accountKeys.has(key)) invalidCall(`UTxO ${key} is the account's own`);
    named.add(key);
  }
  checkCallScripts(call, context, { chainId });
  const accountPolicy: string = identity.contractVersion.accountValidatorHash;
  const policies = new Set<string>();
  for (const { policyId, assets } of call.mint ?? []) {
    if (policyId === accountPolicy) {
      invalidCall('A contract call cannot mint custody account tokens');
    }
    if (policies.has(policyId)) {
      invalidCall(`Policy ${policyId} is named twice`);
    }
    policies.add(policyId);
    if (
      assets.size === 0 ||
      [...assets.values()].some(quantity => quantity === 0n)
    ) {
      invalidCall(`Policy ${policyId} names no asset or a zero quantity`);
    }
  }
};

/**
 * What the requested outputs take from the account before the fee: the
 * outputs less what a contract call supplies, by lower-case asset id. A
 * negative quantity is value the call leaves at the account.
 */
export const outflowOf = (
  requested: Cardano.Value,
  supplied: CustodyValueDelta,
): CustodyValueDelta =>
  addValueDeltas([valueDeltaOf(requested), negateValueDelta(supplied)]);

/**
 * What the account's funds owe an outflow before the fee: its lovelace,
 * which may be negative, and the assets it takes. An asset the call leaves
 * at the account is owed by no fund.
 */
export const owedOf = ({
  lovelace,
  assets,
}: CustodyValueDelta): Required<Cardano.Value> => ({
  coins: lovelace,
  assets: new Map([...assets].filter(([, quantity]) => quantity > 0n)),
});

/** The call's mints as the plan holds them, each policy's tokens by asset id. */
export const contractMintsOf = ({
  mint = [],
}: CardanoCustodyContractCall): CustodyMint[] =>
  mint.map(({ policyId, assets, redeemer }) => ({
    assets: new Map(
      [...assets].map(([assetName, quantity]) => [
        Cardano.AssetId.fromParts(policyId, assetName),
        quantity,
      ]),
    ),
    redeemer,
  }));

/**
 * The value a contract call brings into the transaction: what its inputs
 * hold and what it mints, less what it burns. Assets go by lower-case id,
 * and an asset that nets to zero is left out.
 */
export const contractCallSupplyOf = (
  call: CardanoCustodyContractCall,
): CustodyValueDelta =>
  addValueDeltas([
    ...(call.inputs ?? []).map(({ utxo: [, { value }] }) =>
      valueDeltaOf(value),
    ),
    ...contractMintsOf(call).map(({ assets }) =>
      valueDeltaOf({ coins: 0n, assets }),
    ),
  ]);

/**
 * The call's reference inputs the build does not already read: a UTxO the
 * build references itself, such as the control or a parked custody
 * script, is read once.
 */
export const contractReferencesOf = (
  { referenceInputs = [] }: CardanoCustodyContractCall,
  referenced: readonly Cardano.Utxo[],
): Cardano.Utxo[] => {
  const keys = new Set(referenced.map(([input]) => outpointKey(input)));
  return referenceInputs.filter(([input]) => !keys.has(outpointKey(input)));
};

/** How many redeemers a contract call runs: one per input and one per mint policy. */
export const contractRedeemerCountOf = ({
  inputs = [],
  mint = [],
}: CardanoCustodyContractCall): number => inputs.length + mint.length;
