import { Cardano, Serialization, setInConwayEra } from '@lace-lib/cardano-core';

import {
  accountBalanceInterval,
  accumulateDirectDeposit,
  applyAccountEntries,
} from './account-entries';
import {
  applyGuards,
  assertGuardDatums,
  assertRedeemersMatchPlutusScripts,
  assertSpentDatumsProvided,
  carriedPlutusScripts,
  carriedScripts,
  certificateWitnessCredential,
  MalformedGuardDatumError,
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
import { computeConwayScriptDataHash } from './script-data-hash';
import {
  auxiliaryDataHash,
  serializeSubTransaction,
  serializeTransaction,
} from './serialization';

import type { RedeemerKey, RedeemerSources } from './redeemers';
import type { TxEvaluator } from './types';
import type * as Crypto from '@lace-lib/cardano-crypto';

/**
 * A redeemer of a sub transaction, with the execution units it runs with
 * when the caller already knows them.
 */
export interface SubTransactionRedeemerProps {
  redeemer: Cardano.PlutusData;
  /**
   * The execution units the redeemer runs with. Without them the
   * {@link SubTransactionPlutusContext} evaluator measures them.
   */
  executionUnits?: Cardano.ExUnits;
}

/** Script-unlock witness data for spending a UTxO that sits at a script address. */
export interface SubTransactionScriptInputProps
  extends SubTransactionRedeemerProps {
  /** Inline datum is read from the UTxO; supply only when the datum is provided by hash. */
  datum?: Cardano.PlutusData;
}

/**
 * The Plutus context a sub transaction that carries redeemers or Plutus
 * scripts needs to compute its script data hash and, for redeemers given
 * without execution units, to evaluate them.
 */
export interface SubTransactionPlutusContext {
  /** The protocol cost models, the PlutusV4 one included. */
  costModels: Cardano.CostModels;
  /**
   * Computes the execution units of the redeemers given without them.
   *
   * The redeemers must be evaluated as those of the sub transaction that
   * `serializedTx` carries: a transaction with no inputs, outputs or fee
   * whose only content is the sub transaction, byte for byte, at index 0 of
   * its batch, so a PlutusV4 script sees a sub transaction context. `tx` is
   * the sub transaction body with a fee of 0, given only for the shape of
   * its redeemers, never a transaction to evaluate at the top level or to
   * submit. `resolvedInputs` are the UTxOs the sub transaction spends and
   * references. Results are matched to the redeemers by purpose and index.
   *
   * A provider evaluator, such as one made with
   * `createProviderExUnitsEvaluator` over Blockfrost's
   * `/utils/txs/evaluate`, can price them only when the node evaluates the
   * sub transaction redeemers of such a carrier; otherwise the caller gives
   * the execution units with each redeemer. The units become final once the
   * parties sign, since the script data hash that covers them is part of the
   * signed body.
   */
  txEvaluator?: TxEvaluator;
}

/** The execution units a redeemer holds until the evaluator measures it. */
const UNEVALUATED_EX_UNITS: Cardano.ExUnits = { memory: 0, steps: 0 };

/**
 * Thrown when a sub transaction would run a PlutusV1, PlutusV2 or PlutusV3
 * script, attached or read from an input. Those scripts cannot see the
 * batch, so the ledger never runs them inside a sub transaction; only
 * native and PlutusV4 scripts run there.
 */
export class UnsupportedSubTransactionScriptError extends Error {
  public constructor(
    readonly version: Cardano.PlutusLanguageVersion,
    readonly scriptHash: string,
  ) {
    super(
      `PlutusV${
        version + 1
      } script ${scriptHash} cannot run inside a sub transaction, only native and PlutusV4 scripts can`,
    );
    this.name = 'UnsupportedSubTransactionScriptError';
  }
}

/**
 * The Plutus languages whose scripts cannot run inside a sub transaction.
 * Only native and PlutusV4 scripts can.
 */
const LEGACY_PLUTUS_LANGUAGES: ReadonlySet<Cardano.PlutusLanguageVersion> =
  new Set([
    Cardano.PlutusLanguageVersion.V1,
    Cardano.PlutusLanguageVersion.V2,
    Cardano.PlutusLanguageVersion.V3,
  ]);

/** The reference of a UTxO, as an input lists it. */
const toTxIn = ([{ txId, index }]: Cardano.Utxo): Cardano.TxIn => ({
  txId,
  index,
});

/**
 * Builds a CIP-118 sub transaction for a batcher to carry, as a party to a
 * batch does. A sub transaction pays no fee and is never balanced: what it
 * consumes minus what it produces is value the batch receives, or funds
 * when negative, and the batcher's transaction balances it.
 *
 * Its parts are inputs, reference inputs, outputs, mints, certificates,
 * withdrawals, guards, required top level guards, direct deposits, account
 * balance intervals, supplemental datums, a validity interval and metadata.
 * It cannot yet set a network id, a donation, votes or proposals. Its
 * scripts run inside the batch, so it runs only native and PlutusV4
 * scripts, whether attached or read from an input. Every script its
 * redeemers run must be attached to it or carried by its own inputs or
 * reference inputs, even one another level of the batch provides. Its
 * redeemers are indexed over its own body and its script data hash covers
 * its own redeemers and datums.
 *
 * `build()` resolves with the sub transaction unsigned. Its parties sign
 * its id before the batcher adds it, since the batch carries it byte for
 * byte.
 */
export class SubTransactionBuilder {
  private readonly spentUtxos: Cardano.Utxo[] = [];
  private readonly referenceUtxos: Cardano.Utxo[] = [];
  private readonly outputs: Cardano.TxOut[] = [];
  private readonly scripts: Cardano.Script[] = [];
  private readonly datums: Cardano.PlutusData[] = [];
  private readonly certificates: Cardano.Certificate[] = [];
  private readonly withdrawals = new Map<
    Cardano.RewardAccount,
    Cardano.Lovelace
  >();
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
  /** Required top level guards keyed by {@link guardKey}; serialization writes them in canonical order. */
  private readonly requiredTopLevelGuards = new Map<
    string,
    Cardano.RequiredTopLevelGuardEntry
  >();
  /** Guards keyed by {@link guardKey}, in the order they were added. */
  private readonly guards = new Map<string, Cardano.Credential>();
  private readonly spendRedeemers = new Map<string, Cardano.PlutusData>();
  private readonly mintRedeemers = new Map<
    Cardano.PolicyId,
    Cardano.PlutusData
  >();
  private readonly certificateRedeemers = new Map<
    Cardano.Certificate,
    Cardano.PlutusData
  >();
  private readonly withdrawalRedeemers = new Map<
    Cardano.RewardAccount,
    Cardano.PlutusData
  >();
  private readonly guardRedeemers = new Map<string, Cardano.PlutusData>();
  /** Execution units the caller gave, keyed as the redeemers are. */
  private readonly suppliedExecutionUnits = new Map<
    RedeemerKey,
    Cardano.ExUnits
  >();
  private mint?: Cardano.TokenMap;
  private metadata?: Cardano.TxMetadata;
  private validityInterval?: Cardano.ValidityInterval;
  private plutusContext?: SubTransactionPlutusContext;

  /**
   * Creates a new {@link SubTransactionBuilder} with an empty sub
   * transaction, and sets Conway era mode for serialization.
   */
  public constructor() {
    setInConwayEra(true);
  }

  /**
   * Supplies the Plutus context (see {@link SubTransactionPlutusContext}).
   * Required before {@link build} when the sub transaction carries a
   * redeemer or attaches a PlutusV4 script.
   *
   * @param context - The cost models and the evaluator.
   * @returns `this` for fluent chaining.
   */
  public setPlutusContext(
    context: SubTransactionPlutusContext,
  ): SubTransactionBuilder {
    this.plutusContext = context;
    return this;
  }

  /**
   * Spends a UTxO. For a UTxO at a script address, pass `script` with the
   * spend redeemer and, when the datum is by hash, the datum.
   *
   * @param utxo - The UTxO to spend.
   * @param script - Script-unlock data for a script input.
   * @throws If the input is already spent, or `script` is given for an
   *   input whose address has no script payment credential.
   * @returns `this` for fluent chaining.
   */
  public addInput(
    utxo: Cardano.Utxo,
    script?: SubTransactionScriptInputProps,
  ): SubTransactionBuilder {
    const key = utxoRefKey(utxo);
    if (script && !paymentScriptHash(utxo[1].address)) {
      throw new Error(
        `Spend redeemer requires an input at a script address, got ${key}`,
      );
    }
    if (this.spentUtxos.some(spent => utxoRefKey(spent) === key)) {
      throw new Error(`Cannot add duplicate input: ${key}`);
    }
    this.spentUtxos.push(utxo);
    if (script) {
      this.addRedeemer(this.spendRedeemers, key, script);
      if (script.datum !== undefined) recordDatum(this.datums, script.datum);
    }
    return this;
  }

  /**
   * Adds a reference input: a UTxO the sub transaction reads without
   * spending. A Plutus script it carries witnesses every redeemer that runs
   * it.
   *
   * @param utxo - The resolved UTxO to reference.
   * @throws If the UTxO is already a reference input.
   * @returns `this` for fluent chaining.
   */
  public addReferenceInput(utxo: Cardano.Utxo): SubTransactionBuilder {
    const key = utxoRefKey(utxo);
    if (
      this.referenceUtxos.some(referenced => utxoRefKey(referenced) === key)
    ) {
      throw new Error(`Cannot add duplicate reference input: ${key}`);
    }
    this.referenceUtxos.push(utxo);
    return this;
  }

  /**
   * Appends an output.
   *
   * @param output - The output, optionally with an inline datum.
   * @returns `this` for fluent chaining.
   */
  public addOutput(output: Cardano.TxOut): SubTransactionBuilder {
    this.outputs.push(output);
    return this;
  }

  /**
   * Sets the validity interval.
   *
   * @param validityInterval - The validity interval to set.
   * @returns `this` for fluent chaining.
   */
  public setValidityInterval(
    validityInterval: Cardano.ValidityInterval,
  ): SubTransactionBuilder {
    this.validityInterval = validityInterval;
    return this;
  }

  /**
   * Attaches a native or PlutusV4 script to the witness set. A sub
   * transaction cannot run a PlutusV1, PlutusV2 or PlutusV3 script from any
   * source: they cannot see the batch, so the ledger never runs them inside
   * a sub transaction.
   *
   * @param script - The script to attach.
   * @throws `UnsupportedSubTransactionScriptError` If `script` is a
   *   PlutusV1, PlutusV2 or PlutusV3 script.
   * @returns `this` for fluent chaining.
   */
  public attachScript(script: Cardano.Script): SubTransactionBuilder {
    if (
      Cardano.isPlutusScript(script) &&
      LEGACY_PLUTUS_LANGUAGES.has(script.version)
    ) {
      throw new UnsupportedSubTransactionScriptError(
        script.version,
        Serialization.Script.fromCore(script).hash(),
      );
    }
    this.scripts.push(script);
    return this;
  }

  /**
   * Sets a metadata entry under the given label, keeping the entries set
   * before; setting a label again overwrites it. The body commits to the
   * auxiliary data by its hash.
   *
   * @param label - Metadata label (e.g. `674` for CIP-20 messages).
   * @param metadatum - The metadatum to set under the label.
   * @returns `this` for fluent chaining.
   */
  public setMetadata(
    label: bigint,
    metadatum: Cardano.Metadatum,
  ): SubTransactionBuilder {
    this.metadata = new Map(this.metadata).set(label, metadatum);
    return this;
  }

  /**
   * Mints (or burns, with negative quantities) assets. A Plutus policy
   * needs the mint redeemer given in `script`; a native policy needs none.
   *
   * @param assets - The assets to mint or burn.
   * @param script - Mint redeemer for a Plutus policy.
   * @returns `this` for fluent chaining.
   */
  public mintAssets(
    assets: Cardano.TokenMap,
    script?: SubTransactionRedeemerProps,
  ): SubTransactionBuilder {
    this.mint = new Map([...(this.mint ?? []), ...assets]);
    if (script) {
      for (const assetId of assets.keys()) {
        this.addRedeemer(
          this.mintRedeemers,
          Cardano.AssetId.getPolicyId(assetId),
          script,
        );
      }
    }
    return this;
  }

  /**
   * Adds a datum to the witness set, such as the datum of an output the sub
   * transaction creates locked by its hash, or of an output it spends. The
   * script data hash covers it, and a datum already in the witness set is
   * not added again.
   *
   * @param datum - The datum to add.
   * @returns `this` for fluent chaining.
   */
  public addDatum(datum: Cardano.PlutusData): SubTransactionBuilder {
    recordDatum(this.datums, datum);
    return this;
  }

  /**
   * Adds a certificate. When a Plutus script credential witnesses the
   * certificate, the stake credential of a stake certificate, the DRep
   * credential of a DRep certificate or the cold credential of a committee
   * certificate, its redeemer is given in `script`.
   *
   * A pool registration counts the pool deposit once per pool in the value
   * the sub transaction takes from the batch, and the batch charges it once
   * per pool across all of its transactions, as the ledger does. A
   * registration that updates the parameters of a pool already registered
   * on chain is charged nothing when the batcher gives the pool to
   * `TransactionBuilder.setRegisteredPools`, and is charged otherwise. A
   * pool retirement refunds nothing in the batch, as the ledger returns its
   * deposit at the epoch boundary.
   *
   * @param certificate - The certificate to add.
   * @param script - Certificate redeemer for a script hash credential.
   * @throws If `script` is given for a certificate no script hash credential
   *   witnesses, such as a legacy stake registration.
   * @returns `this` for fluent chaining.
   */
  public addCertificate(
    certificate: Cardano.Certificate,
    script?: SubTransactionRedeemerProps,
  ): SubTransactionBuilder {
    const credential = certificateWitnessCredential(certificate);
    if (script && credential?.type !== Cardano.CredentialType.ScriptHash) {
      throw new Error(
        `Certificate redeemer requires a script hash credential that witnesses the certificate, got ${certificate.__typename}`,
      );
    }
    this.certificates.push(certificate);
    if (script)
      this.addRedeemer(this.certificateRedeemers, certificate, script);
    return this;
  }

  /**
   * Withdraws rewards from a reward account. A Plutus script reward account
   * needs the withdrawal redeemer given in `script`.
   *
   * @param rewardAccount - The reward account to withdraw from.
   * @param amount - The amount to withdraw, the whole balance.
   * @param script - Withdrawal redeemer for a script reward account.
   * @returns `this` for fluent chaining.
   */
  public addRewardsWithdrawal(
    rewardAccount: Cardano.RewardAccount,
    amount: Cardano.Lovelace,
    script?: SubTransactionRedeemerProps,
  ): SubTransactionBuilder {
    this.withdrawals.set(rewardAccount, amount);
    if (script) {
      this.addRedeemer(this.withdrawalRedeemers, rewardAccount, script);
    }
    return this;
  }

  /**
   * Marks a key hash as a required signer, a key hash guard among the
   * guards added with {@link addGuard}.
   *
   * @param keyHash - The Ed25519 key hash to require.
   * @returns `this` for fluent chaining.
   */
  public addRequiredSigner(
    keyHash: Crypto.Ed25519KeyHashHex,
  ): SubTransactionBuilder {
    return this.addGuard({
      type: Cardano.CredentialType.KeyHash,
      hash: keyHash as unknown as Crypto.Hash28ByteBase16,
    });
  }

  /**
   * Requires a guard to approve the sub transaction. A key hash guard is a
   * required signer; a script hash guard makes the ledger run the script,
   * and a Plutus script needs the guarding redeemer given in `script`.
   *
   * Guards keep the order they were added in, and a guarding redeemer's
   * index is its guard's position among them. While every guard is a key
   * hash the body lists them as required signers.
   *
   * @param guard - The key hash or script hash credential to require.
   * @param script - Guarding redeemer for a Plutus script hash `guard`.
   * @throws If `script` is given for a key hash guard, or the guard already
   *   has a redeemer.
   * @returns `this` for fluent chaining.
   */
  public addGuard(
    guard: Cardano.Credential,
    script?: SubTransactionRedeemerProps,
  ): SubTransactionBuilder {
    recordGuard(
      { guards: this.guards, guardRedeemers: this.guardRedeemers },
      guard,
      script?.redeemer,
    );
    if (script?.executionUnits) {
      this.suppliedExecutionUnits.set(guardKey(guard), script.executionUnits);
    }
    return this;
  }

  /**
   * Requires the transaction that carries the sub transaction to carry
   * `guard` among its own guards, supplied with `datum`. Requiring the same
   * guard again replaces its datum. The body writes the required guards in
   * canonical order, by credential, whatever the order they were added in.
   *
   * The ledger requires a datum for a Plutus script guard and refuses one
   * for a key hash or native script guard. A datum for a key hash guard is
   * refused here; a script hash guard is checked by {@link build} when the
   * sub transaction attaches the script or its inputs carry it.
   *
   * @param guard - The key hash or script hash credential to require.
   * @param datum - The datum the guard must be supplied with, for a Plutus
   *   script guard only.
   * @throws `MalformedGuardDatumError` If `datum` is given for a key hash
   *   guard.
   * @returns `this` for fluent chaining.
   */
  public requireTopLevelGuard(
    guard: Cardano.Credential,
    datum?: Cardano.PlutusData,
  ): SubTransactionBuilder {
    if (datum !== undefined && guard.type === Cardano.CredentialType.KeyHash) {
      throw new MalformedGuardDatumError(guard);
    }
    this.requiredTopLevelGuards.set(guardKey(guard), {
      credential: { type: guard.type, hash: guard.hash },
      datum: datum ?? null,
    });
    return this;
  }

  /**
   * Deposits coin directly into the account behind a reward account.
   * Deposits to the same reward account add up into one entry.
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
  ): SubTransactionBuilder {
    accumulateDirectDeposit(this.directDeposits, rewardAccount, amount);
    return this;
  }

  /**
   * Requires the balance of the account behind a reward account to lie in
   * `interval` when the sub transaction is applied. A second interval for
   * the same reward account replaces the first.
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
  ): SubTransactionBuilder {
    this.accountBalanceIntervals.set(
      rewardAccount,
      accountBalanceInterval(interval),
    );
    return this;
  }

  /**
   * Builds the unsigned sub transaction: indexes its redeemers over its
   * body, takes the execution units the caller gave or has the
   * {@link SubTransactionPlutusContext} evaluator measure the others, and
   * computes its script data hash. It is written in the canonical form the
   * cardano-c sub transaction builder writes.
   *
   * A sub transaction that carries datums but no redeemer or Plutus script
   * needs no Plutus context: its script data hash covers the datums alone.
   *
   * @throws If a redeemer or PlutusV4 script needs a Plutus context that is
   *   not set, or a redeemer has no execution units and the context
   *   has no evaluator, or the evaluator skips a redeemer.
   * @throws `ExtraneousRedeemerError` When a redeemer runs a script that is
   *   not a Plutus script the sub transaction attaches or its inputs carry.
   * @throws `MissingRedeemerError` When a purpose runs a Plutus script the
   *   sub transaction attaches or its inputs carry, without a redeemer.
   * @throws `MissingDatumError` When a spend redeemer spends an output
   *   locked by a datum hash whose datum the sub transaction does not carry.
   * @throws `MalformedGuardDatumError` When a required top level guard is a
   *   native script the sub transaction provides and carries a datum, or a
   *   Plutus script it provides and carries none.
   * @throws `UnsupportedSubTransactionScriptError` When a redeemer runs a
   *   PlutusV1, PlutusV2 or PlutusV3 script an input carries.
   * @returns The unsigned sub transaction.
   */
  public async build(): Promise<Serialization.SubTransaction> {
    const body = this.body();
    const sources = this.redeemerSources();
    const spent = this.spentUtxos;
    assertRedeemersMatchPlutusScripts(
      scriptPurposes(sources, body, spent),
      scriptHashes([
        ...this.scripts.filter(Cardano.isPlutusScript),
        ...this.providedPlutusScripts(),
      ]),
    );
    assertSpentDatumsProvided(this.spendRedeemers, spent, this.datums);
    assertGuardDatums(this.requiredTopLevelGuards.values(), [
      ...this.scripts,
      ...carriedScripts([...this.spentUtxos, ...this.referenceUtxos]),
    ]);
    this.assertRunsNoLegacyScript(body);

    const shouldRunPlutus =
      redeemerCount(sources) > 0 || this.scripts.some(Cardano.isPlutusScript);
    const context = this.plutusContext;
    if (shouldRunPlutus && !context) {
      throw new Error(
        'Plutus context is not set. Call setPlutusContext() before build()',
      );
    }

    const redeemers = await this.evaluateRedeemers(
      body,
      indexRedeemers(
        sources,
        body,
        (_purpose, _index, key) =>
          this.suppliedExecutionUnits.get(key) ?? UNEVALUATED_EX_UNITS,
      ),
    );
    const scriptIntegrityHash = computeConwayScriptDataHash({
      costModels:
        context?.costModels ??
        new Map<Cardano.PlutusLanguageVersion, Cardano.CostModel>(),
      usedLanguages: scriptDataLanguages(
        this.scripts,
        this.providedPlutusScripts(),
        redeemedScriptHashes(sources, spent),
      ),
      redeemers,
      datums: this.datums.length > 0 ? this.datums : undefined,
    });

    return serializeSubTransaction({
      body: { ...body, ...(scriptIntegrityHash && { scriptIntegrityHash }) },
      witness: this.witness(redeemers),
      ...this.auxiliaryData(),
    });
  }

  /**
   * A sub transaction cannot run a PlutusV1, PlutusV2 or PlutusV3 script, so
   * no redeemer may run one an input carries.
   *
   * @throws `UnsupportedSubTransactionScriptError` For the first redeemed
   *   purpose, in the ledger's order, whose script is such a script.
   */
  private assertRunsNoLegacyScript(body: Cardano.SubTransactionBody): void {
    const legacyScripts = new Map<string, Cardano.PlutusScript>(
      this.providedPlutusScripts()
        .filter(({ version }) => LEGACY_PLUTUS_LANGUAGES.has(version))
        .map(script => [Serialization.Script.fromCore(script).hash(), script]),
    );
    for (const { scriptHash, isRedeemed } of scriptPurposes(
      this.redeemerSources(),
      body,
      this.spentUtxos,
    )) {
      const script = legacyScripts.get(scriptHash);
      if (isRedeemed && script) {
        throw new UnsupportedSubTransactionScriptError(
          script.version,
          scriptHash,
        );
      }
    }
  }

  /** The auxiliary data the metadata makes, when any is set. */
  private auxiliaryData(): Pick<Cardano.SubTransaction, 'auxiliaryData'> {
    return this.metadata ? { auxiliaryData: { blob: this.metadata } } : {};
  }

  /** Records `script`'s redeemer in `redeemers` and any execution units it gives. */
  private addRedeemer<K extends RedeemerKey>(
    redeemers: Map<K, Cardano.PlutusData>,
    key: K,
    script: SubTransactionRedeemerProps,
  ): void {
    redeemers.set(key, script.redeemer);
    if (script.executionUnits) {
      this.suppliedExecutionUnits.set(key, script.executionUnits);
    } else {
      this.suppliedExecutionUnits.delete(key);
    }
  }

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

  /** The Plutus scripts the spent and reference inputs carry. */
  private providedPlutusScripts(): Cardano.PlutusScript[] {
    return carriedPlutusScripts([...this.spentUtxos, ...this.referenceUtxos]);
  }

  /** The sub transaction body, without its script data hash. */
  private body(): Cardano.SubTransactionBody {
    const body: Cardano.SubTransactionBody = {
      inputs: this.spentUtxos.map(toTxIn),
      outputs: this.outputs,
    };
    if (this.referenceUtxos.length > 0) {
      body.referenceInputs = this.referenceUtxos.map(toTxIn);
    }
    if (this.mint) body.mint = this.mint;
    if (this.certificates.length > 0) body.certificates = this.certificates;
    if (this.withdrawals.size > 0) {
      body.withdrawals = [...this.withdrawals].map(
        ([stakeAddress, quantity]) => ({ stakeAddress, quantity }),
      );
    }
    if (this.validityInterval) {
      body.validityInterval = this.validityInterval;
    }
    const auxiliaryDataHashOfBody = auxiliaryDataHash(
      this.auxiliaryData().auxiliaryData,
    );
    if (auxiliaryDataHashOfBody) {
      body.auxiliaryDataHash = auxiliaryDataHashOfBody;
    }
    applyGuards(body, this.guards);
    if (this.requiredTopLevelGuards.size > 0) {
      body.requiredTopLevelGuards = [...this.requiredTopLevelGuards.values()];
    }
    applyAccountEntries(body, {
      directDeposits: this.directDeposits,
      accountBalanceIntervals: this.accountBalanceIntervals,
    });
    return body;
  }

  /** The witness set of the sub transaction, without signatures. */
  private witness(redeemers: Cardano.Redeemer[]): Cardano.Witness {
    return {
      signatures: new Map(),
      ...(this.scripts.length > 0 && { scripts: this.scripts }),
      ...(this.datums.length > 0 && { datums: this.datums }),
      ...(redeemers.length > 0 && { redeemers }),
    };
  }

  /**
   * Gives every redeemer the caller left without execution units the units
   * the evaluator measures for it.
   *
   * @param body - The sub transaction body.
   * @param redeemers - The indexed redeemers, with the units the caller gave.
   * @returns The redeemers, each with its execution units.
   */
  private async evaluateRedeemers(
    body: Cardano.SubTransactionBody,
    redeemers: Cardano.Redeemer[],
  ): Promise<Cardano.Redeemer[]> {
    const unevaluated = redeemers.filter(
      ({ executionUnits }) => executionUnits === UNEVALUATED_EX_UNITS,
    );
    if (unevaluated.length === 0) return redeemers;
    const evaluator = this.plutusContext?.txEvaluator;
    if (!evaluator) {
      throw new Error(
        `No execution units for redeemer ${unevaluated[0].purpose}#${unevaluated[0].index}: give them with the redeemer or set a txEvaluator in the Plutus context`,
      );
    }
    const subTransaction = serializeSubTransaction({
      body,
      witness: this.witness(redeemers),
      ...this.auxiliaryData(),
    });
    const tx: Cardano.Tx = {
      id: subTransaction.getId(),
      body: { ...body, fee: 0n },
      witness: this.witness(redeemers),
    };
    const carrier = serializeTransaction(
      {
        id: subTransaction.getId(),
        body: { inputs: [], outputs: [], fee: 0n },
        witness: { signatures: new Map() },
      },
      [subTransaction],
    );
    const evaluation = await evaluator.evaluate(
      tx,
      [...this.spentUtxos, ...this.referenceUtxos],
      carrier,
    );
    return redeemers.map(redeemer => {
      if (redeemer.executionUnits !== UNEVALUATED_EX_UNITS) return redeemer;
      const result = evaluation.find(
        item =>
          item.purpose === redeemer.purpose && item.index === redeemer.index,
      );
      if (!result) {
        throw new Error(
          `No ex-units evaluation for redeemer ${redeemer.purpose}#${redeemer.index}`,
        );
      }
      return { ...redeemer, executionUnits: result.budget };
    });
  }
}
