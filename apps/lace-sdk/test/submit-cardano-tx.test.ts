import { ActivityType } from '@lace-contract/activities';
import {
  CardanoNetworkId,
  FEATURE_FLAG_CARDANO,
  UNBOUNDED_IN_FLIGHT_SLOTS,
  UTXO_SYNC_CONFIRMATION_DEPTH,
} from '@lace-contract/cardano-context';
import { FEATURE_FLAG_NETWORK_TYPE } from '@lace-contract/network';
import { Cardano, Serialization } from '@lace-lib/cardano-core';
import { BigNumber, HexBytes, Milliseconds, Timestamp } from '@lace-lib/util';
import { firstValueFrom, filter, map, take, timeout } from 'rxjs';
import { expect, it, vi } from 'vitest';

import { createLaceWallet } from '../src/create-lace-wallet';
import { createTxBuilder, waitForNetworkInfo } from '../src/create-tx-builder';
import * as m from '../src/modules-cardano';
import { createPasskeyVaultModule } from '../src/passkey-vault-module';
import { createPasskeyWalletEntity } from '../src/passkey-wallet-entity';
import { submitCardanoTx } from '../src/submit-cardano-tx';

import type { CardanoBip32AccountProps } from '@lace-contract/cardano-context';
import type * as CardanoCore from '@lace-lib/cardano-core';
import type * as CardanoProviderCore from '@lace-lib/cardano-provider-core';
import type { PasskeyKeySource } from '@lace-lib/passkey';

const ADDRESS = Cardano.PaymentAddress(
  'addr_test1qp0np478uj3lpl5ffk72m9t89rrgplcmxq6rz8lhk3yxeadwylevelqjsja5ucxf7kq6as840xtphdkr56t97fzhy7zqzmtjwh',
);
const UTXO0_TX = 'a1'.repeat(32);
const FOREIGN_ADDRESS = Cardano.PaymentAddress(
  'addr_test1vqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqd9tg5t',
);
const UTXO1_TX = 'b2'.repeat(32);
const TIP_SLOT = 50_000_000;

// What the mocked Blockfrost serves: the account's UTxOs as Blockfrost's
// `accounts/{stake}/utxos` reports them, whether `tx/submit` refuses, the
// transactions it accepted, and the transactions the wallet asked `txs/{hash}`
// about, none of which it holds.
const fixture = vi.hoisted(() => ({
  accountUtxos: [] as unknown[],
  refuseSubmissions: false,
  submitted: [] as string[],
  responses: new Map<string, Promise<void>>(),
  lookedUp: [] as string[],
}));
fixture.accountUtxos = [
  { txHash: UTXO0_TX, outputIndex: 0, lovelace: '10000000' },
  { txHash: UTXO1_TX, outputIndex: 1, lovelace: '20000000' },
].map(({ txHash, outputIndex, lovelace }) => ({
  address: ADDRESS,
  tx_hash: txHash,
  tx_index: outputIndex,
  output_index: outputIndex,
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
  const { HttpClientError: ClientError } = await import(
    '@lace-lib/util-provider'
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
              cost_models_raw: {},
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
        if (endpoint === 'tx/submit') {
          if (fixture.refuseSubmissions)
            throw new ClientError(
              400,
              JSON.stringify({
                status_code: 400,
                error: 'Bad Request',
                message: 'The transaction is invalid.',
              }),
            );
          const cbor = Buffer.from(init?.body as Uint8Array).toString('hex');
          fixture.submitted.push(cbor);
          await fixture.responses.get(cbor);
          return {
            data: CoreSerialization.Transaction.fromCbor(
              CoreSerialization.TxCBOR(cbor),
            ).getId(),
          };
        }
        const lookup = /^txs\/([\da-f]{64})$/.exec(endpoint);
        if (lookup) {
          fixture.lookedUp.push(lookup[1]);
          throw new ClientError(
            404,
            JSON.stringify({
              status_code: 404,
              error: 'Not Found',
              message: 'The requested component has not been found.',
            }),
          );
        }
        throw new Error(`Unexpected Blockfrost request: ${endpoint}`);
      },
    }),
  };
});

const outpoint = ({ txId, index }: Pick<Cardano.TxIn, 'index' | 'txId'>) =>
  `${txId}#${index}`;

it.each([false, true])(
  'reserves accepted inputs when child responses arrive first (external payment: %s)',
  async isExternalPayment => {
    fixture.submitted = [];
    fixture.lookedUp = [];
    fixture.responses.clear();
    fixture.refuseSubmissions = false;
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
                projectId: 'submit-test',
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
    const account = entity.accounts.find(
      candidate =>
        candidate.blockchainName === 'Cardano' &&
        Number(
          (candidate.blockchainSpecific as CardanoBip32AccountProps).chainId
            .networkMagic,
        ) === Number(Cardano.ChainIds.Preprod.networkMagic),
    )!;
    wallet.dispatch('wallets.addWallet', entity);
    await waitForNetworkInfo(wallet, { timeout: Milliseconds(15_000) });

    const available$ =
      wallet.stateObservables.cardanoContext.selectAvailableAccountUtxos$.pipe(
        map(byAccount => byAccount[account.accountId] ?? []),
      );
    const readAvailable = async () => firstValueFrom(available$);
    const readActivities = async () =>
      firstValueFrom(wallet.stateObservables.activities.selectAllMap$);
    const readInFlight = async () =>
      Object.values(
        await firstValueFrom(
          wallet.stateObservables.cardanoContext.selectInFlightTransactions$,
        ),
      );
    const buildFrom = async (utxos: Cardano.Utxo[]) =>
      createTxBuilder(wallet)
        .unwrap()
        .setChangeAddress(ADDRESS)
        .setUnspentOutputs(utxos)
        .transferValue(ADDRESS, { coins: 1_500_000n })
        .expiresIn(900)
        .build();

    const settled = await firstValueFrom(
      available$.pipe(
        filter(utxos => utxos.length === 2),
        take(1),
        timeout(15_000),
      ),
    );
    // (1) Before any submission, every read offers the same UTxOs.
    expect(await readAvailable()).toEqual(settled);
    const utxo0 = settled.find(([txIn]) => txIn.txId === UTXO0_TX)!;
    const utxo1 = settled.find(([txIn]) => txIn.txId === UTXO1_TX)!;

    const first = await buildFrom([utxo0]);
    const firstBody = first.toCore().body;
    const result = await submitCardanoTx(wallet, {
      serializedTx: HexBytes(first.toCbor()),
    });
    expect(result.isOk()).toBe(true);

    // (2) The accepted transaction's input leaves the set; its change joins it.
    const afterSubmit = await readAvailable();
    const afterOutpoints = afterSubmit.map(([txIn]) => outpoint(txIn));
    expect(afterOutpoints).not.toContain(outpoint(utxo0[0]));
    expect(afterOutpoints).toContain(outpoint(utxo1[0]));
    const changeIndex = firstBody.outputs.findIndex(
      output => output.value.coins !== 1_500_000n,
    );
    expect(afterOutpoints).toContain(
      outpoint({ txId: first.getId(), index: changeIndex }),
    );

    // (3) A transaction built straight after spends none of the first's inputs.
    const second = await buildFrom(afterSubmit);
    const firstInputs = firstBody.inputs.map(outpoint);
    for (const txIn of second.toCore().body.inputs)
      expect(firstInputs).not.toContain(outpoint(txIn));

    // (4) The wallet holds it in flight with the body's bound, and the
    // activities list holds it as pending on the account it spends from.
    const inFlight = await readInFlight();
    expect(
      inFlight.find(({ txId }) => txId === first.getId())?.invalidHereafter,
    ).toBe(firstBody.validityInterval?.invalidHereafter);
    expect(firstBody.validityInterval?.invalidHereafter).toBeDefined();
    const activities = await readActivities();
    const pending = activities[account.accountId]?.find(
      activity => activity.activityId === String(first.getId()),
    );
    expect(pending?.type).toBe(ActivityType.Pending);

    // (5) A refused submission changes neither the set nor the activities.
    fixture.refuseSubmissions = true;
    const refused = await submitCardanoTx(wallet, {
      serializedTx: HexBytes(second.toCbor()),
    });
    expect(refused.isErr()).toBe(true);
    expect(await readAvailable()).toEqual(afterSubmit);
    expect(await readActivities()).toEqual(activities);
    expect(await readInFlight()).toEqual(inFlight);
    expect(fixture.submitted).toEqual([first.toCbor()]);

    fixture.refuseSubmissions = false;
    const transfer = (
      input: Cardano.TxIn,
      coins: bigint,
      { address = ADDRESS, validityInterval = firstBody.validityInterval } = {},
    ) =>
      Serialization.Transaction.fromCore({
        id: Cardano.TransactionId('0'.repeat(64)),
        body: {
          inputs: [input],
          outputs: [{ address, value: { coins } }],
          fee: 200_000n,
          validityInterval,
        },
        witness: { signatures: new Map() },
      });
    const parent = transfer(utxo1[0], 19_800_000n);
    const child = transfer({ txId: parent.getId(), index: 0 }, 19_600_000n, {
      address: isExternalPayment ? FOREIGN_ADDRESS : ADDRESS,
    });
    const parentResponse = Promise.withResolvers<void>();
    fixture.responses.set(parent.toCbor(), parentResponse.promise);
    const parentSubmission = submitCardanoTx(wallet, {
      serializedTx: HexBytes(parent.toCbor()),
    });
    try {
      await vi.waitFor(() => {
        expect(fixture.submitted).toContain(parent.toCbor());
      });
      const childResult = await submitCardanoTx(wallet, {
        serializedTx: HexBytes(child.toCbor()),
      });
      expect(childResult.isOk()).toBe(true);
    } finally {
      parentResponse.resolve();
    }
    expect((await parentSubmission).isOk()).toBe(true);
    const afterChainedSubmit = await readAvailable();
    const chainedOutpoints = afterChainedSubmit.map(([txIn]) => outpoint(txIn));
    expect(chainedOutpoints).not.toContain(outpoint(utxo1[0]));
    expect(chainedOutpoints).not.toContain(
      outpoint({ txId: parent.getId(), index: 0 }),
    );
    expect(
      chainedOutpoints.includes(outpoint({ txId: child.getId(), index: 0 })),
    ).toBe(!isExternalPayment);
    expect(
      afterChainedSubmit.reduce(
        (sum, [, output]) => sum + output.value.coins,
        0n,
      ),
    ).toBe(
      afterSubmit.reduce((sum, [, output]) => sum + output.value.coins, 0n) -
        (isExternalPayment ? 20_000_000n : 400_000n),
    );
    // The child is pending on the account, with the time its entry was
    // recorded, also when it pays only a foreign address: the parent's entry
    // then shows that the account owns its input.
    const childEntry = (await readInFlight()).find(
      ({ txId }) => txId === child.getId(),
    );
    await vi.waitFor(async () => {
      const childActivity = (await readActivities())[account.accountId]?.find(
        activity => activity.activityId === String(child.getId()),
      );
      expect(childActivity?.type).toBe(ActivityType.Pending);
      expect(childActivity?.timestamp).toBe(childEntry?.submittedAt);
      expect(childActivity?.tokenBalanceChanges).toEqual([
        {
          tokenId: 'lovelace',
          amount: BigNumber(isExternalPayment ? -19_800_000n : -200_000n),
        },
      ]);
    });

    // (6) Once the first transaction shows as confirmed, a spend of its
    // change keeps that change out of the available set, also once the
    // synced UTxOs list it, and is pending on the account.
    const firstChange = afterSubmit.find(
      ([input]) => input.txId === first.getId(),
    )!;
    wallet.dispatch('activities.upsertActivities', {
      accountId: account.accountId,
      activities: [{ ...pending!, type: ActivityType.Send }],
    });
    const gapChild = transfer(
      firstChange[0],
      firstChange[1].value.coins - 200_000n,
      { address: FOREIGN_ADDRESS },
    );
    expect(
      (
        await submitCardanoTx(wallet, {
          serializedTx: HexBytes(gapChild.toCbor()),
        })
      ).isOk(),
    ).toBe(true);
    const offered: string[][] = [];
    const subscription = available$.subscribe(utxos =>
      offered.push(utxos.map(([input]) => outpoint(input))),
    );
    wallet.dispatch('cardanoContext.setAccountUtxos', {
      accountId: account.accountId,
      utxos: [firstChange],
    });
    await vi.waitFor(async () => {
      expect(
        (await readActivities())[account.accountId]?.find(
          activity => activity.activityId === String(gapChild.getId()),
        )?.type,
      ).toBe(ActivityType.Pending);
    });
    subscription.unsubscribe();
    expect(offered.length).toBeGreaterThan(1);
    for (const emission of offered)
      expect(emission).not.toContain(outpoint(firstChange[0]));

    // (7) A body without an upper validity bound is held until the first
    // network tip the wallet receives after acceptance plus the wallet's
    // cut-off.
    const unbounded = Serialization.Transaction.fromCore({
      id: Cardano.TransactionId('0'.repeat(64)),
      body: {
        inputs: [{ txId: Cardano.TransactionId('cc'.repeat(32)), index: 0 }],
        outputs: [{ address: ADDRESS, value: { coins: 2_000_000n } }],
        fee: 200_000n,
      },
      witness: { signatures: new Map() },
    });
    expect(
      (
        await submitCardanoTx(wallet, {
          serializedTx: HexBytes(unbounded.toCbor()),
        })
      ).isOk(),
    ).toBe(true);
    const unboundedBound = async () =>
      (await readInFlight()).find(({ txId }) => txId === unbounded.getId())
        ?.invalidHereafter;
    expect(await unboundedBound()).toBeUndefined();
    const nextTipSlot = TIP_SLOT + 20;
    wallet.dispatch('cardanoContext.setTip', {
      network: CardanoNetworkId(Cardano.ChainIds.Preprod.networkMagic),
      tip: {
        slot: Cardano.Slot(nextTipSlot),
        blockNo: Cardano.BlockNo(100_001),
        hash: Cardano.BlockId('b'.repeat(64)),
      },
    });
    expect(await unboundedBound()).toBe(
      nextTipSlot + UNBOUNDED_IN_FLIGHT_SLOTS,
    );
    const unboundedRow = async () =>
      (await readActivities())[account.accountId]?.find(
        activity => activity.activityId === String(unbounded.getId()),
      );
    await vi.waitFor(async () => {
      expect((await unboundedRow())?.type).toBe(ActivityType.Pending);
    });

    // (8) Once the tip is past that cut-off by the lag the wallet allows its
    // provider, the wallet asks the provider, which does not hold the
    // transaction: its entry and its pending activity go.
    expect(fixture.lookedUp).toEqual([]);
    wallet.dispatch('cardanoContext.setTip', {
      network: CardanoNetworkId(Cardano.ChainIds.Preprod.networkMagic),
      tip: {
        slot: Cardano.Slot(
          nextTipSlot +
            UNBOUNDED_IN_FLIGHT_SLOTS +
            UTXO_SYNC_CONFIRMATION_DEPTH +
            1,
        ),
        blockNo: Cardano.BlockNo(100_002),
        hash: Cardano.BlockId('c'.repeat(64)),
      },
    });
    await vi.waitFor(async () => {
      expect(
        (await readInFlight()).some(({ txId }) => txId === unbounded.getId()),
      ).toBe(false);
      expect(await unboundedRow()).toBeUndefined();
    });
    expect(fixture.lookedUp).toContain(String(unbounded.getId()));

    const lateInput: Cardano.Utxo = [
      {
        txId: Cardano.TransactionId('dd'.repeat(32)),
        index: 0,
        address: ADDRESS,
      },
      { address: ADDRESS, value: { coins: 5_000_000n } },
    ];
    wallet.dispatch('cardanoContext.setAccountUtxos', {
      accountId: account.accountId,
      utxos: [lateInput],
    });
    const lateValidity = {
      invalidHereafter: Cardano.Slot(
        nextTipSlot +
          UNBOUNDED_IN_FLIGHT_SLOTS +
          UTXO_SYNC_CONFIRMATION_DEPTH +
          900,
      ),
    };
    const lateParent = transfer(lateInput[0], 4_800_000n, {
      validityInterval: lateValidity,
    });
    const confirmedChild = transfer(
      { txId: lateParent.getId(), index: 0 },
      4_600_000n,
      { validityInterval: lateValidity },
    );
    const lateResponse = Promise.withResolvers<void>();
    fixture.responses.set(lateParent.toCbor(), lateResponse.promise);
    const lateSubmission = submitCardanoTx(wallet, {
      serializedTx: HexBytes(lateParent.toCbor()),
    });
    const lateOffers: string[][] = [];
    const lateSubscription = available$.subscribe(utxos =>
      lateOffers.push(utxos.map(([input]) => outpoint(input))),
    );
    try {
      await vi.waitFor(() => {
        expect(fixture.submitted).toContain(lateParent.toCbor());
      });
      expect(
        (
          await submitCardanoTx(wallet, {
            serializedTx: HexBytes(confirmedChild.toCbor()),
          })
        ).isOk(),
      ).toBe(true);
      wallet.dispatch('activities.upsertActivities', {
        accountId: account.accountId,
        activities: [lateParent, confirmedChild].map(transaction => ({
          accountId: account.accountId,
          activityId: String(transaction.getId()),
          type: ActivityType.Send,
          timestamp: Timestamp(Date.now()),
          tokenBalanceChanges: [],
          blockchainSpecific: {
            Cardano: { consumedInputs: transaction.toCore().body.inputs },
          },
        })),
      });
      await vi.waitFor(async () => {
        expect(
          (await readInFlight()).some(
            ({ txId }) => txId === confirmedChild.getId(),
          ),
        ).toBe(false);
      });
      lateResponse.resolve();
      expect((await lateSubmission).isOk()).toBe(true);
      expect(
        (await readInFlight()).some(({ txId }) => txId === lateParent.getId()),
      ).toBe(true);
      const spentChange = outpoint({ txId: lateParent.getId(), index: 0 });
      for (const emission of lateOffers)
        expect(emission).not.toContain(spentChange);
      expect(
        (await readAvailable()).map(([input]) => outpoint(input)),
      ).not.toContain(outpoint(lateInput[0]));
    } finally {
      lateResponse.resolve();
      await lateSubmission;
      lateSubscription.unsubscribe();
    }
  },
);
