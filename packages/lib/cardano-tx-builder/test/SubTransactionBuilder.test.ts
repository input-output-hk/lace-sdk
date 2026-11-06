import { Cardano, Serialization } from '@lace-lib/cardano-core';
import { HexBlob } from '@lace-lib/cardano-util';
import { describe, expect, it, vi } from 'vitest';

import { LargeFirstCoinSelector } from '../src/input-selection/LargeFirstCoinSelector';
import {
  ExtraneousRedeemerError,
  MalformedGuardDatumError,
  MissingDatumError,
  MissingRedeemerError,
} from '../src/redeemers';
import { computeConwayScriptDataHash } from '../src/script-data-hash';
import { auxiliaryDataHash } from '../src/serialization';
import {
  SubTransactionBuilder,
  UnsupportedSubTransactionScriptError,
} from '../src/SubTransactionBuilder';
import { TransactionBuilder } from '../src/TransactionBuilder';

import type { TxEvaluator } from '../src/types';
import type * as Crypto from '@lace-lib/cardano-crypto';

const address = Cardano.PaymentAddress(
  'addr_test1qpfhhfy2qgls50r9u4yh0l7z67xpg0a5rrhkmvzcuqrd0znuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q9gw0lz',
);
const rewardAccount = Cardano.RewardAccount(
  'stake_test1uqfu74w3wh4gfzu8m6e7j987h4lq9r3t7ef5gaw497uu85qsqfy27',
);
const otherRewardAccount = Cardano.RewardAccount(
  'stake_test1uzvenxvenxvenxvenxvenxvenxvenxvenxvenxvenxvenxgkhq6sq',
);

const plutusScript = (
  version: Cardano.PlutusLanguageVersion,
  bytes: string,
): Cardano.PlutusScript => ({
  __type: Cardano.ScriptType.Plutus,
  version,
  bytes: HexBlob(bytes),
});

const v4Script = plutusScript(Cardano.PlutusLanguageVersion.V4, '450100002499');
const v4Hash = Serialization.Script.fromCore(v4Script).hash();
const v4Address = Cardano.EnterpriseAddress.fromCredentials(
  Cardano.NetworkId.Testnet,
  { type: Cardano.CredentialType.ScriptHash, hash: v4Hash },
)
  .toAddress()
  .toBech32() as Cardano.PaymentAddress;
const v4Guard: Cardano.Credential = {
  type: Cardano.CredentialType.ScriptHash,
  hash: v4Hash,
};
const nativeScript: Cardano.Script = {
  __type: Cardano.ScriptType.Native,
  kind: Cardano.NativeScriptKind.RequireAllOf,
  scripts: [],
};
const nativePolicyId = Cardano.PolicyId(
  Serialization.Script.fromCore(nativeScript).hash(),
);
const signerKeyHash = '88'.repeat(28) as Crypto.Ed25519KeyHashHex;
const keyGuard: Cardano.Credential = {
  type: Cardano.CredentialType.KeyHash,
  hash: signerKeyHash as unknown as Crypto.Hash28ByteBase16,
};

const unit = Serialization.PlutusData.fromCbor(HexBlob('d87980')).toCore();
const datum = Serialization.PlutusData.fromCbor(HexBlob('182a')).toCore();
const budget: Cardano.ExUnits = { memory: 1_108_660, steps: 1_069_065 };
const costModels: Cardano.CostModels = new Map([
  [Cardano.PlutusLanguageVersion.V4, Array.from({ length: 320 }, () => 1)],
]);

const utxoOf = (
  byte: string,
  coins: bigint,
  owner: Cardano.PaymentAddress = address,
  extra: Partial<Cardano.TxOut> = {},
  // eslint-disable-next-line max-params
): Cardano.Utxo => [
  { txId: Cardano.TransactionId(byte.repeat(32)), index: 0, address: owner },
  { address: owner, value: { coins }, ...extra },
];

const keyUtxo = utxoOf('b2', 10_000_000n);
const otherKeyUtxo = utxoOf('a1', 4_000_000n);
const scriptUtxo = utxoOf('c3', 5_000_000n, v4Address, { datum: unit });

const fixedEvaluator = (): TxEvaluator => ({
  evaluate: vi.fn(async (tx: Cardano.Tx) =>
    (tx.witness.redeemers ?? []).map(({ purpose, index }) => ({
      purpose,
      index,
      budget,
    })),
  ),
});

const redeemersOf = (subTransaction: Serialization.SubTransaction) =>
  subTransaction.witnessSet().redeemers()?.toCore() ?? [];

describe('SubTransactionBuilder', () => {
  it('builds an unsigned sub transaction with no fee that need not balance, inputs in set order and outputs in the map form', async () => {
    const subTransaction = await new SubTransactionBuilder()
      .addInput(keyUtxo)
      .addInput(otherKeyUtxo)
      .addOutput({ address, value: { coins: 50_000_000n } })
      .build();

    const body = subTransaction.body();
    expect(body.inputs().toCore()).toEqual(
      [otherKeyUtxo[0], keyUtxo[0]].map(({ txId, index }) => ({ txId, index })),
    );
    expect(body.outputs()[0].isBabbageOutput()).toBe(true);
    expect(body.toCore().outputs[0].value.coins).toBe(50_000_000n);
    expect('fee' in body.toCore()).toBe(false);
    expect(subTransaction.witnessSet().vkeys()).toBeUndefined();
    expect(body.scriptDataHash()).toBeUndefined();
  });

  it('refuses PlutusV1, PlutusV2 and PlutusV3 scripts, and attaches native and PlutusV4 scripts', () => {
    for (const version of [
      Cardano.PlutusLanguageVersion.V1,
      Cardano.PlutusLanguageVersion.V2,
      Cardano.PlutusLanguageVersion.V3,
    ]) {
      expect(() =>
        new SubTransactionBuilder().attachScript(
          plutusScript(version, '4746010000222499'),
        ),
      ).toThrow(UnsupportedSubTransactionScriptError);
    }
    expect(() =>
      new SubTransactionBuilder()
        .attachScript(nativeScript)
        .attachScript(v4Script),
    ).not.toThrow();
  });

  it('indexes a spend redeemer over its own inputs and hashes its own redeemers, datums and the PlutusV4 language view', async () => {
    const subTransaction = await new SubTransactionBuilder()
      .setPlutusContext({ costModels, txEvaluator: fixedEvaluator() })
      .addInput(keyUtxo)
      .addInput(scriptUtxo, { redeemer: unit, datum })
      .attachScript(v4Script)
      .addOutput({ address, value: { coins: 15_000_000n } })
      .build();

    const redeemers = redeemersOf(subTransaction);
    expect(redeemers).toEqual([
      {
        purpose: Cardano.RedeemerPurpose.spend,
        index: 1,
        data: unit,
        executionUnits: budget,
      },
    ]);
    expect(subTransaction.body().scriptDataHash()).toBe(
      computeConwayScriptDataHash({
        costModels,
        usedLanguages: [Cardano.PlutusLanguageVersion.V4],
        redeemers,
        datums: [datum],
      }),
    );
  });

  it('hands the evaluator the sub transaction as a transaction with no fee, the UTxOs it spends and references, and a transaction that carries its bytes', async () => {
    const evaluator = fixedEvaluator();
    const referenceUtxo = utxoOf('d4', 2_000_000n);
    const subTransaction = await new SubTransactionBuilder()
      .setPlutusContext({ costModels, txEvaluator: evaluator })
      .addInput(scriptUtxo, { redeemer: unit })
      .addReferenceInput(referenceUtxo)
      .attachScript(v4Script)
      .build();

    const [tx, resolvedInputs, carrier] = vi.mocked(evaluator.evaluate).mock
      .calls[0];
    expect(tx.body.fee).toBe(0n);
    expect(tx.body.inputs).toEqual(
      [scriptUtxo[0]].map(({ txId, index }) => ({
        txId,
        index,
      })),
    );
    expect(tx.witness.redeemers).toHaveLength(1);
    expect(resolvedInputs).toEqual([scriptUtxo, referenceUtxo]);
    const carried = carrier!.body().subTransactions()!.values();
    expect(carried).toHaveLength(1);
    expect(carried[0].body().toCbor()).toBe(
      Serialization.SubTransactionBody.fromCore({
        ...subTransaction.body().toCore(),
        scriptIntegrityHash: undefined,
      }).toCbor(),
    );
  });

  it('keeps the execution units given with a redeemer and evaluates only the others', async () => {
    const evaluator = fixedEvaluator();
    const given: Cardano.ExUnits = { memory: 7, steps: 9 };
    const subTransaction = await new SubTransactionBuilder()
      .setPlutusContext({ costModels, txEvaluator: evaluator })
      .addInput(scriptUtxo, { redeemer: unit, executionUnits: given })
      .attachScript(v4Script)
      .mintAssets(new Map([[Cardano.AssetId(`${v4Hash}5634`), 5n]]), {
        redeemer: unit,
      })
      .build();

    expect(
      redeemersOf(subTransaction).map(({ purpose, executionUnits }) => [
        purpose,
        executionUnits,
      ]),
    ).toEqual([
      [Cardano.RedeemerPurpose.spend, given],
      [Cardano.RedeemerPurpose.mint, budget],
    ]);
    expect(evaluator.evaluate).toHaveBeenCalledTimes(1);
  });

  it('needs no evaluator when every redeemer carries its execution units', async () => {
    const subTransaction = await new SubTransactionBuilder()
      .setPlutusContext({ costModels })
      .addInput(scriptUtxo, { redeemer: unit, executionUnits: budget })
      .attachScript(v4Script)
      .build();

    expect(redeemersOf(subTransaction)[0].executionUnits).toEqual(budget);
  });

  it('refuses a redeemer without execution units when the Plutus context has no evaluator', async () => {
    await expect(
      new SubTransactionBuilder()
        .setPlutusContext({ costModels })
        .addInput(scriptUtxo, { redeemer: unit })
        .attachScript(v4Script)
        .build(),
    ).rejects.toThrow('No execution units for redeemer spend#0');
  });

  it('needs the Plutus context for a redeemer', async () => {
    await expect(
      new SubTransactionBuilder()
        .addInput(scriptUtxo, { redeemer: unit, executionUnits: budget })
        .attachScript(v4Script)
        .build(),
    ).rejects.toThrow('Plutus context is not set');
  });

  it('needs the Plutus context for a datum carried beside a redeemer whose script a reference input provides', async () => {
    await expect(
      new SubTransactionBuilder()
        .addInput(scriptUtxo, { redeemer: unit, executionUnits: budget })
        .addReferenceInput(
          utxoOf('d4', 10_000_000n, address, { scriptReference: v4Script }),
        )
        .addDatum(datum)
        .build(),
    ).rejects.toThrow('Plutus context is not set');
  });

  it('refuses to spend a PlutusV4 output without a redeemer, and a redeemer whose script it does not provide', async () => {
    await expect(
      new SubTransactionBuilder()
        .setPlutusContext({ costModels })
        .addInput(scriptUtxo)
        .attachScript(v4Script)
        .build(),
    ).rejects.toThrow(MissingRedeemerError);
    await expect(
      new SubTransactionBuilder()
        .setPlutusContext({ costModels })
        .addInput(scriptUtxo, { redeemer: unit, executionUnits: budget })
        .build(),
    ).rejects.toThrow(ExtraneousRedeemerError);
  });

  it('refuses a redeemer that runs a PlutusV3 script a reference input carries', async () => {
    const v3Script = plutusScript(
      Cardano.PlutusLanguageVersion.V3,
      '46450101002499',
    );
    const v3Address = Cardano.EnterpriseAddress.fromCredentials(
      Cardano.NetworkId.Testnet,
      {
        type: Cardano.CredentialType.ScriptHash,
        hash: Serialization.Script.fromCore(v3Script).hash(),
      },
    )
      .toAddress()
      .toBech32() as Cardano.PaymentAddress;

    await expect(
      new SubTransactionBuilder()
        .setPlutusContext({ costModels })
        .addInput(utxoOf('c5', 5_000_000n, v3Address, { datum: unit }), {
          redeemer: unit,
          executionUnits: budget,
        })
        .addReferenceInput(
          utxoOf('d4', 10_000_000n, address, { scriptReference: v3Script }),
        )
        .build(),
    ).rejects.toThrow(UnsupportedSubTransactionScriptError);
  });

  it('refuses to spend an output locked by a datum hash without its datum, and spends it with the datum', async () => {
    const hashed = utxoOf('c6', 5_000_000n, v4Address, {
      datumHash: Serialization.PlutusData.fromCore(datum).hash(),
    });
    const spend = async (script: {
      redeemer: Cardano.PlutusData;
      datum?: Cardano.PlutusData;
    }) =>
      new SubTransactionBuilder()
        .setPlutusContext({ costModels })
        .addInput(hashed, { ...script, executionUnits: budget })
        .attachScript(v4Script)
        .build();

    await expect(spend({ redeemer: unit })).rejects.toThrow(MissingDatumError);
    await expect(spend({ redeemer: unit, datum })).resolves.toBeDefined();
  });

  it('forgets the execution units of a redeemer replaced by one given without them', async () => {
    const evaluator = fixedEvaluator();
    const subTransaction = await new SubTransactionBuilder()
      .setPlutusContext({ costModels, txEvaluator: evaluator })
      .attachScript(v4Script)
      .mintAssets(new Map([[Cardano.AssetId(`${v4Hash}41`), 1n]]), {
        redeemer: unit,
        executionUnits: { memory: 7, steps: 9 },
      })
      .mintAssets(new Map([[Cardano.AssetId(`${v4Hash}42`), 1n]]), {
        redeemer: unit,
      })
      .build();

    expect(redeemersOf(subTransaction)[0].executionUnits).toEqual(budget);
    expect(evaluator.evaluate).toHaveBeenCalledTimes(1);
  });

  it('writes metadata as auxiliary data the body commits to by its hash', async () => {
    const subTransaction = await new SubTransactionBuilder()
      .addInput(keyUtxo)
      .setMetadata(674n, new Map([['msg', ['first']]]))
      .setMetadata(721n, 'nft')
      .setMetadata(674n, new Map([['msg', ['intent']]]))
      .build();

    expect(subTransaction.auxiliaryData()?.toCore().blob).toEqual(
      new Map<bigint, Cardano.Metadatum>([
        [674n, new Map([['msg', ['intent']]])],
        [721n, 'nft'],
      ]),
    );
    expect(subTransaction.body().auxiliaryDataHash()).toBe(
      auxiliaryDataHash(subTransaction.auxiliaryData()!.toCore()),
    );
  });

  it('runs a PlutusV4 script a reference input carries, attaching none', async () => {
    const subTransaction = await new SubTransactionBuilder()
      .setPlutusContext({ costModels })
      .addInput(scriptUtxo, { redeemer: unit, executionUnits: budget })
      .addReferenceInput(
        utxoOf('d4', 10_000_000n, address, { scriptReference: v4Script }),
      )
      .build();

    expect(subTransaction.witnessSet().toCore().scripts).toBeUndefined();
    expect(subTransaction.body().scriptDataHash()).toBeDefined();
  });

  it('mints under a native policy without a redeemer or Plutus context', async () => {
    const subTransaction = await new SubTransactionBuilder()
      .addInput(keyUtxo)
      .attachScript(nativeScript)
      .mintAssets(new Map([[Cardano.AssetId(`${nativePolicyId}4e41`), 3n]]))
      .build();

    expect(subTransaction.body().mint()).toEqual(
      new Map([[Cardano.AssetId(`${nativePolicyId}4e41`), 3n]]),
    );
    expect(redeemersOf(subTransaction)).toEqual([]);
  });

  it('adds a supplemental datum to the witness set once and hashes it into its script data hash', async () => {
    const subTransaction = await new SubTransactionBuilder()
      .setPlutusContext({ costModels })
      .addInput(keyUtxo)
      .addOutput({
        address,
        value: { coins: 2_000_000n },
        datumHash: Serialization.PlutusData.fromCore(datum).hash(),
      })
      .addDatum(datum)
      .addDatum(datum)
      .build();

    expect(subTransaction.witnessSet().toCore().datums).toEqual([datum]);
    expect(subTransaction.body().scriptDataHash()).toBe(
      computeConwayScriptDataHash({
        costModels,
        usedLanguages: [],
        redeemers: [],
        datums: [datum],
      }),
    );
  });

  it('builds a sub transaction that carries only a datum without a Plutus context, hashing the datum alone', async () => {
    const subTransaction = await new SubTransactionBuilder()
      .addInput(keyUtxo)
      .addOutput({
        address,
        value: { coins: 2_000_000n },
        datumHash: Serialization.PlutusData.fromCore(datum).hash(),
      })
      .addDatum(datum)
      .build();

    expect(subTransaction.witnessSet().toCore().datums).toEqual([datum]);
    expect(subTransaction.body().scriptDataHash()).toBe(
      computeConwayScriptDataHash({
        costModels: new Map(),
        usedLanguages: [],
        redeemers: [],
        datums: [datum],
      }),
    );
  });

  it('keeps a spend datum of zero', async () => {
    const hashed = utxoOf('c8', 5_000_000n, v4Address, {
      datumHash: Serialization.PlutusData.fromCore(0n).hash(),
    });

    const subTransaction = await new SubTransactionBuilder()
      .setPlutusContext({ costModels })
      .addInput(hashed, { redeemer: unit, datum: 0n, executionUnits: budget })
      .attachScript(v4Script)
      .build();

    expect(subTransaction.witnessSet().toCore().datums).toEqual([0n]);
  });

  it('provides the datum of an output a redeemer spends, and keeps one copy of a datum the input also carries', async () => {
    const hashed = utxoOf('c7', 5_000_000n, v4Address, {
      datumHash: Serialization.PlutusData.fromCore(datum).hash(),
    });
    const build = async (spendDatum?: Cardano.PlutusData) =>
      new SubTransactionBuilder()
        .setPlutusContext({ costModels })
        .addInput(hashed, {
          redeemer: unit,
          datum: spendDatum,
          executionUnits: budget,
        })
        .addDatum(datum)
        .attachScript(v4Script)
        .build();

    for (const subTransaction of [await build(), await build(datum)]) {
      expect(subTransaction.witnessSet().toCore().datums).toEqual([datum]);
    }
  });

  it('lists key hash guards as required signers and indexes a guarding redeemer by its position among the guards', async () => {
    const signed = await new SubTransactionBuilder()
      .addInput(keyUtxo)
      .addRequiredSigner(signerKeyHash)
      .build();
    expect(signed.body().toCore().requiredExtraSignatures).toEqual([
      signerKeyHash,
    ]);

    const guarded = await new SubTransactionBuilder()
      .setPlutusContext({ costModels })
      .addInput(keyUtxo)
      .addRequiredSigner(signerKeyHash)
      .addGuard(v4Guard, { redeemer: unit, executionUnits: budget })
      .attachScript(v4Script)
      .build();
    expect(guarded.body().toCore().guards).toEqual([keyGuard, v4Guard]);
    expect(redeemersOf(guarded)[0]).toMatchObject({
      purpose: Cardano.RedeemerPurpose.guarding,
      index: 1,
    });
  });

  it('refuses a guarding redeemer for a key hash guard', () => {
    expect(() =>
      new SubTransactionBuilder().addGuard(keyGuard, { redeemer: unit }),
    ).toThrow('Guarding redeemer requires a script hash guard');
  });

  it('keeps an integer zero guarding redeemer and refuses one for a key hash guard', async () => {
    const guarded = await new SubTransactionBuilder()
      .setPlutusContext({ costModels })
      .addInput(keyUtxo)
      .addGuard(v4Guard, { redeemer: 0n, executionUnits: budget })
      .attachScript(v4Script)
      .build();

    expect(redeemersOf(guarded)).toEqual([
      {
        purpose: Cardano.RedeemerPurpose.guarding,
        index: 0,
        data: 0n,
        executionUnits: budget,
      },
    ]);
    expect(() =>
      new SubTransactionBuilder().addGuard(keyGuard, { redeemer: 0n }),
    ).toThrow('Guarding redeemer requires a script hash guard');
  });

  it('writes the required top level guards in canonical order, whatever the order they were added in, and replaces the datum of a guard required again', async () => {
    const lowerScriptGuard: Cardano.Credential = {
      type: Cardano.CredentialType.ScriptHash,
      hash: '00'.repeat(28) as Crypto.Hash28ByteBase16,
    };
    const subTransaction = await new SubTransactionBuilder()
      .addInput(keyUtxo)
      .requireTopLevelGuard(v4Guard, unit)
      .requireTopLevelGuard(lowerScriptGuard)
      .requireTopLevelGuard(keyGuard)
      .requireTopLevelGuard(lowerScriptGuard, datum)
      .build();

    expect(subTransaction.body().toCore().requiredTopLevelGuards).toEqual([
      { credential: keyGuard, datum: null },
      { credential: lowerScriptGuard, datum },
      { credential: v4Guard, datum: unit },
    ]);
  });

  describe('required top level guard datums', () => {
    const nativeGuard: Cardano.Credential = {
      type: Cardano.CredentialType.ScriptHash,
      hash: nativePolicyId as unknown as Crypto.Hash28ByteBase16,
    };
    const v4ScriptUtxo = utxoOf('d4', 5_000_000n, address, {
      scriptReference: v4Script,
    });

    it('refuses a datum for a key hash guard when the guard is required', () => {
      for (const keyDatum of [datum, 0n]) {
        expect(() =>
          new SubTransactionBuilder().requireTopLevelGuard(keyGuard, keyDatum),
        ).toThrow(new MalformedGuardDatumError(keyGuard));
      }
    });

    it('refuses a datum for a native script guard whose script the sub transaction attaches', async () => {
      await expect(
        new SubTransactionBuilder()
          .addInput(keyUtxo)
          .attachScript(nativeScript)
          .requireTopLevelGuard(nativeGuard, datum)
          .build(),
      ).rejects.toThrow(
        new MalformedGuardDatumError(nativeGuard, nativeScript),
      );
    });

    it('refuses a Plutus script guard without a datum whose script the sub transaction attaches or a reference input carries', async () => {
      await expect(
        new SubTransactionBuilder()
          .setPlutusContext({ costModels })
          .addInput(keyUtxo)
          .attachScript(v4Script)
          .requireTopLevelGuard(v4Guard)
          .build(),
      ).rejects.toThrow(new MalformedGuardDatumError(v4Guard, v4Script));
      await expect(
        new SubTransactionBuilder()
          .addInput(keyUtxo)
          .addReferenceInput(v4ScriptUtxo)
          .requireTopLevelGuard(v4Guard)
          .build(),
      ).rejects.toThrow(MalformedGuardDatumError);
    });

    it('builds a script guard whose script it does not know with or without a datum, and a known one with the datum its script takes', async () => {
      const unknown = await new SubTransactionBuilder()
        .addInput(keyUtxo)
        .requireTopLevelGuard(v4Guard)
        .requireTopLevelGuard(nativeGuard, datum)
        .build();
      const known = await new SubTransactionBuilder()
        .addInput(keyUtxo)
        .addReferenceInput(v4ScriptUtxo)
        .attachScript(nativeScript)
        .requireTopLevelGuard(v4Guard, 0n)
        .requireTopLevelGuard(nativeGuard)
        .build();

      expect(unknown.body().toCore().requiredTopLevelGuards).toHaveLength(2);
      expect(known.body().toCore().requiredTopLevelGuards).toHaveLength(2);
    });
  });

  it('adds up direct deposits to one reward account, replaces its interval and writes both sorted by reward account', async () => {
    const subTransaction = await new SubTransactionBuilder()
      .addInput(keyUtxo)
      .addDirectDeposit(rewardAccount, 1_000_000n)
      .addDirectDeposit(otherRewardAccount, 2_000_000n)
      .addDirectDeposit(rewardAccount, 500_000n)
      .addAccountBalanceInterval(rewardAccount, { exactBalance: 3n })
      .addAccountBalanceInterval(rewardAccount, { inclusiveLowerBound: 1n })
      .build();

    const body = subTransaction.body().toCore();
    expect(body.directDeposits).toEqual([
      { stakeAddress: rewardAccount, quantity: 1_500_000n },
      { stakeAddress: otherRewardAccount, quantity: 2_000_000n },
    ]);
    expect(body.accountBalanceIntervals).toEqual([
      { rewardAccount, interval: { inclusiveLowerBound: 1n } },
    ]);
  });

  it('refuses a direct deposit of zero and an interval with neither bound nor an exact balance', () => {
    expect(() =>
      new SubTransactionBuilder().addDirectDeposit(rewardAccount, 0n),
    ).toThrow('must be greater than zero');
    expect(() =>
      new SubTransactionBuilder().addAccountBalanceInterval(rewardAccount, {}),
    ).toThrow();
  });

  it('writes the validity interval, the certificates and the withdrawals', async () => {
    const certificate: Cardano.Certificate = {
      __typename: Cardano.CertificateType.Registration,
      stakeCredential: {
        type: Cardano.CredentialType.KeyHash,
        hash: Cardano.RewardAccount.toHash(rewardAccount),
      },
      deposit: 2_000_000n,
    };
    const subTransaction = await new SubTransactionBuilder()
      .addInput(keyUtxo)
      .setValidityInterval({
        invalidBefore: Cardano.Slot(10),
        invalidHereafter: Cardano.Slot(20),
      })
      .addCertificate(certificate)
      .addRewardsWithdrawal(rewardAccount, 1_000_000n)
      .build();

    const body = subTransaction.body().toCore();
    expect(body.validityInterval).toEqual({
      invalidBefore: 10,
      invalidHereafter: 20,
    });
    expect(body.certificates).toEqual([certificate]);
    expect(body.withdrawals).toEqual([
      { stakeAddress: rewardAccount, quantity: 1_000_000n },
    ]);
  });

  it('refuses a certificate redeemer for a key hash stake credential', () => {
    expect(() =>
      new SubTransactionBuilder().addCertificate(
        {
          __typename: Cardano.CertificateType.Registration,
          stakeCredential: keyGuard,
          deposit: 2_000_000n,
        },
        { redeemer: unit },
      ),
    ).toThrow('Certificate redeemer requires a script hash credential');
  });

  it.each<Cardano.Certificate>([
    {
      __typename: Cardano.CertificateType.StakeRegistration,
      stakeCredential: v4Guard,
    },
    {
      __typename: Cardano.CertificateType.MIR,
      kind: Cardano.MirCertificateKind.ToStakeCreds,
      stakeCredential: v4Guard,
      quantity: 1n,
      pot: Cardano.MirCertificatePot.Reserves,
    },
  ])(
    'refuses a certificate redeemer for a $__typename, which no credential witnesses',
    certificate => {
      expect(() =>
        new SubTransactionBuilder().addCertificate(certificate, {
          redeemer: unit,
        }),
      ).toThrow(
        'Certificate redeemer requires a script hash credential that witnesses the certificate',
      );
    },
  );

  const keyCertificate: Cardano.Certificate = {
    __typename: Cardano.CertificateType.StakeDelegation,
    stakeCredential: keyGuard,
    poolId: Cardano.PoolId(
      'pool1ev8vy6fyj7693ergzty2t0azjvw35tvkt2vcjwpgajqs7z6u2vn',
    ),
  };
  const scriptCertificates: {
    kind: string;
    certificate: Cardano.Certificate;
  }[] = [
    {
      kind: 'a DRep registration',
      certificate: {
        __typename: Cardano.CertificateType.RegisterDelegateRepresentative,
        dRepCredential: v4Guard,
        deposit: 500_000_000n,
        anchor: null,
      },
    },
    {
      kind: 'a DRep unregistration',
      certificate: {
        __typename: Cardano.CertificateType.UnregisterDelegateRepresentative,
        dRepCredential: v4Guard,
        deposit: 500_000_000n,
      },
    },
    {
      kind: 'a DRep update',
      certificate: {
        __typename: Cardano.CertificateType.UpdateDelegateRepresentative,
        dRepCredential: v4Guard,
        anchor: null,
      },
    },
    {
      kind: 'a committee hot key authorization',
      certificate: {
        __typename: Cardano.CertificateType.AuthorizeCommitteeHot,
        coldCredential: v4Guard,
        hotCredential: keyGuard,
      },
    },
    {
      kind: 'a committee resignation',
      certificate: {
        __typename: Cardano.CertificateType.ResignCommitteeCold,
        coldCredential: v4Guard,
        anchor: null,
      },
    },
  ];

  it.each(scriptCertificates)(
    'indexes the redeemer of $kind of a PlutusV4 script credential at its certificate position',
    async ({ certificate }) => {
      const subTransaction = await new SubTransactionBuilder()
        .setPlutusContext({ costModels })
        .addInput(keyUtxo)
        .addCertificate(keyCertificate)
        .addCertificate(certificate, { redeemer: unit, executionUnits: budget })
        .attachScript(v4Script)
        .build();

      expect(redeemersOf(subTransaction)).toEqual([
        {
          purpose: Cardano.RedeemerPurpose.certificate,
          index: 1,
          data: unit,
          executionUnits: budget,
        },
      ]);
    },
  );

  it.each(scriptCertificates)(
    'refuses $kind of a PlutusV4 script credential without a redeemer',
    async ({ certificate }) => {
      await expect(
        new SubTransactionBuilder()
          .setPlutusContext({ costModels })
          .addInput(keyUtxo)
          .addCertificate(keyCertificate)
          .addCertificate(certificate)
          .attachScript(v4Script)
          .build(),
      ).rejects.toThrow(
        new MissingRedeemerError(
          Cardano.RedeemerPurpose.certificate,
          1,
          v4Hash,
        ),
      );
    },
  );

  it('hashes the language of a PlutusV4 script a reference input carries for a DRep certificate redeemer', async () => {
    const subTransaction = await new SubTransactionBuilder()
      .setPlutusContext({ costModels })
      .addInput(keyUtxo)
      .addCertificate(scriptCertificates[0].certificate, {
        redeemer: unit,
        executionUnits: budget,
      })
      .addReferenceInput(
        utxoOf('d4', 10_000_000n, address, { scriptReference: v4Script }),
      )
      .build();

    expect(subTransaction.body().scriptDataHash()).toBe(
      computeConwayScriptDataHash({
        costModels,
        usedLanguages: [Cardano.PlutusLanguageVersion.V4],
        redeemers: redeemersOf(subTransaction),
        datums: undefined,
      }),
    );
  });

  it('refuses a duplicate input, a duplicate reference input and a spend redeemer for a key hash address', () => {
    expect(() =>
      new SubTransactionBuilder().addInput(keyUtxo).addInput(keyUtxo),
    ).toThrow('Cannot add duplicate input');
    expect(() =>
      new SubTransactionBuilder()
        .addReferenceInput(keyUtxo)
        .addReferenceInput(keyUtxo),
    ).toThrow('Cannot add duplicate reference input');
    expect(() =>
      new SubTransactionBuilder().addInput(keyUtxo, { redeemer: unit }),
    ).toThrow('Spend redeemer requires an input at a script address');
  });

  it('builds a sub transaction a batcher carries byte for byte', async () => {
    const subTransaction = await new SubTransactionBuilder()
      .addInput(otherKeyUtxo)
      .addOutput({ address, value: { coins: 4_000_000n } })
      .requireTopLevelGuard(keyGuard)
      .build();

    const tx = await new TransactionBuilder(Cardano.NetworkMagics.Preprod, {
      minFeeCoefficient: 44,
      minFeeConstant: 155_381,
      prices: { memory: 0.0577, steps: 0.0000721 },
      coinsPerUtxoByte: 4310,
      maxTxSize: 16_384,
      maxValueSize: 5000,
      collateralPercentage: 150,
      maxCollateralInputs: 3,
      stakeKeyDeposit: 2_000_000,
      poolDeposit: 500_000_000,
      minFeeRefScriptCostPerByte: '15',
    })
      .useCoinSelector(new LargeFirstCoinSelector())
      .setChangeAddress(address)
      .setUnspentOutputs([keyUtxo])
      .addGuard(keyGuard)
      .addSubTransaction(subTransaction, [otherKeyUtxo])
      .build();

    const [carried] = tx.body().subTransactions()!.values();
    expect(carried.toCbor()).toBe(subTransaction.toCbor());
    expect(carried.getId()).toBe(subTransaction.getId());
  });
});
