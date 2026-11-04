import { Cardano, Serialization } from '@cardano-sdk/core';
import { HexBlob } from '@cardano-sdk/util';
import { describe, expect, it } from 'vitest';

import { decodeHydraDepositDatum } from '../src';

import {
  bytes,
  constr,
  datumOf,
  depositDatum,
  integer,
  list,
  nestedListCbor,
  nothing,
  txOutData,
} from './fixtures/plutus';
import { preprodUtxos } from './fixtures/preprod';

const testnet = Cardano.NetworkId.Testnet;

const HEAD_ID = '324c8b8198c4c9db7526d6dccb79e992c4863b24b56453bb16995bdc';

const OWNER = 'ab'.repeat(28);

const POLICY_ID = 'cd'.repeat(28);

/** Largest index a JavaScript number holds without losing precision. */
const MAX_INDEX = BigInt(Number.MAX_SAFE_INTEGER);

/** Builds a pointer staking part from its slot and indexes. */
const pointerTo = (slot: bigint, txIndex: bigint, certIndex: bigint) =>
  constr(0n, constr(1n, integer(slot), integer(txIndex), integer(certIndex)));

/** Builds a deposit datum with one commit spending the output at the index. */
const depositSpendingIndex = (index: bigint) =>
  constr(
    0n,
    bytes(HEAD_ID),
    integer(0n),
    list(
      constr(
        0n,
        constr(0n, bytes('00'.repeat(32)), integer(index)),
        bytes(txOutData({ paymentKeyHash: OWNER, coins: 1n }).toCbor()),
      ),
    ),
  ).toCbor();

/** Builds a value holding one unit under the empty policy id. */
const emptyPolicyValue = (assetName: string) => {
  const tokens = new Serialization.PlutusMap();
  tokens.insert(bytes(assetName), integer(1n));
  const value = new Serialization.PlutusMap();
  value.insert(bytes(''), Serialization.PlutusData.newMap(tokens));
  return Serialization.PlutusData.newMap(value);
};

/**
 * Builds a value from policy entries as given, so a policy id or an asset
 * name may repeat.
 */
const valueWith = (
  policies: [
    policyId: string,
    tokens: [assetName: string, quantity: bigint][],
  ][],
) => {
  const value = new Serialization.PlutusMap();
  for (const [policyId, tokens] of policies) {
    const names = new Serialization.PlutusMap();
    for (const [assetName, quantity] of tokens) {
      names.insert(bytes(assetName), integer(quantity));
    }
    value.insert(bytes(policyId), Serialization.PlutusData.newMap(names));
  }
  return Serialization.PlutusData.newMap(value);
};

/** Builds a ledger API `TxOut` from a payment credential and a value. */
const txOutWith = (
  credential: Serialization.PlutusData,
  value: Serialization.PlutusData,
) =>
  constr(0n, constr(0n, credential, nothing()), value, constr(0n), nothing());

/** Latest instant in milliseconds that a JavaScript `Date` can represent. */
const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000n;

const addressType = (address = '') =>
  Cardano.Address.fromBech32(address).getType();

describe('decodeHydraDepositDatum', () => {
  it('decodes a Preprod deposit into a key credential base address', () => {
    expect(
      decodeHydraDepositDatum(datumOf(preprodUtxos.depositV2), testnet),
    ).toEqual({
      headId: HEAD_ID,
      deadline: Date.parse('2026-09-01T13:10:29.599Z'),
      committed: [
        {
          input: {
            txId: 'e2f094efbbf8e363b9d02c7b5c61f89abdd6b839161d3a01638a882356ef96b1',
            index: 1,
          },
          address:
            'addr_test1qzapupn6h7c8anvr8nk8qpdg42yuhhcfuyxkepamw0dfuddvy3kkxepv7ha6x2mtvpgkhz4lf48fymayyagdkxp5zsrqu57a0v',
          paymentKeyHash:
            'ba1e067abfb07ecd833cec7005a8aa89cbdf09e10d6c87bb73da9e35',
          value: { coins: 4_626_931n, assets: new Map() },
        },
      ],
    });
  });

  it('reads the deadline of a later deposit of the same output', () => {
    expect(
      decodeHydraDepositDatum(datumOf(preprodUtxos.redepositV2), testnet)
        ?.deadline,
    ).toEqual(Date.parse('2026-09-01T14:09:48.101Z'));
  });

  it('decodes script credential commits with native assets', () => {
    const datum = decodeHydraDepositDatum(
      datumOf(preprodUtxos.depositV2ScriptCommits),
      testnet,
    );
    expect(datum?.committed).toHaveLength(2);
    expect(datum?.committed[0]).toEqual({
      input: {
        txId: '070993f1b3e051bb52a129c120c6c29d0e772a85a541bf31ce1904dfce75d30a',
        index: 3,
      },
      address:
        'addr_test1wpwsntw7nl0shvxt79qcp7jfpgetgqcuvl5r7angq665pls6fx9ch',
      value: {
        coins: 1_022_038_630n,
        assets: new Map([
          [
            '5d09adde9fdf0bb0cbf14180fa490a32b4031c67e83f766806b540fe1b9cff79ccffe244ad9aca17d397b2bf9f33c2ec1e7e0d39c8cc8f8af4fb2da2',
            1n,
          ],
          [
            'd2a8592ec9673ac18fea1044885f94518e954ab0cb2b6bb0a328d2af425443',
            100_000n,
          ],
        ]),
      },
    });
    expect(datum?.committed[1].paymentKeyHash).toBeUndefined();
  });

  it('decodes a deposit at the validator shared by earlier releases', () => {
    const datum = decodeHydraDepositDatum(
      datumOf(preprodUtxos.depositV1),
      testnet,
    );
    expect(datum?.headId).toBe(
      '0bb9800f5ca9ff850cc0d4328978f4d0d67c16c7b49c56b7dd577092',
    );
    expect(datum?.deadline).toEqual(Date.parse('2025-04-24T01:37:56.693Z'));
    expect(
      datum?.committed.map(({ paymentKeyHash }) => paymentKeyHash),
    ).toEqual(['dcdc1c3ebd69660cfab24fcb905192740e32b406d9b1846309215320']);
  });

  it('decodes a Hydra 2.1.0 deposit into a key credential base address', () => {
    expect(
      decodeHydraDepositDatum(datumOf(preprodUtxos.depositV21), testnet),
    ).toEqual({
      headId: '915c743c079446c4ef1099e29ac4b0a98d236620663dcc939ab0693f',
      deadline: Date.parse('2026-07-09T08:45:36.763Z'),
      committed: [
        {
          input: {
            txId: '1df91d1f2c6aab9a004510bf1c4adeb95712b04ac6868d273d2b40df5eb1a2c9',
            index: 0,
          },
          address:
            'addr_test1qp4u0p7p67gfvgxxqf6azrdggmx5frt3pns6esda3wxdgd0kkvz0uzqnznqa7h7sl9hcanu3fm2wv3lvf60vy5fntnpq05s83p',
          paymentKeyHash:
            '6bc787c1d7909620c60275d10da846cd448d710ce1acc1bd8b8cd435',
          value: { coins: 299_000_000n, assets: new Map() },
        },
      ],
    });
  });

  it('decodes a deposit that commits nothing', () => {
    expect(
      decodeHydraDepositDatum(datumOf(preprodUtxos.depositV1Empty), testnet)
        ?.committed,
    ).toEqual([]);
  });

  it('rebuilds committed addresses for the given network', () => {
    const [committed] =
      decodeHydraDepositDatum(
        datumOf(preprodUtxos.depositV2),
        Cardano.NetworkId.Mainnet,
      )?.committed ?? [];
    expect(committed.address.startsWith('addr1')).toBe(true);
  });

  it('decodes enterprise and pointer addresses', () => {
    const paymentKeyHash = 'ab'.repeat(28);
    const decodeAddress = (staking: Serialization.PlutusData) =>
      decodeHydraDepositDatum(
        depositDatum(HEAD_ID, 0, [
          txOutData({ paymentKeyHash, coins: 1n, staking }),
        ]),
        testnet,
      )?.committed[0];

    const enterprise = decodeAddress(nothing());
    expect(enterprise?.paymentKeyHash).toBe(paymentKeyHash);
    expect(addressType(enterprise?.address)).toBe(
      Cardano.AddressType.EnterpriseKey,
    );

    const pointer = decodeAddress(
      constr(0n, constr(1n, integer(1n), integer(2n), integer(3n))),
    );
    expect(addressType(pointer?.address)).toBe(Cardano.AddressType.PointerKey);
  });

  it.each([
    [
      'a negative pointer slot',
      txOutData({
        paymentKeyHash: OWNER,
        coins: 1n,
        staking: constr(0n, constr(1n, integer(-1n), integer(2n), integer(3n))),
      }),
    ],
    [
      'an unknown credential constructor',
      txOutWith(constr(2n, bytes(OWNER)), emptyPolicyValue('')),
    ],
    [
      'lovelace under a non-empty asset name',
      txOutWith(constr(0n, bytes(OWNER)), emptyPolicyValue('aa')),
    ],
    [
      'a pointer transaction index beyond the safe integer range',
      txOutData({
        paymentKeyHash: OWNER,
        coins: 1n,
        staking: pointerTo(1n, MAX_INDEX + 1n, 3n),
      }),
    ],
    [
      'a pointer certificate index beyond the safe integer range',
      txOutData({
        paymentKeyHash: OWNER,
        coins: 1n,
        staking: pointerTo(1n, 2n, MAX_INDEX + 1n),
      }),
    ],
    ['zero lovelace', txOutData({ paymentKeyHash: OWNER, coins: 0n })],
    ['negative lovelace', txOutData({ paymentKeyHash: OWNER, coins: -1n })],
    [
      'a zero asset quantity',
      txOutData({
        paymentKeyHash: OWNER,
        coins: 1n,
        assets: [[POLICY_ID, '01', 0n]],
      }),
    ],
    [
      'a negative asset quantity',
      txOutData({
        paymentKeyHash: OWNER,
        coins: 1n,
        assets: [[POLICY_ID, '01', -1n]],
      }),
    ],
    [
      'a repeated policy id',
      txOutData({
        paymentKeyHash: OWNER,
        coins: 1n,
        assets: [
          [POLICY_ID, '01', 1n],
          [POLICY_ID, '02', 1n],
        ],
      }),
    ],
    [
      'a policy without tokens',
      txOutWith(
        constr(0n, bytes(OWNER)),
        valueWith([
          ['', [['', 1n]]],
          [POLICY_ID, []],
        ]),
      ),
    ],
    [
      'a repeated asset name',
      txOutWith(
        constr(0n, bytes(OWNER)),
        valueWith([
          ['', [['', 1n]]],
          [
            POLICY_ID,
            [
              ['01', 1n],
              ['01', 1n],
            ],
          ],
        ]),
      ),
    ],
    [
      'no lovelace entry',
      txOutWith(
        constr(0n, bytes(OWNER)),
        valueWith([[POLICY_ID, [['01', 1n]]]]),
      ),
    ],
    [
      'repeated lovelace',
      txOutWith(
        constr(0n, bytes(OWNER)),
        valueWith([
          ['', [['', 1n]]],
          ['', [['', 1n]]],
        ]),
      ),
    ],
  ])('rejects a deposit committing an output with %s', (_, output) => {
    expect(
      decodeHydraDepositDatum(depositDatum(HEAD_ID, 0, [output]), testnet),
    ).toBeUndefined();
  });

  it('accepts an output paying lovelace under the empty asset name', () => {
    expect(
      decodeHydraDepositDatum(
        depositDatum(HEAD_ID, 0, [
          txOutWith(constr(0n, bytes(OWNER)), emptyPolicyValue('')),
        ]),
        testnet,
      )?.committed[0].value,
    ).toEqual({ coins: 1n, assets: new Map() });
  });

  it('decodes two asset names under one policy', () => {
    expect(
      decodeHydraDepositDatum(
        depositDatum(HEAD_ID, 0, [
          txOutWith(
            constr(0n, bytes(OWNER)),
            valueWith([
              ['', [['', 1n]]],
              [
                POLICY_ID,
                [
                  ['01', 2n],
                  ['02', 3n],
                ],
              ],
            ]),
          ),
        ]),
        testnet,
      )?.committed[0].value,
    ).toEqual({
      coins: 1n,
      assets: new Map([
        [`${POLICY_ID}01`, 2n],
        [`${POLICY_ID}02`, 3n],
      ]),
    });
  });

  it('decodes one asset name under two policies', () => {
    const otherPolicyId = 'ef'.repeat(28);
    expect(
      decodeHydraDepositDatum(
        depositDatum(HEAD_ID, 0, [
          txOutWith(
            constr(0n, bytes(OWNER)),
            valueWith([
              ['', [['', 1n]]],
              [POLICY_ID, [['01', 2n]]],
              [otherPolicyId, [['01', 3n]]],
            ]),
          ),
        ]),
        testnet,
      )?.committed[0].value,
    ).toEqual({
      coins: 1n,
      assets: new Map([
        [`${POLICY_ID}01`, 2n],
        [`${otherPolicyId}01`, 3n],
      ]),
    });
  });

  it('rejects commits with a negative quantity offsetting another', () => {
    expect(
      decodeHydraDepositDatum(
        depositDatum(HEAD_ID, 0, [
          txOutData({ paymentKeyHash: OWNER, coins: 1_000_000_000n }),
          txOutData({ paymentKeyHash: OWNER, coins: -998_000_000n }),
        ]),
        testnet,
      ),
    ).toBeUndefined();
  });

  it('accepts indexes up to the largest safe integer', () => {
    const [committed] =
      decodeHydraDepositDatum(depositSpendingIndex(MAX_INDEX), testnet)
        ?.committed ?? [];
    expect(committed.input.index).toBe(Number.MAX_SAFE_INTEGER);

    const pointer = decodeHydraDepositDatum(
      depositDatum(HEAD_ID, 0, [
        txOutData({
          paymentKeyHash: OWNER,
          coins: 1n,
          staking: pointerTo(1n, MAX_INDEX, MAX_INDEX),
        }),
      ]),
      testnet,
    )?.committed[0];
    expect(addressType(pointer?.address)).toBe(Cardano.AddressType.PointerKey);
  });

  it('decodes a deadline at the end of the date range', () => {
    expect(
      decodeHydraDepositDatum(
        constr(
          0n,
          bytes(HEAD_ID),
          integer(MAX_DATE_MILLISECONDS),
          list(),
        ).toCbor(),
        testnet,
      )?.deadline,
    ).toEqual(Number(MAX_DATE_MILLISECONDS));
  });

  describe('nesting and size limits', () => {
    /**
     * Builds a deposit committing one lovelace to the owner in an output
     * whose inline datum is a zero inside lists nested `depth` deep. The
     * serialized output adds two levels around them.
     */
    const depositWithNestedOutputDatum = (depth: number) => {
      const output = constr(
        0n,
        constr(0n, constr(0n, bytes(OWNER)), nothing()),
        valueWith([['', [['', 1n]]]]),
        constr(
          2n,
          Serialization.PlutusData.fromCbor(HexBlob(nestedListCbor(depth))),
        ),
        nothing(),
      );
      return depositDatum(HEAD_ID, 0, [output]);
    };

    /** Builds a deposit committing one lovelace to the owner per output. */
    const depositOfOutputs = (count: number) =>
      depositDatum(
        HEAD_ID,
        0,
        Array.from({ length: count }, () =>
          txOutData({ paymentKeyHash: OWNER, coins: 1n }),
        ),
      );

    it('decodes a committed output nested 32 levels deep', () => {
      expect(
        decodeHydraDepositDatum(depositWithNestedOutputDatum(30), testnet)
          ?.committed,
      ).toHaveLength(1);
    });

    it('rejects a committed output nested deeper than 32 levels', () => {
      expect(
        decodeHydraDepositDatum(depositWithNestedOutputDatum(31), testnet),
      ).toBeUndefined();
    });

    it('rejects deeply nested data without decoding it', () => {
      const nestedOutput = constr(
        0n,
        bytes(HEAD_ID),
        integer(0n),
        list(
          constr(
            0n,
            constr(0n, bytes('00'.repeat(32)), integer(0n)),
            bytes(nestedListCbor(2000)),
          ),
        ),
      ).toCbor();
      const start = performance.now();
      expect(
        decodeHydraDepositDatum(nestedListCbor(2000), testnet),
      ).toBeUndefined();
      expect(decodeHydraDepositDatum(nestedOutput, testnet)).toBeUndefined();
      expect(performance.now() - start).toBeLessThan(1000);
    });

    it('decodes a datum of up to 4 KB and rejects a larger one', () => {
      const fitting = depositOfOutputs(30);
      const oversized = depositOfOutputs(60);
      expect(fitting.length / 2).toBeLessThanOrEqual(4096);
      expect(oversized.length / 2).toBeGreaterThan(4096);
      expect(decodeHydraDepositDatum(fitting, testnet)?.committed).toHaveLength(
        30,
      );
      expect(decodeHydraDepositDatum(oversized, testnet)).toBeUndefined();
    });
  });

  it.each([
    ['garbage CBOR', 'deadbeef'],
    ['an empty string', ''],
    ['non hex text', 'not-hex'],
    ['a head datum', preprodUtxos.headV2Open.inline_datum],
    [
      'a wrong constructor',
      constr(1n, bytes(HEAD_ID), integer(0n), list()).toCbor(),
    ],
    ['a short head id', constr(0n, bytes('aa'), integer(0n), list()).toCbor()],
    [
      'a negative deadline',
      constr(0n, bytes(HEAD_ID), integer(-1n), list()).toCbor(),
    ],
    [
      'a deadline beyond the date range',
      constr(
        0n,
        bytes(HEAD_ID),
        integer(MAX_DATE_MILLISECONDS + 1n),
        list(),
      ).toCbor(),
    ],
    [
      'an output reference index beyond the safe integer range',
      depositSpendingIndex(MAX_INDEX + 1n),
    ],
    [
      'a commit whose output is not serialized Plutus data',
      constr(
        0n,
        bytes(HEAD_ID),
        integer(0n),
        list(
          constr(
            0n,
            constr(0n, bytes('00'.repeat(32)), integer(0n)),
            bytes('ff'),
          ),
        ),
      ).toCbor(),
    ],
  ])('returns undefined for %s', (_, datum) => {
    expect(decodeHydraDepositDatum(datum, testnet)).toBeUndefined();
  });
});
