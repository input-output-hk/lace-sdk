import { Cardano, Serialization } from '@lace-lib/cardano-core';
import { HexBlob } from '@lace-lib/cardano-util';
import { describe, expect, it } from 'vitest';

import { getHydraScriptRegistry, toHydraDepositRecovery } from '../src';
import {
  parsePlutusData,
  readConstr,
  readLedgerTxOut,
  readListData,
} from '../src/plutus-data';
import { toPlutusTxOutData } from '../src/tx-out-data';

import { toCardanoUtxo } from './fixtures/cardano';
import {
  bytes,
  constr,
  datumOf,
  depositDatum,
  integer,
  list,
  nothing,
  txOutData,
} from './fixtures/plutus';
import { preprodUtxos } from './fixtures/preprod';

import type { HydraBlockfrostUtxo } from '../src';

const HEAD_ID = '324c8b8198c4c9db7526d6dccb79e992c4863b24b56453bb16995bdc';
const OWNER = 'ba1e067abfb07ecd833cec7005a8aa89cbdf09e10d6c87bb73da9e35';
const STRANGER = 'ab'.repeat(28);
const POLICY_A = 'aa'.repeat(28);
const POLICY_B = 'bb'.repeat(28);
const DEADLINE = Date.parse('2026-09-01T13:10:29.599Z');
const AFTER_DEADLINE = DEADLINE + 1;
const DEPOSIT_ADDRESS = preprodUtxos.depositV2.address;

/** The deadline of a Preprod deposit fixture, read from its datum. */
const deadlineOf = (utxo: HydraBlockfrostUtxo) =>
  Number(readConstr(parsePlutusData(datumOf(utxo)), 0n, 3)![1].asInteger()!);

/** The redeemer as CBOR hex. */
const cborOf = (data: Cardano.PlutusData) =>
  Serialization.PlutusData.fromCore(data).toCbor();

/** A deposit UTxO at `address` holding `value`, with the given inline datum. */
const depositAt = (
  datum: string,
  value: Cardano.Value,
  address = DEPOSIT_ADDRESS,
): Cardano.Utxo => {
  const paymentAddress = Cardano.PaymentAddress(address);
  return [
    {
      txId: Cardano.TransactionId('cd'.repeat(32)),
      index: 1,
      address: paymentAddress,
    },
    {
      address: paymentAddress,
      value,
      datum: Serialization.PlutusData.fromCbor(HexBlob(datum)).toCore(),
    },
  ];
};

/** A deposit datum whose commits spent the given output references. */
const datumWithInputs = (
  commits: readonly (readonly [string, bigint, Serialization.PlutusData])[],
) =>
  constr(
    0n,
    bytes(HEAD_ID),
    integer(BigInt(DEADLINE)),
    list(
      ...commits.map(([txId, index, output]) =>
        constr(
          0n,
          constr(0n, bytes(txId), integer(index)),
          bytes(output.toCbor()),
        ),
      ),
    ),
  ).toCbor();

/** A ledger API `TxOut` paying the owner's enterprise address. */
const ownerTxOut = ({
  value,
  datum = constr(0n),
  referenceScript = nothing(),
}: {
  value: Serialization.PlutusData;
  datum?: Serialization.PlutusData;
  referenceScript?: Serialization.PlutusData;
}) =>
  constr(
    0n,
    constr(0n, constr(0n, bytes(OWNER)), nothing()),
    value,
    datum,
    referenceScript,
  );

/** Value data from its policies and their tokens, in the given order. */
const valueData = (
  entries: readonly (readonly [
    string,
    readonly (readonly [string, bigint])[],
  ])[],
) => {
  const policies = new Serialization.PlutusMap();
  for (const [policyId, tokens] of entries) {
    const names = new Serialization.PlutusMap();
    for (const [name, quantity] of tokens)
      names.insert(bytes(name), integer(quantity));
    policies.insert(bytes(policyId), Serialization.PlutusData.newMap(names));
  }
  return Serialization.PlutusData.newMap(policies);
};

const OWNER_ADDRESS = Cardano.EnterpriseAddress.fromCredentials(
  Cardano.NetworkId.Testnet,
  { type: Cardano.CredentialType.KeyHash, hash: OWNER as never },
)
  .toAddress()
  .toBech32();

describe('toHydraDepositRecovery', () => {
  it.each([
    [
      '0.20.0 to 2.0.0',
      preprodUtxos.depositV1,
      'dcdc1c3ebd69660cfab24fcb905192740e32b406d9b1846309215320',
    ],
    [
      '2.1.0',
      preprodUtxos.depositV21,
      '6bc787c1d7909620c60275d10da846cd448d710ce1acc1bd8b8cd435',
    ],
    ['2.2.0 and 2.3.0', preprodUtxos.depositV2, OWNER],
  ])(
    'pays back a Preprod deposit at the validator of Hydra %s exactly as committed',
    (_, fixture, owner) => {
      const deposit = toCardanoUtxo(fixture);
      const deadline = deadlineOf(fixture);
      const recovery = toHydraDepositRecovery(deposit, [owner], deadline + 1);

      expect(recovery.deposit).toBe(deposit);
      expect(recovery.deadline).toBe(deadline);
      expect(recovery.outputs).toHaveLength(1);
      expect(recovery.outputs[0].value).toEqual({
        coins: deposit[1].value.coins,
      });
      expect(
        Cardano.Address.fromBech32(recovery.outputs[0].address).getProps()
          .paymentPart?.hash,
      ).toBe(owner);
      expect(cborOf(recovery.redeemer)).toBe('d87a9f01ff');
    },
  );

  it.each(
    [Cardano.NetworkId.Testnet, Cardano.NetworkId.Mainnet].flatMap(networkId =>
      getHydraScriptRegistry(networkId).flatMap(({ version, depositAddress }) =>
        depositAddress === undefined ? [] : [{ version, depositAddress }],
      ),
    ),
  )(
    'attaches the deposit validator of Hydra $version at $depositAddress',
    ({ depositAddress }) => {
      const datum = depositDatum(HEAD_ID, DEADLINE, [
        txOutData({ paymentKeyHash: OWNER, coins: 2_000_000n }),
      ]);
      const recovery = toHydraDepositRecovery(
        depositAt(datum, { coins: 2_000_000n }, depositAddress),
        [OWNER],
        AFTER_DEADLINE,
      );

      const parsed = Cardano.Address.fromBech32(depositAddress);
      expect(recovery.script.version).toBe(Cardano.PlutusLanguageVersion.V3);
      expect(Serialization.Script.fromCore(recovery.script).hash()).toBe(
        parsed.getProps().paymentPart?.hash,
      );
      expect(
        Cardano.Address.fromBech32(recovery.outputs[0].address).getNetworkId(),
      ).toBe(parsed.getNetworkId());
    },
  );

  it('orders the outputs by the output references their commits spent', () => {
    const output = (coins: bigint) =>
      ownerTxOut({ value: valueData([['', [['', coins]]]]) });
    const datum = datumWithInputs([
      ['02'.repeat(32), 0n, output(3_000_000n)],
      ['01'.repeat(32), 7n, output(2_000_000n)],
      ['01'.repeat(32), 1n, output(1_000_000n)],
    ]);

    const recovery = toHydraDepositRecovery(
      depositAt(datum, { coins: 6_000_000n }),
      [OWNER],
      AFTER_DEADLINE,
    );

    expect(recovery.outputs.map(({ value }) => value.coins)).toEqual([
      1_000_000n,
      2_000_000n,
      3_000_000n,
    ]);
    expect(cborOf(recovery.redeemer)).toBe('d87a9f03ff');
  });

  it('restores tokens, datum hashes and inline datums', () => {
    const datumHash = 'ef'.repeat(32);
    const inline = constr(0n, integer(42n));
    const datum = datumWithInputs([
      [
        '01'.repeat(32),
        0n,
        ownerTxOut({
          value: valueData([
            ['', [['', 2_000_000n]]],
            [
              POLICY_A,
              [
                ['01', 5n],
                ['0102', 1n],
              ],
            ],
            [POLICY_B, [['', 9n]]],
          ]),
          datum: constr(1n, bytes(datumHash)),
        }),
      ],
      [
        '01'.repeat(32),
        1n,
        ownerTxOut({
          value: valueData([['', [['', 3_000_000n]]]]),
          datum: constr(2n, inline),
        }),
      ],
    ]);

    const recovery = toHydraDepositRecovery(
      depositAt(datum, {
        coins: 5_000_000n,
        assets: new Map([
          [Cardano.AssetId(`${POLICY_A}01`), 5n],
          [Cardano.AssetId(`${POLICY_A}0102`), 1n],
          [Cardano.AssetId(POLICY_B), 9n],
        ]),
      }),
      [OWNER],
      AFTER_DEADLINE,
    );

    expect(recovery.outputs[0]).toEqual({
      address: OWNER_ADDRESS,
      value: {
        coins: 2_000_000n,
        assets: new Map([
          [`${POLICY_A}01`, 5n],
          [`${POLICY_A}0102`, 1n],
          [POLICY_B, 9n],
        ]),
      },
      datumHash,
    });
    expect(recovery.outputs[1].datumHash).toBeUndefined();
    expect(cborOf(recovery.outputs[1].datum!)).toBe(inline.toCbor());
  });

  it('refuses a deposit up to and including its deadline', () => {
    const deposit = toCardanoUtxo(preprodUtxos.depositV2);
    const deadline = deadlineOf(preprodUtxos.depositV2);

    for (const now of [deadline - 1, deadline]) {
      expect(() => toHydraDepositRecovery(deposit, [OWNER], now)).toThrow(
        `The deposit can be recovered only after its deadline, ${new Date(
          deadline,
        ).toISOString()}`,
      );
    }
  });

  it('refuses a deposit that commits nothing to the account', () => {
    const deposit = toCardanoUtxo(preprodUtxos.depositV2);

    expect(() =>
      toHydraDepositRecovery(deposit, [STRANGER], Number.MAX_SAFE_INTEGER),
    ).toThrow(/commits nothing to the account/);
  });

  it('refuses a deposit that commits other than it holds', () => {
    const datum = depositDatum(HEAD_ID, DEADLINE, [
      txOutData({ paymentKeyHash: OWNER, coins: 2_000_000n }),
    ]);

    expect(() =>
      toHydraDepositRecovery(
        depositAt(datum, { coins: 2_000_001n }),
        [OWNER],
        AFTER_DEADLINE,
      ),
    ).toThrow(/other than it holds/);
  });

  it('refuses a UTxO away from the deposit validators', () => {
    const [txIn, txOut] = toCardanoUtxo(preprodUtxos.depositV2);
    const address = Cardano.PaymentAddress(preprodUtxos.headV2Open.address);

    expect(() =>
      toHydraDepositRecovery(
        [
          { ...txIn, address },
          { ...txOut, address },
        ],
        [OWNER],
        Number.MAX_SAFE_INTEGER,
      ),
    ).toThrow(/is not a Hydra deposit validator address/);
  });

  it('refuses a deposit without a decodable datum', () => {
    const [txIn, txOut] = toCardanoUtxo(preprodUtxos.depositV2);

    expect(() =>
      toHydraDepositRecovery(
        [txIn, { ...txOut, datum: undefined }],
        [OWNER],
        Number.MAX_SAFE_INTEGER,
      ),
    ).toThrow(/no Hydra deposit datum/);
    expect(() =>
      toHydraDepositRecovery(
        depositAt(constr(0n, integer(1n)).toCbor(), txOut.value),
        [OWNER],
        Number.MAX_SAFE_INTEGER,
      ),
    ).toThrow(/no Hydra deposit datum/);
  });

  it('refuses a deposit committing an output with a reference script', () => {
    const datum = datumWithInputs([
      [
        '01'.repeat(32),
        0n,
        ownerTxOut({
          value: valueData([['', [['', 2_000_000n]]]]),
          referenceScript: constr(0n, bytes(POLICY_A)),
        }),
      ],
    ]);

    expect(() =>
      toHydraDepositRecovery(
        depositAt(datum, { coins: 2_000_000n }),
        [OWNER],
        AFTER_DEADLINE,
      ),
    ).toThrow(/with a reference script, which a recover cannot restore/);
  });

  it.each([
    [
      'lovelace after the tokens',
      [
        [POLICY_A, [['01', 5n]]],
        ['', [['', 2_000_000n]]],
      ],
    ],
    [
      'policies out of order',
      [
        ['', [['', 2_000_000n]]],
        [POLICY_B, [['01', 5n]]],
        [POLICY_A, [['01', 5n]]],
      ],
    ],
    [
      'asset names out of order',
      [
        ['', [['', 2_000_000n]]],
        [
          POLICY_A,
          [
            ['02', 5n],
            ['01', 5n],
          ],
        ],
      ],
    ],
  ] as const)(
    'refuses a commit the ledger would serialize otherwise: %s',
    (_, entries) => {
      const value = valueData(entries);
      const datum = datumWithInputs([
        ['01'.repeat(32), 0n, ownerTxOut({ value })],
      ]);
      const assets = new Map<Cardano.AssetId, bigint>();
      for (const [policyId, tokens] of entries) {
        if (policyId === '') continue;
        for (const [name, quantity] of tokens) {
          assets.set(Cardano.AssetId(policyId + name), quantity);
        }
      }

      expect(() =>
        toHydraDepositRecovery(
          depositAt(datum, { coins: 2_000_000n, assets }),
          [OWNER],
          AFTER_DEADLINE,
        ),
      ).toThrow(/in an encoding a recover cannot reproduce/);
    },
  );
});

describe('toPlutusTxOutData', () => {
  it('serializes every output Hydra committed on Preprod as Hydra did', () => {
    const deposits = [
      preprodUtxos.depositV1,
      preprodUtxos.depositV21,
      preprodUtxos.depositV2,
      preprodUtxos.depositV2ScriptCommits,
    ];
    const committed = deposits.flatMap(deposit =>
      readListData(
        readConstr(parsePlutusData(datumOf(deposit)), 0n, 3)![2],
      )!.map(commit =>
        HexBlob.fromBytes(readConstr(commit, 0n, 2)![1].asBoundedBytes()!),
      ),
    );

    const restorable = committed.flatMap(serialized => {
      const restored = readLedgerTxOut(
        parsePlutusData(serialized),
        Cardano.NetworkId.Testnet,
      )!;
      return restored.referenceScriptHash === undefined
        ? [[serialized, restored.output] as const]
        : [];
    });

    expect(restorable).toHaveLength(committed.length - 1);
    for (const [serialized, output] of restorable) {
      expect(toPlutusTxOutData(output).toCbor()).toBe(serialized);
    }
  });
});
