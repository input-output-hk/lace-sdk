import {
  FEATURE_FLAG_CARDANO,
  type CardanoBip32AccountProps,
} from '@lace-contract/cardano-context';
import { FEATURE_FLAG_NETWORK_TYPE } from '@lace-contract/network';
import { Cardano, Serialization } from '@lace-lib/cardano-core';
import { Milliseconds, Timestamp } from '@lace-lib/util';
import { filter, firstValueFrom, map, take, timeout } from 'rxjs';
import { expect, it, vi } from 'vitest';

import { createLaceWallet } from '../src/create-lace-wallet';
import { waitForNetworkInfo } from '../src/create-tx-builder';
import { buildHydraRecoverTx } from '../src/hydra/build-hydra-recover-tx';
import * as m from '../src/modules-cardano';
import { createPasskeyVaultModule } from '../src/passkey-vault-module';
import { createPasskeyWalletEntity } from '../src/passkey-wallet-entity';

import { depositCommitting, runScripts } from './hydra-recover-fixtures';

import type { CardanoTxId } from '@lace-contract/cardano-context';
import type * as CardanoCore from '@lace-lib/cardano-core';
import type * as CardanoProviderCore from '@lace-lib/cardano-provider-core';
import type { PasskeyKeySource } from '@lace-lib/passkey';

const ADDRESS = Cardano.PaymentAddress(
  'addr_test1qp0np478uj3lpl5ffk72m9t89rrgplcmxq6rz8lhk3yxeadwylevelqjsja5ucxf7kq6as840xtphdkr56t97fzhy7zqzmtjwh',
);
const FUNDS_TX = 'a1'.repeat(32);
const RESERVED_TX = 'b2'.repeat(32);
const DEPOSIT_TX = 'd3'.repeat(32);
const TIP_SLOT = 50_000_000;

/**
 * What the mocked Blockfrost serves: the account's UTxOs, the deposit UTxO
 * with its datum, and the UTxOs the evaluation resolves the inputs from.
 */
const fixture = vi.hoisted(() => ({
  accountUtxos: [] as unknown[],
  deposit: undefined as unknown,
  resolvedInputs: [] as unknown[],
}));
fixture.accountUtxos = [
  { txHash: FUNDS_TX, lovelace: '10000000' },
  { txHash: RESERVED_TX, lovelace: '5000000' },
].map(({ txHash, lovelace }) => ({
  address: ADDRESS,
  tx_hash: txHash,
  tx_index: 0,
  output_index: 0,
  amount: [{ unit: 'lovelace', quantity: lovelace }],
  block: 'c'.repeat(64),
  data_hash: null,
  inline_datum: null,
  reference_script_hash: null,
}));

vi.mock('@lace-lib/cardano-provider-core', async importActual => {
  const actual = await importActual<typeof CardanoProviderCore>();
  const { Serialization: CoreSerialization } = await vi.importActual<
    typeof CardanoCore
  >('@lace-lib/cardano-core');
  const { PLUTUS_V3_COST_MODEL: costModel, runScripts: run } = await import(
    './hydra-recover-fixtures'
  );
  return {
    ...actual,
    getBlockfrostClient: () => ({
      request: async (endpoint: string, init?: RequestInit) => {
        if (endpoint === 'blocks/latest')
          return {
            data: { height: 100000, hash: 'a'.repeat(64), slot: TIP_SLOT },
          };
        if (endpoint === 'genesis')
          return {
            data: {
              active_slots_coefficient: 0.05,
              epoch_length: 432000,
              max_kes_evolutions: 62,
              max_lovelace_supply: '45000000000000000',
              network_magic: 1,
              security_param: 2160,
              slot_length: 1,
              slots_per_kes_period: 129600,
              system_start: 1506203091,
              update_quorum: 5,
            },
          };
        if (endpoint === 'network/eras')
          return {
            data: [
              {
                start: { time: 0, slot: 0, epoch: 0 },
                parameters: {
                  epoch_length: 21600,
                  slot_length: 20,
                  safe_zone: 4320,
                },
              },
            ],
          };
        if (endpoint === 'epochs/latest/parameters')
          return {
            data: {
              min_fee_a: 44,
              min_fee_b: 155381,
              max_block_size: 90112,
              max_tx_size: 16384,
              max_block_header_size: 1100,
              key_deposit: '2000000',
              pool_deposit: '500000000',
              e_max: 18,
              n_opt: 500,
              a0: '0.3',
              rho: '0.003',
              tau: '0.2',
              protocol_major_ver: 10,
              protocol_minor_ver: 0,
              min_pool_cost: '170000000',
              price_mem: '0.0577',
              price_step: '0.0000721',
              max_tx_ex_mem: '14000000',
              max_tx_ex_steps: '10000000000',
              max_block_ex_mem: '62000000',
              max_block_ex_steps: '20000000000',
              max_val_size: '5000',
              collateral_percent: 150,
              max_collateral_inputs: 3,
              coins_per_utxo_word: '4310',
              min_fee_ref_script_cost_per_byte: 15,
              cost_models_raw: { PlutusV3: costModel },
            },
          };
        if (endpoint === 'network')
          return {
            data: {
              stake: { active: '0', live: '0' },
              supply: { circulating: '0', total: '45000000000000000' },
            },
          };
        if (/^accounts\/.*\/addresses\?/.test(endpoint)) return { data: [] };
        if (/^accounts\/.*\/utxos\?/.test(endpoint))
          return { data: fixture.accountUtxos };
        if (endpoint === `txs/${'d3'.repeat(32)}/utxos`)
          return { data: fixture.deposit };
        if (endpoint === 'utils/txs/evaluate') {
          const body = init?.body;
          const cbor =
            typeof body === 'string'
              ? body
              : Buffer.from(body as Uint8Array).toString('hex');
          const measured = run(
            CoreSerialization.TxCBOR(cbor),
            fixture.resolvedInputs as CardanoCore.Cardano.Utxo[],
          );
          return {
            data: {
              result: {
                EvaluationResult: Object.fromEntries(
                  measured.map(({ index, executionUnits }) => [
                    `spend:${index}`,
                    executionUnits,
                  ]),
                ),
              },
            },
          };
        }
        throw new Error(`Unexpected Blockfrost request: ${endpoint}`);
      },
    }),
  };
});

const outpointOf = ([{ txId, index }]: Cardano.Utxo) => ({ txId, index });

it('falls back to the available UTxOs for collateral once another transaction spends the reserved one', async () => {
  const keySource = {
    credentialRef: () => ({
      credentialId: 'AQID',
      rpId: 'localhost',
      recipeVersion: 'v1',
    }),
    withPasskeyMnemonic: async (
      use: (words: readonly string[]) => Promise<unknown>,
    ) =>
      use(
        'fame coconut utility print giraffe common twin evil alone exclude great echo since cart erode noise icon repair amused drip awake coral hat unveil'.split(
          ' ',
        ),
      ),
  } as unknown as PasskeyKeySource;
  const wallet = await createLaceWallet({
    modules: [
      m.featureDev,
      m.storageInMemory,
      m.blockchainCardano,
      m.cardanoProviderBlockfrost,
      m.cryptoCardanoSdk,
      createPasskeyVaultModule({ keySource }),
    ] as const,
    environment: 'development',
    featureFlags: [
      { key: FEATURE_FLAG_CARDANO },
      { key: FEATURE_FLAG_NETWORK_TYPE, payload: 'testnet' },
    ],
    config: {
      defaultFeatureFlags: [
        { key: FEATURE_FLAG_CARDANO },
        { key: FEATURE_FLAG_NETWORK_TYPE, payload: 'testnet' },
      ],
      extraFeatureFlags: [],
      defaultTestnetChainId: Cardano.ChainIds.Preprod,
      cardanoProvider: {
        tipPollFrequency: Milliseconds(30_000),
        blockfrostConfigs: {
          1: {
            clientConfig: {
              baseUrl: 'https://cardano-preprod.blockfrost.io',
              apiVersion: 'v0',
              projectId: 'hydra-recover-test',
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
    },
  });
  const { entity } = await createPasskeyWalletEntity(wallet, {
    keySource,
    walletName: 'Preprod',
  });
  const { accountId } = entity.accounts.find(
    candidate =>
      candidate.blockchainName === 'Cardano' &&
      Number(
        (candidate.blockchainSpecific as CardanoBip32AccountProps).chainId
          .networkMagic,
      ) === Number(Cardano.ChainIds.Preprod.networkMagic),
  )!;
  wallet.dispatch('wallets.addWallet', entity);
  await waitForNetworkInfo(wallet, { timeout: Milliseconds(15_000) });

  const settled = await firstValueFrom(
    wallet.stateObservables.cardanoContext.selectAccountUtxos$.pipe(
      map(byAccount => byAccount[accountId] ?? []),
      filter(utxos => utxos.length === 2),
      take(1),
      timeout(15_000),
    ),
  );
  const funds = settled.find(([txIn]) => txIn.txId === FUNDS_TX)!;
  const reserved = settled.find(([txIn]) => txIn.txId === RESERVED_TX)!;
  const [{ address: accountAddress }] = (
    await firstValueFrom(wallet.stateObservables.addresses.selectAllAddresses$)
  ).filter(address => address.accountId === accountId);

  const deposit = depositCommitting({
    txId: DEPOSIT_TX,
    deadline: Date.now() - 60 * 60 * 1000,
    outputs: [
      {
        address: Cardano.PaymentAddress(accountAddress as string),
        value: { coins: 3_000_000n },
      },
    ],
  });
  fixture.deposit = {
    hash: DEPOSIT_TX,
    inputs: [],
    outputs: [
      {
        address: deposit[1].address,
        amount: [{ unit: 'lovelace', quantity: '3000000' }],
        output_index: 0,
        data_hash: null,
        inline_datum: Serialization.PlutusData.fromCore(
          deposit[1].datum!,
        ).toCbor(),
        collateral: false,
        reference_script_hash: null,
      },
    ],
  };
  fixture.resolvedInputs = [deposit, funds, reserved];
  wallet.dispatch('cardanoContext.setAccountUnspendableUtxos', {
    accountId,
    utxos: [reserved],
  });
  const recover = async () =>
    (
      await buildHydraRecoverTx(wallet, {
        accountId,
        deposit: { txId: DEPOSIT_TX, index: 0 },
      })
    ).unwrap();

  const whileReserved = (await recover()).toCore().body;
  expect(whileReserved.collaterals).toEqual([outpointOf(reserved)]);

  wallet.dispatch('cardanoContext.recordInFlightTransaction', {
    chainId: Cardano.ChainIds.Preprod,
    txId: 'e4'.repeat(32) as CardanoTxId,
    effects: { consumedInputs: [outpointOf(reserved)], producedOutputs: [] },
    submittedAt: Timestamp(Date.now()),
  });
  const stillReserved = await firstValueFrom(
    wallet.stateObservables.cardanoContext.selectAccountUnspendableUtxos$,
  );
  expect(stillReserved[accountId]).toEqual([reserved]);

  const afterSpend = await recover();
  expect(afterSpend.toCore().body.collaterals).toEqual([outpointOf(funds)]);
  expect(() => runScripts(afterSpend.toCbor(), [deposit, funds])).not.toThrow();
}, 30_000);
