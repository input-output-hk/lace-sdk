import { FEATURE_FLAG_CARDANO } from '@lace-contract/cardano-context';
import { FEATURE_FLAG_NETWORK_TYPE } from '@lace-contract/network';
import {
  Cardano,
  ProviderError,
  ProviderFailure,
  Serialization,
} from '@lace-lib/cardano-core';
import { serializeTransaction } from '@lace-lib/cardano-tx-builder';
import { Err, Milliseconds, Ok } from '@lace-lib/util';
import { filter, firstValueFrom, of, throwError } from 'rxjs';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { createLaceWallet } from '../src/create-lace-wallet';
import { createPlutusContext } from '../src/create-plutus-context';
import { createTxBuilder, waitForNetworkInfo } from '../src/create-tx-builder';
import * as m from '../src/modules-cardano';
import { createPasskeyVaultModule } from '../src/passkey-vault-module';

import type {
  CardanoProvider,
  CardanoProviderDependencies,
  RedeemerExecutionUnits,
} from '@lace-contract/cardano-context';
import type { PasskeyKeySource } from '@lace-lib/passkey';

const cardanoFlags = [
  { key: FEATURE_FLAG_CARDANO },
  { key: FEATURE_FLAG_NETWORK_TYPE, payload: 'testnet' },
];

const cardanoConfig = {
  defaultFeatureFlags: cardanoFlags,
  extraFeatureFlags: [],
  defaultTestnetChainId: Cardano.ChainIds.Preprod,
  cardanoProvider: {
    tipPollFrequency: Milliseconds(30_000),
    blockfrostConfigs: {
      1: {
        clientConfig: {
          baseUrl: 'https://cardano-preprod.blockfrost.io',
          apiVersion: 'v0' as const,
          projectId: 'plutus-context-test',
        },
        rateLimiterConfig: {
          size: 500,
          increaseAmount: 10,
          increaseInterval: Milliseconds(1000),
        },
      },
    },
  },
  cexplorerUrls: { 1: 'https://preprod.cexplorer.io' },
};

const costModels: Cardano.CostModels = new Map([
  [Cardano.PlutusLanguageVersion.V3, [100_788, 420, 1, 1]],
]);

const protocolParameters = {
  minFeeCoefficient: 44,
  minFeeConstant: 155_381,
  prices: { memory: 0.0577, steps: 0.000_072_1 },
  coinsPerUtxoByte: 4310,
  poolDeposit: 500_000_000,
  stakeKeyDeposit: 2_000_000,
  dRepDeposit: 500_000_000,
  maxTxSize: 16_384,
  maxValueSize: 5000,
  collateralPercentage: 150,
  maxCollateralInputs: 3,
  minFeeRefScriptCostPerByte: 15,
  desiredNumberOfPools: 500,
  monetaryExpansion: '0.003',
  poolInfluence: '0.3',
  costModels,
} as unknown as Cardano.ProtocolParameters;

const evaluateTx = vi.fn<CardanoProvider['evaluateTx']>(() => of(Ok([])));
const getProtocolParameters = vi.fn<CardanoProvider['getProtocolParameters']>(
  () => of(Ok(protocolParameters)),
);

/**
 * The Blockfrost module with its provider's evaluation and protocol parameter
 * reads replaced by the test's fakes.
 */
const blockfrostWithFakeEvaluation: typeof m.cardanoProviderBlockfrost = {
  ...m.cardanoProviderBlockfrost,
  store: m.cardanoProviderBlockfrost.store && {
    ...m.cardanoProviderBlockfrost.store,
    load: async () => {
      const loaded = await m.cardanoProviderBlockfrost.store!.load();
      return {
        ...loaded,
        default: async (...args: Parameters<typeof loaded.default>) => {
          const init = await loaded.default(...args);
          const { cardanoProvider } =
            init.sideEffectDependencies as CardanoProviderDependencies;
          return {
            ...init,
            sideEffectDependencies: {
              ...init.sideEffectDependencies,
              cardanoProvider: {
                ...cardanoProvider,
                evaluateTx,
                getProtocolParameters,
              },
            },
          };
        },
      };
    },
  },
};

const createCardanoWallet = async () =>
  createLaceWallet({
    modules: [
      m.featureDev,
      m.storageInMemory,
      m.blockchainCardano,
      blockfrostWithFakeEvaluation,
      m.cryptoCardanoSdk,
      createPasskeyVaultModule({ keySource: {} as PasskeyKeySource }),
    ] as const,
    environment: 'development',
    featureFlags: cardanoFlags,
    config: cardanoConfig,
  });

const redeemer = (
  purpose: Cardano.RedeemerPurpose,
  index: number,
): Cardano.Redeemer => ({
  purpose,
  index,
  data: 42n,
  executionUnits: { memory: 0, steps: 0 },
});

const mintAndSpend = {
  id: Cardano.TransactionId('00'.repeat(32)),
  body: {
    inputs: [{ txId: Cardano.TransactionId('11'.repeat(32)), index: 0 }],
    outputs: [],
    fee: 200_000n,
  },
  witness: {
    signatures: new Map(),
    redeemers: [
      redeemer(Cardano.RedeemerPurpose.mint, 0),
      redeemer(Cardano.RedeemerPurpose.spend, 1),
    ],
  },
} as Cardano.Tx;

const measured: RedeemerExecutionUnits[] = [
  {
    purpose: Cardano.RedeemerPurpose.spend,
    index: 1,
    budget: { memory: 700_000, steps: 230_000_000 },
  },
  {
    purpose: Cardano.RedeemerPurpose.mint,
    index: 0,
    budget: { memory: 500_001, steps: 160_000_000 },
  },
];

describe('createPlutusContext', () => {
  let wallet: Awaited<ReturnType<typeof createCardanoWallet>>;
  let chainId: Cardano.ChainId;

  const context = async () => (await createPlutusContext(wallet)).unwrap();

  beforeAll(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    wallet = await createCardanoWallet();
    chainId = await firstValueFrom(
      wallet.stateObservables.cardanoContext.selectChainId$.pipe(
        filter((id): id is Cardano.ChainId => id !== undefined),
      ),
    );
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    evaluateTx.mockReset();
    getProtocolParameters.mockReset();
  });

  it("gives the network's cost models, read through the wallet's provider", async () => {
    const result = await context();

    expect(result.costModels).toBe(costModels);
    expect(getProtocolParameters).toHaveBeenCalledWith({ chainId });
  });

  it('declares each redeemer at what the provider measures, plus a 10 percent margin rounded up', async () => {
    evaluateTx.mockReturnValue(of(Ok(measured)));
    const { txEvaluator } = await context();

    await expect(txEvaluator.evaluate(mintAndSpend, [])).resolves.toEqual([
      {
        purpose: Cardano.RedeemerPurpose.mint,
        index: 0,
        budget: { memory: 550_002, steps: 176_000_000 },
      },
      {
        purpose: Cardano.RedeemerPurpose.spend,
        index: 1,
        budget: { memory: 770_000, steps: 253_000_000 },
      },
    ]);
    expect(evaluateTx).toHaveBeenCalledWith(
      { tx: serializeTransaction(mintAndSpend).toCbor() },
      { chainId },
    );
  });

  it('sends the provider the transaction exactly as the builder serialized it', async () => {
    evaluateTx.mockReturnValue(of(Ok(measured)));
    const serialized = serializeTransaction({
      ...mintAndSpend,
      body: { ...mintAndSpend.body, fee: 300_000n },
    });
    const { txEvaluator } = await context();

    await txEvaluator.evaluate(mintAndSpend, [], serialized);

    expect(evaluateTx).toHaveBeenCalledWith(
      { tx: serialized.toCbor() },
      { chainId },
    );
  });

  it("rejects with the provider's message when it refuses to evaluate the transaction", async () => {
    evaluateTx.mockReturnValue(
      of(
        Err(
          new ProviderError(
            ProviderFailure.BadRequest,
            undefined,
            'the validator crashed',
          ),
        ),
      ),
    );
    const { txEvaluator } = await context();

    await expect(txEvaluator.evaluate(mintAndSpend, [])).rejects.toThrow(
      /Transaction evaluation failed: .*the validator crashed/,
    );
  });

  it('rejects with the same message and the original as cause when the evaluation errors', async () => {
    const socketError = new Error('socket hang up');
    evaluateTx.mockReturnValue(throwError(() => socketError));
    const { txEvaluator } = await context();

    const caught: unknown = await txEvaluator
      .evaluate(mintAndSpend, [])
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(
      'Transaction evaluation failed: socket hang up',
    );
    expect((caught as Error).cause).toBe(socketError);
  });

  it('rejects when the provider leaves a redeemer unmeasured', async () => {
    evaluateTx.mockReturnValue(of(Ok(measured.slice(0, 1))));
    const { txEvaluator } = await context();

    await expect(txEvaluator.evaluate(mintAndSpend, [])).rejects.toThrow(
      'the provider did not evaluate redeemer mint#0',
    );
  });

  it("makes the builder's build() reject with the provider's refusal", async () => {
    evaluateTx.mockReturnValue(
      of(
        Err(
          new ProviderError(
            ProviderFailure.BadRequest,
            undefined,
            'the validator crashed',
          ),
        ),
      ),
    );
    await waitForNetworkInfo(wallet);
    const plutusContext = await context();
    const changeAddress =
      'addr_test1qpfhhfy2qgls50r9u4yh0l7z67xpg0a5rrhkmvzcuqrd0znuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q9gw0lz' as Cardano.PaymentAddress;
    const script = {
      __type: Cardano.ScriptType.Plutus,
      version: Cardano.PlutusLanguageVersion.V3,
      bytes: 'deadbeef',
    } as unknown as Cardano.Script;
    const scriptAddress = Cardano.EnterpriseAddress.fromCredentials(
      Cardano.NetworkId.Testnet,
      {
        type: Cardano.CredentialType.ScriptHash,
        hash: Serialization.Script.fromCore(script).hash(),
      },
    )
      .toAddress()
      .toBech32() as Cardano.PaymentAddress;
    const utxoAt = (
      txId: string,
      address: Cardano.PaymentAddress,
      coins: bigint,
    ): Cardano.Utxo => [
      { txId: Cardano.TransactionId(txId.repeat(32)), index: 0, address },
      { address, value: { coins } },
    ];

    const build = createTxBuilder(wallet)
      .unwrap()
      .setChangeAddress(changeAddress)
      .setUnspentOutputs([])
      .addInput(utxoAt('22', scriptAddress, 20_000_000n), { redeemer: 42n })
      .attachScript(script)
      .setCollateralUtxos([utxoAt('33', changeAddress, 10_000_000n)])
      .setCollateralChangeAddress(changeAddress)
      .setPlutusContext(plutusContext)
      .build();

    await expect(build).rejects.toThrow(
      /Transaction evaluation failed: .*the validator crashed/,
    );
  });

  it('fails when the provider cannot read the protocol parameters', async () => {
    getProtocolParameters.mockReturnValue(
      of(
        Err(
          new ProviderError(
            ProviderFailure.ConnectionFailure,
            undefined,
            'unreachable',
          ),
        ),
      ),
    );

    const result = await createPlutusContext(wallet);

    expect(result.isErr() && result.error.message).toMatch(
      /Protocol parameters not available: .*unreachable/,
    );
  });

  it('fails when the protocol parameter read errors', async () => {
    getProtocolParameters.mockReturnValue(
      throwError(() => new Error('socket hang up')),
    );

    const result = await createPlutusContext(wallet);

    expect(result.isErr() && result.error.message).toBe(
      'Protocol parameters not available: socket hang up',
    );
  });

  it('fails for a wallet without the Cardano modules', async () => {
    const bare = await createLaceWallet({
      modules: [m.featureDev, m.storageInMemory] as const,
      environment: 'development',
      featureFlags: [],
      config: { defaultFeatureFlags: [], extraFeatureFlags: [] },
    });

    const result = await createPlutusContext(bare);

    expect(result.isErr() && result.error.message).toMatch(
      /Cardano provider not available/,
    );
  });
});
