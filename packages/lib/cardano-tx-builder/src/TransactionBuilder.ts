import {
  Cardano,
  Serialization,
  coalesceValueQuantities,
  setInConwayEra,
} from '@lace-lib/cardano-core';
import { dummyLogger } from 'ts-log';

import {
  accountBalanceInterval,
  accumulateDirectDeposit,
  applyAccountEntries,
} from './account-entries';
import {
  balanceTransaction,
  correctFeeAfterEvaluation,
  isZeroValue,
  type CollateralBodyFields,
} from './balancing';
import { executionUnitsFee } from './exact-fees';
import { batchScriptUsage, minAdaRequired } from './fees';
import { LargeFirstCoinSelector } from './input-selection/LargeFirstCoinSelector';
import { RoundRobinRandomCoinSelector } from './input-selection/RoundRobinRandomCoinSelector';
import { MAX_U64 } from './output-limits';
import {
  applyGuards,
  assertGuardDatums,
  assertRedeemersMatchPlutusScripts,
  assertSpentDatumsProvided,
  carriedPlutusScripts,
  carriedScripts,
  certificateWitnessCredential,
  guardKey,
  indexRedeemers,
  paymentScriptHash,
  recordDatum,
  recordGuard,
  redeemedScriptHashes,
  redeemerCount,
  scriptDataLanguages,
  scriptHashes,
  scriptPurposes,
  utxoRefKey,
} from './redeemers';
import {
  missingReferenceScriptTiers,
  referenceScriptFee,
} from './reference-scripts';
import { computeConwayScriptDataHash } from './script-data-hash';
import { auxiliaryDataHash, serializeTransaction } from './serialization';
import {
  findUtxo,
  inputKey,
  subTransactionInputs,
  subTransactionsImbalance,
} from './sub-transactions';
import { resolveSlotNo } from './time';

import type { CoinSelector } from './input-selection/types';
import type { RedeemerSources, ScriptPurpose } from './redeemers';
import type {
  TransactionBuilderProtocolParameters,
  TxEvaluator,
} from './types';
import type * as Crypto from '@lace-lib/cardano-crypto';
import type { Logger } from 'ts-log';

/** Script-unlock witness data for spending a UTxO that sits at a script address. */
export interface ScriptInputProps {
  redeemer: Cardano.PlutusData;
  /** Inline datum is read from the UTxO; supply only when the datum is provided by hash. */
  datum?: Cardano.PlutusData;
}

/**
 * Script witness data for a certificate whose witnessing credential is a
 * script hash. The script itself is attached separately with `attachScript`
 * or read from a reference input.
 */
interface ScriptCertificateProps {
  /** Redeemer for the certificate (Conway `publish`) purpose. */
  redeemer: Cardano.PlutusData;
}

/**
 * Script witness data for a guard whose credential is a Plutus script hash.
 * The script itself is attached separately with `attachScript` or read from
 * a reference input.
 */
export interface ScriptGuardProps {
  /** Redeemer for the guarding purpose. */
  redeemer: Cardano.PlutusData;
}

/**
 * The Plutus context the builder needs to evaluate redeemer execution units and
 * compute the script-data-hash. Only required when the transaction carries
 * Plutus scripts; pure-payment / certificate transactions never touch it.
 */
export interface PlutusContext {
  /**
   * FULL protocol cost models (incl. the Plutus V3 and V4 cost models). The
   * script-data-hash is computed over ONLY the language views of the scripts
   * actually attached — a stray V1/V2 view would make the node's recomputed
   * hash diverge.
   */
  costModels: Cardano.CostModels;
  /**
   * Computes redeemer execution units. Supply a provider-backed evaluator
   * (Ogmios / Blockfrost `evaluate`) for tight fees, or a fixed-budget
   * evaluator for a deterministic, network-free build.
   */
  txEvaluator: TxEvaluator;
  /**
   * Not read by the builder.
   *
   * @deprecated The builder resolves every input it spends from the UTxOs it
   *   holds, added with `addInput` or picked from `setUnspentOutputs`, with
   *   their datums and reference scripts, so it needs no input resolver.
   */
  inputResolver?: Cardano.InputResolver;
  /**
   * The execution units the caller expects every redeemer together to
   * measure. Balancing then prices the fee, and the collateral reservation,
   * at this estimate instead of the per-transaction maximum, so the inputs
   * need to cover little more than the real fee. The fee is linear in the
   * total units, so one total serves every redeemer.
   *
   * The fee is never raised after evaluation: when the evaluated units need
   * more fee than balancing funded, {@link TransactionBuilder.build} fails with
   * `EvaluatedFeeShortfallError`, and the caller rebuilds at a larger
   * estimate. Without an estimate the builder prices the per-transaction
   * maximum, which no valid transaction exceeds.
   */
  executionUnitsEstimate?: Cardano.ExUnits;
}

/**
 * Per-TX ex-units budget used to SEED the witness before balancing — split
 * across redeemers by `seedRedeemers` — so the balancer's `minFee` prices
 * script execution, unless the {@link PlutusContext} gives an estimate. The
 * injected evaluator replaces the seeds with concrete budgets after
 * balancing, before the script-data-hash is computed. A generous figure (the
 * Plutus V3 mainnet per-tx max) is safe here: it only inflates the
 * pre-balance fee estimate, which the evaluator corrects.
 */
const SEED_EX_UNITS: Cardano.ExUnits = {
  memory: 14_000_000,
  steps: 10_000_000_000,
};

/**
 * 32-byte zero placeholder for `scriptDataHash` written into the tx body
 * before balancing starts, so that `minFee` accounts for the 35-byte CBOR
 * field during fee estimation. Replaced by the real hash in finalizePlutusTx.
 */
const DUMMY_SCRIPT_INTEGRITY_HASH = '0'.repeat(64) as Crypto.Hash32ByteBase16;

/** The reference of a UTxO, as a collateral input lists it. */
const toTxIn = ([{ txId, index }]: Cardano.Utxo): Cardano.TxIn => ({
  txId,
  index,
});

/**
 * Fallback collateral amount (5 ADA), used when the fee or the
 * collateralPercentage protocol parameter is 0 and the proportional
 * `ceil(fee * collateralPercentage / 100)` cannot be derived.
 */
const COLLATERAL_COVERAGE_TARGET = 5_000_000n;

/**
 * Thrown when the available collateral UTxOs cannot fund the required
 * collateral and still leave a return output that meets the min-ADA rule.
 */
export class InsufficientCollateralError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InsufficientCollateralError';
  }
}

export {
  ExtraneousRedeemerError,
  MalformedGuardDatumError,
  MissingDatumError,
  MissingRedeemerError,
} from './redeemers';

/**
 * Thrown when a sub transaction requires the transaction that carries it to
 * carry a guard it lacks. The builder never adds the guard on the batcher's
 * behalf, since a key hash guard also makes its key a required signer.
 */
export class MissingTopLevelGuardError extends Error {
  public constructor(
    readonly subTransactionId: Cardano.TransactionId,
    readonly guard: Cardano.Credential,
  ) {
    super(
      `Sub transaction ${subTransactionId} requires the top level guard ${guard.hash}, which the transaction does not carry; add it with addGuard`,
    );
    this.name = 'MissingTopLevelGuardError';
  }
}

/**
 * Thrown when the transaction or one of its sub transactions carries
 * redeemers but no collateral UTxOs or no collateral change address are
 * set. The ledger requires collateral whenever any level of a batch runs a
 * Plutus script with a redeemer.
 */
export class MissingCollateralError extends Error {
  public constructor() {
    super(
      'The transaction or one of its sub transactions carries redeemers, so it must post collateral; set the collateral UTxOs with setCollateralUtxos and the collateral change address with setCollateralChangeAddress',
    );
    this.name = 'MissingCollateralError';
  }
}

/**
 * Thrown when the transaction runs a PlutusV1, PlutusV2 or PlutusV3 script
 * and its sub transactions do not balance between themselves. The ledger
 * then validates the transaction in legacy mode, where it must also conserve
 * value on its own, with its sub transactions removed, so its inputs and
 * change cannot absorb what the sub transactions leave to or take from the
 * batch. A balancing sub transaction can.
 */
export class UnbalancedSubTransactionsError extends Error {
  public constructor(
    /** What the sub transactions consume minus what they produce. */
    readonly imbalance: Cardano.Value,
  ) {
    super(
      `The transaction runs a PlutusV1, PlutusV2 or PlutusV3 script, so its sub transactions must balance between themselves, but they consume ${
        imbalance.coins
      } lovelace${
        [...(imbalance.assets?.values() ?? [])].some(
          quantity => quantity !== 0n,
        )
          ? ' and native assets'
          : ''
      } more than they produce; add a balancing sub transaction`,
    );
    this.name = 'UnbalancedSubTransactionsError';
  }
}

/**
 * Thrown when the transaction runs a PlutusV1, PlutusV2 or PlutusV3 script,
 * carries sub transactions and attaches a datum that only they allow. The
 * ledger then checks the datums of the transaction with its sub transactions
 * removed: each must be needed by an input it spends at a Plutus script
 * address, or match the datum hash of one of its outputs or of an output
 * one of its reference inputs points to.
 */
export class NotAllowedSupplementalDatumError extends Error {
  public constructor(readonly datumHash: Cardano.DatumHash) {
    super(
      `The transaction runs a PlutusV1, PlutusV2 or PlutusV3 script, so it may not carry the datum ${datumHash}, which no input it spends needs and no output it creates or references names`,
    );
    this.name = 'NotAllowedSupplementalDatumError';
  }
}

/**
 * The last protocol version of the Babbage era. The ledger refuses a
 * transaction that spends an input it also references from the next
 * version until version 11.
 */
const BABBAGE_MAX_PROTOCOL_VERSION = 8;

/** The protocol version from which the ledger again lets a transaction spend an input it also references. */
const SPENT_REFERENCE_INPUTS_PROTOCOL_VERSION = 11;

/**
 * The Plutus languages whose scripts cannot see sub transactions. The
 * ledger validates a transaction that runs one of them in legacy mode.
 */
const LEGACY_PLUTUS_LANGUAGES: ReadonlySet<Cardano.PlutusLanguageVersion> =
  new Set([
    Cardano.PlutusLanguageVersion.V1,
    Cardano.PlutusLanguageVersion.V2,
    Cardano.PlutusLanguageVersion.V3,
  ]);

/** The redeemers the witness set of a sub transaction carries. */
const subTransactionRedeemers = (
  subTransaction: Serialization.SubTransaction,
): Cardano.Redeemer[] =>
  subTransaction.witnessSet().redeemers()?.toCore() ?? [];

/**
 * Builds Cardano transactions: transfers, certificates and, with a
 * {@link PlutusContext}, Plutus script transactions. `build()` balances the
 * transaction, evaluates the execution units of any scripts it runs and
 * resolves with it unsigned.
 *
 * Its parts are inputs, reference inputs, outputs, certificates, direct
 * deposits, account balance intervals, a treasury donation, native script
 * mints, supplemental datums and, for Plutus smart-contract spends, mints,
 * script spends, script certificates and script withdrawals and script
 * guards with their redeemers, collateral and required signers.
 */
export class TransactionBuilder {
  private readonly params: TransactionBuilderProtocolParameters;
  private readonly transaction: Serialization.Transaction;
  private readonly preSelectedUtxos: Cardano.Utxo[] = [];
  private readonly referenceUtxos: Cardano.Utxo[] = [];
  /** Sub transactions the body carries, in the order added, each with the bytes it was given in. */
  private readonly subTransactions: Serialization.SubTransaction[] = [];
  /** The resolved UTxOs the sub transactions spend. */
  private readonly subTransactionUtxos: Cardano.Utxo[] = [];
  /** Pools already registered on chain, whose registration takes no pool deposit. */
  private registeredPools: ReadonlySet<Cardano.PoolId> = new Set();
  /** Where the builder reports conditions that do not stop a build. */
  private logger: Logger = dummyLogger;
  /** The resolved UTxOs the sub transactions reference. */
  private readonly subTransactionReferenceUtxos: Cardano.Utxo[] = [];
  private readonly certificates: Cardano.Certificate[] = [];
  private readonly withdrawals: Map<Cardano.RewardAccount, Cardano.Lovelace> =
    new Map();
  /** Direct deposits keyed by reward account, each the sum of its deposits. */
  private readonly directDeposits = new Map<
    Cardano.RewardAccount,
    Cardano.Lovelace
  >();
  /** Account balance intervals keyed by reward account, the last one added for each. */
  private readonly accountBalanceIntervals = new Map<
    Cardano.RewardAccount,
    Cardano.AccountBalanceInterval
  >();
  /** Starting account balance intervals keyed by reward account, the last one added for each. */
  private readonly startingAccountBalanceIntervals = new Map<
    Cardano.RewardAccount,
    Cardano.AccountBalanceInterval
  >();
  private coinSelector: CoinSelector = new RoundRobinRandomCoinSelector();
  private changeAddress?: Cardano.PaymentAddress;
  private availableUtxos: Cardano.Utxo[] = [];
  private networkMagic: Cardano.NetworkMagics;

  // --- Plutus state ---------------------------------------------------------
  private plutusContext?: PlutusContext;
  private readonly scripts: Cardano.Script[] = [];
  private readonly datums: Cardano.PlutusData[] = [];
  /** Guards keyed by {@link guardKey}, in the order they were added. */
  private readonly guards = new Map<string, Cardano.Credential>();
  private mint?: Cardano.TokenMap;
  /** Spend redeemers keyed by `${txId}#${index}` (canonical index assigned at build). */
  private readonly spendRedeemers = new Map<string, Cardano.PlutusData>();
  /** Mint redeemers keyed by PolicyId (canonical index assigned at build). */
  private readonly mintRedeemers = new Map<
    Cardano.PolicyId,
    Cardano.PlutusData
  >();
  /** Withdrawal redeemers keyed by RewardAccount (canonical index assigned at build). */
  private readonly withdrawalRedeemers = new Map<
    Cardano.RewardAccount,
    Cardano.PlutusData
  >();
  /** Certificate redeemers keyed by the certificate entry in `certificates`. */
  private readonly certificateRedeemers = new Map<
    Cardano.Certificate,
    Cardano.PlutusData
  >();
  /** Guarding redeemers keyed by {@link guardKey} (index assigned at build). */
  private readonly guardRedeemers = new Map<string, Cardano.PlutusData>();
  private collateralUtxos: Cardano.Utxo[] = [];
  private collateralReturnAddress?: Cardano.PaymentAddress;
  private validityInterval?: Cardano.ValidityInterval;
  private donation?: Cardano.Lovelace;

  /**
   * Creates a new {@link TransactionBuilder}.
   *
   * Initializes an empty transaction body (no inputs/outputs, fee `0n`),
   * and sets Conway era mode for `@cardano-sdk/core` serialization.
   *
   * @param networkMagic - Cardano network magic (e.g. `Mainnet`, `Preprod`, `Preview`).
   * @param params - Protocol parameters to be used during balancing and fee/min-ADA calculations.
   */
  public constructor(
    networkMagic: Cardano.NetworkMagics,
    params: TransactionBuilderProtocolParameters,
  ) {
    setInConwayEra(true);
    this.params = params;
    this.transaction = new Serialization.Transaction(
      new Serialization.TransactionBody(
        Serialization.CborSet.fromCore(
          [],
          Serialization.TransactionInput.fromCore,
        ),
        [],
        0n,
        undefined,
      ),
      Serialization.TransactionWitnessSet.fromCore({ signatures: new Map() }),
    );
    this.networkMagic = networkMagic;
  }

  /**
   * Sets the change (return) address used by the balancer when creating a change output.
   *
   * @param address - Bech32 payment address for change.
   * @returns `this` for fluent chaining.
   */
  public setChangeAddress(address: Cardano.PaymentAddress): TransactionBuilder {
    this.changeAddress = address;
    return this;
  }

  /**
   * Replaces the coin selection strategy.
   *
   * Balancing keeps a deterministic {@link LargeFirstCoinSelector} fallback:
   * when the supplied selector fails, balancing is retried once with
   * Large-First. The fallback is omitted when the supplied selector is itself
   * Large-First, as retrying the same deterministic strategy cannot succeed.
   *
   * @param selector - A {@link CoinSelector} implementation.
   * @returns `this` for fluent chaining.
   */
  public useCoinSelector(selector: CoinSelector): TransactionBuilder {
    this.coinSelector = selector;
    return this;
  }

  /**
   * Sets the network on the transaction body (Mainnet/Testnet) and updates internal `networkMagic`.
   *
   * @param networkMagic - Cardano network magic.
   * @returns `this` for fluent chaining.
   */
  public setNetwork(networkMagic: Cardano.NetworkMagics): TransactionBuilder {
    const body = this.transaction.body();
    const networkId =
      networkMagic === Cardano.NetworkMagics.Mainnet
        ? Cardano.NetworkId.Mainnet
        : Cardano.NetworkId.Testnet;
    body.setNetworkId(networkId);

    this.networkMagic = networkMagic;
    this.transaction.setBody(body);

    return this;
  }

  /**
   * Provides the set of UTxOs that are available for selection during balancing.
   *
   * @param utxos - Available unspent transaction outputs.
   * @returns `this` for fluent chaining.
   */
  public setUnspentOutputs(utxos: Cardano.Utxo[]): TransactionBuilder {
    this.availableUtxos = utxos;
    return this;
  }

  /**
   * Sets the logger the builder reports conditions that do not stop a
   * build to, such as a fee priced with fallback values for protocol
   * parameters the network should set. Without one nothing is reported.
   *
   * @param logger - The logger to report to.
   * @returns `this` for fluent chaining.
   */
  public setLogger(logger: Logger): TransactionBuilder {
    this.logger = logger;
    return this;
  }

  /**
   * Tells the builder which pools are already registered on chain. A pool
   * registration certificate for such a pool, in the transaction or in one
   * of its sub transactions, updates the pool's parameters, and the ledger
   * charges no pool deposit for it, so balancing charges none either.
   * Setting them again replaces them.
   *
   * @param poolIds - The ids of the registered pools among the ones the
   *   transaction or its sub transactions register.
   * @returns `this` for fluent chaining.
   */
  public setRegisteredPools(poolIds: Cardano.PoolId[]): TransactionBuilder {
    this.registeredPools = new Set(poolIds);
    return this;
  }

  /**
   * Supplies the Plutus context (cost models + ex-units evaluator) required
   * to build a smart-contract transaction. Required before
   * {@link build} if any Plutus script is attached.
   *
   * @param context - See {@link PlutusContext}.
   * @returns `this` for fluent chaining.
   */
  public setPlutusContext(context: PlutusContext): TransactionBuilder {
    this.plutusContext = context;
    return this;
  }

  /**
   * Adds a specific input (preselected UTxO) to the transaction.
   *
   * The input is also recorded as "preselected" so the balancer will ensure it
   * remains included. For a UTxO at a script address, pass
   * {@link ScriptInputProps} with the spend redeemer (and, when the datum is by
   * hash, the datum).
   *
   * A Plutus script the UTxO carries witnesses every redeemer that runs it,
   * as a reference input's script does.
   *
   * @throws If the same input (same txId and index) is added more than once,
   *   is spent by a sub transaction, is already a reference input under a
   *   protocol version that refuses spending a referenced input, or `script`
   *   is given for an input whose address has no script payment credential.
   *
   * @param utxo - The UTxO to add as an input.
   * @param script - Optional script-unlock data for a script input.
   * @returns `this` for fluent chaining.
   */
  public addInput(
    utxo: Cardano.Utxo,
    script?: ScriptInputProps,
  ): TransactionBuilder {
    if (script && !paymentScriptHash(utxo[1].address)) {
      throw new Error(
        `Spend redeemer requires an input at a script address, got ${utxoRefKey(
          utxo,
        )}`,
      );
    }
    if (this.refusesSpendingReferencedInputs() && this.isReferenced(utxo)) {
      throw new Error(
        `Cannot spend an input the transaction references: ${utxoRefKey(utxo)}`,
      );
    }
    if (findUtxo(this.subTransactionUtxos, utxo[0])) {
      throw new Error(
        `Cannot spend an input a sub transaction spends: ${utxoRefKey(utxo)}`,
      );
    }
    const body = this.transaction.body();
    const inputs = body.inputs();
    const values = [...inputs.values()];
    if (
      values.find(
        value =>
          Number(value.index()) == utxo[0].index &&
          value.transactionId() == utxo[0].txId,
      )
    ) {
      throw new Error('Cannot add duplicate input to the transaction');
    }
    values.push(Serialization.TransactionInput.fromCore(utxo[0]));
    inputs.setValues(values);

    body.setInputs(inputs);
    this.transaction.setBody(body);
    this.preSelectedUtxos.push(utxo);

    if (script) {
      const [txIn] = utxo;
      this.spendRedeemers.set(`${txIn.txId}#${txIn.index}`, script.redeemer);
      if (script.datum !== undefined) recordDatum(this.datums, script.datum);
    }

    return this;
  }

  /**
   * Adds a reference input: a UTxO the transaction reads without spending,
   * such as a state output a validator inspects. Balancing never selects it.
   *
   * The builder resolves the input from `utxo` itself. Ex-unit evaluation
   * receives that resolution, and the fee and the collateral reservation price
   * any reference script it carries at `minFeeRefScriptCostPerByte`.
   *
   * A Plutus script the UTxO carries witnesses every redeemer that runs it,
   * as the ledger allows, and its language joins the script data hash when
   * a redeemer runs it. Attach only the scripts no reference input carries:
   * the ledger refuses a script provided both ways.
   *
   * @throws If the UTxO is already a reference input, or a spent input under
   *   a protocol version that refuses spending a referenced input.
   *
   * @param utxo - The resolved UTxO to reference.
   * @returns `this` for fluent chaining.
   */
  public addReferenceInput(utxo: Cardano.Utxo): TransactionBuilder {
    const key = utxoRefKey(utxo);
    if (this.isReferenced(utxo)) {
      throw new Error(`Cannot add duplicate reference input: ${key}`);
    }
    if (
      this.refusesSpendingReferencedInputs() &&
      this.preSelectedUtxos.some(spent => utxoRefKey(spent) === key)
    ) {
      throw new Error(
        `Cannot reference an input the transaction spends: ${key}`,
      );
    }
    this.referenceUtxos.push(utxo);
    return this;
  }

  /**
   * Appends a new output to the transaction body.
   *
   * @param output - Core output containing destination address and `Value`
   *   (ADA and/or assets), optionally an inline `datum`.
   * @returns `this` for fluent chaining.
   */
  public addOutput(output: Cardano.TxOut): TransactionBuilder {
    const body = this.transaction.body();

    const outputs = body.outputs();
    outputs.push(Serialization.TransactionOutput.fromCore(output));
    body.setOutputs(outputs);
    this.transaction.setBody(body);

    return this;
  }

  /**
   * Sets the transaction to be valid for a specific duration from now.
   *
   * This is a convenience method that calculates a future expiration date and sets it.
   * The transaction will be marked as invalid if it is not included in a block
   * within the specified duration.
   *
   * @param seconds - The number of seconds from now that the transaction should remain valid.
   * @returns The builder instance for chaining.
   */
  public expiresIn(seconds: number): TransactionBuilder {
    const body = this.transaction.body();

    const now = Date.now() / 1000;
    const unixTime = Math.floor(now + seconds) * 1000;
    const slot = resolveSlotNo(this.networkMagic, unixTime);

    body.setTtl(slot);
    this.transaction.setBody(body);

    return this;
  }

  /**
   * Sets the validity interval (e.g. an `invalidHereafter` TTL slot) directly.
   * Applied to the body during {@link build}.
   *
   * @param validityInterval - The validity interval to set.
   * @returns `this` for fluent chaining.
   */
  public setValidityInterval(
    validityInterval: Cardano.ValidityInterval,
  ): TransactionBuilder {
    this.validityInterval = validityInterval;
    return this;
  }

  /**
   * Adds a transaction output to send a value (lovelace and/or other assets) to an address.
   *
   * @param address - The recipient's address as a bech32 string.
   * @param value - The value object, containing the coins and/or other assets to send.
   * @returns The builder instance for chaining.
   */
  public transferValue(
    address: Cardano.PaymentAddress,
    value: Cardano.Value,
  ): TransactionBuilder {
    return this.addOutput({
      address,
      value,
    });
  }

  /**
   * Attaches a Plutus (or native) script to the witness set.
   *
   * @param script - The script to attach.
   * @returns `this` for fluent chaining.
   */
  public attachScript(script: Cardano.Script): TransactionBuilder {
    this.scripts.push(script);
    return this;
  }

  /**
   * Mints (or burns, with negative quantities) assets under a policy. A
   * Plutus policy needs its mint redeemer, whose canonical index (position of
   * the policy in the sorted mint map) is assigned during {@link build}. A
   * native policy needs none: its script, attached with {@link attachScript}
   * or read from a reference input, witnesses the mint. The keys an attached
   * native script requires are counted as signers; for a script read from a
   * reference input, add them with {@link addRequiredSigner}.
   *
   * @param assets - The assets to mint or burn.
   * @param redeemer - The mint redeemer of a Plutus policy.
   * @returns `this` for fluent chaining.
   */
  public mintAssets(
    assets: Cardano.TokenMap,
    redeemer?: Cardano.PlutusData,
  ): TransactionBuilder {
    this.mint = new Map([...(this.mint ?? []), ...assets]);
    if (redeemer !== undefined) {
      for (const assetId of assets.keys()) {
        this.mintRedeemers.set(Cardano.AssetId.getPolicyId(assetId), redeemer);
      }
    }
    return this;
  }

  /**
   * Adds a datum to the witness set, such as the datum of an output the
   * transaction creates locked by its hash, or of an output it spends. The
   * script data hash covers it, and a datum already in the witness set is
   * not added again.
   *
   * @param datum - The datum to add.
   * @returns `this` for fluent chaining.
   */
  public addDatum(datum: Cardano.PlutusData): TransactionBuilder {
    recordDatum(this.datums, datum);
    return this;
  }

  /**
   * Donates lovelace to the treasury. Balancing funds the donation from the
   * wallet like an output. Setting it again replaces it, and a donation of
   * zero removes it, as the ledger accepts only a positive one.
   *
   * @param donation - The lovelace to donate.
   * @throws If `donation` is negative or exceeds the largest unsigned 64-bit
   *   integer.
   * @returns `this` for fluent chaining.
   */
  public setDonation(donation: Cardano.Lovelace): TransactionBuilder {
    if (donation < 0n) {
      throw new Error(`Donation must not be negative, got ${donation}`);
    }
    if (donation > MAX_U64) {
      throw new Error(
        `Donation exceeds the maximum of ${MAX_U64} lovelace, got ${donation}`,
      );
    }
    this.donation = donation === 0n ? undefined : donation;
    return this;
  }

  /**
   * Marks an extra key hash as a required signer (e.g. Plutus scripts that
   * check `extra_signatories`). A required signer is a key hash guard, so it
   * takes its place among the guards added with {@link addGuard}.
   *
   * @param keyHash - The Ed25519 key hash to require.
   * @returns `this` for fluent chaining.
   */
  public addRequiredSigner(
    keyHash: Crypto.Ed25519KeyHashHex,
  ): TransactionBuilder {
    return this.addGuard({
      type: Cardano.CredentialType.KeyHash,
      hash: keyHash as unknown as Crypto.Hash28ByteBase16,
    });
  }

  /**
   * Requires a guard to approve the transaction. A key hash guard is a
   * required signer: the transaction must carry a witness for the key. A
   * script hash guard makes the ledger run the script as a validity
   * condition; a Plutus script needs the guarding redeemer given in `script`.
   * The script itself is attached with `attachScript` or read from a
   * reference input.
   *
   * Guards keep the order they were added in, required signers included,
   * and a guarding redeemer's index is its guard's position among them.
   * Adding a guard again keeps its position. While every guard is a key
   * hash the body lists them as required signers; a script hash guard
   * switches the body to the credential form, valid from the Dijkstra era.
   *
   * @param guard - The key hash or script hash credential to require.
   * @param script - Guarding redeemer for a Plutus script hash `guard`.
   * @throws If `script` is given for a key hash guard, or the guard already
   *   has a redeemer.
   * @returns `this` for fluent chaining.
   */
  public addGuard(
    guard: Cardano.Credential,
    script?: ScriptGuardProps,
  ): TransactionBuilder {
    recordGuard(
      { guards: this.guards, guardRedeemers: this.guardRedeemers },
      guard,
      script?.redeemer,
    );
    return this;
  }

  /**
   * Sets the pool of UTxOs the builder may draw collateral from for a Plutus
   * transaction. The builder selects largest-first and may combine several to
   * cover the required collateral. A collateral return sends the unused portion
   * (incl. native assets) to the collateral change address on script failure;
   * an ADA-only remainder below min-ADA may be absorbed into total collateral.
   *
   * The pool may overlap `setUnspentOutputs`; overlapping UTxOs may be spent as
   * funding inputs on success. To keep a dedicated collateral UTxO unspent,
   * supply it only here, not to `setUnspentOutputs` or `addInput`.
   *
   * @param utxos - Candidate collateral UTxOs (need not be pure ADA).
   * @returns `this` for fluent chaining.
   */
  public setCollateralUtxos(utxos: Cardano.Utxo[]): TransactionBuilder {
    this.collateralUtxos = utxos;
    return this;
  }

  /**
   * Sets the address that receives the unused collateral (the collateral
   * return).
   *
   * @param address - Address that receives the collateral return.
   * @returns `this` for fluent chaining.
   */
  public setCollateralChangeAddress(
    address: Cardano.PaymentAddress,
  ): TransactionBuilder {
    this.collateralReturnAddress = address;
    return this;
  }

  /**
   * Attaches a memo/message as auxiliary data using label `674` with the `msg` field (CIP-20 style).
   *
   * @param memo - Human-readable memo text.
   * @returns `this` for fluent chaining.
   */
  public setMemo(memo: string): TransactionBuilder {
    return this.setMetadata(674n, new Map([['msg', [memo]]]));
  }

  /**
   * Sets a transaction metadata entry under the given label, preserving any
   * previously set entries (including those added via {@link setMemo}). Calling
   * with an existing label overwrites that label's value.
   *
   * @param label - Metadata label (e.g. `674` for CIP-20 messages, `721` for CIP-25 NFT metadata).
   * @param metadatum - The metadatum value to associate with the label.
   * @returns `this` for fluent chaining.
   */
  public setMetadata(
    label: bigint,
    metadatum: Cardano.Metadatum,
  ): TransactionBuilder {
    const existing = this.transaction.auxiliaryData()?.toCore();
    const blob = new Map(existing?.blob);
    blob.set(label, metadatum);
    this.transaction.setAuxiliaryData(
      Serialization.AuxiliaryData.fromCore({ ...existing, blob }),
    );

    return this;
  }

  /**
   * Adds a certificate. When a Plutus script credential witnesses the
   * certificate, the stake credential of a stake certificate, the DRep
   * credential of a DRep certificate or the cold credential of a committee
   * certificate, its redeemer is given in `script`.
   *
   * A pool registration is charged the pool deposit once per pool across
   * the transaction and its sub transactions, as the ledger charges it. A
   * registration that updates the parameters of a pool already registered
   * on chain is charged nothing once the pool is given to
   * {@link setRegisteredPools}, and is charged otherwise, as the builder
   * cannot know the pool is registered. A pool retirement refunds nothing in
   * the transaction, as the ledger returns its deposit at the epoch
   * boundary.
   *
   * @param certificate - The certificate to add.
   * @param script - Certificate redeemer for a script hash credential.
   *   Its canonical index is assigned during {@link build}.
   * @throws If `script` is given for a certificate no script hash credential
   *   witnesses, such as a legacy stake registration.
   * @returns `this` for fluent chaining.
   */
  public addCertificate(
    certificate: Cardano.Certificate,
    script?: ScriptCertificateProps,
  ): TransactionBuilder {
    const credential = certificateWitnessCredential(certificate);
    if (script && credential?.type !== Cardano.CredentialType.ScriptHash) {
      throw new Error(
        `Certificate redeemer requires a script hash credential that witnesses the certificate, got ${certificate.__typename}`,
      );
    }
    this.certificates.push(certificate);
    if (script) this.certificateRedeemers.set(certificate, script.redeemer);
    return this;
  }

  /**
   * Adds a stake delegation certificate to delegate stake to a pool.
   *
   * @param poolId - The ID of the stake pool to delegate to.
   * @param stakeCredential - The stake credential (key hash or script hash) being delegated.
   * @param script - Certificate redeemer for a script-hash `stakeCredential`.
   *   Its canonical index is assigned during {@link build}.
   * @throws If `script` is given for a key-hash credential.
   * @returns `this` for fluent chaining.
   */
  public addStakeDelegationCertificate(
    poolId: Cardano.PoolId,
    stakeCredential: Cardano.Credential,
    script?: ScriptCertificateProps,
  ): TransactionBuilder {
    const certificate: Cardano.StakeDelegationCertificate = {
      __typename: Cardano.CertificateType.StakeDelegation,
      poolId,
      stakeCredential,
    };
    return this.addCertificate(certificate, script);
  }

  /**
   * Adds a Conway-era combined stake registration + delegation certificate.
   * This registers the stake key and delegates to a pool in a single certificate.
   *
   * @param poolId - The pool to delegate to.
   * @param stakeCredential - The stake credential to register and delegate.
   * @param deposit - The deposit amount in lovelace.
   * @returns `this` for fluent chaining.
   */
  public addStakeRegistrationDelegationCertificate(
    poolId: Cardano.PoolId,
    stakeCredential: Cardano.Credential,
    deposit: bigint,
  ): TransactionBuilder {
    const certificate: Cardano.StakeRegistrationDelegationCertificate = {
      __typename: Cardano.CertificateType.StakeRegistrationDelegation,
      poolId,
      stakeCredential,
      deposit,
    };
    return this.addCertificate(certificate);
  }

  /**
   * Adds a Conway-era stake registration certificate with deposit.
   * This registers the stake key.
   *
   * @param stakeCredential - The stake credential to register and delegate.
   * @param deposit - The deposit amount in lovelace.
   * @param script - Certificate redeemer for a script-hash `stakeCredential`.
   *   Its canonical index is assigned during {@link build}.
   * @throws If `script` is given for a key-hash credential.
   * @returns `this` for fluent chaining.
   */
  public addNewStakeAddressCertificate(
    stakeCredential: Cardano.Credential,
    deposit: bigint,
    script?: ScriptCertificateProps,
  ): TransactionBuilder {
    const certificate: Cardano.NewStakeAddressCertificate = {
      __typename: Cardano.CertificateType.Registration,
      stakeCredential,
      deposit,
    };
    return this.addCertificate(certificate, script);
  }

  /**
   * Adds a Conway-era stake unregistration certificate.
   * This de-registers the stake key and returns the deposit.
   *
   * @param stakeCredential - The stake credential to deregister.
   * @param deposit - The deposit amount in lovelace to be returned.
   * @returns `this` for fluent chaining.
   */
  public addStakeDeregistrationCertificate(
    stakeCredential: Cardano.Credential,
    deposit: bigint,
  ): TransactionBuilder {
    const certificate: Cardano.NewStakeAddressCertificate = {
      __typename: Cardano.CertificateType.Unregistration,
      stakeCredential,
      deposit,
    };
    return this.addCertificate(certificate);
  }

  /**
   * Adds a Conway-era vote delegation certificate.
   * This delegates the stake credential's voting power to a DRep.
   *
   * @param stakeCredential - The stake credential delegating its vote.
   * @param dRep - The delegate representative to delegate to (credential, AlwaysAbstain, or AlwaysNoConfidence).
   * @returns `this` for fluent chaining.
   */
  public addVoteDelegationCertificate(
    stakeCredential: Cardano.Credential,
    dRep: Cardano.DelegateRepresentative,
  ): TransactionBuilder {
    const certificate: Cardano.VoteDelegationCertificate = {
      __typename: Cardano.CertificateType.VoteDelegation,
      stakeCredential,
      dRep,
    };
    return this.addCertificate(certificate);
  }

  /**
   * Adds a Conway-era combined stake registration + vote delegation certificate.
   * Registers the stake key and delegates voting power to a DRep in a single certificate.
   *
   * @param dRep - The DRep to delegate voting power to.
   * @param stakeCredential - The stake credential to register and delegate.
   * @param deposit - The stake key deposit amount in lovelace.
   * @returns `this` for fluent chaining.
   */
  public addVoteRegistrationDelegationCertificate(
    dRep: Cardano.DelegateRepresentative,
    stakeCredential: Cardano.Credential,
    deposit: bigint,
  ): TransactionBuilder {
    const certificate: Cardano.VoteRegistrationDelegationCertificate = {
      __typename: Cardano.CertificateType.VoteRegistrationDelegation,
      dRep,
      stakeCredential,
      deposit,
    };
    return this.addCertificate(certificate);
  }

  /**
   * @param rewardAccount - stake address to withdraw rewards from
   * @param amount - amount to withdraw (must match the available amount exactly - either withdraw all or nothing)
   * @returns `this` for fluent chaining.
   */
  public addRewardsWithdrawal(
    rewardAccount: Cardano.RewardAccount,
    amount: Cardano.Lovelace,
  ): TransactionBuilder {
    this.withdrawals.set(rewardAccount, amount);
    return this;
  }

  /**
   * Withdraws rewards from a script-controlled reward account, with a
   * withdrawal redeemer. The redeemer's canonical index (position of the
   * account in the sorted script withdrawals) is assigned during {@link build}.
   *
   * @param rewardAccount - The script reward account to withdraw from.
   * @param amount - The amount to withdraw.
   * @param redeemer - The withdrawal redeemer.
   * @returns `this` for fluent chaining.
   */
  public addScriptWithdrawal(
    rewardAccount: Cardano.RewardAccount,
    amount: Cardano.Lovelace,
    redeemer: Cardano.PlutusData,
  ): TransactionBuilder {
    this.withdrawals.set(rewardAccount, amount);
    this.withdrawalRedeemers.set(rewardAccount, redeemer);
    return this;
  }

  /**
   * Deposits coin directly into the account behind a reward account, valid
   * from the Dijkstra era. The deposit is value the transaction produces, so
   * balancing funds it from the wallet like an output. It needs no witness
   * from the account, which must be registered when the transaction is
   * applied.
   *
   * Deposits to the same reward account add up into one entry. The
   * transaction lists the entries sorted by reward account, as canonical
   * CBOR orders map keys.
   *
   * @param rewardAccount - The reward account to deposit into.
   * @param amount - The lovelace to deposit.
   * @throws If `amount` is not greater than zero, or it, or the sum of the
   *   deposits to `rewardAccount`, exceeds the largest signed 64-bit integer.
   * @returns `this` for fluent chaining.
   */
  public addDirectDeposit(
    rewardAccount: Cardano.RewardAccount,
    amount: Cardano.Lovelace,
  ): TransactionBuilder {
    accumulateDirectDeposit(this.directDeposits, rewardAccount, amount);
    return this;
  }

  /**
   * Requires the balance of the account behind a reward account to lie in
   * `interval` when the transaction is applied, valid from the Dijkstra era.
   * The interval is a half open range, from an inclusive lower bound to an
   * exclusive upper bound with either bound optional, or an exact balance.
   * It needs no witness from the account.
   *
   * A second interval for the same reward account replaces the first. The
   * transaction lists the intervals sorted by reward account, as canonical
   * CBOR orders map keys.
   *
   * @param rewardAccount - The reward account whose balance is checked.
   * @param interval - The range or exact balance, in lovelace.
   * @throws If `interval` has neither bound nor an exact balance, or an exact
   *   balance together with a bound.
   * @returns `this` for fluent chaining.
   */
  public addAccountBalanceInterval(
    rewardAccount: Cardano.RewardAccount,
    interval: Cardano.AccountBalanceInterval,
  ): TransactionBuilder {
    this.accountBalanceIntervals.set(
      rewardAccount,
      accountBalanceInterval(interval),
    );
    return this;
  }

  /**
   * Requires the balance of the account behind a reward account to lie in
   * `interval` before the transaction and its sub transactions are applied,
   * valid from the Dijkstra era. The interval is a half open range, from an
   * inclusive lower bound to an exclusive upper bound with either bound
   * optional, or an exact balance. It needs no witness from the account.
   *
   * A second starting interval for the same reward account replaces the
   * first. The transaction lists the starting intervals sorted by reward
   * account, as canonical CBOR orders map keys.
   *
   * @param rewardAccount - The reward account whose balance is checked.
   * @param interval - The range or exact balance, in lovelace.
   * @throws If `interval` has neither bound nor an exact balance, or an exact
   *   balance together with a bound.
   * @returns `this` for fluent chaining.
   */
  public addStartingAccountBalanceInterval(
    rewardAccount: Cardano.RewardAccount,
    interval: Cardano.AccountBalanceInterval,
  ): TransactionBuilder {
    this.startingAccountBalanceIntervals.set(
      rewardAccount,
      accountBalanceInterval(interval),
    );
    return this;
  }

  /**
   * Adds a signed sub transaction to the batch the transaction carries, as a
   * CIP-118 batcher does, after any added before. The sub transaction keeps
   * the bytes it was given in through balancing, fee sizing and
   * serialization, so its id and the signatures over it survive the build.
   *
   * The transaction balances the whole batch: what the sub transaction
   * consumes minus what it produces, its inputs, withdrawals and reclaimed
   * deposits against its outputs, deposits, donation and direct deposits,
   * with what it mints, is value the transaction receives, or funds when
   * negative. The fee prices the batch: the sub transaction's bytes, the
   * execution units of its redeemers, which are final, and the reference
   * scripts its inputs carry, again for every sub transaction that reads
   * the same output. Coin selection and collateral never use a UTxO a sub
   * transaction spends or references. A sub transaction that carries
   * redeemers makes the transaction post collateral, from
   * {@link setCollateralUtxos} with {@link setCollateralChangeAddress}, even
   * when the transaction runs no script; {@link build} refuses the batch
   * without them.
   *
   * Every top level guard the sub transaction requires must be added with
   * {@link addGuard} before {@link build}.
   *
   * @param subTransaction - The sub transaction, signed by its parties, since
   *   signing it afterwards would change the batch.
   * @param resolvedUtxos - UTxOs that resolve every input the sub transaction
   *   spends and every input it references, so its reference scripts are
   *   priced and evaluated.
   * @throws If the batch already carries a sub transaction with the same id,
   *   the sub transaction spends an input the transaction or another sub
   *   transaction spends, or `resolvedUtxos` does not resolve an input it
   *   spends or references.
   * @returns `this` for fluent chaining.
   */
  public addSubTransaction(
    subTransaction: Serialization.SubTransaction,
    resolvedUtxos: readonly Cardano.Utxo[],
  ): TransactionBuilder {
    const id = subTransaction.getId();
    if (this.subTransactions.some(added => added.getId() === id)) {
      throw new Error(`Sub transaction ${id} is already part of the batch`);
    }
    const { inputs, referenceInputs } = subTransactionInputs(subTransaction);
    const spent = inputs.map(input => {
      const key = inputKey(input);
      if (findUtxo(this.preSelectedUtxos, input)) {
        throw new Error(
          `Sub transaction ${id} spends an input the transaction spends: ${key}`,
        );
      }
      if (findUtxo(this.subTransactionUtxos, input)) {
        throw new Error(
          `Sub transaction ${id} spends an input another sub transaction spends: ${key}`,
        );
      }
      const utxo = findUtxo(resolvedUtxos, input);
      if (!utxo) {
        throw new Error(
          `Sub transaction ${id} spends an input the resolved UTxOs do not resolve: ${key}`,
        );
      }
      return utxo;
    });
    const referenced = referenceInputs.map(input => {
      const utxo = findUtxo(resolvedUtxos, input);
      if (!utxo) {
        throw new Error(
          `Sub transaction ${id} references an input the resolved UTxOs do not resolve: ${inputKey(
            input,
          )}`,
        );
      }
      return utxo;
    });
    this.subTransactions.push(subTransaction.clone());
    this.subTransactionUtxos.push(...spent);
    this.subTransactionReferenceUtxos.push(...referenced);
    return this;
  }

  /**
   * Finalizes and balances the transaction.
   *
   * Steps:
   * 1. Validates that `availableUtxos`/`preSelectedUtxos` and `changeAddress`
   *    are set, and that the transaction carries every top level guard its
   *    sub transactions require.
   * 2. Applies the direct deposits, the account balance intervals, the
   *    donation, the reference inputs and the Plutus surface (scripts,
   *    datums, mint, guards, collateral, validity interval) and seeds the
   *    redeemers at the per-tx max ex-units, or at the
   *    {@link PlutusContext} estimate, so the balancer prices script
   *    execution.
   * 3. If auxiliary data is present, computes and sets the `auxiliaryDataHash`.
   * 4. Calls {@link balanceTransaction} to select inputs, compute fee/min-ADA,
   *    create change, and iterate until balanced, funding the direct
   *    deposits like outputs and balancing what the sub transactions leave
   *    to or take from the batch; if the configured selector fails, balancing
   *    is retried with a Large-First fallback (see {@link useCoinSelector}).
   *    A transaction that runs a PlutusV1, PlutusV2 or PlutusV3 script is
   *    validated in legacy mode, so its sub transactions must balance between
   *    themselves and its datums must not rely on them.
   * 5. For Plutus transactions: re-indexes redeemers canonically over the
   *    balanced tx's sorted inputs / mint policies / certificates /
   *    withdrawals / guards, evaluates their execution units via the injected
   *    evaluator, which sees the whole batch, and computes the
   *    `scriptIntegrityHash` over the used cost models, evaluated redeemers
   *    and datums. Collateral is posted when the transaction or one of its
   *    sub transactions carries redeemers, and covers the fee of the batch.
   *    A transaction that carries datums but runs no Plutus script gets a
   *    script data hash over its datums alone.
   * 6. Writes the transaction in the canonical form the cardano-c
   *    transaction builder writes: inputs, collateral inputs and reference inputs in set order,
   *    outputs and the collateral return as maps, auxiliary data under
   *    tag 259, and sub transactions with the bytes they were added with.
   *
   * @throws Error If no UTxOs are available, no change address is set, the tx
   *   cannot be balanced, a Plutus tx is missing its {@link PlutusContext},
   *   or a spent or reference input carries an attached script.
   * @throws `MissingTopLevelGuardError` When a sub transaction requires a top
   *   level guard the transaction does not carry.
   * @throws `MalformedGuardDatumError` When a sub transaction requires a top
   *   level guard with a datum its credential does not take, or a Plutus
   *   script guard without one, for a script the batch provides.
   * @throws `ExtraneousRedeemerError` When a redeemer of a spent input, mint
   *   policy, withdrawal, certificate or guard runs a script that is not a
   *   Plutus script the transaction attaches or its inputs carry.
   * @throws `MissingRedeemerError` When a spent input, mint policy,
   *   withdrawal, certificate or guard runs a Plutus script the transaction
   *   attaches or its inputs carry, without a redeemer for it.
   * @throws `MissingDatumError` When a spend redeemer spends an output
   *   locked by a datum hash whose datum the transaction does not carry.
   * @throws `EvaluatedFeeShortfallError` When the evaluated ex-units need a
   *   larger fee than balancing priced at the seed.
   * @throws `MissingCollateralError` When the transaction or one of its sub
   *   transactions carries redeemers and no collateral UTxOs or no collateral
   *   change address are set.
   * @throws `UnbalancedSubTransactionsError` When the transaction runs a
   *   PlutusV1, PlutusV2 or PlutusV3 script and its sub transactions do not
   *   balance between themselves.
   * @throws `NotAllowedSupplementalDatumError` When the transaction runs a
   *   PlutusV1, PlutusV2 or PlutusV3 script and carries a datum only its sub
   *   transactions allow.
   *
   * @returns A `Serialization.Transaction` ready for signing.
   */
  public async build(): Promise<Serialization.Transaction> {
    if (
      this.availableUtxos.length === 0 &&
      this.preSelectedUtxos.length === 0
    ) {
      throw new Error('No available UTXOs to select from');
    }

    if (!this.changeAddress) {
      throw new Error('Change address is not set');
    }
    this.assertRequiredTopLevelGuards();

    const hasRedeemers = this.hasRedeemers();
    const shouldRunPlutus = this.shouldRunPlutus();
    const hasSubTransactionRedeemers = this.subTransactions.some(
      subTransaction => subTransactionRedeemers(subTransaction).length > 0,
    );
    const shouldPostCollateral = shouldRunPlutus || hasSubTransactionRedeemers;
    if (shouldRunPlutus && !this.plutusContext) {
      throw new Error(
        'Plutus context is not set. Call setPlutusContext() before build()',
      );
    }
    if (
      (hasRedeemers || hasSubTransactionRedeemers) &&
      (this.collateralUtxos.length === 0 || !this.collateralReturnAddress)
    ) {
      throw new MissingCollateralError();
    }
    this.assertNoAttachedScriptIsProvided();

    this.applyAuxiliaryDataHash();

    const unbalancedTx = this.transaction.toCore();
    if (this.certificates.length > 0) {
      unbalancedTx.body.certificates = this.certificates;
    }
    if (this.withdrawals.size > 0) {
      unbalancedTx.body.withdrawals = [...this.withdrawals].map(
        ([stakeAddress, quantity]) => ({ stakeAddress, quantity }),
      );
    }
    applyAccountEntries(unbalancedTx.body, {
      directDeposits: this.directDeposits,
      accountBalanceIntervals: this.accountBalanceIntervals,
      startingAccountBalanceIntervals: this.startingAccountBalanceIntervals,
    });
    if (this.validityInterval?.invalidHereafter !== undefined) {
      unbalancedTx.body.validityInterval = {
        ...unbalancedTx.body.validityInterval,
        invalidHereafter: this.validityInterval.invalidHereafter,
      };
    }
    if (this.validityInterval?.invalidBefore !== undefined) {
      unbalancedTx.body.validityInterval = {
        ...unbalancedTx.body.validityInterval,
        invalidBefore: this.validityInterval.invalidBefore,
      };
    }
    if (this.mint) {
      unbalancedTx.body.mint = this.mint;
    }
    if (this.donation !== undefined) {
      unbalancedTx.body.donation = this.donation;
    }
    applyGuards(unbalancedTx.body, this.guards);
    if (this.referenceUtxos.length > 0) {
      unbalancedTx.body.referenceInputs = this.referenceUtxos.map(
        ([{ txId, index }]) => ({ txId, index }),
      );
    }

    let reservedCollateral: Cardano.Utxo[] = [];
    let spendableUtxos = this.withoutBatchUtxos(this.availableUtxos);
    if (
      shouldPostCollateral &&
      this.collateralUtxos.length > 0 &&
      this.collateralReturnAddress
    ) {
      const coverageTarget = this.collateralCoverageTarget();
      reservedCollateral = this.selectCollateralInputs(coverageTarget);
      unbalancedTx.body.collaterals = reservedCollateral.map(toTxIn);
      const seeded = this.buildCollateralFields(
        reservedCollateral,
        coverageTarget,
      );
      unbalancedTx.body.totalCollateral = seeded.totalCollateral;
      if (seeded.collateralReturn) {
        unbalancedTx.body.collateralReturn = seeded.collateralReturn;
      }
      // Inputs are consumed on success and collateral only on script failure,
      // so collateral may also fund the transaction. Reference inputs may not.
    }
    if (this.referenceUtxos.length > 0) {
      spendableUtxos = spendableUtxos.filter(utxo => !this.isReferenced(utxo));
    }

    if (this.scripts.length > 0) {
      unbalancedTx.witness.scripts = this.scripts;
    }
    if (this.datums.length > 0) {
      unbalancedTx.witness.datums = this.datums;
    }

    // Seed the witness redeemers at the per-tx max ex-units, or the caller's
    // estimate, so `minFee` (called by the balancer) prices script execution.
    // Indices are corrected after balancing; the evaluator then assigns
    // concrete budgets.
    if (hasRedeemers) {
      unbalancedTx.witness.redeemers = this.seedRedeemers();
    }
    if (hasRedeemers || this.datums.length > 0) {
      unbalancedTx.body.scriptIntegrityHash = DUMMY_SCRIPT_INTEGRITY_HASH;
    }

    const { tx: balancedTx, selection } = balanceTransaction({
      unbalancedTx,
      availableUtxo: spendableUtxos,
      protocolParameters: this.params,
      preSelectedUtxo: this.preSelectedUtxos,
      collateralUtxos:
        reservedCollateral.length > 0 ? reservedCollateral : undefined,
      referenceUtxos: this.referenceUtxos,
      subTransactions: this.subTransactions,
      subTransactionUtxos: this.batchUtxos(),
      registeredPools: this.registeredPools,
      coinSelector: this.coinSelector,
      fallbackCoinSelector:
        this.coinSelector instanceof LargeFirstCoinSelector
          ? undefined
          : new LargeFirstCoinSelector(),
      changeAddress: this.changeAddress,
    });

    this.warnOfFallbackReferenceScriptTiers(balancedTx.body, selection);
    this.assertLegacyModeBatch(balancedTx.body, selection);
    this.assertRedeemersMatchPlutusScripts(balancedTx.body, selection);
    assertSpentDatumsProvided(this.spendRedeemers, selection, this.datums);

    if (!shouldPostCollateral) {
      const scriptIntegrityHash = this.datumsScriptDataHash();
      return serializeTransaction(
        scriptIntegrityHash
          ? { ...balancedTx, body: { ...balancedTx.body, scriptIntegrityHash } }
          : balancedTx,
        this.subTransactions,
      );
    }

    const finalTx = await this.finalizePlutusTx(
      balancedTx,
      selection,
      reservedCollateral,
    );
    return serializeTransaction(finalTx, this.subTransactions);
  }

  // --- private: body assembly ----------------------------------------------

  /** The redeemers the builder holds, with the certificates and guards they index into. */
  private redeemerSources(): RedeemerSources {
    return {
      spendRedeemers: this.spendRedeemers,
      mintRedeemers: this.mintRedeemers,
      certificates: this.certificates,
      certificateRedeemers: this.certificateRedeemers,
      withdrawalRedeemers: this.withdrawalRedeemers,
      guards: this.guards,
      guardRedeemers: this.guardRedeemers,
    };
  }

  /** Whether the transaction carries a redeemer for any purpose. */
  private hasRedeemers(): boolean {
    return redeemerCount(this.redeemerSources()) > 0;
  }

  /**
   * Whether the transaction itself runs Plutus: it carries redeemers or
   * attaches a Plutus script.
   */
  private shouldRunPlutus(): boolean {
    return (
      this.hasRedeemers() ||
      this.scripts.some(script => script.__type === Cardano.ScriptType.Plutus)
    );
  }

  /**
   * The UTxOs the sub transactions spend and then the ones they reference,
   * each as often as a sub transaction uses it.
   */
  private batchUtxos(): Cardano.Utxo[] {
    return [...this.subTransactionUtxos, ...this.subTransactionReferenceUtxos];
  }

  /**
   * `utxos` without the ones a sub transaction spends or references: they
   * belong to the parties of the batch and to the holders of the scripts
   * they read, so the transaction must never spend them or post them as
   * collateral.
   */
  private withoutBatchUtxos(utxos: Cardano.Utxo[]): Cardano.Utxo[] {
    const used = this.batchUtxos();
    return used.length === 0
      ? utxos
      : utxos.filter(([txIn]) => !findUtxo(used, txIn));
  }

  /**
   * The ledger requires every top level guard a sub transaction lists to be
   * among the guards of the transaction that carries it, and to carry a
   * datum only when it is a Plutus script, which must carry one. A script
   * guard is checked only when the batch provides its script.
   *
   * @throws `MalformedGuardDatumError` For the first required guard whose
   *   datum does not fit its credential, in the order the sub transactions
   *   were added.
   * @throws `MissingTopLevelGuardError` For the first required guard the
   *   transaction lacks, in the order the sub transactions were added.
   */
  private assertRequiredTopLevelGuards(): void {
    const scripts = [
      ...this.scripts,
      ...carriedScripts([
        ...this.preSelectedUtxos,
        ...this.referenceUtxos,
        ...this.batchUtxos(),
      ]),
      ...this.subTransactions.flatMap(
        subTransaction => subTransaction.witnessSet().toCore().scripts ?? [],
      ),
    ];
    for (const subTransaction of this.subTransactions) {
      const { requiredTopLevelGuards = [] } = subTransaction.body().toCore();
      assertGuardDatums(
        requiredTopLevelGuards,
        scripts,
        subTransaction.getId(),
      );
      for (const { credential } of requiredTopLevelGuards) {
        if (!this.guards.has(guardKey(credential))) {
          throw new MissingTopLevelGuardError(
            subTransaction.getId(),
            credential,
          );
        }
      }
    }
  }

  /**
   * From Dijkstra the protocol parameters set the tiers reference scripts
   * are priced in. When they lack one and the batch reads reference
   * scripts, the fee prices them in Conway's tiers, which falls short of
   * the ledger's fee on a network that sets other tiers, so the builder
   * warns through its logger, naming the missing parameters and the values
   * used in their place.
   *
   * @param body - The balanced body.
   * @param spent - UTxOs that resolve the inputs `body` spends.
   */
  private warnOfFallbackReferenceScriptTiers(
    body: Cardano.TxBody,
    spent: readonly Cardano.Utxo[],
  ): void {
    const missing = missingReferenceScriptTiers(this.params);
    if (missing.length === 0) return;
    const { referenceScriptSize } = batchScriptUsage(
      body,
      [...spent, ...this.referenceUtxos, ...this.batchUtxos()],
      this.subTransactions,
    );
    if (referenceScriptSize === 0) return;
    const names = missing.map(({ name }) => name).join(' and ');
    const fallbacks = missing
      .map(({ name, fallback }) => `${name} ${fallback}`)
      .join(' and ');
    this.logger.warn(
      `The protocol parameters of protocol version ${this.params.protocolVersion?.major} lack ${names}, so the ${referenceScriptSize} bytes of reference scripts the transaction reads are priced with Conway's ${fallbacks}; the fee falls short if the network sets others`,
    );
  }

  private isReferenced(utxo: Cardano.Utxo): boolean {
    const key = utxoRefKey(utxo);
    return this.referenceUtxos.some(
      referenced => utxoRefKey(referenced) === key,
    );
  }

  /**
   * Whether the ledger refuses a transaction that spends an input it also
   * references: from the first protocol version after Babbage until version
   * 11, and at any version when the protocol parameters give none.
   */
  private refusesSpendingReferencedInputs(): boolean {
    const major = this.params.protocolVersion?.major;
    return (
      major === undefined ||
      (major > BABBAGE_MAX_PROTOCOL_VERSION &&
        major < SPENT_REFERENCE_INPUTS_PROTOCOL_VERSION)
    );
  }

  /**
   * The Plutus scripts the batch provides besides the ones the transaction
   * attaches, as the ledger pools them: the ones the outputs of `spent`, of
   * the reference inputs and of the inputs the sub transactions spend and
   * reference carry, and the ones the sub transactions attach.
   */
  private providedPlutusScripts(
    spent: readonly Cardano.Utxo[],
  ): Cardano.PlutusScript[] {
    return [
      ...carriedPlutusScripts([
        ...spent,
        ...this.referenceUtxos,
        ...this.batchUtxos(),
      ]),
      ...this.subTransactions.flatMap(subTransaction =>
        (subTransaction.witnessSet().toCore().scripts ?? []).filter(
          Cardano.isPlutusScript,
        ),
      ),
    ];
  }

  /**
   * The Plutus scripts the batch makes available to the transaction: the
   * ones it attaches and the ones {@link providedPlutusScripts} pools.
   */
  private availablePlutusScripts(
    spent: readonly Cardano.Utxo[],
  ): Cardano.PlutusScript[] {
    return [
      ...this.scripts.filter(Cardano.isPlutusScript),
      ...this.providedPlutusScripts(spent),
    ];
  }

  /**
   * Whether the ledger validates the transaction in legacy mode: when a
   * script one of its purposes needs (see {@link scriptPurposes}) is a
   * PlutusV1, PlutusV2 or PlutusV3 script the batch makes available. A
   * needed script nothing provides does not count.
   */
  private isLegacyMode(body: Cardano.TxBody, spent: Cardano.Utxo[]): boolean {
    const needed = new Set(
      this.scriptPurposes(body, spent).map(({ scriptHash }) => scriptHash),
    );
    return this.availablePlutusScripts(spent).some(
      script =>
        LEGACY_PLUTUS_LANGUAGES.has(script.version) &&
        needed.has(Serialization.Script.fromCore(script).hash()),
    );
  }

  /**
   * The datum hashes the transaction alone allows its datums to have: those
   * of the outputs it spends at the address of a Plutus script the batch
   * makes available, of its own outputs, and of the outputs its reference
   * inputs point to.
   */
  private topLevelDatumHashes(
    body: Cardano.TxBody,
    spent: Cardano.Utxo[],
  ): Set<string> {
    const plutusHashes = new Set<string>(
      this.availablePlutusScripts(spent).map(script =>
        Serialization.Script.fromCore(script).hash(),
      ),
    );
    const scriptOutputs = spent.flatMap(([, output]) => {
      const scriptHash = paymentScriptHash(output.address);
      return scriptHash && plutusHashes.has(scriptHash) ? [output] : [];
    });
    return new Set(
      [
        ...scriptOutputs,
        ...body.outputs,
        ...this.referenceUtxos.map(([, output]) => output),
      ].flatMap(({ datumHash }) => (datumHash ? [datumHash] : [])),
    );
  }

  /**
   * A transaction that runs a PlutusV1, PlutusV2 or PlutusV3 script is
   * validated in legacy mode, which checks it again with its sub
   * transactions removed: it must conserve value on its own, and each of
   * its datums must be one it allows on its own (see
   * {@link topLevelDatumHashes}).
   *
   * @throws `UnbalancedSubTransactionsError` When the sub transactions do
   *   not balance between themselves.
   * @throws `NotAllowedSupplementalDatumError` For the first datum only the
   *   sub transactions allow.
   */
  private assertLegacyModeBatch(
    body: Cardano.TxBody,
    spent: Cardano.Utxo[],
  ): void {
    if (this.subTransactions.length === 0 || !this.isLegacyMode(body, spent)) {
      return;
    }
    const imbalance = subTransactionsImbalance(
      this.subTransactions,
      this.batchUtxos(),
      { ...this.params, registeredPools: this.registeredPools },
    );
    if (!isZeroValue(imbalance)) {
      throw new UnbalancedSubTransactionsError(imbalance);
    }
    const allowed = this.topLevelDatumHashes(body, spent);
    const datumHash = this.datums
      .map(datum => Serialization.PlutusData.fromCore(datum).hash())
      .find(hash => !allowed.has(hash));
    if (datumHash) throw new NotAllowedSupplementalDatumError(datumHash);
  }

  /**
   * The ledger requires a redeemer for every purpose that runs a Plutus
   * script, and a Plutus script for every redeemer, so the build refuses a
   * transaction that lacks either.
   *
   * @throws `ExtraneousRedeemerError` For the first purpose of
   *   {@link scriptPurposes} with a redeemer whose script is not a Plutus
   *   script the transaction attaches or its inputs carry.
   * @throws `MissingRedeemerError` For the first purpose of
   *   {@link scriptPurposes} that runs a Plutus script the transaction
   *   attaches or its inputs carry, without a redeemer.
   */
  private assertRedeemersMatchPlutusScripts(
    body: Cardano.TxBody,
    spent: Cardano.Utxo[],
  ): void {
    assertRedeemersMatchPlutusScripts(
      this.scriptPurposes(body, spent),
      scriptHashes(this.availablePlutusScripts(spent)),
    );
  }

  /**
   * The purposes of `body` a script must authorize, in the order the ledger
   * lists them: spent inputs at a script address, mint policies,
   * withdrawals from a script reward account, certificates of a script
   * credential and script hash guards, each at the index its redeemer takes.
   */
  private scriptPurposes(
    body: Cardano.TxBody,
    spent: Cardano.Utxo[],
  ): ScriptPurpose[] {
    return scriptPurposes(this.redeemerSources(), body, spent);
  }

  /**
   * The languages the script data hash covers, as the ledger counts them:
   * every attached script runs, and a script a spent or reference input
   * carries counts only when a redeemer runs it.
   */
  private usedLanguages(
    spent: Cardano.Utxo[],
  ): Cardano.PlutusLanguageVersion[] {
    return scriptDataLanguages(
      this.scripts,
      this.providedPlutusScripts(spent),
      redeemedScriptHashes(this.redeemerSources(), spent),
    );
  }

  /**
   * The ledger refuses a witness-set script that a spent or reference input
   * also provides, as an extraneous witness. Scripts the inputs carry never
   * replace attached ones here, so such a transaction could not be submitted.
   * Of the spent inputs, only the ones added with `addInput` are known
   * before balancing.
   */
  private assertNoAttachedScriptIsProvided(): void {
    const attachedHashes = new Set(
      this.scripts.map(script => Serialization.Script.fromCore(script).hash()),
    );
    if (attachedHashes.size === 0) return;
    const providers = [
      ...this.preSelectedUtxos.map(utxo => ['Input', utxo] as const),
      ...this.referenceUtxos.map(utxo => ['Reference input', utxo] as const),
    ];
    for (const [kind, [txIn, { scriptReference }]] of providers) {
      if (!scriptReference) continue;
      const hash = Serialization.Script.fromCore(scriptReference).hash();
      if (attachedHashes.has(hash)) {
        throw new Error(
          `${kind} ${txIn.txId}#${txIn.index} carries attached script ${hash}`,
        );
      }
    }
  }

  private applyAuxiliaryDataHash(): void {
    const auxDataHash = auxiliaryDataHash(
      this.transaction.auxiliaryData()?.toCore(),
    );
    if (auxDataHash) {
      const body = this.transaction.body();
      body.setAuxiliaryDataHash(auxDataHash);
      this.transaction.setBody(body);
    }
  }

  // --- private: Plutus finalisation ----------------------------------------

  /**
   * The ex-units balancing prices every redeemer together at: the caller's
   * estimate, or what the per-tx maximum leaves to the transaction once the
   * redeemers of its sub transactions, which the ledger counts against the
   * same maximum, take their final units.
   */
  private seedExecutionUnits(): Cardano.ExUnits {
    const estimate = this.plutusContext?.executionUnitsEstimate;
    if (estimate) return estimate;
    const used = this.subTransactionExecutionUnits();
    return {
      memory: Math.max(SEED_EX_UNITS.memory - used.memory, 0),
      steps: Math.max(SEED_EX_UNITS.steps - used.steps, 0),
    };
  }

  /** The execution units of every redeemer the sub transactions carry, summed. */
  private subTransactionExecutionUnits(): Cardano.ExUnits {
    const total: Cardano.ExUnits = { memory: 0, steps: 0 };
    for (const subTransaction of this.subTransactions) {
      for (const { executionUnits } of subTransactionRedeemers(
        subTransaction,
      )) {
        total.memory += executionUnits.memory;
        total.steps += executionUnits.steps;
      }
    }
    return total;
  }

  /**
   * Flattens the accumulated redeemers, seeding each with a SHARE of the seed
   * execution units so their TOTAL stays at (just above, from rounding) the
   * seed — never `count × seed`. The seed only prices `minFee` during
   * balancing (the evaluator assigns concrete budgets afterwards), so it must
   * upper-bound the tx's real ex-units. The per-tx maximum does, since the
   * ledger caps a tx at it regardless of redeemer count — seeding each
   * redeemer at the full max would over-price a multi-redeemer tx by that
   * multiple. Indices are placeholders; corrected canonically after
   * balancing in {@link reindexRedeemers}.
   */
  private seedRedeemers(): Cardano.Redeemer[] {
    const count = redeemerCount(this.redeemerSources());
    const seed = this.seedExecutionUnits();
    // ceil keeps the summed seed >= the seed total (a valid upper bound)
    // while staying ~1× it rather than count×.
    const perRedeemer: Cardano.ExUnits =
      count <= 1
        ? seed
        : {
            memory: Math.ceil(seed.memory / count),
            steps: Math.ceil(seed.steps / count),
          };
    // Without an estimate every placeholder index is 0, which the Conway
    // redeemer map encodes once per purpose: the per-tx maximum's fee covers
    // the bytes of the others many times over. An estimate leaves no such
    // room, so each redeemer gets its own placeholder and its bytes are
    // priced.
    const isEstimated =
      this.plutusContext?.executionUnitsEstimate !== undefined;
    const seeded = (
      purpose: Cardano.RedeemerPurpose,
      redeemerData: Iterable<Cardano.PlutusData>,
    ): Cardano.Redeemer[] =>
      [...redeemerData].map((data, position) => ({
        index: isEstimated ? position : 0,
        purpose,
        data,
        executionUnits: perRedeemer,
      }));
    return [
      ...seeded(Cardano.RedeemerPurpose.spend, this.spendRedeemers.values()),
      ...seeded(Cardano.RedeemerPurpose.mint, this.mintRedeemers.values()),
      ...seeded(
        Cardano.RedeemerPurpose.certificate,
        this.certificateRedeemers.values(),
      ),
      ...seeded(
        Cardano.RedeemerPurpose.withdrawal,
        this.withdrawalRedeemers.values(),
      ),
      ...seeded(Cardano.RedeemerPurpose.guarding, this.guardRedeemers.values()),
    ];
  }

  /**
   * Re-indexes the redeemers canonically over the balanced transaction body
   * (see {@link indexRedeemers}), each at the seed execution units, which
   * the evaluator replaces.
   */
  private reindexRedeemers(body: Cardano.TxBody): Cardano.Redeemer[] {
    return indexRedeemers(this.redeemerSources(), body, () => SEED_EX_UNITS);
  }

  /**
   * Lovelace the collateral reservation must cover so finalisation never fails
   * on an under-sized pick.
   *
   * Collateral is reserved before balancing so the fee prices it, but the
   * amount the ledger requires is `ceil(fee * collateralPercentage / 100)`,
   * derived from the post-evaluation fee. The reservation must therefore cover
   * the worst-case fee the balancer could price,
   * `ceil(maxFee * collateralPercentage / 100)`, because the fee is only
   * corrected downward from there. Finalisation then reselects, from the
   * reservation only, the collateral the evaluated fee needs, so it never
   * ships more collateral inputs than the fee was priced with.
   *
   * `maxFee = maxSizeFee + maxScriptFee + referenceScriptFee`:
   * - the size component is `minFeeConstant + minFeeCoefficient * maxTxSize`;
   * - the script component prices the seed execution units (the per-tx max
   *   ex-units, or the caller's estimate, which is exactly the TOTAL
   *   {@link seedRedeemers} seeds regardless of redeemer count, so this
   *   matches the fee the balancer prices);
   * - the reference-script component prices the scripts the reference inputs
   *   and the inputs added with `addInput` carry, which are fixed before
   *   balancing.
   *
   * The ledger prices the batch together, so the script component also
   * prices the final execution units of the sub transactions' redeemers, and
   * the reference-script component the scripts each sub transaction's spent
   * and reference inputs carry.
   *
   * `minFee` also charges reference scripts carried by inputs coin selection
   * picks. The bound leaves those out, since balancing chooses them after
   * collateral is reserved; it holds while no selected input carries one.
   *
   * A blunt 5-ADA floor here would over-reserve: on a wallet with few cover
   * UTxOs it forces a whole large UTxO to be locked as collateral (its excess
   * over the floor falls below a return output's min-ADA, so a second UTxO is
   * grabbed), starving the tx of funding inputs (LW-15113). `COLLATERAL_COVERAGE_TARGET`
   * is kept only for the `collateralPercentage === 0` case, mirroring
   * `finalizePlutusTx`'s collateral derivation.
   */
  private collateralCoverageTarget(): bigint {
    const pct = BigInt(this.params.collateralPercentage);
    if (pct === 0n) return COLLATERAL_COVERAGE_TARGET;
    const maxSizeFee =
      BigInt(this.params.minFeeConstant) +
      BigInt(this.params.minFeeCoefficient) * BigInt(this.params.maxTxSize);
    // 0 when prices are missing/zero; the target is then size-proportional,
    // which still upper-bounds the (zero-script) fee's proportional collateral.
    const seed = this.hasRedeemers()
      ? this.seedExecutionUnits()
      : { memory: 0, steps: 0 };
    const batch = batchScriptUsage(
      {
        inputs: this.preSelectedUtxos.map(toTxIn),
        referenceInputs: this.referenceUtxos.map(toTxIn),
      },
      [...this.preSelectedUtxos, ...this.referenceUtxos, ...this.batchUtxos()],
      this.subTransactions,
    );
    const maxScriptFee = executionUnitsFee(
      {
        memory: seed.memory + batch.executionUnits.memory,
        steps: seed.steps + batch.executionUnits.steps,
      },
      this.params.prices ?? { memory: 0, steps: 0 },
    );
    const referenceFee = referenceScriptFee(
      batch.referenceScriptSize,
      this.params,
    );
    return ((maxSizeFee + maxScriptFee + referenceFee) * pct + 99n) / 100n;
  }

  /**
   * Selects collateral inputs largest-first from `collateralUtxos`, as the
   * cardano-c transaction builder does (see {@link pickCollateral}),
   * combining at most `maxCollateralInputs`.
   *
   * When no selection within that limit leaves a valid return, an ADA-only
   * selection that covers the amount is still accepted and its remainder is
   * absorbed into total collateral, unless an execution estimate prices the
   * fee, which leaves no room for a return that appears after evaluation.
   * Native assets can leave the collateral inputs only through the return, so
   * a selection carrying them always needs a valid one.
   *
   * @param coverAmount - Lovelace the selected collateral must cover.
   * @returns The selected collateral UTxOs.
   * @throws `InsufficientCollateralError` When the pool cannot fund a valid return.
   */
  private selectCollateralInputs(coverAmount: bigint): Cardano.Utxo[] {
    const maxInputs = this.params.maxCollateralInputs;
    const sorted = [...this.withoutBatchUtxos(this.collateralUtxos)].sort(
      (a, b) => {
        const diff = (b[1].value.coins ?? 0n) - (a[1].value.coins ?? 0n);
        return diff > 0n ? 1 : diff < 0n ? -1 : 0;
      },
    );
    const { selected, absorbable } = this.pickCollateral(
      sorted.slice(0, maxInputs),
      coverAmount,
    );
    if (selected) return selected;
    if (
      absorbable &&
      this.plutusContext?.executionUnitsEstimate === undefined
    ) {
      return absorbable;
    }

    throw new InsufficientCollateralError(
      `Collateral UTxOs cannot cover ${coverAmount} lovelace plus a valid return output (max ${maxInputs} inputs)`,
    );
  }

  /**
   * Picks the shortest prefix of `candidates`, in their order, that covers
   * `coverAmount` and leaves either nothing or a return output that meets the
   * min-ADA rule: the largest UTxOs until they cover the amount, then the
   * next largest while the return would fall below min-ADA.
   *
   * @param candidates - Collateral UTxOs, largest first.
   * @param coverAmount - Lovelace the collateral must cover.
   * @returns The `selected` prefix, or none when no prefix leaves a valid
   *   return, and the shortest ADA-only prefix that covers the amount as
   *   `absorbable`, whose remainder total collateral may absorb.
   */
  private pickCollateral(
    candidates: Cardano.Utxo[],
    coverAmount: bigint,
  ): { selected?: Cardano.Utxo[]; absorbable?: Cardano.Utxo[] } {
    const returnAddress = this
      .collateralReturnAddress as Cardano.PaymentAddress;
    let absorbable: Cardano.Utxo[] | undefined;
    for (let count = 1; count <= candidates.length; count++) {
      const prefix = candidates.slice(0, count);
      const total = coalesceValueQuantities(prefix.map(([, out]) => out.value));
      if (total.coins < coverAmount) continue;

      const returnCoin = total.coins - coverAmount;
      const hasAssets = (total.assets?.size ?? 0) > 0;
      if (returnCoin === 0n && !hasAssets) return { selected: prefix };

      const minReturn = minAdaRequired(
        {
          address: returnAddress,
          value: { coins: returnCoin, assets: total.assets },
        },
        BigInt(this.params.coinsPerUtxoByte),
      );
      if (returnCoin >= minReturn) return { selected: prefix };
      if (!hasAssets && absorbable === undefined) absorbable = prefix;
    }
    return { absorbable };
  }

  /**
   * Computes `totalCollateral` and (when there is a remainder or native assets)
   * `collateralReturn` for a given collateral amount drawn from the
   * `collateral` inputs. The return carries every native asset on them and
   * must meet the min-ADA rule. Called pre-balancing with the coverage target
   * so the fee prices the collateral fields, and again in finalization with
   * the fee-derived amount.
   *
   * @throws `InsufficientCollateralError` When the inputs cannot fund the
   *   amount plus a valid return output.
   */
  private buildCollateralFields(
    collateral: Cardano.Utxo[],
    amount: Cardano.Lovelace,
  ): { totalCollateral: Cardano.Lovelace; collateralReturn?: Cardano.TxOut } {
    const returnAddress = this
      .collateralReturnAddress as Cardano.PaymentAddress;
    const collateralValue = coalesceValueQuantities(
      collateral.map(([, out]) => out.value),
    );
    const returnCoin = collateralValue.coins - amount;
    if (returnCoin < 0n) {
      throw new InsufficientCollateralError(
        `Collateral inputs hold ${collateralValue.coins} lovelace but the required collateral is ${amount}`,
      );
    }
    const hasAssets = (collateralValue.assets?.size ?? 0) > 0;
    if (returnCoin === 0n && !hasAssets) {
      return { totalCollateral: amount };
    }
    const returnValue: Cardano.Value = { coins: returnCoin };
    if (hasAssets) returnValue.assets = collateralValue.assets;
    const collateralReturn: Cardano.TxOut = {
      address: returnAddress,
      value: returnValue,
    };
    const minReturn = minAdaRequired(
      collateralReturn,
      BigInt(this.params.coinsPerUtxoByte),
    );
    if (returnCoin < minReturn) {
      if (hasAssets) {
        // Native assets can only leave the collateral inputs through a return
        // output, so a return that cannot meet min-ADA is unrecoverable.
        throw new InsufficientCollateralError(
          `Collateral return needs ${minReturn} lovelace but only ${returnCoin} is available`,
        );
      }
      // Over-declare instead of failing: the ledger checks only
      // `totalCollateral === inputs - return` plus `>= ceil(fee * pct / 100)`,
      // and both hold when the whole reservation is declared with no return.
      // The alternative is a hard failure, because a dust remainder cannot ship
      // as an output — and the first pricing pass reaches here on ANY
      // exact-cover reservation, whose remainder is only
      // `minFeeCoefficient * pct% * (maxTxSize - txSize)` (LW-15113).
      return { totalCollateral: collateralValue.coins };
    }
    return { totalCollateral: amount, collateralReturn };
  }

  /**
   * The script data hash of a transaction that runs no Plutus script itself
   * but carries datums: it covers the datums alone, with no redeemers and no
   * language views, so it needs no cost models.
   */
  private datumsScriptDataHash(): Crypto.Hash32ByteBase16 | undefined {
    return computeConwayScriptDataHash({
      costModels: new Map(),
      usedLanguages: [],
      redeemers: [],
      datums: this.datums,
    });
  }

  /**
   * Evaluates the redeemers of the transaction, priced at the seed, with the
   * injected evaluator, and computes the script data hash. The evaluator
   * sees the whole batch: the transaction as written, with the sub
   * transactions it carries byte for byte, and the UTxOs every level spends
   * and references. A transaction whose only redeemers are those of its sub
   * transactions, whose execution units are final, runs no evaluation.
   */
  private async evaluatePlutus(
    balancedTx: Cardano.Tx,
    selection: Cardano.Utxo[],
  ): Promise<{
    evaluatedRedeemers: Cardano.Redeemer[];
    scriptIntegrityHash?: Crypto.Hash32ByteBase16;
  }> {
    const context = this.plutusContext;
    if (!context || !this.shouldRunPlutus()) {
      return {
        evaluatedRedeemers: [],
        scriptIntegrityHash: this.datumsScriptDataHash(),
      };
    }
    const reindexed = this.reindexRedeemers(balancedTx.body);
    const resolvedInputs: Cardano.Utxo[] = [];
    for (const utxo of [
      ...selection,
      ...this.referenceUtxos,
      ...this.batchUtxos(),
    ]) {
      if (!findUtxo(resolvedInputs, utxo[0])) resolvedInputs.push(utxo);
    }
    const txForEvaluation: Cardano.Tx = {
      ...balancedTx,
      witness: { ...balancedTx.witness, redeemers: reindexed },
    };
    const evaluation =
      reindexed.length > 0
        ? await context.txEvaluator.evaluate(
            txForEvaluation,
            resolvedInputs,
            serializeTransaction(txForEvaluation, this.subTransactions),
          )
        : [];
    const evaluatedRedeemers = reindexed.map(redeemer => {
      const result = evaluation.find(
        item =>
          item.purpose === redeemer.purpose && item.index === redeemer.index,
      );
      if (!result) {
        // No evaluated budget for this redeemer would otherwise ship the seed
        // (per-tx Plutus maximum) ex-units -- over-paying at best, and at worst
        // exceeding the tx budget or masking an evaluator that skipped a
        // redeemer. Fail fast rather than submit unevaluated ex-units.
        throw new Error(
          `No ex-units evaluation for redeemer ${redeemer.purpose}#${redeemer.index}`,
        );
      }
      return { ...redeemer, executionUnits: result.budget };
    });

    const scriptIntegrityHash = computeConwayScriptDataHash({
      costModels: context.costModels,
      usedLanguages: this.usedLanguages(resolvedInputs),
      redeemers: evaluatedRedeemers,
      datums: this.datums.length > 0 ? this.datums : undefined,
    });
    return { evaluatedRedeemers, scriptIntegrityHash };
  }

  /**
   * Evaluates the redeemers (see {@link evaluatePlutus}), derives the
   * collateral the fee needs from the reservation, and corrects the fee
   * downward when the evaluated execution units need less than the seed.
   * Returns the final unsigned `Cardano.Tx`.
   */
  private async finalizePlutusTx(
    balancedTx: Cardano.Tx,
    selection: Cardano.Utxo[],
    reservedCollateral: Cardano.Utxo[],
  ): Promise<Cardano.Tx> {
    const { evaluatedRedeemers, scriptIntegrityHash } =
      await this.evaluatePlutus(balancedTx, selection);

    const allResolvedInputs = [
      ...selection,
      ...this.collateralUtxos,
      ...this.referenceUtxos,
      ...this.batchUtxos(),
    ];

    // The ledger requires `ceil(fee * collateralPercentage / 100)` collateral,
    // but collateral was reserved before balancing against the (larger)
    // coverage target. Reselect the collateral inputs from the reservation and
    // re-derive their fields per candidate fee so the fee correction prices
    // the fee over the exact collateral that ships (see
    // correctFeeAfterEvaluation). When no part of the reservation leaves a
    // valid return, the whole reservation ships and absorbs the remainder.
    const pct = BigInt(this.params.collateralPercentage);
    const deriveCollateralFields = (
      fee: Cardano.Lovelace,
    ): CollateralBodyFields => {
      if (reservedCollateral.length === 0 || !this.collateralReturnAddress) {
        return {};
      }
      const amount =
        pct === 0n || fee === 0n
          ? COLLATERAL_COVERAGE_TARGET
          : (fee * pct + 99n) / 100n;
      const collateral =
        this.pickCollateral(reservedCollateral, amount).selected ??
        reservedCollateral;
      return {
        collaterals: collateral.map(toTxIn),
        ...this.buildCollateralFields(collateral, amount),
      };
    };

    const {
      outputs: correctedOutputs,
      fee: correctedFee,
      collateralFields,
    } = correctFeeAfterEvaluation({
      balancedTx,
      evaluatedRedeemers,
      resolvedInputs: allResolvedInputs,
      protocolParameters: this.params,
      changeAddress: this.changeAddress!,
      scriptIntegrityHash,
      deriveCollateralFields,
      subTransactions: this.subTransactions,
    });

    return {
      ...balancedTx,
      body: {
        ...balancedTx.body,
        fee: correctedFee,
        outputs: correctedOutputs,
        scriptIntegrityHash,
        collateralReturn: undefined,
        ...collateralFields,
      },
      witness: {
        ...balancedTx.witness,
        ...(this.scripts.length > 0 && { scripts: this.scripts }),
        ...(this.datums.length > 0 && { datums: this.datums }),
        ...(evaluatedRedeemers.length > 0 && {
          redeemers: evaluatedRedeemers,
        }),
      },
    };
  }
}
