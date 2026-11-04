import { describe, expect, it } from 'vitest';

import { classifyHydraTxByAddresses } from '../src';

import { constr } from './fixtures/plutus';
import { preprodTxs, preprodUtxos } from './fixtures/preprod';

import type { HydraTxEndpoint } from '../src';

const withoutDatums = (endpoints: HydraTxEndpoint[]) =>
  endpoints.map(({ address }) => ({ address }));

const v2Head = (inlineDatum?: string): HydraTxEndpoint => ({
  address: preprodUtxos.headV2Open.address,
  ...(inlineDatum ? { inlineDatum } : {}),
});

const v1Head = (inlineDatum?: string): HydraTxEndpoint => ({
  address: preprodUtxos.headV1Open.address,
  ...(inlineDatum ? { inlineDatum } : {}),
});

const wallet: HydraTxEndpoint = {
  address: 'addr_test1vzapupn6h7c8anvr8nk8qpdg42yuhhcfuyxkepamw0dfudgk46y8x',
};

const datum = (utxo: { inline_datum: string | null }) =>
  utxo.inline_datum ?? undefined;

describe('classifyHydraTxByAddresses', () => {
  it.each([
    ['depositTx', 'DepositTx'],
    ['recoverTx', 'RecoverTx'],
    ['initTx', 'InitTx'],
    ['incrementTx', 'IncrementTx'],
    ['closeTx', 'CloseTx'],
    ['partialFanoutTx', 'PartialFanoutTx'],
    ['fanoutTx', 'FanoutTx'],
  ] as const)('names the Preprod %s %s', (fixture, expected) => {
    const { inputs, outputs } = preprodTxs[fixture];
    expect(classifyHydraTxByAddresses(inputs, outputs)).toBe(expected);
  });

  it.each([
    ['depositTx', 'DepositTx'],
    ['recoverTx', 'RecoverTx'],
    ['initTx', 'InitTx'],
    ['incrementTx', 'IncrementTx'],
    ['closeTx', 'HeadTx'],
    ['fanoutTx', 'HeadTx'],
  ] as const)(
    'names the Preprod %s without datums as %s',
    (fixture, expected) => {
      const { inputs, outputs } = preprodTxs[fixture];
      expect(
        classifyHydraTxByAddresses(
          withoutDatums(inputs),
          withoutDatums(outputs),
        ),
      ).toBe(expected);
    },
  );

  it('names a contest from a closed head to a closed head', () => {
    const closed = datum(preprodUtxos.headV2Closed);
    expect(classifyHydraTxByAddresses([v2Head(closed)], [v2Head(closed)])).toBe(
      'ContestTx',
    );
  });

  it('names a decrement from an open head to an open head', () => {
    const open = datum(preprodUtxos.headV2Open);
    expect(
      classifyHydraTxByAddresses(
        [v2Head(open), wallet],
        [v2Head(open), wallet],
      ),
    ).toBe('DecrementTx');
  });

  it('names the last step of a partial fanout', () => {
    expect(
      classifyHydraTxByAddresses(
        [v2Head(datum(preprodUtxos.headV2FanningOut))],
        [wallet],
      ),
    ).toBe('FanoutTx');
  });

  it('names first generation collect and abort', () => {
    const initial = datum(preprodUtxos.headV1Initial);
    expect(
      classifyHydraTxByAddresses(
        [v1Head(initial)],
        [v1Head(datum(preprodUtxos.headV1Open))],
      ),
    ).toBe('CollectComTx');
    expect(classifyHydraTxByAddresses([v1Head(initial)], [wallet])).toBe(
      'AbortTx',
    );
  });

  it.each([
    [
      'an open head without a head output',
      v2Head(datum(preprodUtxos.headV2Open)),
      [],
    ],
    [
      'a closed head reopened',
      v2Head(datum(preprodUtxos.headV2Closed)),
      [v2Head(datum(preprodUtxos.headV2Open))],
    ],
    [
      'an initial head to a closed head',
      v1Head(datum(preprodUtxos.headV1Initial)),
      [v1Head(datum(preprodUtxos.headV1Closed))],
    ],
    ['a final head', v2Head(constr(2n).toCbor()), []],
  ])('falls back to HeadTx for %s', (_, input, outputs) => {
    expect(classifyHydraTxByAddresses([input], outputs)).toBe('HeadTx');
  });

  it('returns undefined when no Hydra address is involved', () => {
    expect(classifyHydraTxByAddresses([wallet], [wallet])).toBeUndefined();
    expect(classifyHydraTxByAddresses([], [])).toBeUndefined();
  });
});
