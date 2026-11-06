import { Cardano } from '@lace-lib/cardano-core';
import { describe, expect, it } from 'vitest';

import { decodeHydraHeadState, getHydraScriptRegistry } from '../src';

import {
  bytes,
  constr,
  datumOf,
  integer,
  nestedListCbor,
} from './fixtures/plutus';
import { preprodHashedHeadDatums, preprodUtxos } from './fixtures/preprod';

/** Latest instant in milliseconds that a JavaScript `Date` can represent. */
const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000n;

/** Builds a 2.3.0 closed head datum with the given contestation deadline. */
const closedHeadDatum = (deadline: bigint) =>
  constr(
    1n,
    constr(
      0n,
      ...Array.from({ length: 9 }, (_, index) =>
        integer(index === 6 ? deadline : 0n),
      ),
    ),
  ).toCbor();

describe('decodeHydraHeadState', () => {
  it.each([
    {
      name: 'open 2.3.0',
      fixture: preprodUtxos.headV2Open,
      version: '2.3.0',
      expected: { state: 'open' },
    },
    {
      name: 'closed 2.3.0',
      fixture: preprodUtxos.headV2Closed,
      version: '2.3.0',
      expected: {
        state: 'closed',
        contestationDeadline: Date.parse('2026-09-01T14:32:30.000Z'),
      },
    },
    {
      name: 'partially fanned out 2.3.0',
      fixture: preprodUtxos.headV2FanningOut,
      version: '2.3.0',
      expected: {
        state: 'fanningOut',
        contestationDeadline: Date.parse('2026-08-07T13:29:24.000Z'),
      },
    },
    {
      name: 'open 2.2.0',
      fixture: preprodUtxos.head220Open,
      version: '2.2.0',
      expected: { state: 'open' },
    },
    {
      name: 'open 2.1.0',
      fixture: preprodUtxos.head210Open,
      version: '2.1.0',
      expected: { state: 'open' },
    },
    {
      name: 'closed 2.1.0',
      fixture: preprodUtxos.head210ClosedThreeParties,
      version: '2.1.0',
      expected: {
        state: 'closed',
        contestationDeadline: Date.parse('2026-06-04T16:47:54.000Z'),
      },
    },
    {
      name: 'open 2.0.0',
      fixture: preprodUtxos.head200Open,
      version: '2.0.0',
      expected: { state: 'open' },
    },
    {
      name: 'closed 2.0.0',
      fixture: preprodUtxos.head200Closed,
      version: '2.0.0',
      expected: {
        state: 'closed',
        contestationDeadline: Date.parse('2026-04-04T11:22:51.000Z'),
      },
    },
    {
      name: 'initial 1.3.0',
      fixture: preprodUtxos.headV1Initial,
      version: '1.3.0',
      expected: { state: 'initial' },
    },
    {
      name: 'open 1.3.0',
      fixture: preprodUtxos.headV1Open,
      version: '1.3.0',
      expected: { state: 'open' },
    },
    {
      name: 'closed 1.3.0',
      fixture: preprodUtxos.headV1Closed,
      version: '1.3.0',
      expected: {
        state: 'closed',
        contestationDeadline: Date.parse('2026-04-05T01:47:49.000Z'),
      },
    },
    {
      name: 'closed 1.0.0',
      fixture: preprodUtxos.headV1ClosedFourParties,
      version: '1.0.0',
      expected: {
        state: 'closed',
        contestationDeadline: Date.parse('2025-10-06T08:19:05.000Z'),
      },
    },
    {
      name: 'closed 0.19.0',
      fixture: preprodUtxos.head019Closed,
      version: '0.19.0',
      expected: {
        state: 'closed',
        contestationDeadline: Date.parse('2024-12-04T17:20:09.000Z'),
      },
    },
    {
      name: 'closed 0.18.0',
      fixture: preprodUtxos.head018Closed,
      version: '0.18.0',
      expected: {
        state: 'closed',
        contestationDeadline: Date.parse('2024-08-21T22:28:12.000Z'),
      },
    },
    {
      name: 'open 0.15.0',
      fixture: preprodUtxos.head015Open,
      version: '0.15.0',
      expected: { state: 'open' },
    },
    {
      name: 'closed 0.15.0',
      fixture: preprodUtxos.head015Closed,
      version: '0.15.0',
      expected: {
        state: 'closed',
        contestationDeadline: Date.parse('2024-01-31T16:25:04.000Z'),
      },
    },
  ])('decodes the Preprod $name head', ({ fixture, version, expected }) => {
    expect(decodeHydraHeadState(datumOf(fixture), version)).toEqual(expected);
  });

  it('decodes a 0.13.0 closed head from its hash-resolved datum', () => {
    expect(
      decodeHydraHeadState(preprodHashedHeadDatums.head013Closed, '0.13.0'),
    ).toEqual({
      state: 'closed',
      contestationDeadline: Date.parse('2023-12-04T12:03:55.000Z'),
    });
  });

  it.each([
    ['2.3.0', 2n],
    ['2.0.0', 2n],
    ['1.3.0', 3n],
    ['0.18.0', 3n],
    ['0.13.0', 3n],
  ])('decodes the final state of %s', (version, alternative) => {
    expect(decodeHydraHeadState(constr(alternative).toCbor(), version)).toEqual(
      { state: 'final' },
    );
  });

  it.each(
    [
      ...getHydraScriptRegistry(Cardano.NetworkId.Testnet),
      ...getHydraScriptRegistry(Cardano.NetworkId.Mainnet),
    ].map(({ version }) => version),
  )('knows the head datum layout of registered release %s', version => {
    const finalStates = [2n, 3n].map(alternative =>
      decodeHydraHeadState(constr(alternative).toCbor(), version),
    );
    expect(finalStates).toContainEqual({ state: 'final' });
  });

  it.each([
    ['2.3.0', preprodUtxos.head200Open, 'a 2.0.0 open head'],
    ['2.0.0', preprodUtxos.headV2Open, 'a 2.3.0 open head'],
    ['2.0.0', preprodUtxos.headV2Closed, 'a 2.3.0 closed head'],
    ['1.3.0', preprodUtxos.head019Closed, 'a 0.19.0 closed head'],
    ['0.19.0', preprodUtxos.headV1Closed, 'a 1.3.0 closed head'],
    ['1.3.0', preprodUtxos.head015Closed, 'a 0.15.0 closed head'],
    ['1.3.0', preprodUtxos.headV2Closed, 'a 2.3.0 closed head'],
  ])('rejects under %s the datum of %s', (version, fixture) => {
    expect(decodeHydraHeadState(datumOf(fixture), version)).toBeUndefined();
  });

  it('decodes a contestation deadline at the end of the date range', () => {
    expect(
      decodeHydraHeadState(closedHeadDatum(MAX_DATE_MILLISECONDS), '2.3.0'),
    ).toEqual({
      state: 'closed',
      contestationDeadline: Number(MAX_DATE_MILLISECONDS),
    });
  });

  it('rejects a contestation deadline beyond the date range', () => {
    expect(
      decodeHydraHeadState(
        closedHeadDatum(MAX_DATE_MILLISECONDS + 1n),
        '2.3.0',
      ),
    ).toBeUndefined();
  });

  it('returns undefined for an unregistered release', () => {
    expect(
      decodeHydraHeadState(datumOf(preprodUtxos.headV2Open), '9.9.9'),
    ).toBeUndefined();
  });

  it.each([
    ['garbage CBOR', 'deadbeef'],
    ['an empty string', ''],
    ['a deposit datum', datumOf(preprodUtxos.depositV2)],
    ['an unknown constructor', constr(4n).toCbor()],
    ['bytes', bytes('00').toCbor()],
    ['a final state with fields', constr(2n, integer(1n)).toCbor()],
    ['a record with a wrong field count', constr(1n, constr(0n)).toCbor()],
  ])('returns undefined for %s', (_, datum) => {
    expect(decodeHydraHeadState(datum, '2.3.0')).toBeUndefined();
  });

  it('rejects deeply nested data without decoding it', () => {
    const start = performance.now();
    expect(decodeHydraHeadState(nestedListCbor(2000), '2.3.0')).toBeUndefined();
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
