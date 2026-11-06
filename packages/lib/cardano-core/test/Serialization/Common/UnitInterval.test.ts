import { HexBlob } from '@lace-lib/cardano-util';

import { UnitInterval } from '../../../src/Serialization';

import type * as Cardano from '../../../src/Cardano';

// Test data used in the following tests was generated with the cardano-serialization-lib
describe('UnitInterval', () => {
  it('can decode UnitInterval from CBOR', () => {
    const cbor = HexBlob('d81e820105');

    const interval = UnitInterval.fromCbor(cbor);

    expect(interval.numerator()).toEqual(1n);
    expect(interval.denominator()).toEqual(5n);
  });

  it('can decode UnitInterval from Core', () => {
    const core = { denominator: 5, numerator: 1 } as Cardano.Fraction;

    const interval = UnitInterval.fromCore(core);

    expect(interval.numerator()).toEqual(1n);
    expect(interval.denominator()).toEqual(5n);
  });

  it('can encode UnitInterval to CBOR', () => {
    const core = { denominator: 5, numerator: 1 } as Cardano.Fraction;

    const interval = UnitInterval.fromCore(core);

    expect(interval.toCbor()).toEqual('d81e820105');
  });

  it('can encode UnitInterval to Core', () => {
    const cbor = HexBlob('d81e820105');

    const interval = UnitInterval.fromCbor(cbor);

    expect(interval.toCore()).toEqual({ denominator: 5, numerator: 1 });
  });

  it('can convert to a float number', () => {
    const cbor = HexBlob('d81e820102');

    const interval = UnitInterval.fromCbor(cbor);

    expect(interval.toFloat()).toEqual(0.5);
  });

  it('can be created from a float number', () => {
    const interval = UnitInterval.fromFloat(0.5)!;

    expect(interval.toCore()).toEqual({ denominator: 2, numerator: 1 });
    expect(interval.toCbor()).toEqual('d81e820102');
  });
});

describe('UnitInterval above 2^53', () => {
  const cbor = HexBlob('d81e821b0d73913c3f2bb7951b0de0b6b3a7640000');

  it('keeps the exact fraction and re-encodes byte for byte', () => {
    const interval = UnitInterval.fromCbor(cbor);

    expect(interval.numerator()).toEqual(969_278_032_758_683_541n);
    expect(interval.denominator()).toEqual(1_000_000_000_000_000_000n);
    expect(interval.toCbor()).toEqual(cbor);
  });

  it('rounds the numerator in the core form', () => {
    expect(UnitInterval.fromCbor(cbor).toCore()).toEqual({
      denominator: 1_000_000_000_000_000_000,
      numerator: 969_278_032_758_683_500,
    });
  });
});
