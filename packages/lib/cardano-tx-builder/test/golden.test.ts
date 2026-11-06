import { Cardano, Serialization } from '@lace-lib/cardano-core';
import { HexBlob } from '@lace-lib/cardano-util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LargeFirstCoinSelector } from '../src/input-selection/LargeFirstCoinSelector';
import { RoundRobinRandomCoinSelector } from '../src/input-selection/RoundRobinRandomCoinSelector';
import { TransactionBuilder } from '../src/TransactionBuilder';

import goldenTransactions from './fixtures/golden-transactions.json';

import type { TxEvaluator } from '../src/types';

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

const networkMagic = Cardano.NetworkMagics.Preprod;
const changeAddress = Cardano.PaymentAddress(
  'addr_test1qpfhhfy2qgls50r9u4yh0l7z67xpg0a5rrhkmvzcuqrd0znuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q9gw0lz',
);
const recipientAddress = Cardano.PaymentAddress(
  'addr_test1xrphkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gt7r0vd4msrxnuwnccdxlhdjar77j6lg0wypcc9uar5d2shs4p04xh',
);
const rewardAccount = Cardano.RewardAccount(
  'stake_test1up7pvfq8zn4quy45r2g572290p9vf99mr9tn7r9xrgy2l2qdsf58d',
);
const stakeCredential: Cardano.Credential = {
  type: Cardano.CredentialType.KeyHash,
  hash: Cardano.RewardAccount.toHash(rewardAccount),
};
const poolId = Cardano.PoolId(
  'pool1zuevzm3xlrhmwjw87ec38mzs02tlkwec9wxpgafcaykmwg7efhh',
);
const assetId = Cardano.AssetId(`${'a'.repeat(56)}54455354`);
const ttl = { invalidHereafter: Cardano.Slot(90_000_000) };
const seed = 42n;

const utxo = (
  txIdByte: string,
  index: number,
  value: Cardano.Value,
  address: Cardano.PaymentAddress = changeAddress,
  // eslint-disable-next-line max-params
): Cardano.Utxo => [
  {
    txId: Cardano.TransactionId(txIdByte.repeat(32)),
    index,
    address,
  },
  { address, value },
];

const adaUtxos: Cardano.Utxo[] = [
  utxo('01', 0, { coins: 3_000_000n }),
  utxo('02', 0, { coins: 4_500_000n }),
  utxo('03', 1, { coins: 9_000_000n }),
  utxo('04', 2, { coins: 12_000_000n }),
  utxo('05', 0, { coins: 1_500_000n }),
];

const assetUtxos: Cardano.Utxo[] = [
  utxo('a1', 0, { coins: 2_000_000n, assets: new Map([[assetId, 5n]]) }),
  utxo('a2', 0, { coins: 3_000_000n, assets: new Map([[assetId, 2n]]) }),
  utxo('a3', 1, { coins: 4_000_000n }),
];

const seededBuilder = () =>
  new TransactionBuilder(networkMagic, protocolParameters)
    .setNetwork(networkMagic)
    .setChangeAddress(changeAddress)
    .setValidityInterval(ttl)
    .useCoinSelector(new RoundRobinRandomCoinSelector({ seed }));

const plutusScript = {
  __type: Cardano.ScriptType.Plutus,
  version: Cardano.PlutusLanguageVersion.V3,
  bytes: 'deadbeef',
} as unknown as Cardano.Script;
const unitDatum = Serialization.PlutusData.fromCbor(HexBlob('d87980')).toCore();
const costModels: Cardano.CostModels = new Map([
  [Cardano.PlutusLanguageVersion.V3, Array.from({ length: 251 }, () => 0)],
]);
const plutusScriptAddress = Cardano.EnterpriseAddress.fromCredentials(
  Cardano.NetworkId.Testnet,
  {
    type: Cardano.CredentialType.ScriptHash,
    hash: Serialization.Script.fromCore(plutusScript).hash(),
  },
)
  .toAddress()
  .toBech32() as Cardano.PaymentAddress;
const scriptInput = utxo('0a', 0, { coins: 20_000_000n }, plutusScriptAddress);
const collateral = utxo('c0', 0, { coins: 10_000_000n });
const fixedEvaluator: TxEvaluator = {
  evaluate: async tx =>
    (tx.witness.redeemers ?? []).map(({ purpose, index }) => ({
      purpose,
      index,
      budget: { memory: 100, steps: 100_000 },
    })),
};
const scenarios: Record<
  keyof typeof goldenTransactions,
  () => Promise<Serialization.Transaction>
> = {
  'simple send': async () =>
    seededBuilder()
      .setUnspentOutputs(adaUtxos)
      .transferValue(recipientAddress, { coins: 5_000_000n })
      .build(),
  'simple send with large-first selection': async () =>
    seededBuilder()
      .useCoinSelector(new LargeFirstCoinSelector())
      .setUnspentOutputs(adaUtxos)
      .transferValue(recipientAddress, { coins: 5_000_000n })
      .build(),
  'simple send expiring in two hours': async () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(1_750_000_000_000);
    return new TransactionBuilder(networkMagic, protocolParameters)
      .setNetwork(networkMagic)
      .setChangeAddress(changeAddress)
      .useCoinSelector(new RoundRobinRandomCoinSelector({ seed }))
      .setUnspentOutputs(adaUtxos)
      .expiresIn(7200)
      .transferValue(recipientAddress, { coins: 5_000_000n })
      .build();
  },
  'multi-asset send': async () =>
    seededBuilder()
      .setUnspentOutputs(assetUtxos)
      .transferValue(recipientAddress, {
        coins: 3_000_000n,
        assets: new Map([[assetId, 6n]]),
      })
      .build(),
  'send with metadata': async () =>
    seededBuilder()
      .setUnspentOutputs(adaUtxos)
      .setMemo('hello from the golden test')
      .setMetadata(1337n, 'golden')
      .transferValue(recipientAddress, { coins: 2_000_000n })
      .build(),
  'stake delegation': async () =>
    seededBuilder()
      .setUnspentOutputs(adaUtxos)
      .addStakeDelegationCertificate(poolId, stakeCredential)
      .build(),
  'stake registration plus delegation': async () =>
    seededBuilder()
      .setUnspentOutputs(adaUtxos)
      .addStakeRegistrationDelegationCertificate(
        poolId,
        stakeCredential,
        2_000_000n,
      )
      .build(),
  'DRep vote delegation': async () =>
    seededBuilder()
      .setUnspentOutputs(adaUtxos)
      .addVoteDelegationCertificate(stakeCredential, {
        __typename: 'AlwaysAbstain',
      })
      .build(),
  'rewards withdrawal': async () =>
    seededBuilder()
      .setUnspentOutputs(adaUtxos)
      .addRewardsWithdrawal(rewardAccount, 1_000_000n)
      .transferValue(recipientAddress, { coins: 3_000_000n })
      .build(),
  'Plutus script spend with a fixed evaluator': async () =>
    seededBuilder()
      .setUnspentOutputs([])
      .addInput(scriptInput, { redeemer: unitDatum })
      .attachScript(plutusScript)
      .setCollateralUtxos([collateral])
      .setCollateralChangeAddress(changeAddress)
      .setPlutusContext({
        costModels,
        txEvaluator: fixedEvaluator,
      })
      .build(),
};

/**
 * Golden transactions: the CBOR the builder produces for each scenario.
 * Random selection runs from a fixed seed and the validity interval is fixed,
 * so the bytes change only when the builder's selection, balancing, fee or
 * encoding changes.
 */
describe('TransactionBuilder golden transactions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(Object.entries(scenarios))('builds %s', async (name, build) => {
    const tx = await build();

    expect(tx.toCbor()).toBe(
      goldenTransactions[name as keyof typeof goldenTransactions],
    );
  });
});
