import { describe, expect, it } from 'vitest';

import {
  findAccountHydraDeposits,
  fromBlockfrostUtxo,
  fromCardanoUtxo,
  getHydraDepositStatus,
} from '../src';

import { toCardanoUtxo } from './fixtures/cardano';
import { depositDatum, nestedListCbor, txOutData } from './fixtures/plutus';
import { preprodUtxos } from './fixtures/preprod';

import type { HydraBlockfrostUtxo, HydraUtxo, HydraValue } from '../src';

const HEAD_ID = '324c8b8198c4c9db7526d6dccb79e992c4863b24b56453bb16995bdc';
const OWNER = 'ba1e067abfb07ecd833cec7005a8aa89cbdf09e10d6c87bb73da9e35';
const STRANGER = 'ab'.repeat(28);
const DEADLINE = Date.parse('2026-09-01T13:10:29.599Z');
const BEFORE_DEADLINE = DEADLINE - 1;
const AFTER_DEADLINE = DEADLINE + 1;

const converters: [string, (utxo: HydraBlockfrostUtxo) => HydraUtxo][] = [
  ['Blockfrost JSON', fromBlockfrostUtxo],
  ['Cardano.Utxo', utxo => fromCardanoUtxo(toCardanoUtxo(utxo))],
];

const allDeposits = [
  preprodUtxos.depositV2,
  preprodUtxos.depositV2ScriptCommits,
  preprodUtxos.depositV1,
  preprodUtxos.depositV1Empty,
];

describe.each(converters)('findAccountHydraDeposits from %s', (_, convert) => {
  const utxos = allDeposits.map(convert);

  it('finds the deposit committing an output of the account', () => {
    expect(findAccountHydraDeposits(utxos, [OWNER], BEFORE_DEADLINE)).toEqual([
      {
        outpoint: { txId: preprodUtxos.depositV2.tx_hash, index: 0 },
        headId: HEAD_ID,
        deadline: DEADLINE,
        value: { coins: 4_626_931n, assets: new Map() },
        status: 'pending',
      },
    ]);
  });

  it('ignores deposits committing outputs of other keys', () => {
    expect(
      findAccountHydraDeposits(utxos, [STRANGER], BEFORE_DEADLINE),
    ).toEqual([]);
  });

  it('ignores UTxOs outside the deposit addresses', () => {
    const moved = {
      ...convert(preprodUtxos.depositV2),
      address: preprodUtxos.headV2Open.address,
    };
    expect(findAccountHydraDeposits([moved], [OWNER], BEFORE_DEADLINE)).toEqual(
      [],
    );
  });

  it('skips undecodable datums without failing the scan', () => {
    const broken = {
      ...convert(preprodUtxos.redepositV2),
      inlineDatum: 'deadbeef',
    };
    expect(
      findAccountHydraDeposits([broken, ...utxos], [OWNER], BEFORE_DEADLINE),
    ).toHaveLength(1);
  });

  it('skips a deeply nested datum without decoding it', () => {
    const nested = {
      ...convert(preprodUtxos.redepositV2),
      inlineDatum: nestedListCbor(2000),
    };
    const start = performance.now();
    const deposits = findAccountHydraDeposits(
      [nested, ...utxos],
      [OWNER],
      BEFORE_DEADLINE,
    );
    expect(performance.now() - start).toBeLessThan(1000);
    expect(deposits.map(({ outpoint }) => outpoint)).toEqual([
      { txId: preprodUtxos.depositV2.tx_hash, index: 0 },
    ]);
  });
});

describe('findAccountHydraDeposits status', () => {
  const utxos = [fromBlockfrostUtxo(preprodUtxos.depositV2)];
  const statusAt = (now: number) =>
    findAccountHydraDeposits(utxos, [OWNER], now)[0]?.status;

  it('stays pending up to and including the deadline', () => {
    expect(statusAt(BEFORE_DEADLINE)).toBe('pending');
    expect(statusAt(DEADLINE)).toBe('pending');
  });

  it('becomes recoverable right after the deadline', () => {
    expect(statusAt(AFTER_DEADLINE)).toBe('recoverable');
  });
});

describe('getHydraDepositStatus', () => {
  it('is pending up to and including the deadline', () => {
    expect(getHydraDepositStatus(DEADLINE, BEFORE_DEADLINE)).toBe('pending');
    expect(getHydraDepositStatus(DEADLINE, DEADLINE)).toBe('pending');
  });

  it('is recoverable strictly after the deadline', () => {
    expect(getHydraDepositStatus(DEADLINE, AFTER_DEADLINE)).toBe('recoverable');
  });
});

describe('findAccountHydraDeposits value', () => {
  /** The Preprod deposit UTxO with another datum and value. */
  const depositHolding = (
    inlineDatum: string,
    value: HydraValue,
  ): HydraUtxo => ({
    ...fromBlockfrostUtxo(preprodUtxos.depositV2),
    inlineDatum,
    value,
  });

  it('sums only the committed outputs of the account', () => {
    const policyId = 'cd'.repeat(28);
    const datum = depositDatum(HEAD_ID, DEADLINE, [
      txOutData({
        paymentKeyHash: OWNER,
        coins: 2_000_000n,
        assets: [[policyId, '01', 5n]],
      }),
      txOutData({ paymentKeyHash: STRANGER, coins: 9_000_000n }),
      txOutData({
        paymentKeyHash: OWNER,
        coins: 3_000_000n,
        assets: [[policyId, '01', 7n]],
      }),
    ]);
    const [deposit] = findAccountHydraDeposits(
      [
        depositHolding(datum, {
          coins: 14_000_000n,
          assets: new Map([[`${policyId}01`, 12n]]),
        }),
      ],
      [OWNER],
      AFTER_DEADLINE,
    );
    expect(deposit.value).toEqual({
      coins: 5_000_000n,
      assets: new Map([[`${policyId}01`, 12n]]),
    });
  });

  it.each([
    ['more', 1_999_999n],
    ['less', 2_000_001n],
  ])('ignores a deposit whose datum commits %s than it holds', (_, coins) => {
    const datum = depositDatum(HEAD_ID, DEADLINE, [
      txOutData({ paymentKeyHash: OWNER, coins: 2_000_000n }),
    ]);
    expect(
      findAccountHydraDeposits(
        [depositHolding(datum, { coins, assets: new Map() })],
        [OWNER],
        BEFORE_DEADLINE,
      ),
    ).toEqual([]);
  });

  it('ignores a deposit whose datum commits a token it does not hold', () => {
    const datum = depositDatum(HEAD_ID, DEADLINE, [
      txOutData({
        paymentKeyHash: OWNER,
        coins: 2_000_000n,
        assets: [['cd'.repeat(28), '01', 1n]],
      }),
    ]);
    expect(
      findAccountHydraDeposits(
        [depositHolding(datum, { coins: 2_000_000n, assets: new Map() })],
        [OWNER],
        BEFORE_DEADLINE,
      ),
    ).toEqual([]);
  });

  it('ignores a deposit inflating the account through a negative commit of another key', () => {
    const datum = depositDatum(HEAD_ID, DEADLINE, [
      txOutData({ paymentKeyHash: OWNER, coins: 1_000_000_000n }),
      txOutData({ paymentKeyHash: STRANGER, coins: -998_000_000n }),
    ]);
    expect(
      findAccountHydraDeposits(
        [depositHolding(datum, { coins: 2_000_000n, assets: new Map() })],
        [OWNER],
        BEFORE_DEADLINE,
      ),
    ).toEqual([]);
  });

  it('matches a deposit of an earlier release', () => {
    const owner = 'dcdc1c3ebd69660cfab24fcb905192740e32b406d9b1846309215320';
    const [deposit] = findAccountHydraDeposits(
      [fromBlockfrostUtxo(preprodUtxos.depositV1)],
      new Set([owner]),
      AFTER_DEADLINE,
    );
    expect(deposit.value).toEqual({ coins: 25_000_000n, assets: new Map() });
    expect(deposit.status).toBe('recoverable');
  });

  it('matches a deposit at the Hydra 2.1.0 validator', () => {
    const owner = '6bc787c1d7909620c60275d10da846cd448d710ce1acc1bd8b8cd435';
    const [deposit] = findAccountHydraDeposits(
      [fromBlockfrostUtxo(preprodUtxos.depositV21)],
      new Set([owner]),
      Date.parse('2026-07-09T08:45:36.763Z'),
    );
    expect(deposit).toEqual({
      outpoint: { txId: preprodUtxos.depositV21.tx_hash, index: 0 },
      headId: '915c743c079446c4ef1099e29ac4b0a98d236620663dcc939ab0693f',
      deadline: Date.parse('2026-07-09T08:45:36.763Z'),
      value: { coins: 299_000_000n, assets: new Map() },
      status: 'pending',
    });
  });
});
