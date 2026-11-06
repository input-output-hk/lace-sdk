import { Cardano, Serialization } from '@lace-lib/cardano-core';
import { HexBlob } from '@lace-lib/cardano-util';

import { LargeFirstCoinSelector } from '../../src/input-selection/LargeFirstCoinSelector';
import { SubTransactionBuilder } from '../../src/SubTransactionBuilder';
import { TransactionBuilder } from '../../src/TransactionBuilder';

import type {
  TransactionBuilderProtocolParameters,
  TxEvaluator,
} from '../../src/types';
import type * as Crypto from '@lace-lib/cardano-crypto';

/** Lovelace and native assets, the assets keyed by asset id. */
interface ScenarioValue {
  coins: number;
  assets?: Record<string, number>;
}

/** An output a scenario sends or spends, with its datum as CBOR or a hash. */
export interface ScenarioOutput extends ScenarioValue {
  address: string;
  datum?: { inline?: string; hash?: string };
  /** The CBOR of the script the output carries. */
  scriptReference?: string;
}

/** An unspent output, identified by the transaction that created it. */
export interface ScenarioUtxo extends ScenarioOutput {
  txId: string;
  index: number;
}

/** The protocol parameters a scenario is priced with, prices as decimal text. */
export interface ScenarioProtocolParameters {
  minFeeCoefficient: number;
  minFeeConstant: number;
  prices: { memory: string; steps: string };
  coinsPerUtxoByte: number;
  maxTxSize: number;
  maxValueSize: number;
  collateralPercentage: number;
  maxCollateralInputs: number;
  stakeKeyDeposit: number;
  poolDeposit: number;
  dRepDeposit: number;
  minFeeRefScriptCostPerByte: string;
  /** Bytes per reference script fee tier, set from protocol version 12. */
  refScriptCostStride?: number;
  /** Growth of the reference script price per tier, set from protocol version 12. */
  refScriptCostMultiplier?: string;
  protocolVersion: { major: number; minor: number };
  costModels: Partial<
    Record<'PlutusV1' | 'PlutusV2' | 'PlutusV3' | 'PlutusV4', number[]>
  >;
}

/**
 * The balance a reward account must hold: a half open range with either
 * bound optional, or an exact balance.
 */
interface ScenarioAccountBalanceInterval {
  rewardAccount: string;
  inclusiveLowerBound?: number;
  exclusiveUpperBound?: number;
  exactBalance?: number;
}

/**
 * A transaction to build: what it spends, references, pays, mints,
 * registers, withdraws and attaches. Plutus data, scripts and metadata are
 * CBOR in hex. Every redeemer runs with the execution units listed for its
 * purpose and index, so the build involves no script evaluation.
 */
export interface Scenario {
  description: string;
  protocolParameters: ScenarioProtocolParameters;
  changeAddress: string;
  invalidBefore?: number;
  invalidHereafter?: number;
  /** The UTxOs coin selection may spend. */
  utxos: ScenarioUtxo[];
  inputs?: Array<{ utxo: ScenarioUtxo; redeemer?: string; datum?: string }>;
  referenceInputs?: ScenarioUtxo[];
  outputs?: ScenarioOutput[];
  scripts?: string[];
  mint?: Array<{
    policyId: string;
    assetName: string;
    quantity: number;
    redeemer: string;
  }>;
  certificates?: Array<{ type: 'registration'; rewardAccount: string }>;
  withdrawals?: Array<{ rewardAccount: string; quantity: number }>;
  /** Coin deposited directly into reward accounts, in the order it is added. */
  directDeposits?: Array<{ rewardAccount: string; quantity: number }>;
  /** Balances the accounts must hold when the transaction is applied. */
  accountBalanceIntervals?: ScenarioAccountBalanceInterval[];
  /** Balances the accounts must hold before the transaction is applied. */
  startingAccountBalanceIntervals?: ScenarioAccountBalanceInterval[];
  metadata?: Array<{ label: number; cbor: string }>;
  /** Key hashes the transaction requires as signers, added before the guards. */
  requiredSigners?: string[];
  /** Guards in the order they are added, a Plutus script guard with its redeemer. */
  guards?: Array<{
    type: 'keyHash' | 'scriptHash';
    hash: string;
    redeemer?: string;
  }>;
  collateral?: { utxos: ScenarioUtxo[]; returnAddress: string };
  /**
   * Signed sub transactions the transaction batches, in the order they are
   * added, each with the UTxOs that resolve its inputs and reference inputs.
   */
  subTransactions?: Array<{ cbor: string; resolvedUtxos: ScenarioUtxo[] }>;
  executionUnits?: Array<{
    purpose: Cardano.RedeemerPurpose;
    index: number;
    memory: number;
    steps: number;
  }>;
}

/** A guard, a Plutus script guard with its redeemer. */
interface ScenarioGuard {
  type: 'keyHash' | 'scriptHash';
  hash: string;
  redeemer?: string;
}

/**
 * A sub transaction to build, unbalanced and without fee: what it spends,
 * references, pays, mints, registers, withdraws, deposits, requires and
 * attaches. Plutus data and scripts are CBOR in hex. Every redeemer runs
 * with the execution units listed for its purpose and index.
 */
export interface SubTransactionScenario {
  description: string;
  protocolParameters: ScenarioProtocolParameters;
  invalidBefore?: number;
  invalidHereafter?: number;
  inputs?: ScenarioUtxo[];
  scriptInputs?: Array<{
    utxo: ScenarioUtxo;
    redeemer: string;
    datum?: string;
  }>;
  referenceInputs?: ScenarioUtxo[];
  outputs?: ScenarioOutput[];
  scripts?: string[];
  mint?: Array<{
    policyId: string;
    assetName: string;
    quantity: number;
    redeemer?: string;
  }>;
  certificates?: Array<{
    type: 'registration';
    rewardAccount: string;
    redeemer?: string;
  }>;
  withdrawals?: Array<{
    rewardAccount: string;
    quantity: number;
    redeemer?: string;
  }>;
  directDeposits?: Array<{ rewardAccount: string; quantity: number }>;
  accountBalanceIntervals?: ScenarioAccountBalanceInterval[];
  metadata?: Array<{ label: number; cbor: string }>;
  /** Key hashes the sub transaction requires as signers, added before the guards. */
  requiredSigners?: string[];
  guards?: ScenarioGuard[];
  /** Guards the transaction that carries it must carry, each with an optional datum. */
  requiredTopLevelGuards?: Array<{
    type: 'keyHash' | 'scriptHash';
    hash: string;
    datum?: string;
  }>;
  executionUnits?: Scenario['executionUnits'];
}

/**
 * What a sub transaction build produced, in the form both builders are
 * compared in: the unsigned CBOR, the id, the script data hash and the
 * redeemers as `purpose:index`, sorted.
 */
export interface SubTransactionBuildOutputs {
  cbor: string;
  id: string;
  scriptDataHash: string | null;
  redeemers: string[];
}

/**
 * What a build produced, in the form both builders are compared in: the
 * fee, the script data hash, the collateral inputs, total and return, the
 * redeemers as `purpose:index`, the ids of the sub transactions it carries,
 * when it carries any, in the order written, and the transaction CBOR.
 * Inputs and redeemers are sorted, and amounts are decimal text.
 */
export interface BuildOutputs {
  fee: string;
  scriptDataHash: string | null;
  collateral: {
    inputs: string[];
    totalCollateral: string | null;
    collateralReturn: string | null;
  };
  redeemers: string[];
  subTransactionIds?: string[];
  cbor: string;
}

const LANGUAGES = {
  PlutusV1: Cardano.PlutusLanguageVersion.V1,
  PlutusV2: Cardano.PlutusLanguageVersion.V2,
  PlutusV3: Cardano.PlutusLanguageVersion.V3,
  PlutusV4: Cardano.PlutusLanguageVersion.V4,
} as const;

const plutusData = (cbor: string): Cardano.PlutusData =>
  Serialization.PlutusData.fromCbor(HexBlob(cbor)).toCore();

const toValue = ({ coins, assets }: ScenarioValue): Cardano.Value => ({
  coins: BigInt(coins),
  ...(assets && {
    assets: new Map(
      Object.entries(assets).map(([assetId, quantity]) => [
        Cardano.AssetId(assetId),
        BigInt(quantity),
      ]),
    ),
  }),
});

const toAccountBalanceInterval = ({
  inclusiveLowerBound,
  exclusiveUpperBound,
  exactBalance,
}: Omit<
  ScenarioAccountBalanceInterval,
  'rewardAccount'
>): Cardano.AccountBalanceInterval => ({
  ...(inclusiveLowerBound !== undefined && {
    inclusiveLowerBound: BigInt(inclusiveLowerBound),
  }),
  ...(exclusiveUpperBound !== undefined && {
    exclusiveUpperBound: BigInt(exclusiveUpperBound),
  }),
  ...(exactBalance !== undefined && { exactBalance: BigInt(exactBalance) }),
});

const toTxOut = (output: ScenarioOutput): Cardano.TxOut => ({
  address: Cardano.PaymentAddress(output.address),
  value: toValue(output),
  ...(output.datum?.inline && { datum: plutusData(output.datum.inline) }),
  ...(output.datum?.hash && {
    datumHash: output.datum.hash as Cardano.DatumHash,
  }),
  ...(output.scriptReference && {
    scriptReference: Serialization.Script.fromCbor(
      HexBlob(output.scriptReference),
    ).toCore(),
  }),
});

const toUtxo = (utxo: ScenarioUtxo): Cardano.Utxo => [
  {
    txId: Cardano.TransactionId(utxo.txId),
    index: utxo.index,
    address: Cardano.PaymentAddress(utxo.address),
  },
  toTxOut(utxo),
];

const toProtocolParameters = (
  parameters: ScenarioProtocolParameters,
): TransactionBuilderProtocolParameters => ({
  minFeeCoefficient: parameters.minFeeCoefficient,
  minFeeConstant: parameters.minFeeConstant,
  prices: {
    memory: Number(parameters.prices.memory),
    steps: Number(parameters.prices.steps),
  },
  coinsPerUtxoByte: parameters.coinsPerUtxoByte,
  maxTxSize: parameters.maxTxSize,
  maxValueSize: parameters.maxValueSize,
  collateralPercentage: parameters.collateralPercentage,
  maxCollateralInputs: parameters.maxCollateralInputs,
  stakeKeyDeposit: parameters.stakeKeyDeposit,
  poolDeposit: parameters.poolDeposit,
  minFeeRefScriptCostPerByte: parameters.minFeeRefScriptCostPerByte,
  refScriptCostStride: parameters.refScriptCostStride,
  refScriptCostMultiplier: parameters.refScriptCostMultiplier,
  protocolVersion: parameters.protocolVersion,
});

const toCostModels = (
  costModels: ScenarioProtocolParameters['costModels'],
): Cardano.CostModels =>
  new Map(
    Object.entries(costModels).map(([language, costs]) => [
      LANGUAGES[language as keyof typeof LANGUAGES],
      costs,
    ]),
  );

/**
 * Evaluates every redeemer to the execution units the scenario lists for
 * its purpose and index.
 */
const fixedEvaluator = (
  scenario: Pick<Scenario, 'executionUnits'>,
): TxEvaluator => ({
  evaluate: async tx =>
    (tx.witness.redeemers ?? []).map(({ purpose, index }) => {
      const units = scenario.executionUnits?.find(
        entry => entry.purpose === purpose && entry.index === index,
      );
      if (!units) {
        throw new Error(`No execution units for ${purpose}:${index}`);
      }
      return {
        purpose,
        index,
        budget: { memory: units.memory, steps: units.steps },
      };
    }),
});

const stakeCredentialOf = (rewardAccount: string): Cardano.Credential => ({
  type: Cardano.CredentialType.KeyHash,
  hash: Cardano.RewardAccount.toHash(Cardano.RewardAccount(rewardAccount)),
});

const credentialOf = ({
  type,
  hash,
}: {
  type: 'keyHash' | 'scriptHash';
  hash: string;
}): Cardano.Credential => ({
  type:
    type === 'keyHash'
      ? Cardano.CredentialType.KeyHash
      : Cardano.CredentialType.ScriptHash,
  hash: hash as Crypto.Hash28ByteBase16,
});

const redeemerOf = (redeemer: string | undefined) =>
  redeemer ? { redeemer: plutusData(redeemer) } : undefined;

/**
 * Builds a scenario with large-first coin selection.
 *
 * @param scenario - The scenario to build.
 * @returns The unsigned transaction.
 */
export const buildScenario = async (
  scenario: Scenario,
): Promise<Serialization.Transaction> => {
  const { protocolParameters } = scenario;
  const builder = new TransactionBuilder(
    Cardano.NetworkMagics.Preprod,
    toProtocolParameters(protocolParameters),
  )
    .useCoinSelector(new LargeFirstCoinSelector())
    .setChangeAddress(Cardano.PaymentAddress(scenario.changeAddress))
    .setUnspentOutputs(scenario.utxos.map(toUtxo))
    .setValidityInterval({
      invalidBefore:
        scenario.invalidBefore === undefined
          ? undefined
          : Cardano.Slot(scenario.invalidBefore),
      invalidHereafter:
        scenario.invalidHereafter === undefined
          ? undefined
          : Cardano.Slot(scenario.invalidHereafter),
    })
    .setPlutusContext({
      costModels: toCostModels(protocolParameters.costModels),
      txEvaluator: fixedEvaluator(scenario),
    });

  for (const utxo of scenario.referenceInputs ?? []) {
    builder.addReferenceInput(toUtxo(utxo));
  }
  for (const { utxo, redeemer, datum } of scenario.inputs ?? []) {
    builder.addInput(
      toUtxo(utxo),
      redeemer
        ? {
            redeemer: plutusData(redeemer),
            ...(datum && { datum: plutusData(datum) }),
          }
        : undefined,
    );
  }
  for (const output of scenario.outputs ?? []) {
    builder.addOutput(toTxOut(output));
  }
  for (const { cbor, resolvedUtxos } of scenario.subTransactions ?? []) {
    builder.addSubTransaction(
      Serialization.SubTransaction.fromCbor(HexBlob(cbor)),
      resolvedUtxos.map(toUtxo),
    );
  }
  for (const script of scenario.scripts ?? []) {
    builder.attachScript(
      Serialization.Script.fromCbor(HexBlob(script)).toCore(),
    );
  }
  for (const { policyId, assetName, quantity, redeemer } of scenario.mint ??
    []) {
    builder.mintAssets(
      new Map([[Cardano.AssetId(`${policyId}${assetName}`), BigInt(quantity)]]),
      plutusData(redeemer),
    );
  }
  for (const { rewardAccount } of scenario.certificates ?? []) {
    builder.addNewStakeAddressCertificate(
      stakeCredentialOf(rewardAccount),
      BigInt(protocolParameters.stakeKeyDeposit),
    );
  }
  for (const { rewardAccount, quantity } of scenario.withdrawals ?? []) {
    builder.addRewardsWithdrawal(
      Cardano.RewardAccount(rewardAccount),
      BigInt(quantity),
    );
  }
  for (const { rewardAccount, quantity } of scenario.directDeposits ?? []) {
    builder.addDirectDeposit(
      Cardano.RewardAccount(rewardAccount),
      BigInt(quantity),
    );
  }
  for (const {
    rewardAccount,
    ...interval
  } of scenario.accountBalanceIntervals ?? []) {
    builder.addAccountBalanceInterval(
      Cardano.RewardAccount(rewardAccount),
      toAccountBalanceInterval(interval),
    );
  }
  for (const {
    rewardAccount,
    ...interval
  } of scenario.startingAccountBalanceIntervals ?? []) {
    builder.addStartingAccountBalanceInterval(
      Cardano.RewardAccount(rewardAccount),
      toAccountBalanceInterval(interval),
    );
  }
  for (const { label, cbor } of scenario.metadata ?? []) {
    builder.setMetadata(
      BigInt(label),
      Serialization.TransactionMetadatum.fromCbor(HexBlob(cbor)).toCore(),
    );
  }
  for (const keyHash of scenario.requiredSigners ?? []) {
    builder.addRequiredSigner(keyHash as Crypto.Ed25519KeyHashHex);
  }
  for (const guard of scenario.guards ?? []) {
    builder.addGuard(credentialOf(guard), redeemerOf(guard.redeemer));
  }
  if (scenario.collateral) {
    builder
      .setCollateralUtxos(scenario.collateral.utxos.map(toUtxo))
      .setCollateralChangeAddress(
        Cardano.PaymentAddress(scenario.collateral.returnAddress),
      );
  }

  return builder.build();
};

/**
 * Reads the outputs the builders are compared on from a built transaction.
 *
 * @param tx - The built transaction.
 * @returns Its fee, script data hash, collateral, redeemers and CBOR.
 */
export const buildOutputsOf = (tx: Serialization.Transaction): BuildOutputs => {
  const body = tx.body();
  const totalCollateral = body.totalCollateral();
  const subTransactionIds = (body.subTransactions()?.values() ?? []).map(
    subTransaction => subTransaction.getId(),
  );
  return {
    fee: body.fee().toString(),
    scriptDataHash: body.scriptDataHash() ?? null,
    collateral: {
      inputs: (body.collateral()?.toCore() ?? [])
        .map(({ txId, index }) => `${txId}#${index}`)
        .sort(),
      totalCollateral:
        totalCollateral === undefined ? null : totalCollateral.toString(),
      collateralReturn: body.collateralReturn()?.toCbor() ?? null,
    },
    redeemers: (tx.witnessSet().redeemers()?.toCore() ?? [])
      .map(({ purpose, index }) => `${purpose}:${index}`)
      .sort(),
    ...(subTransactionIds.length > 0 && { subTransactionIds }),
    cbor: tx.toCbor(),
  };
};

/**
 * Builds a sub transaction scenario.
 *
 * @param scenario - The scenario to build.
 * @returns The unsigned sub transaction.
 */
export const buildSubTransactionScenario = async (
  scenario: SubTransactionScenario,
): Promise<Serialization.SubTransaction> => {
  const { protocolParameters } = scenario;
  const builder = new SubTransactionBuilder()
    .setValidityInterval({
      invalidBefore:
        scenario.invalidBefore === undefined
          ? undefined
          : Cardano.Slot(scenario.invalidBefore),
      invalidHereafter:
        scenario.invalidHereafter === undefined
          ? undefined
          : Cardano.Slot(scenario.invalidHereafter),
    })
    .setPlutusContext({
      costModels: toCostModels(protocolParameters.costModels),
      txEvaluator: fixedEvaluator(scenario),
    });

  for (const utxo of scenario.inputs ?? []) {
    builder.addInput(toUtxo(utxo));
  }
  for (const { utxo, redeemer, datum } of scenario.scriptInputs ?? []) {
    builder.addInput(toUtxo(utxo), {
      redeemer: plutusData(redeemer),
      ...(datum && { datum: plutusData(datum) }),
    });
  }
  for (const script of scenario.scripts ?? []) {
    builder.attachScript(
      Serialization.Script.fromCbor(HexBlob(script)).toCore(),
    );
  }
  for (const utxo of scenario.referenceInputs ?? []) {
    builder.addReferenceInput(toUtxo(utxo));
  }
  for (const output of scenario.outputs ?? []) {
    builder.addOutput(toTxOut(output));
  }
  for (const { policyId, assetName, quantity, redeemer } of scenario.mint ??
    []) {
    builder.mintAssets(
      new Map([[Cardano.AssetId(`${policyId}${assetName}`), BigInt(quantity)]]),
      redeemerOf(redeemer),
    );
  }
  for (const { rewardAccount, redeemer } of scenario.certificates ?? []) {
    builder.addCertificate(
      {
        __typename: Cardano.CertificateType.Registration,
        stakeCredential: stakeCredentialOf(rewardAccount),
        deposit: BigInt(protocolParameters.stakeKeyDeposit),
      },
      redeemerOf(redeemer),
    );
  }
  for (const { rewardAccount, quantity, redeemer } of scenario.withdrawals ??
    []) {
    builder.addRewardsWithdrawal(
      Cardano.RewardAccount(rewardAccount),
      BigInt(quantity),
      redeemerOf(redeemer),
    );
  }
  for (const { rewardAccount, quantity } of scenario.directDeposits ?? []) {
    builder.addDirectDeposit(
      Cardano.RewardAccount(rewardAccount),
      BigInt(quantity),
    );
  }
  for (const {
    rewardAccount,
    ...interval
  } of scenario.accountBalanceIntervals ?? []) {
    builder.addAccountBalanceInterval(
      Cardano.RewardAccount(rewardAccount),
      toAccountBalanceInterval(interval),
    );
  }
  for (const { label, cbor } of scenario.metadata ?? []) {
    builder.setMetadata(
      BigInt(label),
      Serialization.TransactionMetadatum.fromCbor(HexBlob(cbor)).toCore(),
    );
  }
  for (const keyHash of scenario.requiredSigners ?? []) {
    builder.addRequiredSigner(keyHash as Crypto.Ed25519KeyHashHex);
  }
  for (const guard of scenario.guards ?? []) {
    builder.addGuard(credentialOf(guard), redeemerOf(guard.redeemer));
  }
  for (const guard of scenario.requiredTopLevelGuards ?? []) {
    builder.requireTopLevelGuard(
      credentialOf(guard),
      guard.datum ? plutusData(guard.datum) : undefined,
    );
  }

  return builder.build();
};

/**
 * Reads the outputs the sub transaction builders are compared on.
 *
 * @param subTransaction - The built sub transaction.
 * @returns Its CBOR, id, script data hash and redeemers.
 */
export const subTransactionOutputsOf = (
  subTransaction: Serialization.SubTransaction,
): SubTransactionBuildOutputs => ({
  cbor: subTransaction.toCbor(),
  id: subTransaction.getId(),
  scriptDataHash: subTransaction.body().scriptDataHash() ?? null,
  redeemers: (subTransaction.witnessSet().redeemers()?.toCore() ?? [])
    .map(({ purpose, index }) => `${purpose}:${index}`)
    .sort(),
});
