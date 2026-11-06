import {
  Cardano,
  coalesceValueQuantities,
  Serialization,
  subtractValueQuantities,
} from '@lace-lib/cardano-core';
import { Ed25519Signature, blake2b } from '@lace-lib/cardano-crypto';
import { HexBlob } from '@lace-lib/cardano-util';
import { describe, expect, it, vi } from 'vitest';

import {
  EvaluatedFeeShortfallError,
  isTransactionBalanced,
} from '../src/balancing';
import { estimateSignedTxSize } from '../src/estimate-signed-tx-size';
import { executionUnitsFee } from '../src/exact-fees';
import { minAdaRequired, minFee } from '../src/fees';
import { getUniqueSignerKeyHashes } from '../src/getUniqueSigners';
import {
  InputSelectionError,
  InputSelectionFailure,
} from '../src/input-selection/InputSelectionError';
import { LargeFirstCoinSelector } from '../src/input-selection/LargeFirstCoinSelector';
import { RoundRobinRandomCoinSelector } from '../src/input-selection/RoundRobinRandomCoinSelector';
import { referenceScriptFee } from '../src/reference-scripts';
import { computeConwayScriptDataHash } from '../src/script-data-hash';
import { compareTxIns } from '../src/serialization';
import {
  ExtraneousRedeemerError,
  InsufficientCollateralError,
  MalformedGuardDatumError,
  MissingCollateralError,
  MissingDatumError,
  MissingRedeemerError,
  MissingTopLevelGuardError,
  NotAllowedSupplementalDatumError,
  TransactionBuilder,
  UnbalancedSubTransactionsError,
} from '../src/TransactionBuilder';

import { signedSubTransaction } from './sub-transaction-test-data';

import type {
  TransactionBuilderProtocolParameters,
  TxEvaluator,
} from '../src/types';
import type * as Crypto from '@lace-lib/cardano-crypto';
import type { Logger } from 'ts-log';

const txIn = (txId: string, index: number): Cardano.TxIn => ({
  txId: txId as Cardano.TransactionId,
  index,
});

const mkUtxo = (
  idN: number,
  index: number,
  lovelace: bigint,
  addr: Cardano.PaymentAddress,
  // eslint-disable-next-line max-params
): Cardano.Utxo => [
  { ...txIn(`txid${idN}`, index), address: addr },
  { address: addr, value: { coins: lovelace } } as Cardano.TxOut,
];

const sumCoins = (outs: Cardano.TxOut[]): bigint =>
  outs.reduce((accumulator, o) => accumulator + (o.value.coins ?? 0n), 0n);

/** Registers pool `id`, owned by and rewarding a testnet reward account. */
const poolRegistrationOf = (
  id: Cardano.PoolId,
): Cardano.PoolRegistrationCertificate => {
  const rewardAccount = Cardano.RewardAccount(
    'stake_test1up7pvfq8zn4quy45r2g572290p9vf99mr9tn7r9xrgy2l2qdsf58d',
  );
  return {
    __typename: Cardano.CertificateType.PoolRegistration,
    poolParameters: {
      id,
      rewardAccount,
      pledge: 10_000n,
      cost: 340_000_000n,
      margin: { numerator: 1, denominator: 50 },
      owners: [rewardAccount],
      relays: [],
      vrf: Cardano.VrfVkHex('8d'.repeat(32)),
    },
  };
};

const registeredPoolId = Cardano.PoolId(
  'pool1mpgg03jxj52qwxvvy7cmj58a96vl9pvxcqqvuw0kumheygxmn34',
);

const protocolParameters = {
  minFeeCoefficient: 44,
  minFeeConstant: 155381,
  prices: { memory: 0.0577, steps: 0.0000721 },
  coinsPerUtxoByte: 4310,
  poolDeposit: 2_000_000,
  stakeKeyDeposit: 2_000_000,
  dRepDeposit: 500_000_000,
  maxTxSize: 16384,
  maxValueSize: 4096,
  collateralPercentage: 150,
  maxCollateralInputs: 3,
  minFeeRefScriptCostPerByte: '15',
} as unknown as Cardano.ProtocolParameters;

const poolDeposit = BigInt(protocolParameters.poolDeposit!);

/**
 * Prices `tx` **as signed**, measured rather than derived: dummy vkey witnesses
 * of the real width (32-byte key + 64-byte signature) are attached, then
 * `minFee` prices the serialized result.
 *
 * Deliberately avoids `computeVkWitnessesCost` — a test that priced witnesses
 * with the formula under test would pass however wrong that formula became.
 *
 * NOTE this is a *serializer-measured* (wire) figure, one byte over the
 * ledger's own fee-size: the ledger prices via `toCBORForSizeComputation`,
 * which drops the `isValid` byte the wire encoding carries. Mainnet tx
 * `fa0dc78af838de7c202b9a36bd10e47424a2ba6950aa3099ec16db954fdacd24` confirmed
 * exactly there (chain `tx_size` 4515 vs 4516 wire bytes; `fee` 519911 = the
 * minimum for 4515). Callers therefore pin the one-byte delta rather than
 * assert an inequality.
 *
 * @returns The signer count (so callers can pin it) and the measured fee.
 */
const measureSignedMinFee = (
  tx: Serialization.Transaction,
  resolvedInputs: Cardano.Utxo[],
): { requiredFee: bigint; signerCount: number } => {
  const core = tx.toCore();
  const signerCount = getUniqueSignerKeyHashes(core, resolvedInputs).size;
  const signatures: Cardano.Signatures = new Map();
  for (let index = 0; index < signerCount; index++) {
    signatures.set(
      index.toString(16).padStart(64, '0') as Crypto.Ed25519PublicKeyHex,
      'f'.repeat(128) as Crypto.Ed25519SignatureHex,
    );
  }
  return {
    requiredFee: minFee(
      { ...core, witness: { ...core.witness, signatures } },
      resolvedInputs,
      protocolParameters,
    ),
    signerCount,
  };
};

describe('TransactionBuilder', () => {
  it('builds and balances a simple ADA transfer', async () => {
    const networkMagic = Cardano.NetworkMagics.Preprod;

    const changeAddr =
      'addr_test1qpfhhfy2qgls50r9u4yh0l7z67xpg0a5rrhkmvzcuqrd0znuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q9gw0lz' as Cardano.PaymentAddress;
    const recipientAddr =
      'addr_test1xrphkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gt7r0vd4msrxnuwnccdxlhdjar77j6lg0wypcc9uar5d2shs4p04xh' as Cardano.PaymentAddress;

    const availableUtxos: Cardano.Utxo[] = [
      mkUtxo(1, 0, 3_000_000n, changeAddr),
      mkUtxo(2, 0, 4_500_000n, changeAddr),
      mkUtxo(3, 1, 9_000_000n, changeAddr),
    ];

    const builder = new TransactionBuilder(networkMagic, protocolParameters)
      .setNetwork(networkMagic)
      .setChangeAddress(changeAddr)
      .setUnspentOutputs(availableUtxos)
      .transferValue(recipientAddr, { coins: 5_000_000n });

    const tx = await builder.build();

    const core = tx.toCore();
    const body = core.body;

    const utxoMap = new Map<string, bigint>();
    for (const [txIn, out] of availableUtxos) {
      utxoMap.set(`${txIn.txId}:${txIn.index}`, out.value.coins ?? 0n);
    }

    const inputSum = body.inputs.reduce((accumulator: bigint, index) => {
      const k = `${index.txId}:${index.index}`;
      const v = utxoMap.get(k);
      expect(v).toBeDefined();
      return accumulator + (v ?? 0n);
    }, 0n);

    const outputSum = sumCoins(body.outputs);
    const fee: bigint = body.fee;

    expect(inputSum).toBe(outputSum + fee);

    const hasRecipient = body.outputs.some(
      o => o.address === recipientAddr && (o.value.coins ?? 0n) === 5_000_000n,
    );
    expect(hasRecipient).toBe(true);

    const hasChange = body.outputs.some(o => o.address === changeAddr);
    expect(hasChange).toBe(true);
  });

  // Guards `computeVkWitnessesCost` against drifting from the serializer. Every
  // other fee test prices with the same formula the builder uses, so a wrong
  // formula keeps them all green; this one measures instead.
  it('prices the signed tx within one byte of a serializer-measured minimum', async () => {
    const networkMagic = Cardano.NetworkMagics.Preprod;
    const changeAddr =
      'addr_test1qpfhhfy2qgls50r9u4yh0l7z67xpg0a5rrhkmvzcuqrd0znuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q9gw0lz' as Cardano.PaymentAddress;
    const recipientAddr =
      'addr_test1xrphkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gt7r0vd4msrxnuwnccdxlhdjar77j6lg0wypcc9uar5d2shs4p04xh' as Cardano.PaymentAddress;
    const availableUtxos: Cardano.Utxo[] = [
      mkUtxo(1, 0, 3_000_000n, changeAddr),
      mkUtxo(2, 0, 4_500_000n, changeAddr),
      mkUtxo(3, 1, 9_000_000n, changeAddr),
    ];

    const tx = await new TransactionBuilder(networkMagic, protocolParameters)
      .setNetwork(networkMagic)
      .setChangeAddress(changeAddr)
      .setUnspentOutputs(availableUtxos)
      .transferValue(recipientAddr, { coins: 5_000_000n })
      .build();

    const { requiredFee, signerCount } = measureSignedMinFee(
      tx,
      availableUtxos,
    );
    // All inputs sit at one address, so one witness. Pinned because an
    // under-counted signer would hide an under-funded fee.
    expect(signerCount).toBe(1);
    // The estimate sits exactly one byte under the measured figure: the formula
    // omits the witness-set map key, and the ledger's fee-size omits `isValid`
    // (see measureSignedMinFee) — two per-tx off-by-ones that cancel, landing
    // the estimate on the ledger minimum at any signer count. Any change to the
    // witness framing, the formula, or the encoder moves this delta and fails
    // here — which is the drift this test exists to catch.
    expect(requiredFee - tx.toCore().body.fee).toBe(
      BigInt(protocolParameters.minFeeCoefficient),
    );
  });

  it('supports preselected input + additional selection and still balances', async () => {
    const networkMagic = Cardano.NetworkMagics.Preprod;
    const changeAddr =
      'addr_test1qpfhhfy2qgls50r9u4yh0l7z67xpg0a5rrhkmvzcuqrd0znuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q9gw0lz' as Cardano.PaymentAddress;
    const recipientAddr =
      'addr_test1xrphkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gt7r0vd4msrxnuwnccdxlhdjar77j6lg0wypcc9uar5d2shs4p04xh' as Cardano.PaymentAddress;

    const preSel = mkUtxo(10, 0, 1_000_000n, changeAddr);
    const rest: Cardano.Utxo[] = [
      mkUtxo(11, 0, 2_500_000n, changeAddr),
      mkUtxo(12, 0, 4_000_000n, changeAddr),
    ];
    const all = [preSel, ...rest];

    const builder = new TransactionBuilder(networkMagic, protocolParameters)
      .setChangeAddress(changeAddr)
      .setUnspentOutputs(all)
      .addInput(preSel)
      .transferValue(recipientAddr, { coins: 5_000_000n });

    const tx = await builder.build();
    const core = tx.toCore();
    const body = core.body;

    expect(
      body.inputs.some(
        index =>
          index.txId === preSel[0].txId && index.index === preSel[0].index,
      ),
    ).toBe(true);

    const utxoMap = new Map<string, bigint>();
    for (const [txIn, out] of all) {
      utxoMap.set(`${txIn.txId}:${txIn.index}`, out.value.coins ?? 0n);
    }
    const inputSum = body.inputs.reduce(
      (accumulator: bigint, index) =>
        accumulator + (utxoMap.get(`${index.txId}:${index.index}`) ?? 0n),
      0n,
    );
    const outputSum = body.outputs.reduce(
      (accumulator, o) => accumulator + (o.value.coins ?? 0n),
      0n,
    );
    const fee = body.fee;

    expect(inputSum).toBe(outputSum + fee);

    const hasRecipient = body.outputs.some(
      (o: Cardano.TxOut) => o.address === recipientAddr,
    );
    const hasChange = body.outputs.some(
      (o: Cardano.TxOut) => o.address === changeAddr,
    );
    expect(hasRecipient).toBe(true);
    expect(hasChange).toBe(true);
  });

  it('sets memo and adds auxiliaryDataHash', async () => {
    const networkMagic = Cardano.NetworkMagics.Preprod;

    const changeAddr =
      'addr_test1qpfhhfy2qgls50r9u4yh0l7z67xpg0a5rrhkmvzcuqrd0znuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q9gw0lz' as Cardano.PaymentAddress;
    const recipientAddr =
      'addr_test1xrphkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gt7r0vd4msrxnuwnccdxlhdjar77j6lg0wypcc9uar5d2shs4p04xh' as Cardano.PaymentAddress;

    const availableUtxos: Cardano.Utxo[] = [
      mkUtxo(21, 0, 5_000_000n, changeAddr),
      mkUtxo(22, 0, 6_000_000n, changeAddr),
    ];

    const memo = 'hello from tests';

    const builder = new TransactionBuilder(networkMagic, protocolParameters)
      .setChangeAddress(changeAddr)
      .setUnspentOutputs(availableUtxos)
      .setMemo(memo)
      .transferValue(recipientAddr, { coins: 5_000_000n });

    const tx = await builder.build();
    const core = tx.toCore();
    const body = core.body;

    expect(body.auxiliaryDataHash).toBeDefined();

    const auxiliaryData = tx.auxiliaryData()?.toCbor() ?? HexBlob('');
    const metadata = Serialization.AuxiliaryData.fromCore({
      blob: new Map([[674n, new Map([['msg', [memo]]])]]),
    }).toCbor();
    expect(auxiliaryData).toBe(`d90103a100${metadata}`);
    expect(body.auxiliaryDataHash).toBe(blake2b.hash(auxiliaryData, 32));

    const utxoMap = new Map<string, bigint>();
    for (const [index, out] of availableUtxos) {
      utxoMap.set(`${index.txId}:${index.index}`, out.value.coins ?? 0n);
    }
    const inputSum = body.inputs.reduce(
      (accumulator, index) =>
        accumulator + (utxoMap.get(`${index.txId}:${index.index}`) ?? 0n),
      0n,
    );
    const outputSum = sumCoins(body.outputs);
    const fee: bigint = body.fee;

    expect(inputSum).toBe(outputSum + fee);
  });

  it('balances with native assets (multi-asset output)', async () => {
    const networkMagic = Cardano.NetworkMagics.Preprod;

    const changeAddr =
      'addr_test1qpfhhfy2qgls50r9u4yh0l7z67xpg0a5rrhkmvzcuqrd0znuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q9gw0lz' as Cardano.PaymentAddress;
    const recipientAddr =
      'addr_test1xrphkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gt7r0vd4msrxnuwnccdxlhdjar77j6lg0wypcc9uar5d2shs4p04xh' as Cardano.PaymentAddress;

    const policyIdHex = 'a'.repeat(56);
    const assetNameHex = '54455354';
    const assetId = `${policyIdHex}${assetNameHex}` as Cardano.AssetId;

    const assetUtxo1: Cardano.Utxo = [
      { ...txIn('txidA1', 0), address: changeAddr },
      {
        address: changeAddr,
        value: { coins: 2_000_000n, assets: new Map([[assetId, 5n]]) },
      },
    ];
    const assetUtxo2: Cardano.Utxo = [
      { ...txIn('txidA2', 0), address: changeAddr },
      {
        address: changeAddr,
        value: { coins: 3_000_000n, assets: new Map([[assetId, 2n]]) },
      },
    ];
    const adaOnly: Cardano.Utxo = mkUtxo(33, 1, 4_000_000n, changeAddr);

    const availableUtxos: Cardano.Utxo[] = [assetUtxo1, assetUtxo2, adaOnly];

    const targetAssets = new Map<Cardano.AssetId, bigint>([[assetId, 6n]]);

    const builder = new TransactionBuilder(networkMagic, protocolParameters)
      .setChangeAddress(changeAddr)
      .setUnspentOutputs(availableUtxos)
      .transferValue(recipientAddr, {
        coins: 3_000_000n,
        assets: targetAssets,
      });

    const tx = await builder.build();
    const core = tx.toCore();
    const body = core.body;

    const recipient = body.outputs.find(o => o.address === recipientAddr);
    expect(recipient).toBeDefined();
    const sentAssetsQty = recipient?.value.assets?.get(assetId) ?? 0n;
    expect(sentAssetsQty).toBeGreaterThanOrEqual(6n);

    const usedTxKeys = new Set(
      body.inputs.map(index => `${index.txId}:${index.index}`),
    );
    expect(usedTxKeys.has('txidA1:0')).toBe(true);
    expect(usedTxKeys.has('txidA2:0')).toBe(true);

    const utxoAdaMap = new Map<string, bigint>([
      [
        `${assetUtxo1[0].txId}:${assetUtxo1[0].index}`,
        assetUtxo1[1].value.coins ?? 0n,
      ],
      [
        `${assetUtxo2[0].txId}:${assetUtxo2[0].index}`,
        assetUtxo2[1].value.coins ?? 0n,
      ],
      [`${adaOnly[0].txId}:${adaOnly[0].index}`, adaOnly[1].value.coins ?? 0n],
    ]);

    const inputAda = body.inputs.reduce(
      (accumulator, index) =>
        accumulator + (utxoAdaMap.get(`${index.txId}:${index.index}`) ?? 0n),
      0n,
    );
    const outputAda = sumCoins(body.outputs);
    const fee: bigint = body.fee;

    expect(inputAda).toBe(outputAda + fee);
  });

  it('balances with rewards withdrawal', async () => {
    const networkMagic = Cardano.NetworkMagics.Preprod;

    const changeAddr =
      'addr_test1qpfhhfy2qgls50r9u4yh0l7z67xpg0a5rrhkmvzcuqrd0znuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q9gw0lz' as Cardano.PaymentAddress;
    const recipientAddr =
      'addr_test1xrphkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gt7r0vd4msrxnuwnccdxlhdjar77j6lg0wypcc9uar5d2shs4p04xh' as Cardano.PaymentAddress;
    const rewardAccount = Cardano.RewardAccount(
      'stake_test1up7pvfq8zn4quy45r2g572290p9vf99mr9tn7r9xrgy2l2qdsf58d',
    );

    const adaOnly: Cardano.Utxo = mkUtxo(33, 1, 10_000_000n, changeAddr);
    const withdrawalAmount = 1_000_000n;
    const availableUtxos: Cardano.Utxo[] = [adaOnly];

    const builder = new TransactionBuilder(networkMagic, protocolParameters)
      .setChangeAddress(changeAddr)
      .setUnspentOutputs(availableUtxos)
      .addRewardsWithdrawal(rewardAccount, withdrawalAmount)
      .transferValue(recipientAddr, {
        coins: 3_000_000n,
      });

    const tx = await builder.build();
    const core = tx.toCore();
    const body = core.body;

    const recipient = body.outputs.find(o => o.address === recipientAddr);
    expect(recipient).toBeDefined();

    const inputAda = availableUtxos[0][1].value.coins;
    const outputAda = sumCoins(body.outputs);
    const fee: bigint = body.fee;

    expect(inputAda + withdrawalAmount).toBe(outputAda + fee);
  });

  it('spends the largest-ADA UTxO when a withdrawal alone covers the fee', async () => {
    const networkMagic = Cardano.NetworkMagics.Preprod;

    const changeAddr =
      'addr_test1qpfhhfy2qgls50r9u4yh0l7z67xpg0a5rrhkmvzcuqrd0znuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q9gw0lz' as Cardano.PaymentAddress;
    const rewardAccount = Cardano.RewardAccount(
      'stake_test1up7pvfq8zn4quy45r2g572290p9vf99mr9tn7r9xrgy2l2qdsf58d',
    );

    const small = mkUtxo(40, 0, 2_000_000n, changeAddr);
    const largest = mkUtxo(41, 0, 30_000_000n, changeAddr);
    const withdrawalAmount = 20_000_000n;

    const tx = await new TransactionBuilder(networkMagic, protocolParameters)
      .setChangeAddress(changeAddr)
      .useCoinSelector(new LargeFirstCoinSelector())
      .setUnspentOutputs([small, largest])
      .addRewardsWithdrawal(rewardAccount, withdrawalAmount)
      .build();
    const { body } = tx.toCore();

    expect(body.inputs).toEqual(
      [largest[0]].map(({ txId, index }) => ({ txId, index })),
    );
    expect(body.outputs).toHaveLength(1);
    expect(body.outputs[0].address).toBe(changeAddr);
    expect(largest[1].value.coins + withdrawalAmount).toBe(
      sumCoins(body.outputs) + body.fee,
    );
  });

  it('splits change that exceeds the maximum value size across several outputs', async () => {
    const networkMagic = Cardano.NetworkMagics.Preprod;
    const maxValueSize = 500;

    const changeAddr =
      'addr_test1qpfhhfy2qgls50r9u4yh0l7z67xpg0a5rrhkmvzcuqrd0znuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q9gw0lz' as Cardano.PaymentAddress;
    const recipientAddr =
      'addr_test1xrphkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gt7r0vd4msrxnuwnccdxlhdjar77j6lg0wypcc9uar5d2shs4p04xh' as Cardano.PaymentAddress;

    const assets: Cardano.TokenMap = new Map(
      Array.from({ length: 40 }, (_, index) => [
        Cardano.AssetId(
          `${'b'.repeat(56)}${index.toString(16).padStart(64, '0')}`,
        ),
        BigInt(index + 1),
      ]),
    );
    const bundleUtxo: Cardano.Utxo = [
      { ...txIn('txid50', 0), address: changeAddr },
      { address: changeAddr, value: { coins: 100_000_000n, assets } },
    ];

    const tx = await new TransactionBuilder(networkMagic, {
      ...protocolParameters,
      maxValueSize,
    })
      .setChangeAddress(changeAddr)
      .setUnspentOutputs([bundleUtxo])
      .transferValue(recipientAddr, { coins: 5_000_000n })
      .build();
    const { body } = tx.toCore();

    const changeOutputs = body.outputs.filter(
      output => output.address === changeAddr,
    );
    expect(changeOutputs.length).toBeGreaterThan(1);
    for (const change of changeOutputs) {
      const serializedSize =
        Serialization.Value.fromCore(change.value).toCbor().length / 2;
      expect(serializedSize).toBeLessThanOrEqual(maxValueSize);
    }

    const returnedAssets = new Map<Cardano.AssetId, bigint>();
    for (const change of changeOutputs) {
      for (const [id, quantity] of change.value.assets ?? []) {
        returnedAssets.set(id, (returnedAssets.get(id) ?? 0n) + quantity);
      }
    }
    expect(returnedAssets).toEqual(assets);
    expect(bundleUtxo[1].value.coins).toBe(sumCoins(body.outputs) + body.fee);
  });

  it('includes vote delegation certificate in built transaction', async () => {
    const networkMagic = Cardano.NetworkMagics.Preprod;

    const changeAddr =
      'addr_test1qpfhhfy2qgls50r9u4yh0l7z67xpg0a5rrhkmvzcuqrd0znuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q9gw0lz' as Cardano.PaymentAddress;
    const rewardAccount = Cardano.RewardAccount(
      'stake_test1up7pvfq8zn4quy45r2g572290p9vf99mr9tn7r9xrgy2l2qdsf58d',
    );
    const stakeCredential: Cardano.Credential = {
      type: Cardano.CredentialType.KeyHash,
      hash: Cardano.RewardAccount.toHash(rewardAccount),
    };
    const dRep: Cardano.DelegateRepresentative = {
      __typename: 'AlwaysAbstain',
    };

    const adaOnly: Cardano.Utxo = mkUtxo(40, 0, 10_000_000n, changeAddr);

    const paramsWithDeposits = {
      ...protocolParameters,
      stakeKeyDeposit: 2_000_000,
    } as unknown as Cardano.ProtocolParameters;

    const builder = new TransactionBuilder(networkMagic, paramsWithDeposits)
      .setChangeAddress(changeAddr)
      .setUnspentOutputs([adaOnly])
      .addVoteDelegationCertificate(stakeCredential, dRep);

    const tx = await builder.build();
    const core = tx.toCore();
    const body = core.body;

    expect(body.certificates).toBeDefined();
    expect(body.certificates).toHaveLength(1);

    const cert = body.certificates![0] as Cardano.VoteDelegationCertificate;
    expect(cert.__typename).toBe(Cardano.CertificateType.VoteDelegation);
    expect(cert.stakeCredential).toEqual(stakeCredential);
    expect(cert.dRep).toEqual(dRep);

    // Transaction still balances
    const utxoMap = new Map<string, bigint>();
    for (const [txIn, out] of [adaOnly]) {
      utxoMap.set(`${txIn.txId}:${txIn.index}`, out.value.coins ?? 0n);
    }
    const inputSum = body.inputs.reduce(
      (accumulator: bigint, index) =>
        accumulator + (utxoMap.get(`${index.txId}:${index.index}`) ?? 0n),
      0n,
    );
    const outputSum = sumCoins(body.outputs);
    const fee: bigint = body.fee;

    expect(inputSum).toBe(outputSum + fee);
  });

  it('adds VoteRegistrationDelegation certificate with deposit', async () => {
    const networkMagic = Cardano.NetworkMagics.Preprod;
    const changeAddr =
      'addr_test1qpfhhfy2qgls50r9u4yh0l7z67xpg0a5rrhkmvzcuqrd0znuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q9gw0lz' as Cardano.PaymentAddress;
    const stakeCredential: Cardano.Credential = {
      type: Cardano.CredentialType.KeyHash,
      hash: 'df3c57e80cb3d2e09a2fdde4e0dec9e21b6baf0f87f9c47a1b91c4e' as unknown as Cardano.Credential['hash'],
    };
    const dRep: Cardano.DelegateRepresentative = {
      __typename: 'AlwaysNoConfidence',
    };
    const deposit = 2_000_000n;

    const availableUtxos: Cardano.Utxo[] = [
      mkUtxo(42, 0, 15_000_000n, changeAddr),
    ];

    const tx = await new TransactionBuilder(networkMagic, protocolParameters)
      .setChangeAddress(changeAddr)
      .setUnspentOutputs(availableUtxos)
      .addVoteRegistrationDelegationCertificate(dRep, stakeCredential, deposit)
      .build();
    const core = tx.toCore();

    expect(core.body.certificates).toHaveLength(1);
    const cert = core.body.certificates![0];
    expect(cert.__typename).toBe(
      Cardano.CertificateType.VoteRegistrationDelegation,
    );
    if (
      cert.__typename === Cardano.CertificateType.VoteRegistrationDelegation
    ) {
      expect(cert.dRep).toEqual({ __typename: 'AlwaysNoConfidence' });
      expect(cert.stakeCredential).toBe(stakeCredential);
      expect(cert.deposit).toBe(deposit);
    }
  });

  it('balancing does not require additional utxos if explicitly set enough via addInput AND does not require explicit outputs', async () => {
    const networkMagic = Cardano.NetworkMagics.Preprod;

    const changeAddr =
      'addr_test1qpfhhfy2qgls50r9u4yh0l7z67xpg0a5rrhkmvzcuqrd0znuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q9gw0lz' as Cardano.PaymentAddress;
    const rewardAccount = Cardano.RewardAccount(
      'stake_test1up7pvfq8zn4quy45r2g572290p9vf99mr9tn7r9xrgy2l2qdsf58d',
    );

    const adaOnly: Cardano.Utxo = mkUtxo(33, 1, 10_000_000n, changeAddr);
    const withdrawalAmount = 1_000_000n;
    const availableUtxos: Cardano.Utxo[] = [adaOnly];

    const builder = new TransactionBuilder(networkMagic, protocolParameters)
      .setChangeAddress(changeAddr)
      .addInput(adaOnly)
      .addRewardsWithdrawal(rewardAccount, withdrawalAmount);

    const tx = await builder.build();
    const core = tx.toCore();
    const body = core.body;

    const inputAda = availableUtxos[0][1].value.coins;
    const outputAda = sumCoins(body.outputs);
    const fee: bigint = body.fee;

    expect(inputAda + withdrawalAmount).toBe(outputAda + fee);
  });

  it('merges setMetadata entries with setMemo and overwrites same-label entries', async () => {
    const networkMagic = Cardano.NetworkMagics.Preprod;
    const changeAddr =
      'addr_test1qpfhhfy2qgls50r9u4yh0l7z67xpg0a5rrhkmvzcuqrd0znuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q9gw0lz' as Cardano.PaymentAddress;
    const recipientAddr =
      'addr_test1xrphkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gt7r0vd4msrxnuwnccdxlhdjar77j6lg0wypcc9uar5d2shs4p04xh' as Cardano.PaymentAddress;
    const availableUtxos: Cardano.Utxo[] = [
      mkUtxo(31, 0, 5_000_000n, changeAddr),
      mkUtxo(32, 0, 6_000_000n, changeAddr),
    ];
    const memo = 'memo content';

    const builder = new TransactionBuilder(networkMagic, protocolParameters)
      .setChangeAddress(changeAddr)
      .setUnspentOutputs(availableUtxos)
      .setMetadata(123n, 'overwritten')
      .setMetadata(123n, 'final')
      .setMetadata(456n, 42n)
      .setMemo(memo)
      .transferValue(recipientAddr, { coins: 5_000_000n });

    const tx = await builder.build();
    const body = tx.toCore().body;

    expect(tx.toCore().auxiliaryData?.blob).toEqual(
      new Map<bigint, Cardano.Metadatum>([
        [123n, 'final'],
        [456n, 42n],
        [674n, new Map([['msg', [memo]]])],
      ]),
    );
    expect(body.auxiliaryDataHash).toBe(
      blake2b.hash(tx.auxiliaryData()?.toCbor() ?? HexBlob(''), 32),
    );
  });

  it('builds identical transactions across runs with a fixed-seed RoundRobinRandomCoinSelector', async () => {
    const networkMagic = Cardano.NetworkMagics.Preprod;
    const changeAddr =
      'addr_test1qpfhhfy2qgls50r9u4yh0l7z67xpg0a5rrhkmvzcuqrd0znuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q9gw0lz' as Cardano.PaymentAddress;
    const recipientAddr =
      'addr_test1xrphkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gt7r0vd4msrxnuwnccdxlhdjar77j6lg0wypcc9uar5d2shs4p04xh' as Cardano.PaymentAddress;

    const buildOnce = async () => {
      const tx = await new TransactionBuilder(networkMagic, protocolParameters)
        .setChangeAddress(changeAddr)
        .setUnspentOutputs([
          mkUtxo(1, 0, 3_000_000n, changeAddr),
          mkUtxo(2, 0, 4_500_000n, changeAddr),
          mkUtxo(3, 1, 9_000_000n, changeAddr),
        ])
        .useCoinSelector(new RoundRobinRandomCoinSelector({ seed: 7n }))
        .transferValue(recipientAddr, { coins: 5_000_000n })
        .build();
      return tx.toCbor();
    };

    expect(await buildOnce()).toEqual(await buildOnce());
  });

  it('annotates the error as a fallback failure when the default selectors cannot cover the target', async () => {
    const networkMagic = Cardano.NetworkMagics.Preprod;
    const changeAddr =
      'addr_test1qpfhhfy2qgls50r9u4yh0l7z67xpg0a5rrhkmvzcuqrd0znuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q9gw0lz' as Cardano.PaymentAddress;
    const recipientAddr =
      'addr_test1xrphkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gt7r0vd4msrxnuwnccdxlhdjar77j6lg0wypcc9uar5d2shs4p04xh' as Cardano.PaymentAddress;

    const builder = new TransactionBuilder(networkMagic, protocolParameters)
      .setChangeAddress(changeAddr)
      .setUnspentOutputs([mkUtxo(50, 0, 1_000_000n, changeAddr)])
      .transferValue(recipientAddr, { coins: 5_000_000n });

    const caught: unknown = await builder
      .build()
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(InputSelectionError);
    expect((caught as InputSelectionError).failure).toBe(
      InputSelectionFailure.BalanceInsufficient,
    );
    expect((caught as Error).message).toMatch(/fallback coin selector/);
  });

  it('skips the fallback retry when Large-First is supplied as the primary selector', async () => {
    const networkMagic = Cardano.NetworkMagics.Preprod;
    const changeAddr =
      'addr_test1qpfhhfy2qgls50r9u4yh0l7z67xpg0a5rrhkmvzcuqrd0znuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q9gw0lz' as Cardano.PaymentAddress;
    const recipientAddr =
      'addr_test1xrphkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gt7r0vd4msrxnuwnccdxlhdjar77j6lg0wypcc9uar5d2shs4p04xh' as Cardano.PaymentAddress;

    const selector = new LargeFirstCoinSelector();
    const selectSpy = vi.spyOn(selector, 'select');

    const builder = new TransactionBuilder(networkMagic, protocolParameters)
      .setChangeAddress(changeAddr)
      .setUnspentOutputs([mkUtxo(51, 0, 1_000_000n, changeAddr)])
      .useCoinSelector(selector)
      .transferValue(recipientAddr, { coins: 5_000_000n });

    const caught: unknown = await builder
      .build()
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(InputSelectionError);
    expect((caught as Error).message).not.toMatch(/fallback/);
    expect(selectSpy).toHaveBeenCalledTimes(1);
  });
});

describe('TransactionBuilder Plutus support', () => {
  const changeAddr =
    'addr_test1qpfhhfy2qgls50r9u4yh0l7z67xpg0a5rrhkmvzcuqrd0znuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q9gw0lz' as Cardano.PaymentAddress;
  const otherKeyAddr =
    'addr_test1qpuzeec0zqcm6lrdygkkvvd8e6qactnsl5zzeujsdpkpc939l2f2vykk0ctwq4ys6w3jg8pm0kknmy8m5pml8f9cauzq2zuc95' as Cardano.PaymentAddress;

  const dummyScript = {
    __type: Cardano.ScriptType.Plutus,
    version: Cardano.PlutusLanguageVersion.V3,
    bytes: 'deadbeef',
  } as unknown as Cardano.Script;

  const unitDatum: Cardano.PlutusData = Serialization.PlutusData.fromCbor(
    HexBlob('d87980'),
  ).toCore();

  const costModels: Cardano.CostModels = new Map([
    [Cardano.PlutusLanguageVersion.V3, Array.from({ length: 251 }, () => 0)],
  ]);

  const scriptAddressOf = (script: Cardano.Script): Cardano.PaymentAddress =>
    Cardano.EnterpriseAddress.fromCredentials(Cardano.NetworkId.Testnet, {
      type: Cardano.CredentialType.ScriptHash,
      hash: Serialization.Script.fromCore(script).hash(),
    })
      .toAddress()
      .toBech32() as Cardano.PaymentAddress;
  const dummyScriptAddr = scriptAddressOf(dummyScript);

  const scriptInputUtxo: Cardano.Utxo = mkUtxo(
    0,
    0,
    20_000_000n,
    dummyScriptAddr,
  );
  const collateralUtxo: Cardano.Utxo = mkUtxo(200, 0, 10_000_000n, changeAddr);
  const collateralUtxoOtherAddr: Cardano.Utxo = mkUtxo(
    200,
    0,
    10_000_000n,
    otherKeyAddr,
  );

  // The builder's collateral coverage target, recomputed from the params
  // (maxSizeFee + maxScriptFee priced over the per-tx-max seed ex-units) so the
  // knife-edge cases below track the params instead of a magic number.
  const SEED_MEMORY = 14_000_000;
  const SEED_STEPS = 10_000_000_000;
  const coverageTarget =
    ((BigInt(protocolParameters.minFeeConstant) +
      BigInt(protocolParameters.minFeeCoefficient) *
        BigInt(protocolParameters.maxTxSize) +
      BigInt(
        Math.ceil(
          protocolParameters.prices.memory * SEED_MEMORY +
            protocolParameters.prices.steps * SEED_STEPS,
        ),
      )) *
      BigInt(protocolParameters.collateralPercentage) +
      99n) /
    100n;

  // Sized from the checked-in mainnet dust-mapping validator (its blob is 3207
  // bytes CBOR-wrapped; production attaches the 3204 unwrapped bytes into this
  // same field). `dummyScript` is 4 bytes, which keeps a tx well under the
  // ~1691-byte cliff where the first pricing pass' collateral remainder drops
  // below a return's min-ADA.
  const realSizedScript = {
    __type: Cardano.ScriptType.Plutus,
    version: Cardano.PlutusLanguageVersion.V3,
    bytes: 'ab'.repeat(3207),
  } as unknown as Cardano.Script;
  const realSizedScriptAddr = scriptAddressOf(realSizedScript);

  const makeEvaluator = (budget: Cardano.ExUnits): TxEvaluator => ({
    evaluate: async tx =>
      (tx.witness.redeemers ?? []).map(r => ({
        purpose: r.purpose,
        index: r.index,
        budget,
      })),
  });

  const buildPlutusScriptTx = async (
    collateral: Cardano.Utxo,
    returnAddr: Cardano.PaymentAddress,
    budget: Cardano.ExUnits = { memory: 100, steps: 100_000 },
  ) =>
    new TransactionBuilder(Cardano.NetworkMagics.Preprod, protocolParameters)
      .setChangeAddress(changeAddr)
      .setUnspentOutputs([])
      .addInput(scriptInputUtxo, { redeemer: unitDatum })
      .attachScript(dummyScript)
      .setCollateralUtxos([collateral])
      .setCollateralChangeAddress(returnAddr)
      .setPlutusContext({
        costModels,
        txEvaluator: makeEvaluator(budget),
      })
      .build();

  const keyInputUtxo: Cardano.Utxo = mkUtxo(1, 0, 3_000_000n, changeAddr);

  /**
   * Builds a Plutus transaction that also spends a key input at the change
   * address. A script input needs no vkey witness, so the key input gives the
   * transaction a signer that collateral at the change address shares.
   */
  const buildKeyFundedPlutusTx = async (collateral: Cardano.Utxo) =>
    new TransactionBuilder(Cardano.NetworkMagics.Preprod, protocolParameters)
      .setChangeAddress(changeAddr)
      .setUnspentOutputs([])
      .addInput(keyInputUtxo)
      .addInput(scriptInputUtxo, { redeemer: unitDatum })
      .attachScript(dummyScript)
      .setCollateralUtxos([collateral])
      .setCollateralChangeAddress(changeAddr)
      .setPlutusContext({
        costModels,
        txEvaluator: makeEvaluator({ memory: 100, steps: 100_000 }),
      })
      .build();

  // The designation fee path. `correctFeeAfterEvaluation` walks the fee down to
  // exact equality with its own computed minimum, so there is no headroom to
  // absorb an estimate that drifts from the serializer. Measured, not derived.
  it('prices the signed tx within one byte of a serializer-measured minimum after fee correction, with collateral as its only signer', async () => {
    const tx = await buildPlutusScriptTx(collateralUtxo, changeAddr);

    const { requiredFee, signerCount } = measureSignedMinFee(tx, [
      scriptInputUtxo,
      collateralUtxo,
    ]);
    expect(signerCount).toBe(1);
    expect(requiredFee - tx.toCore().body.fee).toBe(
      BigInt(protocolParameters.minFeeCoefficient),
    );
  });

  it('keeps the one-byte gap fixed when collateral adds a second signer', async () => {
    const tx = await buildKeyFundedPlutusTx(collateralUtxoOtherAddr);

    const { requiredFee, signerCount } = measureSignedMinFee(tx, [
      keyInputUtxo,
      scriptInputUtxo,
      collateralUtxoOtherAddr,
    ]);
    // A distinct collateral address means a second witness. The gap stays ONE
    // byte rather than doubling, which locates it in the witness-set framing
    // (emitted once) and not in the per-witness 101-byte term.
    expect(signerCount).toBe(2);
    expect(requiredFee - tx.toCore().body.fee).toBe(
      BigInt(protocolParameters.minFeeCoefficient),
    );
  });

  it('sets totalCollateral and collateralReturn proportional to fee', async () => {
    const tx = await buildPlutusScriptTx(collateralUtxo, changeAddr);
    const body = tx.toCore().body;
    const fee = body.fee;
    const expectedCollateral = (fee * 150n + 99n) / 100n;

    expect(body.collaterals).toHaveLength(1);
    expect(body.collaterals![0].txId).toBe(collateralUtxo[0].txId);
    expect(body.totalCollateral).toBe(expectedCollateral);
    expect(body.collateralReturn).toBeDefined();
    expect(body.collateralReturn!.value.coins).toBe(
      collateralUtxo[1].value.coins - expectedCollateral,
    );
  });

  it('selects collateral from a frozen collateral array and leaves it unchanged', async () => {
    const smallerCollateral = mkUtxo(202, 0, 6_000_000n, changeAddr);
    const collaterals = Object.freeze([
      smallerCollateral,
      collateralUtxo,
    ]) as Cardano.Utxo[];

    const tx = await new TransactionBuilder(
      Cardano.NetworkMagics.Preprod,
      protocolParameters,
    )
      .setChangeAddress(changeAddr)
      .setUnspentOutputs([])
      .addInput(scriptInputUtxo, { redeemer: unitDatum })
      .attachScript(dummyScript)
      .setCollateralUtxos(collaterals)
      .setCollateralChangeAddress(changeAddr)
      .setPlutusContext({
        costModels,
        txEvaluator: makeEvaluator({ memory: 100, steps: 100_000 }),
      })
      .build();

    expect(tx.toCore().body.collaterals).toEqual([
      txIn(collateralUtxo[0].txId, collateralUtxo[0].index),
    ]);
    expect(collaterals).toEqual([smallerCollateral, collateralUtxo]);
  });

  it('throws InsufficientCollateralError when the pool cannot fund collateral', async () => {
    const tinyCollateral = mkUtxo(201, 0, 100_000n, changeAddr);
    await expect(
      buildPlutusScriptTx(tinyCollateral, changeAddr),
    ).rejects.toThrow(InsufficientCollateralError);
  });

  // Regression (LW-15307): pre-fix this threw InputSelectionError — "Failed to
  // balance transaction with fallback coin selector: UTxO pool exhausted while
  // funding the minimum UTxO value of the change outputs".
  it('funds the tx from a UTxO that also backs collateral instead of starving the pool', async () => {
    const forcedInput = mkUtxo(210, 0, 2_000_000n, dummyScriptAddr);
    const soleCover = mkUtxo(211, 0, 242_000_000n, changeAddr);

    const tx = await new TransactionBuilder(
      Cardano.NetworkMagics.Preprod,
      protocolParameters,
    )
      .setChangeAddress(changeAddr)
      .setUnspentOutputs([soleCover])
      .setCollateralUtxos([soleCover])
      .setCollateralChangeAddress(changeAddr)
      .addInput(forcedInput, { redeemer: unitDatum })
      .attachScript(dummyScript)
      .transferValue(otherKeyAddr, { coins: 1_500_000n })
      .setPlutusContext({
        costModels,
        txEvaluator: makeEvaluator({ memory: 100, steps: 100_000 }),
      })
      .build();

    const body = tx.toCore().body;

    const isSoleCover = (ref: Cardano.TxIn): boolean =>
      ref.txId === soleCover[0].txId && ref.index === soleCover[0].index;
    expect(body.inputs.some(isSoleCover)).toBe(true);
    expect(body.collaterals!.some(isSoleCover)).toBe(true);

    const resolved = new Map<string, bigint>(
      [forcedInput, soleCover].map(([ref, out]) => [
        `${ref.txId}:${ref.index}`,
        out.value.coins ?? 0n,
      ]),
    );
    const inputSum = body.inputs.reduce(
      (total, ref) => total + (resolved.get(`${ref.txId}:${ref.index}`) ?? 0n),
      0n,
    );
    expect(inputSum).toBe(sumCoins(body.outputs) + body.fee);

    // Asserted independently of the input checks above: the collateral fields
    // must still describe the phase-2 branch even though the UTxO is an input.
    expect(body.totalCollateral).toBe((body.fee * 150n + 99n) / 100n);
    expect(body.collateralReturn!.value.coins).toBe(
      (soleCover[1].value.coins ?? 0n) - body.totalCollateral!,
    );
  });

  it.each([true, false])(
    'spends dedicated collateral only when also offered for funding: %s',
    async overlap => {
      const dedicated: Cardano.Utxo = [
        {
          txId: Cardano.TransactionId('fc'.repeat(32)),
          index: 0,
          address: otherKeyAddr,
        },
        { address: otherKeyAddr, value: { coins: 100_000_000n } },
      ];
      const ordinary: Cardano.Utxo = [
        {
          txId: Cardano.TransactionId('fd'.repeat(32)),
          index: 0,
          address: changeAddr,
        },
        { address: changeAddr, value: { coins: 50_000_000n } },
      ];
      const forced: Cardano.Utxo = [
        {
          txId: Cardano.TransactionId('fe'.repeat(32)),
          index: 0,
          address: dummyScriptAddr,
        },
        { address: dummyScriptAddr, value: { coins: 2_000_000n } },
      ];

      const tx = await new TransactionBuilder(
        Cardano.NetworkMagics.Preprod,
        protocolParameters,
      )
        .setChangeAddress(changeAddr)
        .useCoinSelector(new LargeFirstCoinSelector())
        .setUnspentOutputs(overlap ? [dedicated, ordinary] : [ordinary])
        .addInput(forced, { redeemer: unitDatum })
        .attachScript(dummyScript)
        .transferValue(otherKeyAddr, { coins: 5_000_000n })
        .setCollateralUtxos([dedicated])
        .setCollateralChangeAddress(otherKeyAddr)
        .setPlutusContext({
          costModels,
          txEvaluator: makeEvaluator({ memory: 100, steps: 100_000 }),
        })
        .build();
      const body = tx.toCore().body;

      expect(body.inputs.some(input => input.txId === dedicated[0].txId)).toBe(
        overlap,
      );
      expect(body.inputs.some(input => input.txId === ordinary[0].txId)).toBe(
        !overlap,
      );
      expect(body.collaterals).toEqual([{ txId: dedicated[0].txId, index: 0 }]);
      expect(sumCoins(body.outputs) + body.fee).toBe(
        forced[1].value.coins + (overlap ? dedicated : ordinary)[1].value.coins,
      );
    },
  );

  // The min-ADA return must be sized against the fee-derived amount actually
  // declared, not the coverage target — that target is only an upper bound, so
  // sizing against it refuses a ~1 ADA band of pools that build fine. Keyed to
  // collateralPercentage 0 so the target is the stable 5 ADA constant rather
  // than a param-derived figure.
  it('accepts an ADA-only collateral pool whose remainder cannot fund a return', async () => {
    const justOverTarget = mkUtxo(230, 0, 5_000_001n, changeAddr);

    const tx = await new TransactionBuilder(Cardano.NetworkMagics.Preprod, {
      ...protocolParameters,
      collateralPercentage: 0,
    } as unknown as Cardano.ProtocolParameters)
      .setChangeAddress(changeAddr)
      .setUnspentOutputs([])
      .addInput(scriptInputUtxo, { redeemer: unitDatum })
      .attachScript(dummyScript)
      .setCollateralUtxos([justOverTarget])
      .setCollateralChangeAddress(changeAddr)
      .setPlutusContext({
        costModels,
        txEvaluator: makeEvaluator({ memory: 100, steps: 100_000 }),
      })
      .build();

    const body = tx.toCore().body;
    // The dust lovelace is absorbed rather than shipped as its own output:
    // totalCollateral declares the whole reservation and there is no return.
    expect(body.totalCollateral).toBe(5_000_001n);
    expect(body.collateralReturn).toBeUndefined();
  });

  // The other half of the same rule, kept: native assets can leave the
  // collateral inputs ONLY through the return output, so an asset-carrying
  // pick whose remainder cannot meet min-ADA has no escape and must throw.
  it('still refuses an asset-carrying collateral pool whose return cannot meet min-ADA', async () => {
    const assetId = Cardano.AssetId(`${'ab'.repeat(28)}746f6b`);
    const withAssets: Cardano.Utxo = [
      { ...mkUtxo(231, 0, 5_000_001n, changeAddr)[0] },
      {
        address: changeAddr,
        value: { coins: 5_000_001n, assets: new Map([[assetId, 1n]]) },
      } as Cardano.TxOut,
    ];

    await expect(
      new TransactionBuilder(Cardano.NetworkMagics.Preprod, {
        ...protocolParameters,
        collateralPercentage: 0,
      } as unknown as Cardano.ProtocolParameters)
        .setChangeAddress(changeAddr)
        .setUnspentOutputs([])
        .addInput(scriptInputUtxo, { redeemer: unitDatum })
        .attachScript(dummyScript)
        .setCollateralUtxos([withAssets])
        .setCollateralChangeAddress(changeAddr)
        .setPlutusContext({
          costModels,
          txEvaluator: makeEvaluator({ memory: 100, steps: 100_000 }),
        })
        .build(),
    ).rejects.toThrow(InsufficientCollateralError);
  });

  it('selects collateral for the evaluated fee, not the coverage target the reservation needed', async () => {
    const part1 = mkUtxo(202, 0, 3_000_000n, changeAddr);
    const part2 = mkUtxo(203, 0, 3_000_000n, changeAddr);

    const tx = await new TransactionBuilder(
      Cardano.NetworkMagics.Preprod,
      protocolParameters,
    )
      .setChangeAddress(changeAddr)
      .setUnspentOutputs([])
      .addInput(scriptInputUtxo, { redeemer: unitDatum })
      .attachScript(dummyScript)
      .setCollateralUtxos([part1, part2])
      .setCollateralChangeAddress(changeAddr)
      .setPlutusContext({
        costModels,
        txEvaluator: makeEvaluator({ memory: 100, steps: 100_000 }),
      })
      .build();
    const body = tx.toCore().body;
    const expectedCollateral = (body.fee * 150n + 99n) / 100n;

    expect(6_000_000n).toBeGreaterThanOrEqual(coverageTarget);
    expect(3_000_000n).toBeLessThan(coverageTarget);
    expect(body.collaterals).toEqual([{ txId: part1[0].txId, index: 0 }]);
    expect(body.totalCollateral).toBe(expectedCollateral);
    expect(body.collateralReturn!.value.coins).toBe(
      3_000_000n - expectedCollateral,
    );
  });

  it('sizes collateral selection to the fee-derived requirement, not the fallback', async () => {
    // Fees high enough that ceil(fee * collateralPercentage / 100) exceeds the
    // 5 ADA fallback, so a selection seeded at the fallback would reserve too
    // few of the fragmented 4 ADA UTxOs and fail on the larger requirement.
    const highFeeParams = {
      ...protocolParameters,
      minFeeConstant: 5_000_000,
    } as unknown as Cardano.ProtocolParameters;
    const bigScriptInput = mkUtxo(300, 0, 40_000_000n, dummyScriptAddr);
    const collateralParts = [
      mkUtxo(301, 0, 4_000_000n, changeAddr),
      mkUtxo(302, 0, 4_000_000n, changeAddr),
      mkUtxo(303, 0, 4_000_000n, changeAddr),
    ];

    const tx = await new TransactionBuilder(
      Cardano.NetworkMagics.Preprod,
      highFeeParams,
    )
      .setChangeAddress(changeAddr)
      .setUnspentOutputs([])
      .addInput(bigScriptInput, { redeemer: unitDatum })
      .attachScript(dummyScript)
      .setCollateralUtxos(collateralParts)
      .setCollateralChangeAddress(changeAddr)
      .setPlutusContext({
        costModels,
        txEvaluator: makeEvaluator({ memory: 100, steps: 100_000 }),
      })
      .build();

    const body = tx.toCore().body;
    const requiredCollateral = (body.fee * 150n + 99n) / 100n;

    expect(requiredCollateral).toBeGreaterThan(5_000_000n);
    expect(body.collaterals).toHaveLength(3);
    expect(body.totalCollateral).toBe(requiredCollateral);
    expect(body.collateralReturn!.value.coins).toBe(
      12_000_000n - requiredCollateral,
    );
  });

  it('corrects fee downward when evaluated ex-units are less than seed', async () => {
    const seedBudget: Cardano.ExUnits = {
      memory: 14_000_000,
      steps: 10_000_000_000,
    };
    const smallBudget: Cardano.ExUnits = { memory: 100, steps: 100_000 };

    const txSeed = await buildPlutusScriptTx(
      collateralUtxo,
      changeAddr,
      seedBudget,
    );
    const txSmall = await buildPlutusScriptTx(
      collateralUtxo,
      changeAddr,
      smallBudget,
    );

    expect(txSmall.toCore().body.fee).toBeLessThan(txSeed.toCore().body.fee);
  });

  // Regression (LW-15113): collateral summing to exactly the coverage target
  // seeds NO collateral-return (returnCoin === 0), so the balancer prices a
  // body without one; but the smaller fee-derived collateral emits a return at
  // finalisation. Pricing the fee over the stale seed body left the shipped tx
  // ~66 bytes (one minFeeCoefficient per byte) under-priced → Conway rejected
  // it with FeeTooSmallUTxO. The fee must instead be priced over the return it
  // ships, so it must equal a build whose seed already carried the return.
  it('does not under-price the fee when finalisation adds a collateral-return the seed omitted', async () => {
    // Collateral == the coverage target → seed reserves it whole
    // (returnCoin === 0, no seed return).
    const knifeEdgeCollateral = mkUtxo(210, 0, coverageTarget, changeAddr);
    const txKnifeEdge = await buildPlutusScriptTx(
      knifeEdgeCollateral,
      changeAddr,
    );
    // 10 ADA > coverage target → seed already carries a collateral-return.
    const txWithSeedReturn = await buildPlutusScriptTx(
      collateralUtxo,
      changeAddr,
    );

    const knifeEdgeBody = txKnifeEdge.toCore().body;
    // The shipped tx carries the fee-derived collateral-return...
    expect(knifeEdgeBody.collateralReturn).toBeDefined();
    // ...and its fee matches the build whose seed already priced one (same body
    // size). Under the stale-body pricing this was short by one coefficient×66.
    expect(knifeEdgeBody.fee).toBe(txWithSeedReturn.toCore().body.fee);
  });

  // A 1-lovelace shortfall must be rejected by selection, not silently rounded
  // into a pick the ledger under-funds. Turns the one direction the knife-edge
  // case above could drift in (a coverage target that creeps up) into a loud
  // failure instead of a quietly-passing test.
  it('rejects collateral one lovelace short of the coverage target', async () => {
    const shortCollateral = mkUtxo(213, 0, coverageTarget - 1n, changeAddr);
    await expect(
      buildPlutusScriptTx(shortCollateral, changeAddr),
    ).rejects.toThrow(InsufficientCollateralError);
  });

  // A real validator's inline bytes are what carry the tx past the ~1691-byte
  // point where the seed pass' leftover falls under min-ADA; a 4-byte script
  // never reaches the absorb branch. Declaring the whole reservation instead of
  // the corrected shape would hand the extra to a phase-2 failure.
  it('ships the fee-derived collateral shape when the seed pass had to absorb the remainder', async () => {
    const knifeEdgeCollateral = mkUtxo(214, 0, coverageTarget, changeAddr);
    const scriptInput = mkUtxo(215, 0, 20_000_000n, realSizedScriptAddr);

    const tx = await new TransactionBuilder(
      Cardano.NetworkMagics.Preprod,
      protocolParameters,
    )
      .setChangeAddress(changeAddr)
      .setUnspentOutputs([])
      .addInput(scriptInput, { redeemer: unitDatum })
      .attachScript(realSizedScript)
      .setCollateralUtxos([knifeEdgeCollateral])
      .setCollateralChangeAddress(changeAddr)
      .setPlutusContext({
        costModels,
        txEvaluator: makeEvaluator({ memory: 100, steps: 100_000 }),
      })
      .build();

    const body = tx.toCore().body;
    const required =
      (body.fee * BigInt(protocolParameters.collateralPercentage) + 99n) / 100n;

    // Past the cliff, so the seed pass really did take the absorb branch.
    expect(tx.toCbor().length / 2).toBeGreaterThan(1691);
    expect(body.collaterals).toHaveLength(1);
    expect(body.totalCollateral).toBe(required);
    expect(body.collateralReturn?.value.coins).toBe(coverageTarget - required);
  });

  // At `collateralPercentage: 0` the amount is pinned to the flat 5 ADA fallback,
  // so no lower fee can grow the remainder into a returnable one.
  it('still absorbs a sub-min-ADA remainder when the collateral amount is fee-invariant', async () => {
    const collateral = mkUtxo(218, 0, 5_100_000n, changeAddr);
    const scriptInput = mkUtxo(219, 0, 20_000_000n, realSizedScriptAddr);

    const tx = await new TransactionBuilder(Cardano.NetworkMagics.Preprod, {
      ...protocolParameters,
      collateralPercentage: 0,
    })
      .setChangeAddress(changeAddr)
      .setUnspentOutputs([])
      .addInput(scriptInput, { redeemer: unitDatum })
      .attachScript(realSizedScript)
      .setCollateralUtxos([collateral])
      .setCollateralChangeAddress(changeAddr)
      .setPlutusContext({
        costModels,
        txEvaluator: makeEvaluator({ memory: 100, steps: 100_000 }),
      })
      .build();

    const body = tx.toCore().body;

    expect(body.collateralReturn).toBeUndefined();
    expect(body.totalCollateral).toBe(5_100_000n);
  });

  // The shape cannot imply the fee: reading the flip as non-convergence still
  // ships a valid body, just one priced with the per-tx-max seed ex-units —
  // ~1.5 ADA of script budget the evaluated tx never spends.
  it('corrects the fee to its own body minimum when the collateral shape flips mid-correction', async () => {
    const flipCollateral = mkUtxo(216, 0, coverageTarget, changeAddr);
    const scriptInput = mkUtxo(217, 0, 20_000_000n, realSizedScriptAddr);

    const tx = await new TransactionBuilder(
      Cardano.NetworkMagics.Preprod,
      protocolParameters,
    )
      .setChangeAddress(changeAddr)
      .setUnspentOutputs([])
      .addInput(scriptInput, { redeemer: unitDatum })
      .attachScript(realSizedScript)
      .setCollateralUtxos([flipCollateral])
      .setCollateralChangeAddress(changeAddr)
      .setPlutusContext({
        costModels,
        txEvaluator: makeEvaluator({ memory: 100, steps: 100_000 }),
      })
      .build();

    const { requiredFee, signerCount } = measureSignedMinFee(tx, [
      scriptInput,
      flipCollateral,
    ]);

    expect(signerCount).toBe(1);
    expect(requiredFee - tx.toCore().body.fee).toBe(
      BigInt(protocolParameters.minFeeCoefficient),
    );
  });

  const buildRealSizedTx = async (
    collateral: Cardano.Utxo[],
    scriptInputs: Cardano.Utxo[],
  ) => {
    const builder = new TransactionBuilder(
      Cardano.NetworkMagics.Preprod,
      protocolParameters,
    )
      .setChangeAddress(changeAddr)
      .setUnspentOutputs([])
      .attachScript(realSizedScript)
      .setCollateralUtxos(collateral)
      .setCollateralChangeAddress(changeAddr)
      .setPlutusContext({
        costModels,
        txEvaluator: makeEvaluator({ memory: 100, steps: 100_000 }),
      });
    for (const input of scriptInputs) {
      builder.addInput(input, { redeemer: unitDatum });
    }
    return builder.build();
  };

  // The seed pass ships no return while its own leftover stays under a return's
  // min-ADA — a span above the target, not a single point, so the cases walk it
  // rather than pinning one reservation inside it.
  it.each([
    ['exactly the coverage target', 0n],
    ['mid-way through the absorb span', 59_000n],
    ['above the absorb span', 118_020n],
  ])(
    'prices the fee to its own body minimum with collateral %s',
    async (_label, excess) => {
      const collateral = mkUtxo(230, 0, coverageTarget + excess, changeAddr);
      const scriptInput = mkUtxo(231, 0, 20_000_000n, realSizedScriptAddr);

      const tx = await buildRealSizedTx([collateral], [scriptInput]);
      const { requiredFee } = measureSignedMinFee(tx, [
        scriptInput,
        collateral,
      ]);

      expect(requiredFee - tx.toCore().body.fee).toBe(
        BigInt(protocolParameters.minFeeCoefficient),
      );
    },
  );

  const collateralToken = Cardano.AssetId(`${'ab'.repeat(28)}746f6b`);

  const mkTokenUtxo = (idN: number, lovelace: bigint): Cardano.Utxo => [
    mkUtxo(idN, 0, lovelace, changeAddr)[0],
    {
      address: changeAddr,
      value: { coins: lovelace, assets: new Map([[collateralToken, 1n]]) },
    },
  ];

  /**
   * Asserts the ledger's collateral rules on a built transaction: at most
   * `maxCollateralInputs` inputs, a total that covers
   * `ceil(fee * collateralPercentage / 100)` and equals the inputs minus the
   * return, which leaves only ADA as collateral, and a return that carries
   * every native asset of the inputs and meets min-ADA.
   */
  const expectLedgerCollateralRules = (
    tx: Serialization.Transaction,
    pool: Cardano.Utxo[],
  ) => {
    const body = tx.toCore().body;
    const collateral = (body.collaterals ?? []).map(
      ({ txId, index }) =>
        pool.find(([ref]) => ref.txId === txId && ref.index === index)!,
    );
    const inputValue = coalesceValueQuantities(
      collateral.map(([, out]) => out.value),
    );
    const returned = body.collateralReturn?.value ?? { coins: 0n };
    const collected = subtractValueQuantities([inputValue, returned]);

    expect(collateral.length).toBeGreaterThan(0);
    expect(collateral.length).toBeLessThanOrEqual(
      protocolParameters.maxCollateralInputs,
    );
    expect(body.totalCollateral).toBeGreaterThanOrEqual(
      (body.fee * BigInt(protocolParameters.collateralPercentage) + 99n) / 100n,
    );
    expect(body.totalCollateral).toBe(collected.coins);
    expect([...(collected.assets?.values() ?? [])].every(q => q === 0n)).toBe(
      true,
    );
    expect(returned.assets ?? new Map()).toEqual(
      inputValue.assets ?? new Map(),
    );
    if ((inputValue.assets?.size ?? 0) > 0) {
      expect(body.collateralReturn).toBeDefined();
    }
    if (body.collateralReturn) {
      expect(returned.coins).toBeGreaterThanOrEqual(
        minAdaRequired(
          body.collateralReturn,
          BigInt(protocolParameters.coinsPerUtxoByte),
        ),
      );
    }
  };

  it('adds the next largest collateral input when the largest alone would leave a return below min-ADA', async () => {
    const largest = mkUtxo(236, 0, 1_240_000n, changeAddr);
    const first = mkUtxo(237, 0, 1_200_000n, changeAddr);
    const second = mkUtxo(238, 0, 1_200_000n, changeAddr);
    const scriptInput = mkUtxo(239, 0, 20_000_000n, realSizedScriptAddr);
    const pool = [second, largest, first];

    const tx = await buildRealSizedTx(pool, [scriptInput]);
    const body = tx.toCore().body;
    const required = (body.fee * 150n + 99n) / 100n;

    expect(1_240_000n - required).toBeLessThan(
      minAdaRequired(
        { address: changeAddr, value: { coins: 1_240_000n - required } },
        BigInt(protocolParameters.coinsPerUtxoByte),
      ),
    );
    expect(body.collaterals).toEqual([
      { txId: largest[0].txId, index: 0 },
      { txId: second[0].txId, index: 0 },
    ]);
    expect(body.totalCollateral).toBe(required);
    expect(body.collateralReturn?.value.coins).toBe(2_440_000n - required);
    expect(
      measureSignedMinFee(tx, [scriptInput, ...pool]).requiredFee - body.fee,
    ).toBe(BigInt(protocolParameters.minFeeCoefficient));
  });

  it.each([
    ['one UTxO far above the requirement', [10_000_000n]],
    ['the coverage target exactly', [coverageTarget]],
    [
      'equal UTxOs the coverage target needs all of',
      [1_300_000n, 1_300_000n, 1_300_000n],
    ],
    [
      'more UTxOs than the collateral input limit',
      [1_300_000n, 1_300_000n, 1_300_000n, 1_300_000n, 1_300_000n],
    ],
    ['a large UTxO and dust', [4_000_000n, 1_000n, 2_000n]],
    [
      'an ADA-only UTxO and a token UTxO only the reservation needs',
      [3_000_000n, { token: 2_000_000n }],
    ],
    [
      'a token UTxO the evaluated fee needs and an ADA-only UTxO',
      [{ token: 5_000_000n }, 1_000_000n],
    ],
  ] as [string, (bigint | { token: bigint })[]][])(
    'keeps the ledger collateral rules with %s',
    async (_label, amounts) => {
      const pool = amounts.map((amount, index) =>
        typeof amount === 'bigint'
          ? mkUtxo(250 + index, 0, amount, changeAddr)
          : mkTokenUtxo(250 + index, amount.token),
      );
      const scriptInput = mkUtxo(249, 0, 20_000_000n, realSizedScriptAddr);

      const tx = await buildRealSizedTx(pool, [scriptInput]);

      expectLedgerCollateralRules(tx, pool);
    },
  );

  it('ships no token collateral the evaluated fee does not need, though the reservation did', async () => {
    const adaOnly = mkUtxo(260, 0, 3_000_000n, changeAddr);
    const withToken = mkTokenUtxo(261, 2_000_000n);
    const scriptInput = mkUtxo(262, 0, 20_000_000n, realSizedScriptAddr);

    const tx = await buildRealSizedTx([withToken, adaOnly], [scriptInput]);
    const body = tx.toCore().body;

    expect(5_000_000n).toBeGreaterThanOrEqual(coverageTarget);
    expect(3_000_000n).toBeLessThan(coverageTarget);
    expect(body.collaterals).toEqual([{ txId: adaOnly[0].txId, index: 0 }]);
    expect(body.collateralReturn?.value.assets).toBeUndefined();
    expect(body.collateralReturn?.value.coins).toBe(
      3_000_000n - body.totalCollateral!,
    );
  });

  it.each([
    ['the per-transaction maximum', { memory: SEED_MEMORY, steps: SEED_STEPS }],
    ['just under it', { memory: 13_900_000, steps: 9_950_000_000 }],
  ])(
    'never ships more collateral inputs than were reserved, with evaluated units at %s',
    async (_label, budget) => {
      const reserved = mkUtxo(263, 0, coverageTarget + 100_000n, changeAddr);
      const other = mkUtxo(264, 0, 600_000n, otherKeyAddr);
      const scriptInput = mkUtxo(265, 0, 20_000_000n, realSizedScriptAddr);

      const tx = await new TransactionBuilder(
        Cardano.NetworkMagics.Preprod,
        protocolParameters,
      )
        .setChangeAddress(changeAddr)
        .setUnspentOutputs([])
        .addInput(scriptInput, { redeemer: unitDatum })
        .attachScript(realSizedScript)
        .setCollateralUtxos([reserved, other])
        .setCollateralChangeAddress(changeAddr)
        .setPlutusContext({
          costModels,
          txEvaluator: makeEvaluator(budget),
        })
        .build();
      const body = tx.toCore().body;
      const { requiredFee, signerCount } = measureSignedMinFee(tx, [
        scriptInput,
        reserved,
        other,
      ]);

      expect(body.collaterals).toEqual([{ txId: reserved[0].txId, index: 0 }]);
      expectLedgerCollateralRules(tx, [reserved, other]);
      expect(signerCount).toBe(1);
      expect(requiredFee - body.fee).toBe(
        BigInt(protocolParameters.minFeeCoefficient),
      );
    },
  );

  // `update` and `deregister` are the two-redeemer flows. The per-tx seed budget
  // is split across redeemers rather than added up, so a second one changes the
  // body without changing the saving.
  it('corrects the fee over a body carrying two redeemers', async () => {
    const collateral = mkUtxo(232, 0, coverageTarget, changeAddr);
    const first = mkUtxo(233, 0, 20_000_000n, realSizedScriptAddr);
    const second = mkUtxo(234, 0, 20_000_000n, realSizedScriptAddr);

    const tx = await buildRealSizedTx([collateral], [first, second]);
    const { requiredFee } = measureSignedMinFee(tx, [
      first,
      second,
      collateral,
    ]);

    expect(tx.toCore().witness.redeemers).toHaveLength(2);
    expect(requiredFee - tx.toCore().body.fee).toBe(
      BigInt(protocolParameters.minFeeCoefficient),
    );
  });

  // No collateral involvement here: refunding the saving carries the change coin
  // over a CBOR width boundary instead. Pins the correction at the cause rather
  // than at one of its triggers.
  it('corrects the fee when the refunded saving widens the change coin encoding', async () => {
    const scriptInput = mkUtxo(235, 0, 4_295_967_295n, realSizedScriptAddr);

    const tx = await buildRealSizedTx([collateralUtxo], [scriptInput]);
    const { requiredFee } = measureSignedMinFee(tx, [
      scriptInput,
      collateralUtxo,
    ]);

    expect(sumCoins(tx.toCore().body.outputs)).toBeGreaterThan(0xff_ff_ff_ff);
    expect(requiredFee - tx.toCore().body.fee).toBe(
      BigInt(protocolParameters.minFeeCoefficient),
    );
  });

  // Regression (LW-15113): the collateral coverage target is the true max fee
  // (size + script), not a blunt 5-ADA floor. A ~5-ADA UTxO covers the target
  // with a valid return, so ONLY it is reserved and the second candidate is
  // left alone. The old floor rejected the larger UTxO's tiny over-floor
  // remainder (below a return's min-ADA) and grabbed BOTH, starving funding on
  // tight cNIGHT accounts (designate/stop "UTxO pool exhausted").
  // Pins sizing only: the funding pool is empty here, so the reserved-UTxO
  // exclusion from funding (LW-15307) is not exercised by this case.
  it('reserves only the one collateral UTxO that covers the fee-derived target, not both candidates', async () => {
    const big = mkUtxo(220, 0, 5_015_476n, changeAddr);
    const small = mkUtxo(221, 0, 3_400_000n, changeAddr);
    const scriptInput = mkUtxo(222, 0, 20_000_000n, dummyScriptAddr);

    const tx = await new TransactionBuilder(
      Cardano.NetworkMagics.Preprod,
      protocolParameters,
    )
      .setChangeAddress(changeAddr)
      .setUnspentOutputs([])
      .addInput(scriptInput, { redeemer: unitDatum })
      .attachScript(dummyScript)
      .setCollateralUtxos([big, small])
      .setCollateralChangeAddress(changeAddr)
      .setPlutusContext({
        costModels,
        txEvaluator: makeEvaluator({ memory: 100, steps: 100_000 }),
      })
      .build();

    const body = tx.toCore().body;
    // Only the larger UTxO is reserved (old 5-ADA floor would grab both).
    expect(body.collaterals).toHaveLength(1);
    expect(body.collaterals?.[0].txId).toBe(big[0].txId);
  });

  // Regression (LW-15113): two script inputs => two spend redeemers. Under the
  // old per-redeemer seeding (each at the full per-tx max) the balancer priced
  // the fee for 2x the impossible maximum ex-units (~+1.5 ADA), over-reserving
  // inputs so a pool sized for a real (1x-max-bounded) fee failed to balance —
  // the cNIGHT update/deregister failure on tight accounts. Capping the total
  // seed at the per-tx max keeps the 2-redeemer tx affordable here. Inputs
  // (3 ADA) cover the capped ~1.75-ADA seed fee but NOT the old ~3.27-ADA one,
  // and the empty spend pool cannot top up, so the old seeding threw.
  it('caps total seed ex-units at the per-tx max so a multi-redeemer tx is affordable on a tight pool', async () => {
    const scriptInputA = mkUtxo(210, 0, 1_500_000n, dummyScriptAddr);
    const scriptInputB = mkUtxo(211, 0, 1_500_000n, dummyScriptAddr);
    const collateral = mkUtxo(212, 0, 10_000_000n, changeAddr);

    const tx = await new TransactionBuilder(
      Cardano.NetworkMagics.Preprod,
      protocolParameters,
    )
      .setChangeAddress(changeAddr)
      .setUnspentOutputs([])
      .addInput(scriptInputA, { redeemer: unitDatum })
      .addInput(scriptInputB, { redeemer: unitDatum })
      .attachScript(dummyScript)
      .setCollateralUtxos([collateral])
      .setCollateralChangeAddress(changeAddr)
      .setPlutusContext({
        costModels,
        txEvaluator: makeEvaluator({ memory: 100, steps: 100_000 }),
      })
      .build();

    const spendRedeemers = (tx.toCore().witness.redeemers ?? []).filter(
      redeemer => redeemer.purpose === Cardano.RedeemerPurpose.spend,
    );
    expect(spendRedeemers).toHaveLength(2);
  });

  it('prices the witnesses of the collateral that ships, not of the reservation', async () => {
    const own = mkUtxo(204, 0, 3_000_000n, changeAddr);
    const other = mkUtxo(205, 0, 3_000_000n, otherKeyAddr);

    const tx = await new TransactionBuilder(
      Cardano.NetworkMagics.Preprod,
      protocolParameters,
    )
      .setChangeAddress(changeAddr)
      .setUnspentOutputs([])
      .addInput(scriptInputUtxo, { redeemer: unitDatum })
      .attachScript(dummyScript)
      .setCollateralUtxos([own, other])
      .setCollateralChangeAddress(changeAddr)
      .setPlutusContext({
        costModels,
        txEvaluator: makeEvaluator({ memory: 100, steps: 100_000 }),
      })
      .build();

    const { requiredFee, signerCount } = measureSignedMinFee(tx, [
      scriptInputUtxo,
      own,
      other,
    ]);

    expect(tx.toCore().body.collaterals).toEqual([
      { txId: own[0].txId, index: 0 },
    ]);
    expect(signerCount).toBe(1);
    expect(requiredFee - tx.toCore().body.fee).toBe(
      BigInt(protocolParameters.minFeeCoefficient),
    );
  });

  it('accounts for collateral signer when collateral is at a distinct address', async () => {
    const txSameAddr = await buildKeyFundedPlutusTx(collateralUtxo);
    const txOtherAddr = await buildKeyFundedPlutusTx(collateralUtxoOtherAddr);

    expect(txOtherAddr.toCore().body.fee).toBeGreaterThan(
      txSameAddr.toCore().body.fee,
    );
  });

  describe('with a reference input', () => {
    const referenceScript = {
      __type: Cardano.ScriptType.Plutus,
      version: Cardano.PlutusLanguageVersion.V3,
      bytes: 'cd'.repeat(30_000),
    } as unknown as Cardano.Script;
    const referenceScriptFee = 25_600n * 15n + 4_400n * 18n;
    // At another key address, so a witness it wrongly added would show.
    const referenceUtxo: Cardano.Utxo = [
      {
        txId: Cardano.TransactionId('cd'.repeat(32)),
        index: 1,
        address: otherKeyAddr,
      },
      {
        address: otherKeyAddr,
        value: { coins: 50_000_000n },
        scriptReference: referenceScript,
      },
    ];
    const coverageWithReference =
      ((BigInt(protocolParameters.minFeeConstant) +
        BigInt(protocolParameters.minFeeCoefficient) *
          BigInt(protocolParameters.maxTxSize) +
        BigInt(
          Math.ceil(
            protocolParameters.prices.memory * SEED_MEMORY +
              protocolParameters.prices.steps * SEED_STEPS,
          ),
        ) +
        referenceScriptFee) *
        BigInt(protocolParameters.collateralPercentage) +
        99n) /
      100n;

    const buildReferencingTx = async (
      collateral: Cardano.Utxo,
      txEvaluator: TxEvaluator = makeEvaluator({ memory: 100, steps: 100_000 }),
    ) =>
      new TransactionBuilder(Cardano.NetworkMagics.Preprod, protocolParameters)
        .setChangeAddress(changeAddr)
        .setUnspentOutputs([])
        .addInput(scriptInputUtxo, { redeemer: unitDatum })
        .addReferenceInput(referenceUtxo)
        .attachScript(dummyScript)
        .setCollateralUtxos([collateral])
        .setCollateralChangeAddress(changeAddr)
        .setPlutusContext({
          costModels,
          txEvaluator,
        })
        .build();

    it('gives the evaluator the reference input and prices its script in the signed fee', async () => {
      const evaluate = vi.fn(
        makeEvaluator({ memory: 100, steps: 100_000 }).evaluate,
      );

      const tx = await buildReferencingTx(collateralUtxo, { evaluate });

      expect(tx.toCore().body.referenceInputs).toEqual([
        { txId: referenceUtxo[0].txId, index: 1 },
      ]);
      expect(evaluate.mock.calls[0][1]).toEqual([
        scriptInputUtxo,
        referenceUtxo,
      ]);
      const { requiredFee, signerCount } = measureSignedMinFee(tx, [
        scriptInputUtxo,
        collateralUtxo,
        referenceUtxo,
      ]);
      expect(signerCount).toBe(1);
      expect(requiredFee - tx.toCore().body.fee).toBe(
        BigInt(protocolParameters.minFeeCoefficient),
      );
    });

    it('reserves collateral that covers the reference script fee', async () => {
      const tx = await buildReferencingTx(
        mkUtxo(230, 0, coverageWithReference, changeAddr),
      );
      expect(tx.toCore().body.collaterals).toHaveLength(1);

      await expect(
        buildReferencingTx(
          mkUtxo(231, 0, coverageWithReference - 1n, changeAddr),
        ),
      ).rejects.toThrow(InsufficientCollateralError);
    });
  });

  describe('with an execution-units estimate', () => {
    const estimate: Cardano.ExUnits = { memory: 1_000_000, steps: 500_000_000 };
    const coverageAtEstimate =
      ((BigInt(protocolParameters.minFeeConstant) +
        BigInt(protocolParameters.minFeeCoefficient) *
          BigInt(protocolParameters.maxTxSize) +
        BigInt(
          Math.ceil(
            protocolParameters.prices.memory * estimate.memory +
              protocolParameters.prices.steps * estimate.steps,
          ),
        )) *
        BigInt(protocolParameters.collateralPercentage) +
        99n) /
      100n;

    const buildEstimatedTx = async ({
      inputs = [scriptInputUtxo],
      collateral = collateralUtxo,
      collateralUtxos = [collateral],
      budget = { memory: 100, steps: 100_000 },
      executionUnitsEstimate = estimate,
      script = dummyScript,
    }: {
      inputs?: Cardano.Utxo[];
      collateral?: Cardano.Utxo;
      collateralUtxos?: Cardano.Utxo[];
      budget?: Cardano.ExUnits;
      executionUnitsEstimate?: Cardano.ExUnits;
      script?: Cardano.Script;
    } = {}) => {
      const builder = new TransactionBuilder(
        Cardano.NetworkMagics.Preprod,
        protocolParameters,
      )
        .setChangeAddress(changeAddr)
        .setUnspentOutputs([]);
      for (const input of inputs) {
        builder.addInput(input, { redeemer: unitDatum });
      }
      return builder
        .attachScript(script)
        .setCollateralUtxos(collateralUtxos)
        .setCollateralChangeAddress(changeAddr)
        .setPlutusContext({
          costModels,
          txEvaluator: makeEvaluator(budget),
          executionUnitsEstimate,
        })
        .build();
    };

    it('rejects estimated collateral whose seeded remainder cannot fund a return', async () => {
      const collateral: Cardano.Utxo = [
        {
          txId: Cardano.TransactionId('fa'.repeat(32)),
          index: 0,
          address: changeAddr,
        },
        { address: changeAddr, value: { coins: coverageAtEstimate + 59_000n } },
      ];

      await expect(
        buildEstimatedTx({ collateral, budget: estimate }),
      ).rejects.toThrow(InsufficientCollateralError);
    });

    it('reserves a second collateral input for the estimate but ships only the one the evaluated fee needs', async () => {
      const collateralUtxos: Cardano.Utxo[] = [
        [
          {
            txId: Cardano.TransactionId('fa'.repeat(32)),
            index: 0,
            address: changeAddr,
          },
          {
            address: changeAddr,
            value: { coins: coverageAtEstimate + 59_000n },
          },
        ],
        [
          {
            txId: Cardano.TransactionId('fb'.repeat(32)),
            index: 0,
            address: changeAddr,
          },
          { address: changeAddr, value: { coins: 1_100_000n } },
        ],
      ];
      const input: Cardano.Utxo = [
        {
          txId: Cardano.TransactionId('fc'.repeat(32)),
          index: 0,
          address: dummyScriptAddr,
        },
        { address: dummyScriptAddr, value: { coins: 20_000_000n } },
      ];

      const tx = await buildEstimatedTx({
        inputs: [input],
        collateralUtxos,
        budget: estimate,
      });
      const body = tx.toCore().body;

      expect(body.collaterals).toEqual([
        { txId: collateralUtxos[0][0].txId, index: 0 },
      ]);
      expect(body.collateralReturn).toBeDefined();
      expect(sumCoins(body.outputs) + body.fee).toBe(input[1].value.coins);
      expect(
        measureSignedMinFee(tx, [input, ...collateralUtxos]).requiredFee -
          body.fee,
      ).toBe(BigInt(protocolParameters.minFeeCoefficient));
    });

    it('ships the same transaction as a build priced at the per-transaction maximum', async () => {
      const estimated = await buildEstimatedTx();
      const unestimated = await buildPlutusScriptTx(collateralUtxo, changeAddr);
      expect(estimated.toCbor()).toBe(unestimated.toCbor());
    });

    it('balances inputs that cannot pay the fee the per-transaction maximum prices', async () => {
      const smallInput = mkUtxo(240, 0, 2_000_000n, dummyScriptAddr);
      await expect(
        buildEstimatedTx({
          inputs: [smallInput],
          executionUnitsEstimate: { memory: SEED_MEMORY, steps: SEED_STEPS },
        }),
      ).rejects.toThrow(InputSelectionError);

      const tx = await buildEstimatedTx({ inputs: [smallInput] });
      const { outputs, fee } = tx.toCore().body;
      expect(sumCoins(outputs) + fee).toBe(2_000_000n);
    });

    it('absorbs the remainder of the reserved collateral when the evaluated fee leaves one below min-ADA', async () => {
      const collateral = mkUtxo(245, 0, coverageAtEstimate, changeAddr);

      const tx = await buildEstimatedTx({
        inputs: [mkUtxo(0, 0, 20_000_000n, realSizedScriptAddr)],
        collateral,
        budget: estimate,
        script: realSizedScript,
      });
      const body = tx.toCore().body;
      const remainder = coverageAtEstimate - (body.fee * 150n + 99n) / 100n;

      expect(remainder).toBeLessThan(
        minAdaRequired(
          { address: changeAddr, value: { coins: remainder } },
          BigInt(protocolParameters.coinsPerUtxoByte),
        ),
      );
      expect(body.collaterals).toEqual([
        { txId: collateral[0].txId, index: 0 },
      ]);
      expect(body.collateralReturn).toBeUndefined();
      expect(body.totalCollateral).toBe(coverageAtEstimate);
      expect(
        measureSignedMinFee(tx, [scriptInputUtxo, collateral]).requiredFee -
          body.fee,
      ).toBe(BigInt(protocolParameters.minFeeCoefficient));
    });

    it('reserves collateral for the fee the estimate prices', async () => {
      const tx = await buildEstimatedTx({
        collateral: mkUtxo(241, 0, coverageAtEstimate, changeAddr),
      });
      expect(tx.toCore().body.collaterals).toHaveLength(1);

      await expect(
        buildEstimatedTx({
          collateral: mkUtxo(242, 0, coverageAtEstimate - 1n, changeAddr),
        }),
      ).rejects.toThrow(InsufficientCollateralError);
    });

    it('prices the estimate as the total of every redeemer, and refuses an evaluation that needs more fee', async () => {
      const inputs = [
        mkUtxo(243, 0, 10_000_000n, dummyScriptAddr),
        mkUtxo(244, 0, 10_000_000n, dummyScriptAddr),
      ];
      const share = { memory: estimate.memory / 2, steps: estimate.steps / 2 };
      const tx = await buildEstimatedTx({ inputs, budget: share });
      expect(
        tx
          .toCore()
          .witness.redeemers?.map(({ executionUnits }) => executionUnits),
      ).toEqual([share, share]);

      const above = { ...share, memory: share.memory + 100_000 };
      const failure = await buildEstimatedTx({ inputs, budget: above }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(EvaluatedFeeShortfallError);
      const shortfall = failure as EvaluatedFeeShortfallError;
      expect(shortfall.requiredFee).toBeGreaterThan(shortfall.balancedFee);
      expect(
        shortfall.evaluatedRedeemers.map(
          ({ executionUnits }) => executionUnits,
        ),
      ).toEqual([above, above]);
    });
  });
});

describe('TransactionBuilder reference inputs', () => {
  const changeAddr =
    'addr_test1qpfhhfy2qgls50r9u4yh0l7z67xpg0a5rrhkmvzcuqrd0znuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q9gw0lz' as Cardano.PaymentAddress;
  const otherKeyAddr =
    'addr_test1qpuzeec0zqcm6lrdygkkvvd8e6qactnsl5zzeujsdpkpc939l2f2vykk0ctwq4ys6w3jg8pm0kknmy8m5pml8f9cauzq2zuc95' as Cardano.PaymentAddress;
  const referenceTxId = Cardano.TransactionId('cd'.repeat(32));
  const v3Script = (bytes: string): Cardano.Script =>
    ({
      __type: Cardano.ScriptType.Plutus,
      version: Cardano.PlutusLanguageVersion.V3,
      bytes,
    } as unknown as Cardano.Script);
  const referenceAt = (
    address: Cardano.PaymentAddress,
    scriptReference?: Cardano.Script,
  ): Cardano.Utxo => [
    { txId: referenceTxId, index: 1, address },
    {
      address,
      value: { coins: 30_000_000n },
      ...(scriptReference && { scriptReference }),
    },
  ];
  const funding = mkUtxo(500, 0, 10_000_000n, changeAddr);

  const transferReferencing = async (
    reference: Cardano.Utxo,
    available: Cardano.Utxo[] = [funding],
  ) =>
    new TransactionBuilder(Cardano.NetworkMagics.Preprod, protocolParameters)
      .setChangeAddress(changeAddr)
      .setUnspentOutputs(available)
      .useCoinSelector(new LargeFirstCoinSelector())
      .addReferenceInput(reference)
      .transferValue(otherKeyAddr, { coins: 2_000_000n })
      .build();

  it('lists the reference input in the body, apart from the spent inputs, and prices the signed tx exactly', async () => {
    const reference = referenceAt(otherKeyAddr);

    const tx = await transferReferencing(reference);

    const { body } = tx.toCore();
    expect(body.referenceInputs).toEqual([{ txId: referenceTxId, index: 1 }]);
    expect(body.inputs).toEqual([{ txId: funding[0].txId, index: 0 }]);
    const { requiredFee, signerCount } = measureSignedMinFee(tx, [
      funding,
      reference,
    ]);
    // A reference input needs no witness, even at another key address.
    expect(signerCount).toBe(1);
    expect(requiredFee - body.fee).toBe(
      BigInt(protocolParameters.minFeeCoefficient),
    );
  });

  it('never selects a referenced UTxO to fund the transaction', async () => {
    // Large-First would pick the larger referenced UTxO first.
    const reference = referenceAt(changeAddr);

    const tx = await transferReferencing(reference, [reference, funding]);

    expect(tx.toCore().body.inputs).toEqual([
      { txId: funding[0].txId, index: 0 },
    ]);
  });

  it('prices a reference script it carries at minFeeRefScriptCostPerByte', async () => {
    const reference = referenceAt(otherKeyAddr, v3Script('ab'.repeat(1000)));

    const withScript = await transferReferencing(reference);
    const withoutScript = await transferReferencing(referenceAt(otherKeyAddr));

    expect(withScript.toCore().body.fee - withoutScript.toCore().body.fee).toBe(
      1000n * 15n,
    );
    const { requiredFee } = measureSignedMinFee(withScript, [
      funding,
      reference,
    ]);
    expect(requiredFee - withScript.toCore().body.fee).toBe(
      BigInt(protocolParameters.minFeeCoefficient),
    );
  });

  it('prices a reference script it carries in the tiers the protocol parameters set', async () => {
    const reference = referenceAt(otherKeyAddr, v3Script('ab'.repeat(251)));
    const transferPricedWith = async (
      parameters: TransactionBuilderProtocolParameters,
    ) =>
      new TransactionBuilder(Cardano.NetworkMagics.Preprod, parameters)
        .setChangeAddress(changeAddr)
        .setUnspentOutputs([funding])
        .useCoinSelector(new LargeFirstCoinSelector())
        .addReferenceInput(reference)
        .transferValue(otherKeyAddr, { coins: 2_000_000n })
        .build();

    const conwayTiers = await transferPricedWith(protocolParameters);
    const dijkstraTiers = await transferPricedWith({
      ...protocolParameters,
      refScriptCostStride: 100,
      refScriptCostMultiplier: '1.5',
    });

    expect(
      dijkstraTiers.toCore().body.fee - conwayTiers.toCore().body.fee,
    ).toBe(1500n + 2250n + 1721n - 251n * 15n);
  });

  it('refuses to reference an input twice, to reference a spent input, or to spend a referenced one', () => {
    const reference = referenceAt(changeAddr);
    const builder = () =>
      new TransactionBuilder(Cardano.NetworkMagics.Preprod, protocolParameters);

    expect(() =>
      builder().addReferenceInput(reference).addReferenceInput(reference),
    ).toThrow(`Cannot add duplicate reference input: ${referenceTxId}#1`);
    expect(() =>
      builder().addInput(reference).addReferenceInput(reference),
    ).toThrow(
      `Cannot reference an input the transaction spends: ${referenceTxId}#1`,
    );
    expect(() =>
      builder().addReferenceInput(reference).addInput(reference),
    ).toThrow(
      `Cannot spend an input the transaction references: ${referenceTxId}#1`,
    );
  });

  it.each([9, 10])(
    'refuses at protocol version %i to reference a spent input or to spend a referenced one',
    major => {
      const reference = referenceAt(changeAddr);
      const builder = () =>
        new TransactionBuilder(Cardano.NetworkMagics.Preprod, {
          ...protocolParameters,
          protocolVersion: { major, minor: 0 },
        });

      expect(() =>
        builder().addInput(reference).addReferenceInput(reference),
      ).toThrow(
        `Cannot reference an input the transaction spends: ${referenceTxId}#1`,
      );
      expect(() =>
        builder().addReferenceInput(reference).addInput(reference),
      ).toThrow(
        `Cannot spend an input the transaction references: ${referenceTxId}#1`,
      );
    },
  );

  it.each([8, 11, 12])(
    'spends an input it also references at protocol version %i, which the ledger allows',
    async major => {
      const reference = referenceAt(changeAddr);

      const tx = await new TransactionBuilder(Cardano.NetworkMagics.Preprod, {
        ...protocolParameters,
        protocolVersion: { major, minor: 0 },
      })
        .setChangeAddress(changeAddr)
        .setUnspentOutputs([funding])
        .useCoinSelector(new LargeFirstCoinSelector())
        .addReferenceInput(reference)
        .addInput(reference)
        .transferValue(otherKeyAddr, { coins: 2_000_000n })
        .build();

      const { body } = tx.toCore();
      expect(body.inputs).toEqual([{ txId: referenceTxId, index: 1 }]);
      expect(body.referenceInputs).toEqual([{ txId: referenceTxId, index: 1 }]);
    },
  );

  it('refuses to build when a reference input carries a script the witness set attaches', async () => {
    const script = v3Script('deadbeef');

    await expect(
      new TransactionBuilder(Cardano.NetworkMagics.Preprod, protocolParameters)
        .setChangeAddress(changeAddr)
        .setUnspentOutputs([funding])
        .addReferenceInput(referenceAt(otherKeyAddr, script))
        .attachScript(script)
        .setPlutusContext({
          costModels: new Map(),
          txEvaluator: { evaluate: async () => [] },
        })
        .build(),
    ).rejects.toThrow(
      `Reference input ${referenceTxId}#1 carries attached script ${Serialization.Script.fromCore(
        script,
      ).hash()}`,
    );
  });
});

describe('TransactionBuilder certificate redeemers', () => {
  const changeAddr =
    'addr_test1qpfhhfy2qgls50r9u4yh0l7z67xpg0a5rrhkmvzcuqrd0znuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q9gw0lz' as Cardano.PaymentAddress;
  const poolId = Cardano.PoolId(
    'pool1ev8vy6fyj7693ergzty2t0azjvw35tvkt2vcjwpgajqs7z6u2vn',
  );
  const keyCredential: Cardano.Credential = {
    type: Cardano.CredentialType.KeyHash,
    hash: Cardano.RewardAccount.toHash(
      Cardano.RewardAccount(
        'stake_test1up7pvfq8zn4quy45r2g572290p9vf99mr9tn7r9xrgy2l2qdsf58d',
      ),
    ),
  };
  const stakeScript = {
    __type: Cardano.ScriptType.Plutus,
    version: Cardano.PlutusLanguageVersion.V3,
    bytes: 'deadbeef',
  } as unknown as Cardano.Script;
  const stakeScriptHash = Serialization.Script.fromCore(stakeScript).hash();
  const scriptCredential: Cardano.Credential = {
    type: Cardano.CredentialType.ScriptHash,
    hash: stakeScriptHash,
  };
  const scriptRewardAccount = Cardano.RewardAccount.fromCredential(
    scriptCredential,
    Cardano.NetworkId.Testnet,
  );
  const unitRedeemer = Serialization.PlutusData.fromCbor(
    HexBlob('d87980'),
  ).toCore();
  const operateRedeemer = Serialization.PlutusData.fromCbor(
    HexBlob('d87a80'),
  ).toCore();
  const costModels: Cardano.CostModels = new Map([
    [Cardano.PlutusLanguageVersion.V3, Array.from({ length: 251 }, () => 0)],
  ]);
  const deposit = BigInt(protocolParameters.stakeKeyDeposit);
  const lowestHash = '00'.repeat(28) as Crypto.Hash28ByteBase16;

  const fundingUtxo = mkUtxo(400, 0, 20_000_000n, changeAddr);
  const stakeScriptAddr = Cardano.EnterpriseAddress.fromCredentials(
    Cardano.NetworkId.Testnet,
    scriptCredential,
  )
    .toAddress()
    .toBech32() as Cardano.PaymentAddress;
  const scriptInputUtxo = mkUtxo(401, 0, 5_000_000n, stakeScriptAddr);
  const collateralUtxo = mkUtxo(402, 0, 10_000_000n, changeAddr);
  const dRepDeposit = BigInt(protocolParameters.dRepDeposit!);
  const dRepFundingUtxo = mkUtxo(403, 0, 600_000_000n, changeAddr);

  // Distinct per purpose and index, so a budget handed to the wrong redeemer
  // shows up as a mismatch.
  const budgetFor = (
    purpose: Cardano.RedeemerPurpose,
    index: number,
  ): Cardano.ExUnits => {
    const purposeCode = Object.values(Cardano.RedeemerPurpose).indexOf(purpose);
    return {
      memory: 10_000 * (purposeCode + 1) + index,
      steps: 1_000_000 * (purposeCode + 1) + index,
    };
  };

  const evaluator: TxEvaluator = {
    evaluate: async tx =>
      (tx.witness.redeemers ?? []).map(({ purpose, index }) => ({
        purpose,
        index,
        budget: budgetFor(purpose, index),
      })),
  };

  const scriptBuilder = (txEvaluator: TxEvaluator = evaluator) =>
    new TransactionBuilder(Cardano.NetworkMagics.Preprod, protocolParameters)
      .setChangeAddress(changeAddr)
      .setUnspentOutputs([fundingUtxo])
      .useCoinSelector(new LargeFirstCoinSelector())
      .attachScript(stakeScript)
      .setCollateralUtxos([collateralUtxo])
      .setCollateralChangeAddress(changeAddr)
      .setPlutusContext({ costModels, txEvaluator });

  const redeemersOf = (
    tx: Serialization.Transaction,
    purpose: Cardano.RedeemerPurpose,
  ): Cardano.Redeemer[] =>
    (tx.toCore().witness.redeemers ?? []).filter(
      redeemer => redeemer.purpose === purpose,
    );

  it('indexes certificate redeemers by position among all certificates, key certificates included', async () => {
    const tx = await scriptBuilder()
      .addNewStakeAddressCertificate(keyCredential, deposit)
      .addStakeDelegationCertificate(poolId, keyCredential)
      .addNewStakeAddressCertificate(scriptCredential, deposit, {
        redeemer: operateRedeemer,
      })
      .addStakeDelegationCertificate(poolId, scriptCredential, {
        redeemer: unitRedeemer,
      })
      .build();

    const { body } = tx.toCore();
    expect(body.certificates?.map(({ __typename }) => __typename)).toEqual([
      Cardano.CertificateType.Registration,
      Cardano.CertificateType.StakeDelegation,
      Cardano.CertificateType.Registration,
      Cardano.CertificateType.StakeDelegation,
    ]);
    expect(body.certificates?.[2]).toEqual({
      __typename: Cardano.CertificateType.Registration,
      stakeCredential: scriptCredential,
      deposit,
    });
    expect(redeemersOf(tx, Cardano.RedeemerPurpose.certificate)).toEqual([
      {
        purpose: Cardano.RedeemerPurpose.certificate,
        index: 2,
        data: operateRedeemer,
        executionUnits: budgetFor(Cardano.RedeemerPurpose.certificate, 2),
      },
      {
        purpose: Cardano.RedeemerPurpose.certificate,
        index: 3,
        data: unitRedeemer,
        executionUnits: budgetFor(Cardano.RedeemerPurpose.certificate, 3),
      },
    ]);

    // Both registration deposits leave the inputs.
    const inputCoins = body.inputs.reduce(
      (total, input) =>
        total +
        ([fundingUtxo].find(([txIn]) => txIn.txId === input.txId)?.[1].value
          .coins ?? 0n),
      0n,
    );
    expect(inputCoins).toBe(sumCoins(body.outputs) + body.fee + 2n * deposit);
  });

  it('indexes certificate redeemers alongside spend, mint and withdrawal redeemers and hashes them all', async () => {
    const mintedAsset = Cardano.AssetId(`${stakeScriptHash}0a`);
    const evaluate = vi.fn(evaluator.evaluate);

    const tx = await scriptBuilder({ evaluate })
      .addInput(scriptInputUtxo, { redeemer: unitRedeemer })
      .mintAssets(new Map([[mintedAsset, 1n]]), unitRedeemer)
      .addStakeDelegationCertificate(poolId, keyCredential)
      .addStakeDelegationCertificate(poolId, scriptCredential, {
        redeemer: operateRedeemer,
      })
      .addScriptWithdrawal(scriptRewardAccount, 0n, unitRedeemer)
      .build();

    const core = tx.toCore();
    const sortedInputs = [...core.body.inputs].sort((a, b) =>
      a.txId === b.txId ? a.index - b.index : a.txId < b.txId ? -1 : 1,
    );
    const spendIndex = sortedInputs.findIndex(
      ({ txId }) => txId === scriptInputUtxo[0].txId,
    );
    const redeemerKeys = (core.witness.redeemers ?? []).map(
      ({ purpose, index, executionUnits }) => ({
        purpose,
        index,
        executionUnits,
      }),
    );
    expect(redeemerKeys).toEqual([
      {
        purpose: Cardano.RedeemerPurpose.spend,
        index: spendIndex,
        executionUnits: budgetFor(Cardano.RedeemerPurpose.spend, spendIndex),
      },
      {
        purpose: Cardano.RedeemerPurpose.mint,
        index: 0,
        executionUnits: budgetFor(Cardano.RedeemerPurpose.mint, 0),
      },
      {
        purpose: Cardano.RedeemerPurpose.certificate,
        index: 1,
        executionUnits: budgetFor(Cardano.RedeemerPurpose.certificate, 1),
      },
      {
        purpose: Cardano.RedeemerPurpose.withdrawal,
        index: 0,
        executionUnits: budgetFor(Cardano.RedeemerPurpose.withdrawal, 0),
      },
    ]);
    expect(
      evaluate.mock.calls[0][0].witness.redeemers?.find(
        ({ purpose }) => purpose === Cardano.RedeemerPurpose.certificate,
      )?.index,
    ).toBe(1);
    expect(core.body.scriptIntegrityHash).toBe(
      computeConwayScriptDataHash({
        costModels,
        usedLanguages: [Cardano.PlutusLanguageVersion.V3],
        redeemers: core.witness.redeemers ?? [],
        datums: undefined,
      }),
    );
  });

  it('adds no vkey signer for a script stake credential and prices the signed tx exactly', async () => {
    const tx = await scriptBuilder()
      .addNewStakeAddressCertificate(scriptCredential, deposit, {
        redeemer: operateRedeemer,
      })
      .addStakeDelegationCertificate(poolId, scriptCredential, {
        redeemer: operateRedeemer,
      })
      .build();

    const resolvedInputs = [fundingUtxo, collateralUtxo];
    expect([...getUniqueSignerKeyHashes(tx.toCore(), resolvedInputs)]).toEqual([
      Cardano.Address.fromBech32(changeAddr).asBase()!.getPaymentCredential()
        .hash,
    ]);
    const { requiredFee, signerCount } = measureSignedMinFee(
      tx,
      resolvedInputs,
    );
    expect(signerCount).toBe(1);
    expect(requiredFee - tx.toCore().body.fee).toBe(
      BigInt(protocolParameters.minFeeCoefficient),
    );
  });

  it('fails the build when the evaluator returns no budget for a certificate redeemer', async () => {
    const skipsCertificates: TxEvaluator = {
      evaluate: async (tx, resolvedInputs) =>
        (await evaluator.evaluate(tx, resolvedInputs)).filter(
          ({ purpose }) => purpose !== Cardano.RedeemerPurpose.certificate,
        ),
    };

    await expect(
      scriptBuilder(skipsCertificates)
        .addStakeDelegationCertificate(poolId, keyCredential)
        .addStakeDelegationCertificate(poolId, scriptCredential, {
          redeemer: operateRedeemer,
        })
        .build(),
    ).rejects.toThrow('No ex-units evaluation for redeemer certificate#1');
  });

  it('refuses a certificate redeemer for a key-hash stake credential', () => {
    const builder = scriptBuilder();

    expect(() =>
      builder.addNewStakeAddressCertificate(keyCredential, deposit, {
        redeemer: operateRedeemer,
      }),
    ).toThrow(/script hash credential/);
    expect(() =>
      builder.addStakeDelegationCertificate(poolId, keyCredential, {
        redeemer: operateRedeemer,
      }),
    ).toThrow(/script hash credential/);
  });

  it('refuses a certificate redeemer for a legacy stake registration, which no credential witnesses', () => {
    expect(() =>
      scriptBuilder().addCertificate(
        {
          __typename: Cardano.CertificateType.StakeRegistration,
          stakeCredential: scriptCredential,
        },
        { redeemer: operateRedeemer },
      ),
    ).toThrow(
      'Certificate redeemer requires a script hash credential that witnesses the certificate',
    );
  });

  const scriptCertificates: {
    kind: string;
    certificate: Cardano.Certificate;
  }[] = [
    {
      kind: 'a DRep registration',
      certificate: {
        __typename: Cardano.CertificateType.RegisterDelegateRepresentative,
        dRepCredential: scriptCredential,
        deposit: dRepDeposit,
        anchor: null,
      },
    },
    {
      kind: 'a DRep unregistration',
      certificate: {
        __typename: Cardano.CertificateType.UnregisterDelegateRepresentative,
        dRepCredential: scriptCredential,
        deposit: dRepDeposit,
      },
    },
    {
      kind: 'a DRep update',
      certificate: {
        __typename: Cardano.CertificateType.UpdateDelegateRepresentative,
        dRepCredential: scriptCredential,
        anchor: null,
      },
    },
    {
      kind: 'a committee hot key authorization',
      certificate: {
        __typename: Cardano.CertificateType.AuthorizeCommitteeHot,
        coldCredential: scriptCredential,
        hotCredential: keyCredential,
      },
    },
    {
      kind: 'a committee resignation',
      certificate: {
        __typename: Cardano.CertificateType.ResignCommitteeCold,
        coldCredential: scriptCredential,
        anchor: null,
      },
    },
  ];

  it.each(scriptCertificates)(
    'indexes the redeemer of $kind of a Plutus script credential at its certificate position',
    async ({ certificate }) => {
      const tx = await scriptBuilder()
        .setUnspentOutputs([dRepFundingUtxo])
        .addStakeDelegationCertificate(poolId, keyCredential)
        .addCertificate(certificate, { redeemer: operateRedeemer })
        .build();

      expect(tx.toCore().body.certificates).toEqual([
        {
          __typename: Cardano.CertificateType.StakeDelegation,
          poolId,
          stakeCredential: keyCredential,
        },
        certificate,
      ]);
      expect(redeemersOf(tx, Cardano.RedeemerPurpose.certificate)).toEqual([
        {
          purpose: Cardano.RedeemerPurpose.certificate,
          index: 1,
          data: operateRedeemer,
          executionUnits: budgetFor(Cardano.RedeemerPurpose.certificate, 1),
        },
      ]);
    },
  );

  it.each(scriptCertificates)(
    'refuses $kind of a Plutus script credential without a redeemer',
    async ({ certificate }) => {
      await expect(
        scriptBuilder()
          .setUnspentOutputs([dRepFundingUtxo])
          .addStakeDelegationCertificate(poolId, keyCredential)
          .addCertificate(certificate)
          .build(),
      ).rejects.toThrow(
        new MissingRedeemerError(
          Cardano.RedeemerPurpose.certificate,
          1,
          stakeScriptHash,
        ),
      );
    },
  );

  it('balances a pool retirement without a refund, which the ledger pays at the epoch boundary', async () => {
    const tx = await new TransactionBuilder(
      Cardano.NetworkMagics.Preprod,
      protocolParameters,
    )
      .setChangeAddress(changeAddr)
      .setUnspentOutputs([fundingUtxo])
      .useCoinSelector(new LargeFirstCoinSelector())
      .addCertificate({
        __typename: Cardano.CertificateType.PoolRetirement,
        poolId,
        epoch: Cardano.EpochNo(300),
      })
      .build();

    const { body } = tx.toCore();
    expect(body.inputs).toEqual([
      { txId: fundingUtxo[0].txId, index: fundingUtxo[0].index },
    ]);
    expect(sumCoins(body.outputs) + body.fee).toBe(fundingUtxo[1].value.coins);
  });

  it('charges the pool deposit once per pool, however many times the transaction registers it', async () => {
    const tx = await new TransactionBuilder(
      Cardano.NetworkMagics.Preprod,
      protocolParameters,
    )
      .setChangeAddress(changeAddr)
      .setUnspentOutputs([fundingUtxo])
      .useCoinSelector(new LargeFirstCoinSelector())
      .addCertificate(poolRegistrationOf(poolId))
      .addCertificate(poolRegistrationOf(registeredPoolId))
      .addCertificate(poolRegistrationOf(poolId))
      .build();

    const { body } = tx.toCore();
    expect(sumCoins(body.outputs) + body.fee).toBe(
      fundingUtxo[1].value.coins - 2n * poolDeposit,
    );
    expect(
      isTransactionBalanced({
        transaction: tx.toCore(),
        resolvedInputs: [fundingUtxo],
        protocolParameters,
      }),
    ).toBe(true);
  });

  it('charges no pool deposit for the update of a pool already registered on chain', async () => {
    const tx = await new TransactionBuilder(
      Cardano.NetworkMagics.Preprod,
      protocolParameters,
    )
      .setChangeAddress(changeAddr)
      .setUnspentOutputs([fundingUtxo])
      .useCoinSelector(new LargeFirstCoinSelector())
      .setRegisteredPools([registeredPoolId])
      .addCertificate(poolRegistrationOf(registeredPoolId))
      .build();

    const { body } = tx.toCore();
    expect(sumCoins(body.outputs) + body.fee).toBe(fundingUtxo[1].value.coins);
    expect(
      isTransactionBalanced({
        transaction: tx.toCore(),
        resolvedInputs: [fundingUtxo],
        protocolParameters,
        registeredPools: new Set([registeredPoolId]),
      }),
    ).toBe(true);
  });

  it('still charges a new pool the pool deposit once beside the update of a registered pool', async () => {
    const tx = await new TransactionBuilder(
      Cardano.NetworkMagics.Preprod,
      protocolParameters,
    )
      .setChangeAddress(changeAddr)
      .setUnspentOutputs([fundingUtxo])
      .useCoinSelector(new LargeFirstCoinSelector())
      .setRegisteredPools([registeredPoolId])
      .addCertificate(poolRegistrationOf(poolId))
      .addCertificate(poolRegistrationOf(registeredPoolId))
      .addCertificate(poolRegistrationOf(poolId))
      .build();

    const { body } = tx.toCore();
    expect(sumCoins(body.outputs) + body.fee).toBe(
      fundingUtxo[1].value.coins - poolDeposit,
    );
  });

  it('signs a committee certificate with its cold key and prices that signature', async () => {
    const tx = await new TransactionBuilder(
      Cardano.NetworkMagics.Preprod,
      protocolParameters,
    )
      .setChangeAddress(changeAddr)
      .setUnspentOutputs([fundingUtxo])
      .useCoinSelector(new LargeFirstCoinSelector())
      .addCertificate({
        __typename: Cardano.CertificateType.ResignCommitteeCold,
        coldCredential: keyCredential,
        anchor: null,
      })
      .build();

    const resolvedInputs = [fundingUtxo];
    expect([...getUniqueSignerKeyHashes(tx.toCore(), resolvedInputs)]).toEqual([
      keyCredential.hash,
      Cardano.Address.fromBech32(changeAddr).asBase()!.getPaymentCredential()
        .hash,
    ]);
    const { requiredFee, signerCount } = measureSignedMinFee(
      tx,
      resolvedInputs,
    );
    expect(signerCount).toBe(2);
    expect(requiredFee - tx.toCore().body.fee).toBe(
      BigInt(protocolParameters.minFeeCoefficient),
    );
  });

  it('refuses a certificate redeemer without a Plutus script attached or referenced, naming its purpose and index', async () => {
    const withoutScript = new TransactionBuilder(
      Cardano.NetworkMagics.Preprod,
      protocolParameters,
    )
      .setChangeAddress(changeAddr)
      .setUnspentOutputs([fundingUtxo])
      .useCoinSelector(new LargeFirstCoinSelector())
      .setCollateralUtxos([collateralUtxo])
      .setCollateralChangeAddress(changeAddr)
      .setPlutusContext({
        costModels,
        txEvaluator: evaluator,
      });

    await expect(
      withoutScript
        .addStakeDelegationCertificate(poolId, keyCredential)
        .addStakeDelegationCertificate(poolId, scriptCredential, {
          redeemer: operateRedeemer,
        })
        .build(),
    ).rejects.toThrow(
      new ExtraneousRedeemerError(
        Cardano.RedeemerPurpose.certificate,
        1,
        stakeScriptHash,
      ),
    );
  });

  it('refuses a certificate of a Plutus script credential without a redeemer, naming its purpose and index', async () => {
    const build = scriptBuilder()
      .addNewStakeAddressCertificate(keyCredential, deposit)
      .addStakeDeregistrationCertificate(scriptCredential, deposit)
      .build();

    await expect(build).rejects.toThrow(MissingRedeemerError);
    await expect(build).rejects.toThrow(
      `The certificate purpose at index 1 needs a redeemer for the Plutus script ${stakeScriptHash}, but the transaction carries none`,
    );
  });

  it('refuses a withdrawal from a Plutus script reward account without a redeemer', async () => {
    const build = scriptBuilder()
      .addRewardsWithdrawal(scriptRewardAccount, 0n)
      .build();

    await expect(build).rejects.toThrow(MissingRedeemerError);
    await expect(build).rejects.toThrow(
      `The withdrawal purpose at index 0 needs a redeemer for the Plutus script ${stakeScriptHash}, but the transaction carries none`,
    );
  });

  it('indexes a withdrawal redeemer after a native script withdrawal that sorts before it', async () => {
    const nativeRewardAccount = Cardano.RewardAccount.fromCredential(
      { type: Cardano.CredentialType.ScriptHash, hash: lowestHash },
      Cardano.NetworkId.Testnet,
    );

    const tx = await scriptBuilder()
      .addRewardsWithdrawal(nativeRewardAccount, 0n)
      .addScriptWithdrawal(scriptRewardAccount, 0n, unitRedeemer)
      .build();

    expect(
      redeemersOf(tx, Cardano.RedeemerPurpose.withdrawal).map(
        ({ index }) => index,
      ),
    ).toEqual([1]);
  });

  it('keeps a withdrawal redeemer at index 0 when a key withdrawal sorts before it', async () => {
    const keyRewardAccount = Cardano.RewardAccount.fromCredential(
      { type: Cardano.CredentialType.KeyHash, hash: lowestHash },
      Cardano.NetworkId.Testnet,
    );

    const tx = await scriptBuilder()
      .addRewardsWithdrawal(keyRewardAccount, 0n)
      .addScriptWithdrawal(scriptRewardAccount, 0n, unitRedeemer)
      .build();

    expect(
      redeemersOf(tx, Cardano.RedeemerPurpose.withdrawal).map(
        ({ index }) => index,
      ),
    ).toEqual([0]);
  });

  // Pinned bytes: any builder change that alters transactions built without
  // certificate redeemers fails here.
  it('builds byte-identical transactions when no certificate carries a redeemer', async () => {
    const utxoAt = (
      n: number,
      coins: bigint,
      address = changeAddr,
    ): Cardano.Utxo => [
      {
        txId: Cardano.TransactionId(n.toString(16).padStart(64, '0')),
        index: 0,
        address,
      },
      { address, value: { coins } },
    ];

    const keyTx = await new TransactionBuilder(
      Cardano.NetworkMagics.Preprod,
      protocolParameters,
    )
      .setChangeAddress(changeAddr)
      .setUnspentOutputs([utxoAt(1, 10_000_000n), utxoAt(2, 7_000_000n)])
      .useCoinSelector(new LargeFirstCoinSelector())
      .addNewStakeAddressCertificate(keyCredential, deposit)
      .addStakeDelegationCertificate(poolId, keyCredential)
      .build();
    expect(keyTx.toCbor()).toBe(
      '84a400d90102818258200000000000000000000000000000000000000000000000000000000000000001000181a200583900537ba48a023f0a3c65e54977ffc2d78c143fb418ef6db058e006d78a7c16240714ea0e12b41a914f2945784ac494bb19573f0ca61a08afa8011a00776847021a0002a9b904d901028283078200581c7c16240714ea0e12b41a914f2945784ac494bb19573f0ca61a08afa81a001e848083028200581c7c16240714ea0e12b41a914f2945784ac494bb19573f0ca61a08afa8581ccb0ec2692497b458e46812c8a5bfa2931d1a2d965a99893828ec810fa0f5f6',
    );

    const scriptInput = utxoAt(3, 20_000_000n, stakeScriptAddr);
    const collateral = utxoAt(4, 10_000_000n);
    const funding = utxoAt(5, 9_000_000n);
    const plutusTx = await new TransactionBuilder(
      Cardano.NetworkMagics.Preprod,
      protocolParameters,
    )
      .setChangeAddress(changeAddr)
      .setUnspentOutputs([funding])
      .useCoinSelector(new LargeFirstCoinSelector())
      .addInput(scriptInput, { redeemer: unitRedeemer })
      .attachScript(stakeScript)
      .mintAssets(
        new Map([[Cardano.AssetId(`${stakeScriptHash}0a`), 1n]]),
        unitRedeemer,
      )
      .addScriptWithdrawal(scriptRewardAccount, 0n, unitRedeemer)
      .addStakeDelegationCertificate(poolId, keyCredential)
      .setCollateralUtxos([collateral])
      .setCollateralChangeAddress(changeAddr)
      .setPlutusContext({
        costModels,
        txEvaluator: {
          evaluate: async tx =>
            (tx.witness.redeemers ?? []).map(({ purpose, index }) => ({
              purpose,
              index,
              budget: { memory: 1000 + index, steps: 100_000 + index },
            })),
        },
      })
      .build();
    expect(plutusTx.toCbor()).toBe(
      '84aa00d90102818258200000000000000000000000000000000000000000000000000000000000000003000181a200583900537ba48a023f0a3c65e54977ffc2d78c143fb418ef6db058e006d78a7c16240714ea0e12b41a914f2945784ac494bb19573f0ca61a08afa801821a012e52e8a1581c2c492f3f2c90a40274051772c1008e60d9cde2ef84a8a37dbbddf8a9a1410a01021a0002da1804d901028183028200581c7c16240714ea0e12b41a914f2945784ac494bb19573f0ca61a08afa8581ccb0ec2692497b458e46812c8a5bfa2931d1a2d965a99893828ec810f05a1581df02c492f3f2c90a40274051772c1008e60d9cde2ef84a8a37dbbddf8a90009a1581c2c492f3f2c90a40274051772c1008e60d9cde2ef84a8a37dbbddf8a9a1410a010b58209fee82565b1376e5038cc63cb1df524797659b03dbf9537d51cd0f6cdba8a2060dd901028182582000000000000000000000000000000000000000000000000000000000000000040010a200583900537ba48a023f0a3c65e54977ffc2d78c143fb418ef6db058e006d78a7c16240714ea0e12b41a914f2945784ac494bb19573f0ca61a08afa8011a00944f5c111a00044724a205a382000082d87980821903e81a000186a082010082d87980821903e81a000186a082030082d87980821903e81a000186a007d901028144deadbeeff5f6',
    );
  });
});

describe('TransactionBuilder scripts read from spent and reference inputs', () => {
  const changeAddr =
    'addr_test1qpfhhfy2qgls50r9u4yh0l7z67xpg0a5rrhkmvzcuqrd0znuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q9gw0lz' as Cardano.PaymentAddress;
  const otherKeyAddr =
    'addr_test1qpuzeec0zqcm6lrdygkkvvd8e6qactnsl5zzeujsdpkpc939l2f2vykk0ctwq4ys6w3jg8pm0kknmy8m5pml8f9cauzq2zuc95' as Cardano.PaymentAddress;
  const plutusScript = (
    version: Cardano.PlutusLanguageVersion,
    bytes: string,
  ): Cardano.Script =>
    ({
      __type: Cardano.ScriptType.Plutus,
      version,
      bytes,
    } as unknown as Cardano.Script);
  const runScript = plutusScript(Cardano.PlutusLanguageVersion.V3, 'deadbeef');
  const runScriptHash = Serialization.Script.fromCore(runScript).hash();
  const idleScript = plutusScript(Cardano.PlutusLanguageVersion.V2, 'cafe');
  const costModels: Cardano.CostModels = new Map([
    [Cardano.PlutusLanguageVersion.V2, Array.from({ length: 175 }, () => 0)],
    [Cardano.PlutusLanguageVersion.V3, Array.from({ length: 251 }, () => 0)],
  ]);
  const unitRedeemer = Serialization.PlutusData.fromCbor(
    HexBlob('d87980'),
  ).toCore();
  const rewardAccount = Cardano.RewardAccount.fromCredential(
    { type: Cardano.CredentialType.ScriptHash, hash: runScriptHash },
    Cardano.NetworkId.Testnet,
  );
  const scriptAddress = Cardano.EnterpriseAddress.fromCredentials(
    Cardano.NetworkId.Testnet,
    { type: Cardano.CredentialType.ScriptHash, hash: runScriptHash },
  )
    .toAddress()
    .toBech32() as Cardano.PaymentAddress;
  const parked = (script: Cardano.Script, index: number): Cardano.Utxo => [
    {
      txId: Cardano.TransactionId('ef'.repeat(32)),
      index,
      address: otherKeyAddr,
    },
    {
      address: otherKeyAddr,
      value: { coins: 20_000_000n },
      scriptReference: script,
    },
  ];
  const funding = mkUtxo(600, 0, 20_000_000n, changeAddr);
  const collateral = mkUtxo(601, 0, 10_000_000n, changeAddr);
  const scriptInput = mkUtxo(602, 0, 5_000_000n, scriptAddress);
  const selfCarrier: Cardano.Utxo = [
    {
      txId: Cardano.TransactionId('ac'.repeat(32)),
      index: 0,
      address: scriptAddress,
    },
    {
      address: scriptAddress,
      value: { coins: 20_000_000n },
      scriptReference: runScript,
    },
  ];
  const carrier: Cardano.Utxo = [
    {
      txId: Cardano.TransactionId('ab'.repeat(32)),
      index: 0,
      address: changeAddr,
    },
    {
      address: changeAddr,
      value: { coins: 20_000_000n },
      scriptReference: runScript,
    },
  ];
  const budget = { memory: 1000, steps: 100_000 };
  const evaluator: TxEvaluator = {
    evaluate: async tx =>
      (tx.witness.redeemers ?? []).map(({ purpose, index }) => ({
        purpose,
        index,
        budget,
      })),
  };

  const builder = (
    txEvaluator: TxEvaluator = evaluator,
    protocolVersion?: Cardano.ProtocolVersion,
  ) =>
    new TransactionBuilder(Cardano.NetworkMagics.Preprod, {
      ...protocolParameters,
      protocolVersion,
    })
      .setChangeAddress(changeAddr)
      .setUnspentOutputs([funding])
      .useCoinSelector(new LargeFirstCoinSelector())
      .setCollateralUtxos([collateral])
      .setCollateralChangeAddress(changeAddr)
      .setPlutusContext({
        costModels,
        txEvaluator,
      });

  const hashOver = (
    tx: Serialization.Transaction,
    usedLanguages: Cardano.PlutusLanguageVersion[],
  ) =>
    computeConwayScriptDataHash({
      costModels,
      usedLanguages,
      redeemers: tx.toCore().witness.redeemers ?? [],
      datums: undefined,
    });

  it('runs a withdrawal on a script a reference input carries, attaching none', async () => {
    const evaluate = vi.fn(evaluator.evaluate);

    const tx = await builder({ evaluate })
      .addReferenceInput(parked(runScript, 0))
      .addScriptWithdrawal(rewardAccount, 0n, unitRedeemer)
      .build();

    const core = tx.toCore();
    expect(core.witness.scripts).toBeUndefined();
    expect(core.witness.redeemers).toEqual([
      {
        purpose: Cardano.RedeemerPurpose.withdrawal,
        index: 0,
        data: unitRedeemer,
        executionUnits: budget,
      },
    ]);
    expect(evaluate.mock.calls[0][1]).toEqual(
      expect.arrayContaining([parked(runScript, 0)]),
    );
    expect(core.body.scriptIntegrityHash).toBe(
      hashOver(tx, [Cardano.PlutusLanguageVersion.V3]),
    );
    expect(core.body.collaterals).toEqual([
      { txId: collateral[0].txId, index: collateral[0].index },
    ]);
  });

  it('spends an input at a script address with the script a reference input carries', async () => {
    const tx = await builder()
      .addInput(scriptInput, { redeemer: unitRedeemer })
      .addReferenceInput(parked(runScript, 0))
      .build();

    const core = tx.toCore();
    expect(core.witness.scripts).toBeUndefined();
    expect(core.witness.redeemers?.map(({ purpose }) => purpose)).toEqual([
      Cardano.RedeemerPurpose.spend,
    ]);
    expect(core.body.scriptIntegrityHash).toBe(
      hashOver(tx, [Cardano.PlutusLanguageVersion.V3]),
    );
  });

  it('leaves out of the script data hash the language of a referenced script no redeemer runs', async () => {
    const tx = await builder()
      .addReferenceInput(parked(runScript, 0))
      .addReferenceInput(parked(idleScript, 1))
      .addScriptWithdrawal(rewardAccount, 0n, unitRedeemer)
      .build();

    const { scriptIntegrityHash } = tx.toCore().body;
    expect(scriptIntegrityHash).toBe(
      hashOver(tx, [Cardano.PlutusLanguageVersion.V3]),
    );
    expect(scriptIntegrityHash).not.toBe(
      hashOver(tx, [
        Cardano.PlutusLanguageVersion.V2,
        Cardano.PlutusLanguageVersion.V3,
      ]),
    );
  });

  it('runs a script a spent input carries, attaching none, and indexes, hashes and collateralizes it', async () => {
    const tx = await builder()
      .addInput(carrier)
      .addInput(scriptInput, { redeemer: unitRedeemer })
      .build();

    const core = tx.toCore();
    const spendIndex = [...core.body.inputs]
      .sort(compareTxIns)
      .findIndex(({ txId }) => txId === scriptInput[0].txId);
    expect(spendIndex).toBeGreaterThan(0);
    expect(core.witness.scripts).toBeUndefined();
    expect(core.witness.redeemers).toEqual([
      {
        purpose: Cardano.RedeemerPurpose.spend,
        index: spendIndex,
        data: unitRedeemer,
        executionUnits: budget,
      },
    ]);
    expect(core.body.scriptIntegrityHash).toBe(
      hashOver(tx, [Cardano.PlutusLanguageVersion.V3]),
    );
    expect(core.body.collaterals).toEqual([
      { txId: collateral[0].txId, index: collateral[0].index },
    ]);
  });

  it('spends and references at protocol version 11 an output carrying the script it is locked by, handing the evaluator that output once', async () => {
    const evaluate = vi.fn(evaluator.evaluate);

    const tx = await builder({ evaluate }, { major: 11, minor: 0 })
      .addReferenceInput(selfCarrier)
      .addInput(selfCarrier, { redeemer: unitRedeemer })
      .build();

    const core = tx.toCore();
    expect(core.body.referenceInputs).toEqual([
      { txId: selfCarrier[0].txId, index: 0 },
    ]);
    expect(core.witness.redeemers?.map(({ purpose }) => purpose)).toEqual([
      Cardano.RedeemerPurpose.spend,
    ]);
    expect(core.body.scriptIntegrityHash).toBe(
      hashOver(tx, [Cardano.PlutusLanguageVersion.V3]),
    );
    expect(
      evaluate.mock.calls[0][1].filter(
        ([txIn]) => txIn.txId === selfCarrier[0].txId,
      ),
    ).toHaveLength(1);
  });

  describe('with an input resolver that leaves out reference scripts', () => {
    const stripping = (...utxos: Cardano.Utxo[]): Cardano.InputResolver => ({
      resolveInput: vi.fn(async (input: Cardano.TxIn) => {
        const output = utxos.find(
          ([txIn]) => txIn.txId === input.txId && txIn.index === input.index,
        )?.[1];
        if (!output) return null;
        const { scriptReference: _, ...withoutScript } = output;
        return withoutScript;
      }),
    });

    it('spends an output carrying the script it is locked by from the UTxO given to addInput', async () => {
      const evaluate = vi.fn(evaluator.evaluate);
      const inputResolver = stripping(funding, collateral, selfCarrier);

      const tx = await builder()
        .setPlutusContext({
          costModels,
          txEvaluator: { evaluate },
          inputResolver,
        })
        .addInput(selfCarrier, { redeemer: unitRedeemer })
        .build();

      expect(tx.toCore().body.scriptIntegrityHash).toBe(
        hashOver(tx, [Cardano.PlutusLanguageVersion.V3]),
      );
      expect(evaluate.mock.calls[0][1]).toEqual(
        expect.arrayContaining([selfCarrier]),
      );
      expect(inputResolver.resolveInput).not.toHaveBeenCalled();
    });

    it('runs a script a selected wallet UTxO carries from the UTxO given to setUnspentOutputs', async () => {
      const evaluate = vi.fn(evaluator.evaluate);
      const inputResolver = stripping(carrier, collateral);

      const tx = await builder()
        .setUnspentOutputs([carrier])
        .setPlutusContext({
          costModels,
          txEvaluator: { evaluate },
          inputResolver,
        })
        .addScriptWithdrawal(rewardAccount, 0n, unitRedeemer)
        .build();

      expect(tx.toCore().body.inputs).toEqual([
        { txId: carrier[0].txId, index: 0 },
      ]);
      expect(tx.toCore().body.scriptIntegrityHash).toBe(
        hashOver(tx, [Cardano.PlutusLanguageVersion.V3]),
      );
      expect(evaluate.mock.calls[0][1]).toEqual(
        expect.arrayContaining([carrier]),
      );
      expect(inputResolver.resolveInput).not.toHaveBeenCalled();
    });
  });

  it('refuses to build when a spent input carries a script the witness set attaches', async () => {
    await expect(
      builder()
        .addInput(carrier)
        .addInput(scriptInput, { redeemer: unitRedeemer })
        .attachScript(runScript)
        .build(),
    ).rejects.toThrow(
      `Input ${carrier[0].txId}#0 carries attached script ${runScriptHash}`,
    );
  });

  it('refuses to spend an input at an attached Plutus script address without a redeemer, naming its purpose and index', async () => {
    const build = builder().addInput(carrier).addInput(scriptInput).build();

    await expect(build).rejects.toThrow(MissingRedeemerError);
    await expect(build).rejects.toThrow(
      `The spend purpose at index 1 needs a redeemer for the Plutus script ${runScriptHash}, but the transaction carries none`,
    );
  });

  it('refuses to spend an output locked by a datum hash without its datum, and spends it with the datum', async () => {
    const datum = Serialization.PlutusData.fromCbor(HexBlob('182a')).toCore();
    const datumHash = Serialization.PlutusData.fromCore(datum).hash();
    const hashed: Cardano.Utxo = [
      scriptInput[0],
      { ...scriptInput[1], datumHash },
    ];

    const build = builder()
      .addInput(carrier)
      .addInput(hashed, { redeemer: unitRedeemer })
      .build();
    await expect(build).rejects.toThrow(MissingDatumError);
    await expect(build).rejects.toThrow(
      `The input ${hashed[0].txId}#0 is locked by the datum hash ${datumHash}`,
    );
    await expect(
      builder()
        .addInput(carrier)
        .addInput(hashed, { redeemer: unitRedeemer, datum })
        .build(),
    ).resolves.toBeDefined();
  });

  it('refuses to spend an input at the address of a script a reference input carries without a redeemer, even with no Plutus context', async () => {
    await expect(
      new TransactionBuilder(Cardano.NetworkMagics.Preprod, protocolParameters)
        .setChangeAddress(changeAddr)
        .setUnspentOutputs([funding])
        .useCoinSelector(new LargeFirstCoinSelector())
        .addReferenceInput(parked(runScript, 0))
        .addInput(scriptInput)
        .build(),
    ).rejects.toThrow(
      new MissingRedeemerError(Cardano.RedeemerPurpose.spend, 0, runScriptHash),
    );
  });

  it('refuses a spend redeemer for an input at the address of a script the transaction does not provide, naming its purpose and index', async () => {
    const build = builder()
      .addInput(funding)
      .addInput(scriptInput, { redeemer: unitRedeemer })
      .build();

    await expect(build).rejects.toThrow(ExtraneousRedeemerError);
    await expect(build).rejects.toThrow(
      `The spend redeemer at index 1 runs the script ${runScriptHash}, but the transaction provides no Plutus script with that hash`,
    );
  });

  it('refuses a mint redeemer for a policy whose script the transaction does not provide', async () => {
    await expect(
      builder()
        .mintAssets(
          new Map([[Cardano.AssetId(`${runScriptHash}746f6b`), 1n]]),
          unitRedeemer,
        )
        .build(),
    ).rejects.toThrow(
      new ExtraneousRedeemerError(
        Cardano.RedeemerPurpose.mint,
        0,
        runScriptHash,
      ),
    );
  });

  it('refuses a withdrawal redeemer when a reference input carries only another Plutus script', async () => {
    await expect(
      builder()
        .addReferenceInput(parked(idleScript, 0))
        .addScriptWithdrawal(rewardAccount, 0n, unitRedeemer)
        .build(),
    ).rejects.toThrow(
      new ExtraneousRedeemerError(
        Cardano.RedeemerPurpose.withdrawal,
        0,
        runScriptHash,
      ),
    );
  });

  it('refuses a spend redeemer for an input at a key hash address', () => {
    expect(() =>
      builder().addInput(funding, { redeemer: unitRedeemer }),
    ).toThrow(
      `Spend redeemer requires an input at a script address, got ${funding[0].txId}#0`,
    );
  });

  it('needs no Plutus context for a referenced script that no redeemer runs', async () => {
    const tx = await new TransactionBuilder(
      Cardano.NetworkMagics.Preprod,
      protocolParameters,
    )
      .setChangeAddress(changeAddr)
      .setUnspentOutputs([funding])
      .useCoinSelector(new LargeFirstCoinSelector())
      .addReferenceInput(parked(runScript, 0))
      .transferValue(otherKeyAddr, { coins: 2_000_000n })
      .build();

    expect(tx.toCore().body.scriptIntegrityHash).toBeUndefined();
    expect(tx.toCore().witness.redeemers).toBeUndefined();
  });
});

describe('TransactionBuilder guards', () => {
  const changeAddr =
    'addr_test1qpfhhfy2qgls50r9u4yh0l7z67xpg0a5rrhkmvzcuqrd0znuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q9gw0lz' as Cardano.PaymentAddress;
  const recipientAddr =
    'addr_test1qpuzeec0zqcm6lrdygkkvvd8e6qactnsl5zzeujsdpkpc939l2f2vykk0ctwq4ys6w3jg8pm0kknmy8m5pml8f9cauzq2zuc95' as Cardano.PaymentAddress;
  const signerKeyHash = '88'.repeat(28) as Crypto.Ed25519KeyHashHex;
  const keyGuard: Cardano.Credential = {
    type: Cardano.CredentialType.KeyHash,
    hash: signerKeyHash as unknown as Crypto.Hash28ByteBase16,
  };
  const guardScript = {
    __type: Cardano.ScriptType.Plutus,
    version: Cardano.PlutusLanguageVersion.V4,
    bytes: '46450101002496',
  } as unknown as Cardano.Script;
  const scriptGuard: Cardano.Credential = {
    type: Cardano.CredentialType.ScriptHash,
    hash: Serialization.Script.fromCore(guardScript).hash(),
  };
  const timelockScript: Cardano.Script = {
    __type: Cardano.ScriptType.Native,
    kind: Cardano.NativeScriptKind.RequireTimeBefore,
    slot: Cardano.Slot(90_000_000),
  };
  const timelockGuard: Cardano.Credential = {
    type: Cardano.CredentialType.ScriptHash,
    hash: Serialization.Script.fromCore(timelockScript).hash(),
  };
  const unitRedeemer = Serialization.PlutusData.fromCbor(
    HexBlob('d87980'),
  ).toCore();
  const costModels: Cardano.CostModels = new Map([
    [Cardano.PlutusLanguageVersion.V4, Array.from({ length: 251 }, () => 0)],
  ]);
  const budget: Cardano.ExUnits = { memory: 520_000, steps: 210_000_000 };

  const fundingUtxo = mkUtxo(500, 0, 20_000_000n, changeAddr);
  const collateralUtxo = mkUtxo(501, 0, 10_000_000n, changeAddr);

  const evaluator: TxEvaluator = {
    evaluate: async tx =>
      (tx.witness.redeemers ?? []).map(({ purpose, index }) => ({
        purpose,
        index,
        budget,
      })),
  };

  const paymentBuilder = () =>
    new TransactionBuilder(Cardano.NetworkMagics.Preprod, protocolParameters)
      .setChangeAddress(changeAddr)
      .setUnspentOutputs([fundingUtxo])
      .useCoinSelector(new LargeFirstCoinSelector())
      .transferValue(recipientAddr, { coins: 2_000_000n });

  const guardBuilder = () =>
    paymentBuilder()
      .attachScript(guardScript)
      .setCollateralUtxos([collateralUtxo])
      .setCollateralChangeAddress(changeAddr)
      .setPlutusContext({
        costModels,
        txEvaluator: evaluator,
      });

  it('writes a key hash guard as the same transaction as a required signer', async () => {
    const signed = await paymentBuilder()
      .addRequiredSigner(signerKeyHash)
      .build();
    const guarded = await paymentBuilder().addGuard(keyGuard).build();

    expect(guarded.toCbor()).toBe(signed.toCbor());
    expect(guarded.toCore().body.requiredExtraSignatures).toEqual([
      signerKeyHash,
    ]);
    expect(guarded.toCore().body.guards).toBeUndefined();
  });

  it('writes the guards in the credential form and indexes the guarding redeemer by its position, required signers included', async () => {
    const tx = await guardBuilder()
      .addRequiredSigner(signerKeyHash)
      .addGuard(scriptGuard, { redeemer: unitRedeemer })
      .build();

    const core = tx.toCore();
    expect(core.body.guards).toEqual([keyGuard, scriptGuard]);
    expect(core.witness.redeemers).toEqual([
      {
        purpose: Cardano.RedeemerPurpose.guarding,
        index: 1,
        data: unitRedeemer,
        executionUnits: budget,
      },
    ]);
    expect(core.body.scriptIntegrityHash).toBe(
      computeConwayScriptDataHash({
        costModels,
        usedLanguages: [Cardano.PlutusLanguageVersion.V4],
        redeemers: core.witness.redeemers ?? [],
        datums: undefined,
      }),
    );
    expect(core.body.collaterals).toEqual([
      txIn(collateralUtxo[0].txId, collateralUtxo[0].index),
    ]);
  });

  it('prices the key hash guard as a signer', async () => {
    const tx = await guardBuilder()
      .addRequiredSigner(signerKeyHash)
      .addGuard(scriptGuard, { redeemer: unitRedeemer })
      .build();

    const { requiredFee, signerCount } = measureSignedMinFee(tx, [
      fundingUtxo,
      collateralUtxo,
    ]);
    expect(signerCount).toBe(2);
    expect(requiredFee - tx.toCore().body.fee).toBe(
      BigInt(protocolParameters.minFeeCoefficient),
    );
  });

  it('keeps the position of a guard added again', async () => {
    const tx = await guardBuilder()
      .addGuard(scriptGuard)
      .addRequiredSigner(signerKeyHash)
      .addGuard(scriptGuard, { redeemer: unitRedeemer })
      .addGuard(keyGuard)
      .build();

    const core = tx.toCore();
    expect(core.body.guards).toEqual([scriptGuard, keyGuard]);
    expect(
      core.witness.redeemers?.map(({ purpose, index }) => [purpose, index]),
    ).toEqual([[Cardano.RedeemerPurpose.guarding, 0]]);
  });

  it('refuses a guarding redeemer for a key hash guard', () => {
    expect(() =>
      paymentBuilder().addGuard(keyGuard, { redeemer: unitRedeemer }),
    ).toThrow(
      `Guarding redeemer requires a script hash guard, got key hash ${signerKeyHash}`,
    );
  });

  it('keeps an integer zero guarding redeemer', async () => {
    const tx = await guardBuilder()
      .addGuard(scriptGuard, { redeemer: 0n })
      .build();

    expect(tx.toCore().witness.redeemers).toEqual([
      {
        purpose: Cardano.RedeemerPurpose.guarding,
        index: 0,
        data: 0n,
        executionUnits: budget,
      },
    ]);
  });

  it('refuses an integer zero guarding redeemer for a key hash guard', () => {
    expect(() => paymentBuilder().addGuard(keyGuard, { redeemer: 0n })).toThrow(
      `Guarding redeemer requires a script hash guard, got key hash ${signerKeyHash}`,
    );
  });

  it('refuses a guarding redeemer for a guard that already has an integer zero one', () => {
    const builder = paymentBuilder().addGuard(scriptGuard, { redeemer: 0n });

    expect(() =>
      builder.addGuard(scriptGuard, { redeemer: unitRedeemer }),
    ).toThrow(`Guard ${scriptGuard.hash} already has a redeemer`);
  });

  it('refuses a second guarding redeemer for the same guard', () => {
    const builder = paymentBuilder().addGuard(scriptGuard, {
      redeemer: unitRedeemer,
    });

    expect(() =>
      builder.addGuard(scriptGuard, { redeemer: unitRedeemer }),
    ).toThrow(`Guard ${scriptGuard.hash} already has a redeemer`);
  });

  it('refuses a Plutus script guard without a guarding redeemer, naming its purpose and index', async () => {
    const build = guardBuilder()
      .addRequiredSigner(signerKeyHash)
      .addGuard(scriptGuard)
      .build();

    await expect(build).rejects.toThrow(
      new MissingRedeemerError(
        Cardano.RedeemerPurpose.guarding,
        1,
        scriptGuard.hash,
      ),
    );
  });

  it('refuses a guarding redeemer for a Plutus script guard whose script the transaction does not provide, naming its purpose and index', async () => {
    const build = paymentBuilder()
      .setCollateralUtxos([collateralUtxo])
      .setCollateralChangeAddress(changeAddr)
      .setPlutusContext({
        costModels,
        txEvaluator: evaluator,
      })
      .addRequiredSigner(signerKeyHash)
      .addGuard(scriptGuard, { redeemer: unitRedeemer })
      .build();

    await expect(build).rejects.toThrow(
      new ExtraneousRedeemerError(
        Cardano.RedeemerPurpose.guarding,
        1,
        scriptGuard.hash,
      ),
    );
  });

  it('refuses a guarding redeemer for a native script guard', async () => {
    await expect(
      guardBuilder()
        .attachScript(timelockScript)
        .addGuard(timelockGuard, { redeemer: unitRedeemer })
        .build(),
    ).rejects.toThrow(
      new ExtraneousRedeemerError(
        Cardano.RedeemerPurpose.guarding,
        0,
        timelockGuard.hash,
      ),
    );
  });

  it('needs the Plutus context for any redeemer, even one on a native script guard', async () => {
    await expect(
      paymentBuilder()
        .attachScript(timelockScript)
        .addGuard(timelockGuard, { redeemer: unitRedeemer })
        .build(),
    ).rejects.toThrow(/Plutus context is not set/);
  });

  it('needs no redeemer, collateral or Plutus context for a native script guard', async () => {
    const tx = await paymentBuilder()
      .attachScript(timelockScript)
      .addGuard(timelockGuard)
      .build();

    const core = tx.toCore();
    expect(core.body.guards).toEqual([timelockGuard]);
    expect(core.body.collaterals).toBeUndefined();
    expect(core.body.scriptIntegrityHash).toBeUndefined();
    expect(core.witness.redeemers).toBeUndefined();
  });
});

describe('TransactionBuilder direct deposits and account balance intervals', () => {
  const changeAddr =
    'addr_test1qpfhhfy2qgls50r9u4yh0l7z67xpg0a5rrhkmvzcuqrd0znuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q9gw0lz' as Cardano.PaymentAddress;
  const recipientAddr =
    'addr_test1qpuzeec0zqcm6lrdygkkvvd8e6qactnsl5zzeujsdpkpc939l2f2vykk0ctwq4ys6w3jg8pm0kknmy8m5pml8f9cauzq2zuc95' as Cardano.PaymentAddress;
  const rewardAccountOf = (byte: string): Cardano.RewardAccount =>
    Cardano.RewardAccount.fromCredential(
      {
        type: Cardano.CredentialType.KeyHash,
        hash: byte.repeat(28) as Crypto.Hash28ByteBase16,
      },
      Cardano.NetworkId.Testnet,
    );
  const lowerAccount = rewardAccountOf('99');
  const higherAccount = rewardAccountOf('aa');
  const maxDeposit = 9_223_372_036_854_775_807n;

  const writtenBody = (tx: Serialization.Transaction): Cardano.TxBody =>
    Serialization.Transaction.fromCbor(tx.toCbor()).toCore().body;

  const fundingUtxo = mkUtxo(600, 0, 20_000_000n, changeAddr);

  const paymentBuilder = () =>
    new TransactionBuilder(Cardano.NetworkMagics.Preprod, protocolParameters)
      .setChangeAddress(changeAddr)
      .setUnspentOutputs([fundingUtxo])
      .useCoinSelector(new LargeFirstCoinSelector())
      .transferValue(recipientAddr, { coins: 2_000_000n });

  it('funds a direct deposit from the wallet like an output', async () => {
    const tx = await paymentBuilder()
      .addDirectDeposit(lowerAccount, 3_000_000n)
      .build();

    const { body } = tx.toCore();
    expect(body.directDeposits).toEqual([
      { stakeAddress: lowerAccount, quantity: 3_000_000n },
    ]);
    expect(sumCoins(body.outputs) + body.fee + 3_000_000n).toBe(
      fundingUtxo[1].value.coins,
    );
  });

  it('adds up the deposits to the same reward account and writes them sorted by reward account', async () => {
    const tx = await paymentBuilder()
      .addDirectDeposit(higherAccount, 2_500_000n)
      .addDirectDeposit(lowerAccount, 1_000_000n)
      .addDirectDeposit(lowerAccount, 4_000_000n)
      .build();

    expect(writtenBody(tx).directDeposits).toEqual([
      { stakeAddress: lowerAccount, quantity: 5_000_000n },
      { stakeAddress: higherAccount, quantity: 2_500_000n },
    ]);
  });

  it('refuses a direct deposit of zero', () => {
    expect(() => paymentBuilder().addDirectDeposit(lowerAccount, 0n)).toThrow(
      `Direct deposit to ${lowerAccount} must be greater than zero, got 0`,
    );
  });

  it('refuses a negative direct deposit', () => {
    expect(() => paymentBuilder().addDirectDeposit(lowerAccount, -1n)).toThrow(
      `Direct deposit to ${lowerAccount} must be greater than zero, got -1`,
    );
  });

  it('refuses a direct deposit above the largest signed 64-bit integer', () => {
    expect(() =>
      paymentBuilder().addDirectDeposit(lowerAccount, maxDeposit + 1n),
    ).toThrow(
      `Direct deposit to ${lowerAccount} exceeds the maximum of ${maxDeposit} lovelace, got ${
        maxDeposit + 1n
      }`,
    );
  });

  it('refuses deposits to one reward account that add up above the largest signed 64-bit integer', () => {
    const builder = paymentBuilder().addDirectDeposit(lowerAccount, maxDeposit);

    expect(() => builder.addDirectDeposit(lowerAccount, 1n)).toThrow(
      `Direct deposits to ${lowerAccount} add up to ${
        maxDeposit + 1n
      } lovelace, more than the maximum of ${maxDeposit}`,
    );
  });

  it('needs no signer for direct deposits and account balance intervals', async () => {
    const tx = await paymentBuilder()
      .addDirectDeposit(lowerAccount, 3_000_000n)
      .addAccountBalanceInterval(higherAccount, { exactBalance: 0n })
      .addStartingAccountBalanceInterval(higherAccount, {
        inclusiveLowerBound: 0n,
      })
      .build();

    const { requiredFee, signerCount } = measureSignedMinFee(tx, [fundingUtxo]);
    expect(signerCount).toBe(1);
    expect(requiredFee - tx.toCore().body.fee).toBe(
      BigInt(protocolParameters.minFeeCoefficient),
    );
  });

  it('writes a range and an exact balance interval sorted by reward account', async () => {
    const tx = await paymentBuilder()
      .addAccountBalanceInterval(higherAccount, { exactBalance: 1_500_000n })
      .addAccountBalanceInterval(lowerAccount, {
        inclusiveLowerBound: 1_000_000n,
        exclusiveUpperBound: 5_000_000n,
      })
      .build();

    const body = writtenBody(tx);
    expect(body.accountBalanceIntervals).toEqual([
      {
        rewardAccount: lowerAccount,
        interval: {
          inclusiveLowerBound: 1_000_000n,
          exclusiveUpperBound: 5_000_000n,
        },
      },
      { rewardAccount: higherAccount, interval: { exactBalance: 1_500_000n } },
    ]);
    expect(body.startingAccountBalanceIntervals).toBeUndefined();
  });

  it('replaces the interval of a reward account added again, still sorted by reward account', async () => {
    const tx = await paymentBuilder()
      .addAccountBalanceInterval(higherAccount, {
        inclusiveLowerBound: 1_000_000n,
      })
      .addAccountBalanceInterval(lowerAccount, { exactBalance: 0n })
      .addAccountBalanceInterval(higherAccount, { exactBalance: 1_500_000n })
      .build();

    expect(writtenBody(tx).accountBalanceIntervals).toEqual([
      { rewardAccount: lowerAccount, interval: { exactBalance: 0n } },
      { rewardAccount: higherAccount, interval: { exactBalance: 1_500_000n } },
    ]);
  });

  it('replaces the starting interval of a reward account added again, apart from its account balance interval, sorted by reward account', async () => {
    const tx = await paymentBuilder()
      .addAccountBalanceInterval(lowerAccount, { exactBalance: 0n })
      .addStartingAccountBalanceInterval(higherAccount, {
        exclusiveUpperBound: 1_000_000n,
      })
      .addStartingAccountBalanceInterval(lowerAccount, {
        exclusiveUpperBound: 1_000_000n,
      })
      .addStartingAccountBalanceInterval(lowerAccount, {
        inclusiveLowerBound: 0n,
      })
      .build();

    const body = writtenBody(tx);
    expect(body.accountBalanceIntervals).toEqual([
      { rewardAccount: lowerAccount, interval: { exactBalance: 0n } },
    ]);
    expect(body.startingAccountBalanceIntervals).toEqual([
      { rewardAccount: lowerAccount, interval: { inclusiveLowerBound: 0n } },
      {
        rewardAccount: higherAccount,
        interval: { exclusiveUpperBound: 1_000_000n },
      },
    ]);
  });

  it('refuses an interval with neither bound nor an exact balance', () => {
    expect(() =>
      paymentBuilder().addAccountBalanceInterval(lowerAccount, {}),
    ).toThrow('Both interval bounds cannot be nil.');
    expect(() =>
      paymentBuilder().addStartingAccountBalanceInterval(lowerAccount, {}),
    ).toThrow('Both interval bounds cannot be nil.');
  });

  it('refuses an exact balance together with a bound', () => {
    const interval = { exactBalance: 0n, inclusiveLowerBound: 0n };

    expect(() =>
      paymentBuilder().addAccountBalanceInterval(lowerAccount, interval),
    ).toThrow('An exact balance cannot be combined with interval bounds.');
    expect(() =>
      paymentBuilder().addStartingAccountBalanceInterval(
        lowerAccount,
        interval,
      ),
    ).toThrow('An exact balance cannot be combined with interval bounds.');
  });
});

describe('TransactionBuilder sub transactions', () => {
  const changeAddr =
    'addr_test1qpfhhfy2qgls50r9u4yh0l7z67xpg0a5rrhkmvzcuqrd0znuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q9gw0lz' as Cardano.PaymentAddress;
  const recipientAddr =
    'addr_test1qpuzeec0zqcm6lrdygkkvvd8e6qactnsl5zzeujsdpkpc939l2f2vykk0ctwq4ys6w3jg8pm0kknmy8m5pml8f9cauzq2zuc95' as Cardano.PaymentAddress;

  const fundingUtxo = mkUtxo(700, 0, 20_000_000n, changeAddr);

  /**
   * The UTxO a sub transaction of {@link subTransactionOf} spends, holding
   * what it pays out, so the sub transaction leaves the batch balanced.
   */
  const spentBy = (byte: string, coins: bigint): Cardano.Utxo => [
    { ...txIn(byte.repeat(32), 0), address: recipientAddr },
    { address: recipientAddr, value: { coins } },
  ];

  /** Adds each sub transaction with the UTxO it spends. */
  const withSubTransactions = (
    builder: TransactionBuilder,
    subTransactions: Array<[Serialization.SubTransaction, Cardano.Utxo]>,
  ) => {
    for (const [subTransaction, spent] of subTransactions) {
      builder.addSubTransaction(subTransaction, [spent]);
    }
    return builder;
  };

  const paymentBuilder = (
    ...subTransactions: Array<[Serialization.SubTransaction, Cardano.Utxo]>
  ) =>
    withSubTransactions(
      new TransactionBuilder(Cardano.NetworkMagics.Preprod, protocolParameters),
      subTransactions,
    )
      .setChangeAddress(changeAddr)
      .setUnspentOutputs([fundingUtxo])
      .useCoinSelector(new LargeFirstCoinSelector())
      .transferValue(recipientAddr, { coins: 2_000_000n });

  const subTransactionOf = async (byte: string, coins: bigint) =>
    signedSubTransaction(txIn(byte.repeat(32), 0), {
      address: recipientAddr,
      value: { coins },
    });

  const writtenSubTransactions = (tx: Serialization.Transaction) =>
    Serialization.Transaction.fromCbor(tx.toCbor())
      .body()
      .subTransactions()
      ?.values() ?? [];

  it('keeps the bytes, id and signature of a decoded signed sub transaction', async () => {
    const signed = await subTransactionOf('e1', 3_000_000n);
    const subTransaction = Serialization.SubTransaction.fromCbor(signed.cbor);
    expect(
      Serialization.SubTransaction.fromCore(subTransaction.toCore()).toCbor(),
    ).not.toBe(signed.cbor);

    const tx = await paymentBuilder([
      subTransaction,
      spentBy('e1', 3_000_000n),
    ]).build();

    const [written] = writtenSubTransactions(tx);
    expect(writtenSubTransactions(tx)).toHaveLength(1);
    expect(written.toCbor()).toBe(signed.cbor);
    expect(written.getId()).toBe(signed.id);
    const [[vkey, signature]] = written.witnessSet().toCore().signatures;
    expect(vkey).toBe(signed.publicKey.hex());
    expect(
      signed.publicKey.verify(
        Ed25519Signature.fromHex(signature),
        HexBlob(written.getId()),
      ),
    ).toBe(true);
    expect(tx.toCbor()).toContain(signed.cbor);
  });

  it('keeps the sub transactions in the order they were added, and a sub transaction changed after it was added keeps the bytes it was added with', async () => {
    const first = await subTransactionOf('e2', 3_000_000n);
    const second = await subTransactionOf('e1', 4_000_000n);
    const added = Serialization.SubTransaction.fromCbor(first.cbor);

    const builder = paymentBuilder(
      [added, spentBy('e2', 3_000_000n)],
      [
        Serialization.SubTransaction.fromCbor(second.cbor),
        spentBy('e1', 4_000_000n),
      ],
    );
    added.setAuxiliaryData(
      Serialization.AuxiliaryData.fromCore({ blob: new Map([[1n, 'late']]) }),
    );
    const tx = await builder.build();

    expect(writtenSubTransactions(tx).map(subTx => subTx.toCbor())).toEqual([
      first.cbor,
      second.cbor,
    ]);
  });

  it('prices the fee over the transaction as written, sub transactions included', async () => {
    const signed = await subTransactionOf('e1', 3_000_000n);
    const subTransaction = Serialization.SubTransaction.fromCbor(signed.cbor);

    const tx = await paymentBuilder([
      subTransaction,
      spentBy('e1', 3_000_000n),
    ]).build();
    const plainTx = await paymentBuilder().build();

    const signedSize = estimateSignedTxSize(tx, [fundingUtxo]);
    const plainSignedSize = estimateSignedTxSize(plainTx, [fundingUtxo]);
    const coefficient = BigInt(protocolParameters.minFeeCoefficient);
    const constant = BigInt(protocolParameters.minFeeConstant);
    expect(tx.toCore().body.fee).toBe(
      constant + coefficient * BigInt(signedSize - 1),
    );
    expect(plainTx.toCore().body.fee).toBe(
      constant + coefficient * BigInt(plainSignedSize - 1),
    );
    expect(signedSize - plainSignedSize).toBeGreaterThan(
      signed.cbor.length / 2,
    );
  });

  it('keeps the sub transaction bytes and prices them through fee correction after evaluation', async () => {
    const script = {
      __type: Cardano.ScriptType.Plutus,
      version: Cardano.PlutusLanguageVersion.V3,
      bytes: 'deadbeef',
    } as unknown as Cardano.Script;
    const scriptAddr = Cardano.EnterpriseAddress.fromCredentials(
      Cardano.NetworkId.Testnet,
      {
        type: Cardano.CredentialType.ScriptHash,
        hash: Serialization.Script.fromCore(script).hash(),
      },
    )
      .toAddress()
      .toBech32() as Cardano.PaymentAddress;
    const scriptUtxo = mkUtxo(701, 0, 20_000_000n, scriptAddr);
    const collateral = mkUtxo(702, 0, 10_000_000n, changeAddr);
    const signed = await subTransactionOf('e1', 3_000_000n);
    const evaluator: TxEvaluator = {
      evaluate: async tx =>
        (tx.witness.redeemers ?? []).map(({ purpose, index }) => ({
          purpose,
          index,
          budget: { memory: 100, steps: 100_000 },
        })),
    };

    const tx = await new TransactionBuilder(
      Cardano.NetworkMagics.Preprod,
      protocolParameters,
    )
      .addSubTransaction(Serialization.SubTransaction.fromCbor(signed.cbor), [
        spentBy('e1', 3_000_000n),
      ])
      .setChangeAddress(changeAddr)
      .setUnspentOutputs([])
      .addInput(scriptUtxo, {
        redeemer: Serialization.PlutusData.fromCbor(HexBlob('d87980')).toCore(),
      })
      .attachScript(script)
      .setCollateralUtxos([collateral])
      .setCollateralChangeAddress(changeAddr)
      .setPlutusContext({
        costModels: new Map([
          [
            Cardano.PlutusLanguageVersion.V3,
            Array.from({ length: 251 }, () => 0),
          ],
        ]),
        txEvaluator: evaluator,
      })
      .build();

    expect(writtenSubTransactions(tx).map(subTx => subTx.toCbor())).toEqual([
      signed.cbor,
    ]);
    const { fee, totalCollateral } = tx.toCore().body;
    const signedSize = estimateSignedTxSize(tx, [scriptUtxo, collateral]);
    const scriptFee = BigInt(
      Math.ceil(
        protocolParameters.prices.memory * 100 +
          protocolParameters.prices.steps * 100_000,
      ),
    );
    expect(fee).toBe(
      BigInt(protocolParameters.minFeeConstant) +
        BigInt(protocolParameters.minFeeCoefficient) * BigInt(signedSize - 1) +
        scriptFee,
    );
    expect(totalCollateral).toBe(
      (fee * BigInt(protocolParameters.collateralPercentage) + 99n) / 100n,
    );
  });

  describe('as a batcher', () => {
    const partyAddr =
      'addr_test1vz3ppzmmzuz0nlsjeyrqjm4pvdxl3cyfe8x06eg6htj2gwgv02qjt' as Cardano.PaymentAddress;
    const batcherGuard: Cardano.Credential = {
      type: Cardano.CredentialType.KeyHash,
      hash: Cardano.Address.fromBech32(changeAddr)
        .asBase()!
        .getPaymentCredential().hash,
    };

    const partyUtxo = (byte: string, coins: bigint): Cardano.Utxo => [
      { ...txIn(byte.repeat(32), 0), address: partyAddr },
      { address: partyAddr, value: { coins } },
    ];

    /** A sub transaction that spends `spent` and pays `kept` back to the party. */
    const intentOf = (
      spent: Cardano.Utxo[],
      kept: bigint,
      body: Partial<Cardano.SubTransactionBody> = {},
    ) =>
      Serialization.SubTransaction.fromCore({
        body: {
          inputs: spent.map(([{ txId, index }]) => ({ txId, index })),
          outputs: [{ address: partyAddr, value: { coins: kept } }],
          ...body,
        },
        witness: { signatures: new Map() },
      });

    const batcher = () =>
      new TransactionBuilder(Cardano.NetworkMagics.Preprod, protocolParameters)
        .setChangeAddress(changeAddr)
        .setUnspentOutputs([fundingUtxo])
        .useCoinSelector(new LargeFirstCoinSelector());

    const changeOf = (tx: Serialization.Transaction) =>
      sumCoins(
        tx
          .toCore()
          .body.outputs.filter(output => output.address === changeAddr),
      );

    it('returns what a sub transaction leaves to the batch as change', async () => {
      const spent = partyUtxo('c1', 10_000_000n);
      const intent = intentOf([spent], 7_000_000n);

      const tx = await batcher()
        .addSubTransaction(intent, [spent])
        .transferValue(recipientAddr, { coins: 2_000_000n })
        .build();

      const { body } = tx.toCore();
      expect(body.inputs).toEqual([txIn('txid700', 0)]);
      expect(changeOf(tx)).toBe(
        20_000_000n + 3_000_000n - 2_000_000n - body.fee,
      );
      expect(
        isTransactionBalanced({
          transaction: tx.toCore(),
          resolvedInputs: [fundingUtxo, spent],
          protocolParameters,
          subTransactions: [intent],
        }),
      ).toBe(true);
    });

    it('funds what a sub transaction takes from the batch', async () => {
      const spent = partyUtxo('c1', 5_000_000n);
      const intent = intentOf([spent], 8_000_000n);

      const tx = await batcher().addSubTransaction(intent, [spent]).build();

      const { body } = tx.toCore();
      expect(changeOf(tx)).toBe(20_000_000n - 3_000_000n - body.fee);
      expect(
        isTransactionBalanced({
          transaction: tx.toCore(),
          resolvedInputs: [fundingUtxo, spent],
          protocolParameters,
          subTransactions: [intent],
        }),
      ).toBe(true);
    });

    it('charges the pool deposit once for a pool the transaction and a sub transaction register', async () => {
      const spent = partyUtxo('c1', 10_000_000n);
      const intent = intentOf([spent], 10_000_000n - poolDeposit, {
        certificates: [poolRegistrationOf(registeredPoolId)],
      });

      const tx = await batcher()
        .addSubTransaction(intent, [spent])
        .addCertificate(poolRegistrationOf(registeredPoolId))
        .build();

      expect(changeOf(tx)).toBe(20_000_000n - tx.toCore().body.fee);
      expect(
        isTransactionBalanced({
          transaction: tx.toCore(),
          resolvedInputs: [fundingUtxo, spent],
          protocolParameters,
          subTransactions: [intent],
        }),
      ).toBe(true);
    });

    it('charges the pool deposit once for a pool several sub transactions register', async () => {
      const first = partyUtxo('c1', 10_000_000n);
      const second = partyUtxo('c2', 10_000_000n);
      const certificates = [poolRegistrationOf(registeredPoolId)];
      const intents = [
        intentOf([first], 10_000_000n - poolDeposit, { certificates }),
        intentOf([second], 10_000_000n, { certificates }),
      ];

      const tx = await batcher()
        .addSubTransaction(intents[0], [first])
        .addSubTransaction(intents[1], [second])
        .build();

      expect(changeOf(tx)).toBe(20_000_000n - tx.toCore().body.fee);
      expect(
        isTransactionBalanced({
          transaction: tx.toCore(),
          resolvedInputs: [fundingUtxo, first, second],
          protocolParameters,
          subTransactions: intents,
        }),
      ).toBe(true);
    });

    it('charges no pool deposit for a pool registered on chain that the transaction and its sub transactions update', async () => {
      const first = partyUtxo('c1', 10_000_000n);
      const second = partyUtxo('c2', 10_000_000n);
      const certificates = [poolRegistrationOf(registeredPoolId)];
      const intents = [
        intentOf([first], 10_000_000n, { certificates }),
        intentOf([second], 10_000_000n, { certificates }),
      ];

      const tx = await batcher()
        .setRegisteredPools([registeredPoolId])
        .addSubTransaction(intents[0], [first])
        .addSubTransaction(intents[1], [second])
        .addCertificate(poolRegistrationOf(registeredPoolId))
        .build();

      expect(changeOf(tx)).toBe(20_000_000n - tx.toCore().body.fee);
      expect(
        isTransactionBalanced({
          transaction: tx.toCore(),
          resolvedInputs: [fundingUtxo, first, second],
          protocolParameters,
          subTransactions: intents,
          registeredPools: new Set([registeredPoolId]),
        }),
      ).toBe(true);
    });

    it('still charges a new pool the pool deposit once across the batch beside a registered one', async () => {
      const first = partyUtxo('c1', 10_000_000n);
      const second = partyUtxo('c2', 10_000_000n);
      const newPoolId = Cardano.PoolId(
        'pool1ev8vy6fyj7693ergzty2t0azjvw35tvkt2vcjwpgajqs7z6u2vn',
      );
      const certificates = [
        poolRegistrationOf(registeredPoolId),
        poolRegistrationOf(newPoolId),
      ];
      const intents = [
        intentOf([first], 10_000_000n - poolDeposit, { certificates }),
        intentOf([second], 10_000_000n, { certificates }),
      ];

      const tx = await batcher()
        .setRegisteredPools([registeredPoolId])
        .addSubTransaction(intents[0], [first])
        .addSubTransaction(intents[1], [second])
        .addCertificate(poolRegistrationOf(newPoolId))
        .build();

      expect(changeOf(tx)).toBe(20_000_000n - tx.toCore().body.fee);
    });

    it('never selects a UTxO a sub transaction spends or references, nor posts it as collateral', async () => {
      const spent = partyUtxo('c1', 90_000_000n);
      const referenced = partyUtxo('c2', 80_000_000n);
      const intent = intentOf([spent], 90_000_000n, {
        referenceInputs: [referenced[0]],
      });
      const script = {
        __type: Cardano.ScriptType.Plutus,
        version: Cardano.PlutusLanguageVersion.V3,
        bytes: 'deadbeef',
      } as unknown as Cardano.Script;
      const scriptAddr = Cardano.EnterpriseAddress.fromCredentials(
        Cardano.NetworkId.Testnet,
        {
          type: Cardano.CredentialType.ScriptHash,
          hash: Serialization.Script.fromCore(script).hash(),
        },
      )
        .toAddress()
        .toBech32() as Cardano.PaymentAddress;
      const scriptUtxo = mkUtxo(703, 0, 3_000_000n, scriptAddr);
      const collateral = mkUtxo(702, 0, 10_000_000n, changeAddr);
      const evaluate = vi.fn<TxEvaluator['evaluate']>(async tx =>
        (tx.witness.redeemers ?? []).map(({ purpose, index }) => ({
          purpose,
          index,
          budget: { memory: 100, steps: 100_000 },
        })),
      );

      const tx = await batcher()
        .setUnspentOutputs([spent, referenced, fundingUtxo])
        .addSubTransaction(intent, [spent, referenced])
        .addInput(scriptUtxo, {
          redeemer: Serialization.PlutusData.fromCbor(
            HexBlob('d87980'),
          ).toCore(),
        })
        .attachScript(script)
        .transferValue(recipientAddr, { coins: 5_000_000n })
        .setCollateralUtxos([referenced, spent, collateral])
        .setCollateralChangeAddress(changeAddr)
        .setPlutusContext({
          costModels: new Map([
            [
              Cardano.PlutusLanguageVersion.V3,
              Array.from({ length: 251 }, () => 0),
            ],
          ]),
          txEvaluator: { evaluate },
        })
        .build();

      const { body } = tx.toCore();
      expect(body.inputs.map(({ txId }) => txId).sort()).toEqual(
        [scriptUtxo[0].txId, fundingUtxo[0].txId].sort(),
      );
      expect(body.collaterals).toEqual([txIn('txid702', 0)]);
      const [[, resolvedInputs]] = evaluate.mock.calls;
      expect(resolvedInputs).toEqual(
        expect.arrayContaining([spent, referenced]),
      );
    });

    it('refuses a sub transaction already in the batch', async () => {
      const spent = partyUtxo('c1', 5_000_000n);
      const intent = intentOf([spent], 5_000_000n);
      const builder = batcher().addSubTransaction(intent, [spent]);

      expect(() =>
        builder.addSubTransaction(
          Serialization.SubTransaction.fromCbor(intent.toCbor()),
          [spent],
        ),
      ).toThrow(
        `Sub transaction ${intent.getId()} is already part of the batch`,
      );
    });

    it('refuses a sub transaction that spends an input another sub transaction spends', () => {
      const spent = partyUtxo('c1', 5_000_000n);
      const builder = batcher().addSubTransaction(
        intentOf([spent], 5_000_000n),
        [spent],
      );

      expect(() =>
        builder.addSubTransaction(intentOf([spent], 4_000_000n), [spent]),
      ).toThrow('spends an input another sub transaction spends');
    });

    it('refuses a sub transaction that spends an input the transaction spends, and an input a sub transaction spends', () => {
      const spent = partyUtxo('c1', 5_000_000n);
      const intent = intentOf([spent], 5_000_000n);

      expect(() =>
        batcher().addInput(spent).addSubTransaction(intent, [spent]),
      ).toThrow('spends an input the transaction spends');
      expect(() =>
        batcher().addSubTransaction(intent, [spent]).addInput(spent),
      ).toThrow('Cannot spend an input a sub transaction spends');
    });

    it('refuses a sub transaction whose spent input the resolved UTxOs do not resolve', () => {
      const spent = partyUtxo('c1', 5_000_000n);

      expect(() =>
        batcher().addSubTransaction(intentOf([spent], 5_000_000n), []),
      ).toThrow('spends an input the resolved UTxOs do not resolve');
    });

    it('refuses a sub transaction whose reference input the resolved UTxOs do not resolve', () => {
      const spent = partyUtxo('c1', 5_000_000n);
      const referenced = partyUtxo('c2', 5_000_000n);

      expect(() =>
        batcher().addSubTransaction(
          intentOf([spent], 5_000_000n, {
            referenceInputs: [txIn(referenced[0].txId, referenced[0].index)],
          }),
          [spent],
        ),
      ).toThrow('references an input the resolved UTxOs do not resolve');
    });

    it('refuses a batch without a top level guard a sub transaction requires, and never adds it', async () => {
      const spent = partyUtxo('c1', 5_000_000n);
      const intent = intentOf([spent], 5_000_000n, {
        requiredTopLevelGuards: [{ credential: batcherGuard, datum: null }],
      });

      await expect(
        batcher().addSubTransaction(intent, [spent]).build(),
      ).rejects.toThrow(MissingTopLevelGuardError);

      const tx = await batcher()
        .addSubTransaction(intent, [spent])
        .addGuard(batcherGuard)
        .build();
      expect(tx.toCore().body.requiredExtraSignatures).toEqual([
        batcherGuard.hash,
      ]);
    });

    describe('with required top level guard datums', () => {
      const guardDatum = Serialization.PlutusData.fromCbor(
        HexBlob('182a'),
      ).toCore();
      const nativeGuardScript: Cardano.Script = {
        __type: Cardano.ScriptType.Native,
        kind: Cardano.NativeScriptKind.RequireTimeBefore,
        slot: Cardano.Slot(90_000_000),
      };
      const nativeGuard: Cardano.Credential = {
        type: Cardano.CredentialType.ScriptHash,
        hash: Serialization.Script.fromCore(nativeGuardScript).hash(),
      };
      const v4GuardScript = {
        __type: Cardano.ScriptType.Plutus,
        version: Cardano.PlutusLanguageVersion.V4,
        bytes: '46450101002496',
      } as unknown as Cardano.Script;
      const v4Guard: Cardano.Credential = {
        type: Cardano.CredentialType.ScriptHash,
        hash: Serialization.Script.fromCore(v4GuardScript).hash(),
      };
      const spent = partyUtxo('c1', 5_000_000n);
      const requiring = (
        guard: Cardano.Credential,
        datum: Cardano.PlutusData | null,
      ) =>
        intentOf([spent], 5_000_000n, {
          requiredTopLevelGuards: [{ credential: guard, datum }],
        });

      it('refuses a sub transaction that requires a key hash guard with a datum', async () => {
        const intent = requiring(batcherGuard, guardDatum);

        await expect(
          batcher()
            .addSubTransaction(intent, [spent])
            .addGuard(batcherGuard)
            .build(),
        ).rejects.toThrow(
          new MalformedGuardDatumError(batcherGuard, undefined, intent.getId()),
        );
      });

      it('refuses a sub transaction that requires a native script guard with a datum once the batch provides the script', async () => {
        const intent = requiring(nativeGuard, guardDatum);

        const tx = await batcher()
          .addSubTransaction(intent, [spent])
          .addGuard(nativeGuard)
          .build();
        expect(tx.toCore().body.guards).toEqual([nativeGuard]);

        await expect(
          batcher()
            .attachScript(nativeGuardScript)
            .addSubTransaction(intent, [spent])
            .addGuard(nativeGuard)
            .build(),
        ).rejects.toThrow(
          new MalformedGuardDatumError(
            nativeGuard,
            nativeGuardScript,
            intent.getId(),
          ),
        );
      });

      it('refuses a sub transaction that requires a Plutus script guard without a datum when the batch provides the script', async () => {
        const intent = requiring(v4Guard, null);

        await expect(
          batcher()
            .attachScript(v4GuardScript)
            .addSubTransaction(intent, [spent])
            .addGuard(v4Guard, { redeemer: guardDatum })
            .build(),
        ).rejects.toThrow(
          new MalformedGuardDatumError(v4Guard, v4GuardScript, intent.getId()),
        );
      });
    });

    describe('with scripts', () => {
      const unit = Serialization.PlutusData.fromCbor(
        HexBlob('d87980'),
      ).toCore();
      const subTransactionUnits: Cardano.ExUnits = {
        memory: 4_000_000,
        steps: 3_000_000_000,
      };
      const evaluatedUnits: Cardano.ExUnits = { memory: 100, steps: 100_000 };
      const perTransactionMaximum: Cardano.ExUnits = {
        memory: 14_000_000,
        steps: 10_000_000_000,
      };

      const plutusScript = (
        version: Cardano.PlutusLanguageVersion,
      ): Cardano.Script =>
        ({
          __type: Cardano.ScriptType.Plutus,
          version,
          bytes: `deadbeef0${version}`,
        } as unknown as Cardano.Script);

      const scriptUtxoOf = (
        script: Cardano.Script,
        datumHash?: Cardano.DatumHash,
      ): Cardano.Utxo => {
        const address = Cardano.EnterpriseAddress.fromCredentials(
          Cardano.NetworkId.Testnet,
          {
            type: Cardano.CredentialType.ScriptHash,
            hash: Serialization.Script.fromCore(script).hash(),
          },
        )
          .toAddress()
          .toBech32() as Cardano.PaymentAddress;
        const [reference, output] = mkUtxo(703, 0, 3_000_000n, address);
        return [reference, { ...output, ...(datumHash && { datumHash }) }];
      };

      /** A sub transaction like {@link intentOf} that runs a script with `subTransactionUnits`. */
      const redeemingIntentOf = (
        spent: Cardano.Utxo[],
        kept: bigint,
        body: Partial<Cardano.SubTransactionBody> = {},
      ) =>
        Serialization.SubTransaction.fromCore({
          body: {
            inputs: spent.map(([{ txId, index }]) => ({ txId, index })),
            outputs: [{ address: partyAddr, value: { coins: kept } }],
            ...body,
          },
          witness: {
            signatures: new Map(),
            redeemers: [
              {
                purpose: Cardano.RedeemerPurpose.spend,
                index: 0,
                data: unit,
                executionUnits: subTransactionUnits,
              },
            ],
          },
        });

      const evaluatorOf = () =>
        vi.fn<TxEvaluator['evaluate']>(async tx =>
          (tx.witness.redeemers ?? []).map(({ purpose, index }) => ({
            purpose,
            index,
            budget: evaluatedUnits,
          })),
        );

      /**
       * A batcher that spends `scriptUtxo` with a redeemer through `script`,
       * pays 5 ADA and posts collateral from `collateral`.
       */
      const scriptBatcher = ({
        script,
        scriptUtxo,
        collateral,
        evaluate = evaluatorOf(),
        executionUnitsEstimate,
        datum,
      }: {
        script: Cardano.Script;
        scriptUtxo: Cardano.Utxo;
        collateral: Cardano.Utxo;
        evaluate?: TxEvaluator['evaluate'];
        executionUnitsEstimate?: Cardano.ExUnits;
        datum?: Cardano.PlutusData;
      }) =>
        batcher()
          .addInput(scriptUtxo, { redeemer: unit, datum })
          .attachScript(script)
          .transferValue(recipientAddr, { coins: 5_000_000n })
          .setCollateralUtxos([collateral])
          .setCollateralChangeAddress(changeAddr)
          .setPlutusContext({
            costModels: new Map([
              [
                Cardano.PlutusLanguageVersion.V3,
                Array.from({ length: 251 }, () => 0),
              ],
              [
                Cardano.PlutusLanguageVersion.V4,
                Array.from({ length: 251 }, () => 0),
              ],
            ]),
            txEvaluator: { evaluate },
            executionUnitsEstimate,
          });

      /**
       * The collateral a transaction posts for `fee`, rounded up as the
       * ledger requires.
       */
      const collateralFor = (fee: bigint) =>
        (fee * BigInt(protocolParameters.collateralPercentage) + 99n) / 100n;

      /** The largest fee a transaction of the maximum size could need. */
      const maximumFee = (units: Cardano.ExUnits, referenceFee = 0n) =>
        BigInt(protocolParameters.minFeeConstant) +
        BigInt(protocolParameters.minFeeCoefficient) *
          BigInt(protocolParameters.maxTxSize) +
        executionUnitsFee(units, protocolParameters.prices) +
        referenceFee;

      it('posts collateral for the redeemers of a sub transaction, with no Plutus context and no evaluation', async () => {
        const spent = partyUtxo('c1', 5_000_000n);
        const intent = redeemingIntentOf([spent], 5_000_000n);
        const collateral = mkUtxo(702, 0, 10_000_000n, changeAddr);

        const tx = await batcher()
          .addSubTransaction(intent, [spent])
          .setCollateralUtxos([collateral])
          .setCollateralChangeAddress(changeAddr)
          .build();

        const { body, witness } = tx.toCore();
        expect(body.collaterals).toEqual([txIn('txid702', 0)]);
        expect(body.totalCollateral).toBe(collateralFor(body.fee));
        expect(body.scriptIntegrityHash).toBeUndefined();
        expect(witness.redeemers).toBeUndefined();
        const signedSize = estimateSignedTxSize(tx, [fundingUtxo, collateral]);
        expect(body.fee).toBe(
          BigInt(protocolParameters.minFeeConstant) +
            BigInt(protocolParameters.minFeeCoefficient) *
              BigInt(signedSize - 1) +
            executionUnitsFee(subTransactionUnits, protocolParameters.prices),
        );
      });

      it('hashes the datums of a transaction whose only redeemers are those of its sub transactions', async () => {
        const spent = partyUtxo('c1', 5_000_000n);
        const intent = redeemingIntentOf([spent], 5_000_000n);
        const collateral = mkUtxo(702, 0, 10_000_000n, changeAddr);
        const datum = Serialization.PlutusData.fromCbor(
          HexBlob('182a'),
        ).toCore();

        const tx = await batcher()
          .addSubTransaction(intent, [spent])
          .addDatum(datum)
          .setCollateralUtxos([collateral])
          .setCollateralChangeAddress(changeAddr)
          .build();

        const { body, witness } = tx.toCore();
        expect(witness.datums).toEqual([datum]);
        expect(witness.redeemers).toBeUndefined();
        expect(body.scriptIntegrityHash).toBe(
          computeConwayScriptDataHash({
            costModels: new Map(),
            usedLanguages: [],
            redeemers: [],
            datums: [datum],
          }),
        );
        const signedSize = estimateSignedTxSize(tx, [fundingUtxo, collateral]);
        expect(body.fee).toBe(
          BigInt(protocolParameters.minFeeConstant) +
            BigInt(protocolParameters.minFeeCoefficient) *
              BigInt(signedSize - 1) +
            executionUnitsFee(subTransactionUnits, protocolParameters.prices),
        );
      });

      it('evaluates the redeemers of the transaction with its sub transactions as written', async () => {
        const signed = await subTransactionOf('e1', 3_000_000n);
        const spent = spentBy('e1', 3_000_000n);
        const script = plutusScript(Cardano.PlutusLanguageVersion.V4);
        const evaluate = evaluatorOf();

        await scriptBatcher({
          script,
          scriptUtxo: scriptUtxoOf(script),
          collateral: mkUtxo(702, 0, 10_000_000n, changeAddr),
          evaluate,
        })
          .addSubTransaction(
            Serialization.SubTransaction.fromCbor(signed.cbor),
            [spent],
          )
          .build();

        const [[evaluated, resolvedInputs, serializedTx]] = evaluate.mock.calls;
        const [subTransaction] =
          serializedTx?.body().subTransactions()?.values() ?? [];
        expect(subTransaction.toCbor()).toBe(signed.cbor);
        expect(subTransaction.getId()).toBe(signed.id);
        expect(serializedTx?.witnessSet().redeemers()?.toCore()).toEqual(
          evaluated.witness.redeemers,
        );
        expect(evaluated.body.subTransactions).toBeUndefined();
        expect(resolvedInputs).toEqual(expect.arrayContaining([spent]));
      });

      it('never evaluates a transaction whose only redeemers are those of its sub transactions', async () => {
        const spent = partyUtxo('c1', 5_000_000n);
        const evaluate = evaluatorOf();

        const tx = await batcher()
          .addSubTransaction(redeemingIntentOf([spent], 5_000_000n), [spent])
          .setCollateralUtxos([mkUtxo(702, 0, 10_000_000n, changeAddr)])
          .setCollateralChangeAddress(changeAddr)
          .setPlutusContext({
            costModels: new Map(),
            txEvaluator: { evaluate },
          })
          .build();

        expect(evaluate).not.toHaveBeenCalled();
        expect(tx.toCore().body.collaterals).toEqual([txIn('txid702', 0)]);
      });

      it('reserves collateral for the units of the sub transactions alone when only they carry redeemers', async () => {
        const spent = partyUtxo('c1', 5_000_000n);
        const coverage =
          collateralFor(maximumFee(subTransactionUnits)) + 1_200_000n;
        expect(coverage).toBeLessThan(
          collateralFor(maximumFee(perTransactionMaximum)),
        );

        const tx = await batcher()
          .addSubTransaction(redeemingIntentOf([spent], 5_000_000n), [spent])
          .setCollateralUtxos([mkUtxo(702, 0, coverage, changeAddr)])
          .setCollateralChangeAddress(changeAddr)
          .build();

        const { body } = tx.toCore();
        expect(body.collaterals).toEqual([txIn('txid702', 0)]);
        expect(body.totalCollateral).toBeGreaterThanOrEqual(
          collateralFor(body.fee),
        );
      });

      it('refuses redeemers at any level without collateral UTxOs or a collateral change address', async () => {
        const spent = partyUtxo('c1', 5_000_000n);
        const collateral = mkUtxo(702, 0, 10_000_000n, changeAddr);
        const subTransactionOnly = batcher().addSubTransaction(
          redeemingIntentOf([spent], 5_000_000n),
          [spent],
        );
        const script = plutusScript(Cardano.PlutusLanguageVersion.V4);
        const topLevel = scriptBatcher({
          script,
          scriptUtxo: scriptUtxoOf(script),
          collateral,
        }).setCollateralUtxos([]);

        await expect(subTransactionOnly.build()).rejects.toThrow(
          MissingCollateralError,
        );
        await expect(
          subTransactionOnly.setCollateralUtxos([collateral]).build(),
        ).rejects.toThrow(MissingCollateralError);
        await expect(topLevel.build()).rejects.toThrow(MissingCollateralError);
      });

      it('refuses sub transaction redeemers without collateral when the transaction attaches a Plutus script but carries no redeemers', async () => {
        const spent = partyUtxo('c1', 5_000_000n);

        await expect(
          batcher()
            .addSubTransaction(redeemingIntentOf([spent], 5_000_000n), [spent])
            .attachScript(plutusScript(Cardano.PlutusLanguageVersion.V4))
            .setPlutusContext({
              costModels: new Map(),
              txEvaluator: { evaluate: evaluatorOf() },
            })
            .build(),
        ).rejects.toThrow(MissingCollateralError);
      });

      it('reserves collateral for the per-transaction maximum, which the units of the sub transactions count against', async () => {
        const spent = partyUtxo('c1', 5_000_000n);
        const intent = redeemingIntentOf([spent], 5_000_000n);
        const script = plutusScript(Cardano.PlutusLanguageVersion.V4);
        const coverage = collateralFor(maximumFee(perTransactionMaximum));
        const build = async (coins: bigint) =>
          scriptBatcher({
            script,
            scriptUtxo: scriptUtxoOf(script),
            collateral: mkUtxo(702, 0, coins, changeAddr),
          })
            .addSubTransaction(intent, [spent])
            .build();

        const tx = await build(coverage);

        expect(tx.toCore().body.collaterals).toEqual([txIn('txid702', 0)]);
        await expect(build(coverage - 1n)).rejects.toThrow(
          InsufficientCollateralError,
        );
      });

      it('reserves collateral for the estimate plus the units and reference scripts of the sub transactions', async () => {
        const holder = partyUtxo('c2', 20_000_000n);
        const referenced: Cardano.Utxo = [
          holder[0],
          {
            ...holder[1],
            scriptReference: {
              __type: Cardano.ScriptType.Plutus,
              version: Cardano.PlutusLanguageVersion.V4,
              bytes: 'aa'.repeat(1000),
            } as unknown as Cardano.Script,
          },
        ];
        const spent = partyUtxo('c1', 5_000_000n);
        const intent = redeemingIntentOf([spent], 5_000_000n, {
          referenceInputs: [referenced[0]],
        });
        const script = plutusScript(Cardano.PlutusLanguageVersion.V4);
        const estimate: Cardano.ExUnits = { memory: 200, steps: 200_000 };
        const coverage = collateralFor(
          maximumFee(
            {
              memory: estimate.memory + subTransactionUnits.memory,
              steps: estimate.steps + subTransactionUnits.steps,
            },
            referenceScriptFee(1000, protocolParameters),
          ),
        );
        const build = async (coins: bigint) =>
          scriptBatcher({
            script,
            scriptUtxo: scriptUtxoOf(script),
            collateral: mkUtxo(702, 0, coins, changeAddr),
            executionUnitsEstimate: estimate,
          })
            .addSubTransaction(intent, [spent, referenced])
            .build();

        const tx = await build(coverage + 2_000_000n);

        expect(tx.toCore().body.collaterals).toEqual([txIn('txid702', 0)]);
        await expect(build(coverage - 1n)).rejects.toThrow(
          InsufficientCollateralError,
        );
      });

      it('refuses a batch whose sub transactions do not balance between themselves when the transaction runs a PlutusV3 script', async () => {
        const spent = partyUtxo('c1', 10_000_000n);
        const script = plutusScript(Cardano.PlutusLanguageVersion.V3);
        const build = async (kept: bigint) =>
          scriptBatcher({
            script,
            scriptUtxo: scriptUtxoOf(script),
            collateral: mkUtxo(702, 0, 10_000_000n, changeAddr),
          })
            .addSubTransaction(intentOf([spent], kept), [spent])
            .build();

        await expect(build(7_000_000n)).rejects.toThrow(
          UnbalancedSubTransactionsError,
        );
        await expect(build(10_000_000n)).resolves.toBeDefined();
      });

      it('charges the transaction no pool deposit for a pool a sub transaction registers when it runs a PlutusV3 script', async () => {
        const spent = partyUtxo('c1', 10_000_000n);
        const script = plutusScript(Cardano.PlutusLanguageVersion.V3);

        const tx = await scriptBatcher({
          script,
          scriptUtxo: scriptUtxoOf(script),
          collateral: mkUtxo(702, 0, 10_000_000n, changeAddr),
        })
          .addSubTransaction(
            intentOf([spent], 10_000_000n - poolDeposit, {
              certificates: [poolRegistrationOf(registeredPoolId)],
            }),
            [spent],
          )
          .addCertificate(poolRegistrationOf(registeredPoolId))
          .build();

        expect(changeOf(tx)).toBe(
          20_000_000n + 3_000_000n - 5_000_000n - tx.toCore().body.fee,
        );
      });

      it('balances sub transactions that register the same pool between themselves when the transaction runs a PlutusV3 script', async () => {
        const first = partyUtxo('c1', 10_000_000n);
        const second = partyUtxo('c2', 10_000_000n);
        const certificates = [poolRegistrationOf(registeredPoolId)];
        const script = plutusScript(Cardano.PlutusLanguageVersion.V3);

        const tx = await scriptBatcher({
          script,
          scriptUtxo: scriptUtxoOf(script),
          collateral: mkUtxo(702, 0, 10_000_000n, changeAddr),
        })
          .addSubTransaction(
            intentOf([first], 10_000_000n - poolDeposit, { certificates }),
            [first],
          )
          .addSubTransaction(
            intentOf([second], 10_000_000n, { certificates }),
            [second],
          )
          .build();

        expect(changeOf(tx)).toBe(
          20_000_000n + 3_000_000n - 5_000_000n - tx.toCore().body.fee,
        );
      });

      it('lets the transaction balance its sub transactions when it runs a PlutusV4 script', async () => {
        const spent = partyUtxo('c1', 10_000_000n);
        const intent = intentOf([spent], 7_000_000n);
        const script = plutusScript(Cardano.PlutusLanguageVersion.V4);

        const tx = await scriptBatcher({
          script,
          scriptUtxo: scriptUtxoOf(script),
          collateral: mkUtxo(702, 0, 10_000_000n, changeAddr),
        })
          .addSubTransaction(intent, [spent])
          .build();

        expect(changeOf(tx)).toBe(
          20_000_000n +
            3_000_000n +
            3_000_000n -
            5_000_000n -
            tx.toCore().body.fee,
        );
      });

      it('refuses a datum only a sub transaction allows when the transaction runs a PlutusV3 script', async () => {
        const datum = Serialization.PlutusData.fromCbor(HexBlob('182a'));
        const spent = partyUtxo('c1', 5_000_000n);
        const intent = Serialization.SubTransaction.fromCore({
          body: {
            inputs: [spent[0]].map(({ txId, index }) => ({ txId, index })),
            outputs: [
              {
                address: partyAddr,
                value: { coins: 5_000_000n },
                datumHash: datum.hash(),
              },
            ],
          },
          witness: { signatures: new Map() },
        });
        const script = plutusScript(Cardano.PlutusLanguageVersion.V3);
        const build = async (scriptUtxo: Cardano.Utxo) =>
          scriptBatcher({
            script,
            scriptUtxo,
            collateral: mkUtxo(702, 0, 10_000_000n, changeAddr),
            datum: datum.toCore(),
          })
            .addSubTransaction(intent, [spent])
            .build();

        await expect(build(scriptUtxoOf(script))).rejects.toThrow(
          NotAllowedSupplementalDatumError,
        );
        await expect(
          build(scriptUtxoOf(script, datum.hash())),
        ).resolves.toBeDefined();
      });
    });
  });
});

describe('TransactionBuilder native script mints, donations and supplemental datums', () => {
  const changeAddr =
    'addr_test1qpfhhfy2qgls50r9u4yh0l7z67xpg0a5rrhkmvzcuqrd0znuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q9gw0lz' as Cardano.PaymentAddress;
  const recipientAddr =
    'addr_test1qpuzeec0zqcm6lrdygkkvvd8e6qactnsl5zzeujsdpkpc939l2f2vykk0ctwq4ys6w3jg8pm0kknmy8m5pml8f9cauzq2zuc95' as Cardano.PaymentAddress;
  const policyKeyHash = '77'.repeat(28) as Crypto.Ed25519KeyHashHex;
  const nativePolicy: Cardano.NativeScript = {
    __type: Cardano.ScriptType.Native,
    kind: Cardano.NativeScriptKind.RequireAllOf,
    scripts: [
      {
        __type: Cardano.ScriptType.Native,
        kind: Cardano.NativeScriptKind.RequireSignature,
        keyHash: policyKeyHash,
      },
    ],
  };
  const nativeAsset = Cardano.AssetId(
    `${Serialization.Script.fromCore(nativePolicy).hash()}4e41`,
  );
  const plutusPolicy = {
    __type: Cardano.ScriptType.Plutus,
    version: Cardano.PlutusLanguageVersion.V3,
    bytes: 'deadbeef',
  } as unknown as Cardano.Script;
  const plutusPolicyHash = Serialization.Script.fromCore(plutusPolicy).hash();
  const plutusAsset = Cardano.AssetId(`${plutusPolicyHash}4e41`);
  const plutusAddr = Cardano.EnterpriseAddress.fromCredentials(
    Cardano.NetworkId.Testnet,
    { type: Cardano.CredentialType.ScriptHash, hash: plutusPolicyHash },
  )
    .toAddress()
    .toBech32() as Cardano.PaymentAddress;
  const unitRedeemer = Serialization.PlutusData.fromCbor(
    HexBlob('d87980'),
  ).toCore();
  const datum = Serialization.PlutusData.fromCbor(HexBlob('182a')).toCore();
  const datumHash = Serialization.PlutusData.fromCore(datum).hash();
  const costModels: Cardano.CostModels = new Map([
    [Cardano.PlutusLanguageVersion.V3, Array.from({ length: 251 }, () => 0)],
  ]);
  const budget: Cardano.ExUnits = { memory: 100, steps: 100_000 };
  const maxDonation = 18_446_744_073_709_551_615n;

  const fundingUtxo = mkUtxo(800, 0, 20_000_000n, changeAddr);
  const collateralUtxo = mkUtxo(801, 0, 10_000_000n, changeAddr);

  const paymentBuilder = (utxos: Cardano.Utxo[] = [fundingUtxo]) =>
    new TransactionBuilder(Cardano.NetworkMagics.Preprod, protocolParameters)
      .setChangeAddress(changeAddr)
      .setUnspentOutputs(utxos)
      .useCoinSelector(new LargeFirstCoinSelector())
      .transferValue(recipientAddr, { coins: 2_000_000n });

  const plutusBuilder = () =>
    paymentBuilder()
      .setCollateralUtxos([collateralUtxo])
      .setCollateralChangeAddress(changeAddr)
      .setPlutusContext({
        costModels,
        txEvaluator: {
          evaluate: async tx =>
            (tx.witness.redeemers ?? []).map(({ purpose, index }) => ({
              purpose,
              index,
              budget,
            })),
        },
      });

  const writtenTx = (tx: Serialization.Transaction): Cardano.Tx =>
    Serialization.Transaction.fromCbor(tx.toCbor()).toCore();

  describe('native script mints', () => {
    it('mints under a native policy with no redeemer, Plutus context or collateral', async () => {
      const tx = await paymentBuilder()
        .attachScript(nativePolicy)
        .mintAssets(new Map([[nativeAsset, 5n]]))
        .build();

      const { body, witness } = writtenTx(tx);
      expect(body.mint).toEqual(new Map([[nativeAsset, 5n]]));
      expect(witness.scripts).toEqual([nativePolicy]);
      expect(witness.redeemers).toBeUndefined();
      expect(body.scriptIntegrityHash).toBeUndefined();
      expect(body.collaterals).toBeUndefined();
      expect(
        body.outputs.find(({ address }) => address === changeAddr)?.value
          .assets,
      ).toEqual(new Map([[nativeAsset, 5n]]));
    });

    it('burns under a native policy with no redeemer', async () => {
      const holding: Cardano.Utxo = [
        fundingUtxo[0],
        {
          address: changeAddr,
          value: { coins: 20_000_000n, assets: new Map([[nativeAsset, 2n]]) },
        },
      ];

      const tx = await paymentBuilder([holding])
        .attachScript(nativePolicy)
        .mintAssets(new Map([[nativeAsset, -2n]]))
        .build();

      const { body, witness } = writtenTx(tx);
      expect(body.mint).toEqual(new Map([[nativeAsset, -2n]]));
      expect(witness.redeemers).toBeUndefined();
      expect(body.outputs.some(({ value }) => value.assets?.size)).toBe(false);
    });

    it('mints under a native policy a reference input carries, with no redeemer or Plutus context', async () => {
      const referenceUtxo: Cardano.Utxo = [
        { ...txIn('a8'.repeat(32), 0), address: changeAddr },
        {
          address: changeAddr,
          value: { coins: 5_000_000n },
          scriptReference: nativePolicy,
        },
      ];

      const tx = await paymentBuilder()
        .addReferenceInput(referenceUtxo)
        .mintAssets(new Map([[nativeAsset, 1n]]))
        .build();

      const { body, witness } = writtenTx(tx);
      expect(body.mint).toEqual(new Map([[nativeAsset, 1n]]));
      expect(body.referenceInputs).toEqual([txIn('a8'.repeat(32), 0)]);
      expect(witness.scripts).toBeUndefined();
      expect(witness.redeemers).toBeUndefined();
      expect(body.scriptIntegrityHash).toBeUndefined();
    });

    it('counts the key hashes of the native policy as signers and prices their signatures', async () => {
      const tx = await paymentBuilder()
        .attachScript(nativePolicy)
        .mintAssets(new Map([[nativeAsset, 1n]]))
        .build();

      expect(
        getUniqueSignerKeyHashes(tx.toCore(), [fundingUtxo]).has(policyKeyHash),
      ).toBe(true);
      const { requiredFee, signerCount } = measureSignedMinFee(tx, [
        fundingUtxo,
      ]);
      expect(signerCount).toBe(2);
      expect(requiredFee - tx.toCore().body.fee).toBe(
        BigInt(protocolParameters.minFeeCoefficient),
      );
    });

    it('still records the redeemer of a Plutus mint', async () => {
      const tx = await plutusBuilder()
        .attachScript(plutusPolicy)
        .mintAssets(new Map([[plutusAsset, 1n]]), unitRedeemer)
        .build();

      expect(writtenTx(tx).witness.redeemers).toEqual([
        {
          purpose: Cardano.RedeemerPurpose.mint,
          index: 0,
          data: unitRedeemer,
          executionUnits: budget,
        },
      ]);
    });

    it('records a Plutus mint redeemer of zero', async () => {
      const tx = await plutusBuilder()
        .attachScript(plutusPolicy)
        .mintAssets(new Map([[plutusAsset, 1n]]), 0n)
        .build();

      expect(writtenTx(tx).witness.redeemers).toEqual([
        {
          purpose: Cardano.RedeemerPurpose.mint,
          index: 0,
          data: 0n,
          executionUnits: budget,
        },
      ]);
    });

    it('still requires the redeemer of a Plutus mint', async () => {
      await expect(
        plutusBuilder()
          .attachScript(plutusPolicy)
          .mintAssets(new Map([[plutusAsset, 1n]]))
          .build(),
      ).rejects.toThrow(MissingRedeemerError);
    });
  });

  describe('donations', () => {
    it('donates to the treasury, funded from the wallet like an output', async () => {
      const tx = await paymentBuilder().setDonation(3_000_000n).build();

      const { body } = writtenTx(tx);
      expect(body.donation).toBe(3_000_000n);
      expect(sumCoins(body.outputs) + body.fee + 3_000_000n).toBe(
        fundingUtxo[1].value.coins,
      );
      const { requiredFee } = measureSignedMinFee(tx, [fundingUtxo]);
      expect(requiredFee - body.fee).toBe(
        BigInt(protocolParameters.minFeeCoefficient),
      );
    });

    it('replaces the donation, and clears it when set to zero', async () => {
      const replaced = await paymentBuilder()
        .setDonation(1_000_000n)
        .setDonation(2_000_000n)
        .build();
      const cleared = await paymentBuilder()
        .setDonation(1_000_000n)
        .setDonation(0n)
        .build();

      expect(writtenTx(replaced).body.donation).toBe(2_000_000n);
      expect(writtenTx(cleared).body.donation).toBeUndefined();
    });

    it('accepts a donation of the largest unsigned 64-bit integer', () => {
      expect(() => paymentBuilder().setDonation(maxDonation)).not.toThrow();
    });

    it('refuses a negative donation and one above the largest unsigned 64-bit integer', () => {
      expect(() => paymentBuilder().setDonation(-1n)).toThrow(
        'Donation must not be negative, got -1',
      );
      expect(() => paymentBuilder().setDonation(maxDonation + 1n)).toThrow(
        `Donation exceeds the maximum of ${maxDonation} lovelace, got ${
          maxDonation + 1n
        }`,
      );
    });
  });

  describe('supplemental datums', () => {
    it('adds a datum to the witness set once and hashes it into the script data hash without a Plutus context', async () => {
      const tx = await paymentBuilder()
        .addOutput({
          address: recipientAddr,
          value: { coins: 2_000_000n },
          datumHash,
        })
        .addDatum(datum)
        .addDatum(datum)
        .build();

      const { body, witness } = writtenTx(tx);
      expect(witness.datums).toEqual([datum]);
      expect(witness.redeemers).toBeUndefined();
      expect(body.collaterals).toBeUndefined();
      expect(body.scriptIntegrityHash).toBe(
        computeConwayScriptDataHash({
          costModels: new Map(),
          usedLanguages: [],
          redeemers: [],
          datums: [datum],
        }),
      );
      const { requiredFee } = measureSignedMinFee(tx, [fundingUtxo]);
      expect(requiredFee - body.fee).toBe(
        BigInt(protocolParameters.minFeeCoefficient),
      );
    });

    it('keeps a spend datum of zero', async () => {
      const zeroDatumHash = Serialization.PlutusData.fromCore(0n).hash();
      const hashed = mkUtxo(804, 0, 5_000_000n, plutusAddr);
      hashed[1].datumHash = zeroDatumHash;

      const tx = await plutusBuilder()
        .attachScript(plutusPolicy)
        .addInput(hashed, { redeemer: unitRedeemer, datum: 0n })
        .build();

      expect(writtenTx(tx).witness.datums).toEqual([0n]);
    });

    it('provides the datum of an output a redeemer spends, and keeps one copy of a datum the input also carries', async () => {
      const hashed = mkUtxo(802, 0, 5_000_000n, plutusAddr);
      hashed[1].datumHash = datumHash;
      const build = async (spendDatum?: Cardano.PlutusData) =>
        plutusBuilder()
          .attachScript(plutusPolicy)
          .addInput(hashed, { redeemer: unitRedeemer, datum: spendDatum })
          .addDatum(datum)
          .build();

      for (const tx of [await build(), await build(datum)]) {
        const { body, witness } = writtenTx(tx);
        expect(witness.datums).toEqual([datum]);
        expect(body.scriptIntegrityHash).toBe(
          computeConwayScriptDataHash({
            costModels,
            usedLanguages: [Cardano.PlutusLanguageVersion.V3],
            redeemers: witness.redeemers ?? [],
            datums: [datum],
          }),
        );
      }
    });
  });
});

describe('TransactionBuilder reference script fee tiers', () => {
  const changeAddr =
    'addr_test1qpfhhfy2qgls50r9u4yh0l7z67xpg0a5rrhkmvzcuqrd0znuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q9gw0lz' as Cardano.PaymentAddress;
  const recipientAddr =
    'addr_test1qpuzeec0zqcm6lrdygkkvvd8e6qactnsl5zzeujsdpkpc939l2f2vykk0ctwq4ys6w3jg8pm0kknmy8m5pml8f9cauzq2zuc95' as Cardano.PaymentAddress;
  const referenceScript: Cardano.Script = {
    __type: Cardano.ScriptType.Native,
    kind: Cardano.NativeScriptKind.RequireTimeBefore,
    slot: Cardano.Slot(90_000_000),
  };
  const funding = mkUtxo(600, 0, 10_000_000n, changeAddr);
  const scriptReferenceUtxo: Cardano.Utxo = [
    { ...txIn('txid601', 0), address: recipientAddr },
    {
      address: recipientAddr,
      value: { coins: 5_000_000n },
      scriptReference: referenceScript,
    },
  ];
  const plainReferenceUtxo = mkUtxo(602, 0, 5_000_000n, recipientAddr);

  const loggerSpy = (): Logger => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  });

  const transferReferencing = async (
    reference: Cardano.Utxo,
    parameters: Partial<TransactionBuilderProtocolParameters>,
  ) => {
    const logger = loggerSpy();
    await new TransactionBuilder(Cardano.NetworkMagics.Preprod, {
      ...protocolParameters,
      ...parameters,
    })
      .setLogger(logger)
      .setChangeAddress(changeAddr)
      .setUnspentOutputs([funding])
      .useCoinSelector(new LargeFirstCoinSelector())
      .addReferenceInput(reference)
      .transferValue(recipientAddr, { coins: 2_000_000n })
      .build();
    return logger.warn;
  };

  const dijkstra = { protocolVersion: { major: 12, minor: 0 } };

  it('warns when a Dijkstra transaction reads reference scripts without the tier parameters, naming them and the values used', async () => {
    const warn = await transferReferencing(scriptReferenceUtxo, dijkstra);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /protocol version 12 lack refScriptCostStride and refScriptCostMultiplier.*refScriptCostStride 25600 and refScriptCostMultiplier 1\.2/,
      ),
    );
  });

  it('names only the tier parameter that is missing', async () => {
    const warn = await transferReferencing(scriptReferenceUtxo, {
      ...dijkstra,
      refScriptCostStride: 25_600,
    });

    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /lack refScriptCostMultiplier,.*with Conway's refScriptCostMultiplier 1\.2;/,
      ),
    );
  });

  it('does not warn when the tier parameters are set, before Dijkstra, or when the transaction reads no reference script', async () => {
    const warnings = await Promise.all([
      transferReferencing(scriptReferenceUtxo, {
        ...dijkstra,
        refScriptCostStride: 25_600,
        refScriptCostMultiplier: '1.2',
      }),
      transferReferencing(scriptReferenceUtxo, {
        protocolVersion: { major: 11, minor: 0 },
      }),
      transferReferencing(scriptReferenceUtxo, {}),
      transferReferencing(plainReferenceUtxo, dijkstra),
    ]);

    for (const warn of warnings) expect(warn).not.toHaveBeenCalled();
  });
});
