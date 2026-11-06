import { HexBlob } from '@lace-lib/cardano-util';

import { ExUnits } from '../../../src/Serialization';

import type * as Cardano from '../../../src/Cardano';

// Test data used in the following tests was generated with the cardano-serialization-lib
describe('ExUnits', () => {
  it('can decode ExUnits from CBOR', () => {
    const cbor = HexBlob('821b000086788ffc4e831b00015060e9e46451');

    const units = ExUnits.fromCbor(cbor);

    expect(units.mem()).toEqual(147_852_369_874_563n);
    expect(units.steps()).toEqual(369_852_147_852_369n);
  });

  it('can decode ExUnits from Core', () => {
    const core = {
      memory: 147_852_369_874_563,
      steps: 369_852_147_852_369,
    } as Cardano.ExUnits;

    const units = ExUnits.fromCore(core);

    expect(units.mem()).toEqual(147_852_369_874_563n);
    expect(units.steps()).toEqual(369_852_147_852_369n);
  });

  it('can encode ExUnits to CBOR', () => {
    const core = {
      memory: 147_852_369_874_563,
      steps: 369_852_147_852_369,
    } as Cardano.ExUnits;

    const units = ExUnits.fromCore(core);

    expect(units.toCbor()).toEqual('821b000086788ffc4e831b00015060e9e46451');
  });

  it('can encode ExUnits to Core', () => {
    const cbor = HexBlob('821b000086788ffc4e831b00015060e9e46451');

    const units = ExUnits.fromCbor(cbor);

    expect(units.toCore()).toEqual({
      memory: 147_852_369_874_563,
      steps: 369_852_147_852_369,
    });
  });
});

describe('ExUnits above 2^53', () => {
  const cbor = HexBlob('821b5b9a9fba6338f9931b1a689136df261ba5');

  it('keeps the exact units and re-encodes byte for byte', () => {
    const units = ExUnits.fromCbor(cbor);

    expect(units.mem()).toEqual(6_600_763_826_742_294_931n);
    expect(units.steps()).toEqual(1_902_930_507_422_112_677n);
    expect(units.toCbor()).toEqual(cbor);
  });

  it('rounds the units in the core form', () => {
    expect(ExUnits.fromCbor(cbor).toCore()).toEqual({
      memory: 6_600_763_826_742_295_000,
      steps: 1_902_930_507_422_112_800,
    });
  });
});
