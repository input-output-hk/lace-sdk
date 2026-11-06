import { HexBlob } from '@lace-lib/cardano-util';

import { setInConwayEra } from '../../../src';
import { RedeemerPurpose } from '../../../src/Cardano';
import { Redeemers } from '../../../src/Serialization';

import type { Cardano } from '../../../src';

const core: Cardano.Redeemer[] = [
  {
    data: {
      cbor: HexBlob('d8799f0102030405ff'),
      constructor: 0n,
      fields: { cbor: HexBlob('9f0102030405ff'), items: [1n, 2n, 3n, 4n, 5n] },
    },
    executionUnits: { memory: 33, steps: 44 },
    index: 0,
    purpose: RedeemerPurpose.spend,
  },
  {
    data: {
      cbor: HexBlob('d8799f0102030405ff'),
      constructor: 0n,
      fields: { cbor: HexBlob('9f0102030405ff'), items: [1n, 2n, 3n, 4n, 5n] },
    },
    executionUnits: { memory: 55, steps: 66 },
    index: 0,
    purpose: RedeemerPurpose.vote,
  },
];

// Same entries as `core` but with the second redeemer using the Dijkstra guarding purpose
// (redeemer_tag 6 in the pinned Dijkstra CDDL). Vector derived from `cborConway` below by
// setting the second map key tag byte from 04 to 06.
const coreWithGuarding: Cardano.Redeemer[] = [
  core[0],
  { ...core[1], purpose: RedeemerPurpose.guarding },
];

const cbor = HexBlob(
  '82840000d8799f0102030405ff821821182c840400d8799f0102030405ff8218371842',
);
const cborConway = HexBlob(
  'a282000082d8799f0102030405ff821821182c82040082d8799f0102030405ff8218371842',
);
const cborWithGuarding = HexBlob(
  'a282000082d8799f0102030405ff821821182c82060082d8799f0102030405ff8218371842',
);
// Index is an array of 3 elements instead of 2
const cborInvalidMapIndex = HexBlob(
  'a28308000082d8799f0102030405ff821821182c82040082d8799f0102030405ff8218371842',
);
const cborInvalidMapValue = HexBlob(
  'a28200008300d8799f0102030405ff821821182c82040082d8799f0102030405ff8218371842',
);

describe('Redeemers', () => {
  afterEach(() => setInConwayEra(true));

  it('encodes Redeemers built from core as map by default, without any setInConwayEra call', () => {
    const redeemers = Redeemers.fromCore(core);
    expect(redeemers.toCbor()).toEqual(cborConway);
  });

  it('can decode Redeemers from CBOR', () => {
    const redeemers = Redeemers.fromCbor(cbor);
    expect(redeemers.toCore()).toEqual(core);
  });

  it('encodes Redeemers as legacy array when setInConwayEra(false)', () => {
    setInConwayEra(false);
    const redeemers = Redeemers.fromCore(core);
    expect(redeemers.toCbor()).toEqual(cbor);
  });

  it('can decode Redeemers from map encoded CBOR', () => {
    const redeemers = Redeemers.fromCbor(cborConway);
    expect(redeemers.toCore()).toEqual(core);
  });

  it('can decode map encoded Redeemers with a guarding entry alongside a spend entry', () => {
    const redeemers = Redeemers.fromCbor(cborWithGuarding);
    expect(redeemers.toCore()).toEqual(coreWithGuarding);
  });

  it('can encode Redeemers with a guarding entry as map in CBOR, byte-exact', () => {
    const redeemers = Redeemers.fromCore(coreWithGuarding);
    expect(redeemers.toCbor()).toEqual(cborWithGuarding);
  });

  it('detects invalid map', () => {
    expect(() => Redeemers.fromCbor(cborInvalidMapIndex)).toThrowError(
      'Redeemers map index',
    );
    expect(() => Redeemers.fromCbor(cborInvalidMapValue)).toThrowError(
      'Redeemers map value',
    );
  });

  it.each([
    ['spend', '00'],
    ['mint', '01'],
    ['cert', '02'],
    ['reward', '03'],
    ['voting', '04'],
    ['proposing', '05'],
    ['guarding', '06'],
  ])('decodes the %s tag in the map form', (_, tag) => {
    const redeemers = Redeemers.fromCbor(
      HexBlob(`a182${tag}0082d8799f0102030405ff821821182c`),
    );
    expect(redeemers.size()).toBe(1);
    expect(redeemers.toCbor()).toBe(
      `a182${tag}0082d8799f0102030405ff821821182c`,
    );
  });

  it('decodes an index of 2^32-1 in the map and array forms', () => {
    const map = HexBlob('a182001affffffff82d8799f0102030405ff821821182c');
    const array = HexBlob('8184001affffffffd8799f0102030405ff821821182c');

    expect(Redeemers.fromCbor(map).values()[0].index()).toBe(4_294_967_295n);
    expect(Redeemers.fromCbor(array).values()[0].index()).toBe(4_294_967_295n);
  });

  it('rejects an index above 2^32-1 in the map and array forms', () => {
    const map = HexBlob(
      'a182001b000000010000000082d8799f0102030405ff821821182c',
    );
    const array = HexBlob(
      '8184001b0000000100000000d8799f0102030405ff821821182c',
    );

    expect(() => Redeemers.fromCbor(map)).toThrowError('Redeemer index');
    expect(() => Redeemers.fromCbor(array)).toThrowError('Redeemer index');
  });

  it('rejects an unknown tag in the map and array forms', () => {
    const map = HexBlob('a182070082d8799f0102030405ff821821182c');
    const array = HexBlob('81840700d8799f0102030405ff821821182c');

    expect(() => Redeemers.fromCbor(map)).toThrowError('Unknown redeemer tag');
    expect(() => Redeemers.fromCbor(array)).toThrowError(
      'Unknown redeemer tag',
    );
  });

  it.each([true, false])(
    'writes an index of 2^32-1 when in conway era is %s',
    inConwayEra => {
      setInConwayEra(inConwayEra);
      const redeemers = Redeemers.fromCore([
        { ...core[0], index: 2 ** 32 - 1 },
      ]);

      expect(Redeemers.fromCbor(redeemers.toCbor()).values()[0].index()).toBe(
        4_294_967_295n,
      );
    },
  );

  it.each([
    [true, 'a182001b000000010000000082d8799f0102030405ff821821182c'],
    [false, '8184001b0000000100000000d8799f0102030405ff821821182c'],
  ])(
    'writes an index above 2^32-1 when in conway era is %s so a placeholder index can be encoded while estimating fees',
    (inConwayEra, expected) => {
      setInConwayEra(inConwayEra);
      const redeemers = Redeemers.fromCore([{ ...core[0], index: 2 ** 32 }]);

      expect(redeemers.toCbor()).toEqual(expected);
    },
  );
});
