import { AccountId } from '@lace-contract/wallet-repo';
import {
  Cardano,
  ProviderError,
  ProviderFailure,
  Serialization,
} from '@lace-lib/cardano-core';
import { minAdaRequired } from '@lace-lib/cardano-tx-builder';
import { HexBlob } from '@lace-lib/cardano-util';
import {
  classifyHydraTxByAddresses,
  toHydraDepositRecovery,
} from '@lace-lib/hydra-head';
import { Err, Ok } from '@lace-lib/util';
import { of } from 'rxjs';
import { describe, expect, it } from 'vitest';

import { registerCardanoProvider } from '../src/cardano-provider-registry';
import {
  assembleHydraRecoverTx,
  assertPaysBackAsCommitted,
  buildHydraRecoverTx,
  shipAsCommitted,
} from '../src/hydra/build-hydra-recover-tx';

import {
  costModels,
  depositCommitting,
  PREPROD,
  protocolParameters,
  runScripts,
  SLOT_CONFIG,
  uplcEvaluator,
} from './hydra-recover-fixtures';

import type { WalletWithHydraRecovery } from '../src/hydra/build-hydra-recover-tx';
import type { CardanoProvider } from '@lace-contract/cardano-context';
import type { createModuleLoader } from '@lace-contract/module';
import type { HydraDepositRecovery } from '@lace-lib/hydra-head';

/** A Preprod deposit recorded from Blockfrost, with the key it commits to. */
interface DepositFixture {
  readonly release: string;
  readonly txId: string;
  readonly address: string;
  readonly coins: bigint;
  readonly datum: string;
  readonly owner: string;
}

const DEPOSITS: DepositFixture[] = [
  {
    release: '0.20.0 to 2.0.0',
    txId: 'c9bcfbb141f52def5feb7795fad6c88eb00b074a6a4511bb080dc757a1405f5a',
    address: 'addr_test1wzhqrkk782wrgm2ujwhreceegy4epg9clqlefmrt4gjwxrqckxj2j',
    coins: 25_000_000n,
    datum:
      'd8799f581c0bb9800f5ca9ff850cc0d4328978f4d0d67c16c7b49c56b7dd5770921b000001966571c3d59fd8799fd8799f5820bc0576bc057c864839a592d6a5f4330f980d9d3e269eaf352095b480105ab36001ff5f5840d8799fd8799fd8799f581cdcdc1c3ebd69660cfab24fcb905192740e32b406d9b1846309215320ffd8799fd8799fd8799f581ce7a15bc02c97204ea140a4499f5823a3c1e9cd75e1f7f55f1cb332ec8a8dffffffffa140a1401a017d7840d87980d87a80ffffffffff',
    owner: 'dcdc1c3ebd69660cfab24fcb905192740e32b406d9b1846309215320',
  },
  {
    release: '2.1.0',
    txId: '780405c8c68927d16867698635c4841a39886fad87c8b51d1ad382f6b3b7847f',
    address: 'addr_test1wqzrpsd0hdcyppdex67hl4fskhr8gqyupwzl6x884py54kqh56v08',
    coins: 299_000_000n,
    datum:
      'd8799f581c915c743c079446c4ef1099e29ac4b0a98d236620663dcc939ab0693f1b0000019f460dca7b9fd8799fd8799f58201df91d1f2c6aab9a004510bf1c4adeb95712b04ac6868d273d2b40df5eb1a2c900ff5f5840d8799fd8799fd8799f581c6bc787c1d7909620c60275d10da846cd448d710ce1acc1bd8b8cd435ffd8799fd8799fd8799f581cf6b304fe081314c1df5fd0f96f58238ecf914ed4e647ec4e9ec251335cc2ffffffffa140a1401a11d260c0d87980d87a80ffffffffff',
    owner: '6bc787c1d7909620c60275d10da846cd448d710ce1acc1bd8b8cd435',
  },
  {
    release: '2.2.0 and 2.3.0',
    txId: 'c1a8300f3d89c7feca5a91561329d205574170d5886e7bfb384558b5b89759a7',
    address: 'addr_test1wrrcaryjq4epavl0gsg08kuuv95l5md5jlpyvswjnss998qyu7lhm',
    coins: 4_626_931n,
    datum:
      'd8799f581c324c8b8198c4c9db7526d6dccb79e992c4863b24b56453bb16995bdc1b000001a05d17b3df9fd8799fd8799f5820e2f094efbbf8e363b9d02c7b5c61f89abdd6b839161d3a01638a882356ef96b101ff5f5840d8799fd8799fd8799f581cba1e067abfb07ecd833cec7005a8aa89cbdf09e10d6c87bb73da9e35ffd8799fd8799fd8799f581cac246d63642cf5fba32b6b605158236b8abf4d4e926fa42750db18341406ffffffffa140a1401a004699f3d87980d87a80ffffffffff',
    owner: 'ba1e067abfb07ecd833cec7005a8aa89cbdf09e10d6c87bb73da9e35',
  },
];

const depositUtxo = ({
  txId,
  address,
  coins,
  datum,
}: DepositFixture): Cardano.Utxo => {
  const paymentAddress = Cardano.PaymentAddress(address);
  return [
    { txId: Cardano.TransactionId(txId), index: 0, address: paymentAddress },
    {
      address: paymentAddress,
      value: { coins },
      datum: Serialization.PlutusData.fromCbor(HexBlob(datum)).toCore(),
    },
  ];
};

/** A UTxO of the account at the address its deposit pays back to. */
const walletUtxo = (
  address: Cardano.PaymentAddress,
  coins: bigint,
): Cardano.Utxo => [
  { txId: Cardano.TransactionId('aa'.repeat(32)), index: 3, address },
  { address, value: { coins } },
];

const recoverOf = (fixture: DepositFixture) => {
  const deposit = depositUtxo(fixture);
  const deadline = Number(
    Serialization.PlutusData.fromCbor(HexBlob(fixture.datum))
      .asConstrPlutusData()!
      .getData()
      .get(1)
      .asInteger()!,
  );
  const now = deadline + 10 * 60 * 1000;
  const recovery = toHydraDepositRecovery(deposit, [fixture.owner], now);
  return { deposit, deadline, now, recovery };
};

const assemble = async (
  recovery: HydraDepositRecovery,
  now: number,
  fee: Cardano.Utxo,
) =>
  assembleHydraRecoverTx({
    networkMagic: PREPROD,
    protocolParameters,
    plutusContext: { costModels, txEvaluator: uplcEvaluator },
    recovery,
    changeAddress: recovery.outputs[0].address,
    utxos: [fee],
    collateralUtxos: [fee],
    now,
  });

const COINS_PER_UTXO_BYTE = BigInt(protocolParameters.coinsPerUtxoByte);

/** The ledger's minimum ada for an output, from the bytes it ships in. */
const ledgerMinimum = (output: Serialization.TransactionOutput) =>
  (160n + BigInt(output.toCbor().length / 2)) * COINS_PER_UTXO_BYTE;

const expectLedgerMinimumAda = (tx: Serialization.Transaction) => {
  for (const output of tx.body().outputs()) {
    expect(output.amount().coin()).toBeGreaterThanOrEqual(
      ledgerMinimum(output),
    );
  }
};

describe.each(DEPOSITS)(
  'assembleHydraRecoverTx, deposit validator of Hydra $release',
  fixture => {
    it('builds a recover the deposit validator accepts, before and after the fee is settled', async () => {
      const { deposit, recovery, now } = recoverOf(fixture);
      const fee = walletUtxo(recovery.outputs[0].address, 10_000_000n);

      const tx = await assemble(recovery, now, fee);

      expect(() => runScripts(tx.toCbor(), [deposit, fee])).not.toThrow();
    });

    it('pays the committed outputs back first, exactly as committed, and the change after them', async () => {
      const { recovery, now } = recoverOf(fixture);
      const fee = walletUtxo(recovery.outputs[0].address, 10_000_000n);

      const tx = await assemble(recovery, now, fee);
      const { body } = tx.toCore();

      expectLedgerMinimumAda(tx);
      expect(body.outputs.slice(0, recovery.outputs.length)).toEqual(
        recovery.outputs,
      );
      expect(body.outputs).toHaveLength(recovery.outputs.length + 1);
      expect(body.outputs.at(-1)!.value.coins).toBeLessThan(10_000_000n);
    });

    it('spends the deposit with the Recover redeemer and the validator attached, valid from the slot after the deadline', async () => {
      const { deposit, deadline, recovery, now } = recoverOf(fixture);
      const fee = walletUtxo(recovery.outputs[0].address, 10_000_000n);

      const { body, witness } = (await assemble(recovery, now, fee)).toCore();

      expect(body.inputs).toContainEqual({
        txId: deposit[0].txId,
        index: deposit[0].index,
      });
      expect(witness.redeemers).toHaveLength(1);
      expect(witness.redeemers![0].purpose).toBe(Cardano.RedeemerPurpose.spend);
      expect(witness.redeemers![0].data).toEqual(recovery.redeemer);
      expect(witness.scripts).toEqual([recovery.script]);
      expect(body.referenceInputs ?? []).toEqual([]);
      expect(body.collaterals).toEqual([
        { txId: fee[0].txId, index: fee[0].index },
      ]);
      const lowerBound = body.validityInterval!.invalidBefore!;
      const startOf = (slot: number) =>
        SLOT_CONFIG.zeroTime +
        (slot - SLOT_CONFIG.zeroSlot) * SLOT_CONFIG.slotLength;
      expect(startOf(lowerBound)).toBeGreaterThan(deadline);
      expect(startOf(lowerBound - 1)).toBeLessThanOrEqual(deadline);
      expect(startOf(body.validityInterval!.invalidHereafter!)).toBeGreaterThan(
        now,
      );
    });

    it('is recognised as a recover from where its inputs and outputs sit', async () => {
      const { deposit, recovery, now } = recoverOf(fixture);
      const fee = walletUtxo(recovery.outputs[0].address, 10_000_000n);

      const { body } = (await assemble(recovery, now, fee)).toCore();

      expect(
        classifyHydraTxByAddresses(
          [deposit, fee].map(([, { address }]) => ({ address })),
          body.outputs.map(({ address }) => ({ address })),
        ),
      ).toBe('RecoverTx');
    });

    it('refuses a built transaction whose committed outputs changed', async () => {
      const { recovery, now } = recoverOf(fixture);
      const fee = walletUtxo(recovery.outputs[0].address, 10_000_000n);
      const tx = await assemble(recovery, now, fee);
      const [first, ...rest] = recovery.outputs;

      expect(() => {
        assertPaysBackAsCommitted(tx, recovery);
      }).not.toThrow();
      expect(() => {
        assertPaysBackAsCommitted(tx, {
          outputs: [
            {
              ...first,
              value: { ...first.value, coins: first.value.coins + 1n },
            },
            ...rest,
          ],
        });
      }).toThrow(/would not pay the committed outputs back as committed/);
    });

    it('is refused by the validator when an output differs from the committed one', async () => {
      const { recovery, now } = recoverOf(fixture);
      const fee = walletUtxo(recovery.outputs[0].address, 10_000_000n);
      const [first, ...rest] = recovery.outputs;
      const altered: HydraDepositRecovery = {
        ...recovery,
        outputs: [
          {
            ...first,
            value: { ...first.value, coins: first.value.coins - 1n },
          },
          ...rest,
        ],
      };

      await expect(assemble(altered, now, fee)).rejects.toThrow(/D05/);
    });

    it('is refused by the validator when its validity starts in the slot of the deadline', async () => {
      const { recovery, now } = recoverOf(fixture);
      const fee = walletUtxo(recovery.outputs[0].address, 10_000_000n);
      const oneSlotEarlier: HydraDepositRecovery = {
        ...recovery,
        deadline: recovery.deadline - SLOT_CONFIG.slotLength,
      };

      await expect(assemble(oneSlotEarlier, now, fee)).rejects.toThrow(/D04/);
    });

    it('refuses to build before the first slot after the deadline has started', async () => {
      const { deadline, recovery } = recoverOf(fixture);
      const fee = walletUtxo(recovery.outputs[0].address, 10_000_000n);
      const startOfDeadlineSlot =
        deadline - ((deadline - SLOT_CONFIG.zeroTime) % SLOT_CONFIG.slotLength);
      const lastInstantOfDeadlineSlot =
        startOfDeadlineSlot + SLOT_CONFIG.slotLength - 1;

      await expect(
        assemble(recovery, lastInstantOfDeadlineSlot, fee),
      ).rejects.toThrow(/first after its deadline/);
    });
  },
);

describe('buildHydraRecoverTx', () => {
  const fixture = DEPOSITS[2];
  const { deposit, deadline, now } = recoverOf(fixture);
  const accountId = AccountId('hydra-recover-account');
  const ownerAddress = Cardano.PaymentAddress(
    'addr_test1qzapupn6h7c8anvr8nk8qpdg42yuhhcfuyxkepamw0dfuddvy3kkxepv7ha6x2mtvpgkhz4lf48fymayyagdkxp5zsrqu57a0v',
  );
  const strangerAddress = Cardano.PaymentAddress(
    'addr_test1qqnqfr70emn3kyywffxja44znvdw0y4aeyh0vdc3s3rky48vlp50u6nrq5s7k6h89uqrjnmr538y6e50crvz6jdv3vqqxah5fk',
  );
  const spendable = walletUtxo(ownerAddress, 10_000_000n);
  const collateral: Cardano.Utxo = [
    {
      txId: Cardano.TransactionId('bb'.repeat(32)),
      index: 0,
      address: ownerAddress,
    },
    { address: ownerAddress, value: { coins: 5_000_000n } },
  ];

  const providerReading = (
    resolved: Cardano.TxOut | null,
  ): Pick<
    CardanoProvider,
    'evaluateTx' | 'getProtocolParameters' | 'resolveInput'
  > => ({
    resolveInput: () => of(Ok(resolved)),
    getProtocolParameters: () =>
      of(Ok({ costModels } as Cardano.ProtocolParameters)),
    evaluateTx: ({ tx }) => {
      try {
        return of(
          Ok(
            runScripts(tx, [deposit, spendable, collateral]).map(
              ({ purpose, index, executionUnits }) => ({
                purpose,
                index,
                budget: executionUnits,
              }),
            ),
          ),
        );
      } catch (error) {
        return of(
          Err(
            new ProviderError(
              ProviderFailure.BadRequest,
              undefined,
              String(error),
            ),
          ),
        );
      }
    },
  });

  const walletWith = ({
    provider = providerReading(deposit[1]),
    address = ownerAddress,
    reserved = [],
    chainId = Cardano.ChainIds.Preprod,
  }: {
    provider?: Partial<CardanoProvider> | null;
    address?: Cardano.PaymentAddress;
    reserved?: Cardano.Utxo[];
    chainId?: Cardano.ChainId;
  } = {}): WalletWithHydraRecovery => {
    const loadModules = (() => undefined) as unknown as ReturnType<
      typeof createModuleLoader
    >;
    if (provider) {
      void registerCardanoProvider(
        undefined as never,
        undefined as never,
        { cardanoProvider: provider, loadModules } as never,
      );
    }
    return {
      _loadModules: loadModules,
      stateObservables: {
        cardanoContext: {
          selectChainId$: of(chainId),
          selectProtocolParameters$: of(protocolParameters),
          selectAvailableAccountUtxos$: of({ [accountId]: [spendable] }),
          selectSettledAccountUnspendableUtxos$: of({ [accountId]: reserved }),
        },
        addresses: {
          selectAllAddresses$: of([
            { accountId, blockchainName: 'Cardano', address },
          ]),
        },
      },
    } as unknown as WalletWithHydraRecovery;
  };

  const props = { accountId, deposit: { txId: fixture.txId, index: 0 }, now };

  it('builds the recover from the deposit the provider reads, paid for by the account', async () => {
    const result = await buildHydraRecoverTx(walletWith(), props);

    const { body } = result.unwrap().toCore();
    expect(body.inputs).toEqual(
      expect.arrayContaining([
        { txId: deposit[0].txId, index: 0 },
        { txId: spendable[0].txId, index: spendable[0].index },
      ]),
    );
    expect(body.outputs[0]).toEqual({
      address: ownerAddress,
      value: { coins: fixture.coins },
    });
    expect(body.outputs.at(-1)!.address).toBe(ownerAddress);
    expect(body.collaterals).toEqual([
      { txId: spendable[0].txId, index: spendable[0].index },
    ]);
    expect(() =>
      runScripts(result.unwrap().toCbor(), [deposit, spendable]),
    ).not.toThrow();
  });

  it("posts the account's reserved collateral when it has some", async () => {
    const result = await buildHydraRecoverTx(
      walletWith({ reserved: [collateral] }),
      props,
    );

    expect(result.unwrap().toCore().body.collaterals).toEqual([
      { txId: collateral[0].txId, index: collateral[0].index },
    ]);
  });

  it('refuses a deposit that commits nothing to the account', async () => {
    const result = await buildHydraRecoverTx(
      walletWith({ address: strangerAddress }),
      props,
    );

    expect(result.isErr() && result.error.message).toMatch(
      /commits nothing to the account/,
    );
  });

  it('refuses a deposit before its deadline has passed', async () => {
    const result = await buildHydraRecoverTx(walletWith(), {
      ...props,
      now: deadline,
    });

    expect(result.isErr() && result.error.message).toMatch(
      /only after its deadline, 2026-/,
    );
  });

  it('refuses an output that is not at a deposit validator', async () => {
    const result = await buildHydraRecoverTx(
      walletWith({ provider: providerReading(spendable[1]) }),
      props,
    );

    expect(result.isErr() && result.error.message).toMatch(
      /not a Hydra deposit validator address/,
    );
  });

  it('refuses a deposit the provider does not know', async () => {
    const result = await buildHydraRecoverTx(
      walletWith({ provider: providerReading(null) }),
      props,
    );

    expect(result.isErr() && result.error.message).toMatch(/not found/);
  });

  it('refuses an account without a Cardano address', async () => {
    const result = await buildHydraRecoverTx(walletWith(), {
      ...props,
      accountId: AccountId('another-account'),
    });

    expect(result.isErr() && result.error.message).toMatch(
      /No Cardano address found/,
    );
  });

  it('refuses a wallet without a Cardano provider', async () => {
    const result = await buildHydraRecoverTx(
      walletWith({ provider: null }),
      props,
    );

    expect(result.isErr() && result.error.message).toMatch(
      /Cardano provider not available/,
    );
  });
});

describe('assembleHydraRecoverTx, minimum ada of the committed outputs', () => {
  const owner = Cardano.PaymentAddress(
    'addr_test1qzapupn6h7c8anvr8nk8qpdg42yuhhcfuyxkepamw0dfuddvy3kkxepv7ha6x2mtvpgkhz4lf48fymayyagdkxp5zsrqu57a0v',
  );
  const ownerKeyHash =
    Cardano.Address.fromBech32(owner).getProps().paymentPart!.hash;
  const token = Cardano.AssetId(`${'ab'.repeat(28)}746f6b656e`);
  const deadline = Date.parse('2026-06-01T00:00:00.000Z');
  const now = deadline + 10 * 60 * 1000;
  const fee = walletUtxo(owner, 10_000_000n);

  /** The output funded at the legacy array form's minimum, as a wallet funds change. */
  const atLegacyMinimum = (output: Cardano.TxOut): Cardano.TxOut => {
    let coins = output.value.coins;
    for (;;) {
      const funded = { ...output, value: { ...output.value, coins } };
      const minimum = ledgerMinimum(
        Serialization.TransactionOutput.fromCore(funded),
      );
      if (minimum === coins) return funded;
      coins = minimum;
    }
  };

  const recoveryOf = (outputs: Cardano.TxOut[]) =>
    toHydraDepositRecovery(
      depositCommitting({ txId: 'ef'.repeat(32), deadline, outputs }),
      [ownerKeyHash],
      now,
    );

  const tokenOutput = atLegacyMinimum({
    address: owner,
    value: { coins: 1_000_000n, assets: new Map([[token, 1n]]) },
  });

  it('ships an output funded at its legacy minimum in the legacy form, which the validator accepts', async () => {
    const recovery = recoveryOf([tokenOutput]);
    expect(
      Serialization.TransactionOutput.fromCore(tokenOutput).toCbor(),
    ).toMatch(/^82/);
    expect(tokenOutput.value.coins).toBeLessThan(
      minAdaRequired(tokenOutput, COINS_PER_UTXO_BYTE),
    );

    const tx = await assemble(recovery, now, fee);

    const [shipped] = tx.body().outputs();
    expect(shipped.toCbor()).toMatch(/^82/);
    expect(shipped.toCore()).toEqual(tokenOutput);
    expectLedgerMinimumAda(tx);
    const deposit = recovery.deposit;
    expect(() => runScripts(tx.toCbor(), [deposit, fee])).not.toThrow();
  });

  it('keeps the map form for an output whose ada covers it', async () => {
    const funded = {
      ...tokenOutput,
      value: { ...tokenOutput.value, coins: 5_000_000n },
    };

    const tx = await assemble(recoveryOf([funded]), now, fee);

    expect(tx.body().outputs()[0].toCbor()).toMatch(/^a/);
    expectLedgerMinimumAda(tx);
  });

  it('refuses a balanced recover that refunded a fee saving to a legacy form output', async () => {
    const recovery = recoveryOf([tokenOutput]);
    const tx = await assemble(recovery, now, fee);
    const refunded = Serialization.Transaction.fromCbor(tx.toCbor());
    const body = refunded.body();
    body.setOutputs([
      Serialization.TransactionOutput.fromCore({
        ...tokenOutput,
        value: {
          ...tokenOutput.value,
          coins: tokenOutput.value.coins + 1_000n,
        },
      }),
    ]);
    body.setFee(body.fee() - 1_000n);
    refunded.setBody(body);

    expect(() => shipAsCommitted(refunded, recovery, ['legacy'])).toThrow(
      /would not pay the committed outputs back as committed/,
    );
  });

  it('refuses an output below its legacy minimum rather than top it up', async () => {
    const short = {
      ...tokenOutput,
      value: { ...tokenOutput.value, coins: tokenOutput.value.coins - 1n },
    };

    await expect(assemble(recoveryOf([short]), now, fee)).rejects.toThrow(
      /Committed output 0 holds less ada than the ledger now requires of it/,
    );
  });

  it('refuses an output with an inline datum below the map minimum, which has no legacy form', async () => {
    const atMapMinimum = atLegacyMinimum({
      address: owner,
      value: { coins: 1_000_000n },
      datum: 42n,
    });
    const withDatum = {
      ...atMapMinimum,
      value: { coins: atMapMinimum.value.coins - 1n },
    };

    await expect(assemble(recoveryOf([withDatum]), now, fee)).rejects.toThrow(
      /Committed output 0 holds less ada/,
    );
  });
});
