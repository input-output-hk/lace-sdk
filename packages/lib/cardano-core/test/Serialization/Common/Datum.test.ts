import { HexBlob } from '@lace-lib/cardano-util';

import { Datum, DatumKind } from '../../../src/Serialization';

import type * as Cardano from '../../../src/Cardano';

// Test data used in the following tests was generated with the cardano-serialization-lib

const datumHashCbor = HexBlob(
  '820058200000000000000000000000000000000000000000000000000000000000000000',
);
const inlineDatumCbor = HexBlob('8201d81849d8799f0102030405ff');
const untaggedInlineDatumCbor = HexBlob('8201d8799f0102030405ff');
const integerInlineDatumCbor = HexBlob('8201d818421865');

const datumHashCore = HexBlob(
  '0000000000000000000000000000000000000000000000000000000000000000',
) as unknown as Cardano.DatumHash;

const inlineDatumCore = {
  cbor: HexBlob('d8799f0102030405ff'),
  constructor: 0n,
  fields: { cbor: HexBlob('9f0102030405ff'), items: [1n, 2n, 3n, 4n, 5n] },
};

describe('Datum', () => {
  it('can decode Datum hash from CBOR', () => {
    const datum = Datum.fromCbor(datumHashCbor);

    expect(datum.kind()).toEqual(DatumKind.DataHash);
    expect(datum.asInlineData()).toBeUndefined();
    expect(datum.asDataHash()).toEqual(datumHashCore);
  });

  it('can decode Datum hash from Core', () => {
    const datum = Datum.fromCore(datumHashCore);

    expect(datum.kind()).toEqual(DatumKind.DataHash);
    expect(datum.asInlineData()).toBeUndefined();
    expect(datum.asDataHash()).toEqual(datumHashCore);
  });

  it('can encode Datum hash to CBOR', () => {
    const datum = Datum.fromCore(datumHashCore);

    expect(datum.toCbor()).toEqual(datumHashCbor);
  });

  it('can encode Datum hash to Core', () => {
    const datum = Datum.fromCbor(datumHashCbor);

    expect(datum.toCore()).toEqual(datumHashCore);
  });

  it('can decode inline Datum from CBOR', () => {
    const datum = Datum.fromCbor(inlineDatumCbor);

    expect(datum.kind()).toEqual(DatumKind.InlineData);
    expect(datum.asDataHash()).toBeUndefined();
    expect(datum.asInlineData()?.toCbor()).toEqual('d8799f0102030405ff');
  });

  it('can decode inline Datum from Core', () => {
    const datum = Datum.fromCore(inlineDatumCore);

    expect(datum.kind()).toEqual(DatumKind.InlineData);
    expect(datum.asDataHash()).toBeUndefined();
    expect(datum.asInlineData()?.toCbor()).toEqual('d8799f0102030405ff');
  });

  it('can encode inline Datum to CBOR', () => {
    const datum = Datum.fromCore(inlineDatumCore);

    expect(datum.toCbor()).toEqual(inlineDatumCbor);
  });

  it('can encode inline Datum to Core', () => {
    const datum = Datum.fromCbor(inlineDatumCbor);

    expect(datum.toCore()).toEqual(inlineDatumCore);
  });

  it('round trips an inline Datum byte for byte', () => {
    expect(Datum.fromCbor(inlineDatumCbor).toCbor()).toEqual(inlineDatumCbor);
    expect(Datum.fromCbor(integerInlineDatumCbor).toCbor()).toEqual(
      integerInlineDatumCbor,
    );
  });

  it('encodes the same inline Datum when rebuilt from its core form', () => {
    const datum = Datum.fromCbor(inlineDatumCbor);
    const integerDatum = Datum.fromCbor(integerInlineDatumCbor);

    expect(Datum.fromCore(datum.toCore()).toCbor()).toEqual(inlineDatumCbor);
    expect(Datum.fromCore(integerDatum.toCore()).toCbor()).toEqual(
      integerInlineDatumCbor,
    );
  });

  it('decodes an integer inline Datum', () => {
    const datum = Datum.fromCbor(integerInlineDatumCbor);

    expect(datum.kind()).toEqual(DatumKind.InlineData);
    expect(datum.toCore()).toEqual(101n);
  });

  it('hashes the data of an inline Datum', () => {
    expect(Datum.fromCbor(inlineDatumCbor).asInlineData()?.hash()).toEqual(
      '5841885ef0f848d0f3a1133c65c66aa0a36a4d6e8b0c40b59ba6fb2993044a8f',
    );
    expect(
      Datum.fromCbor(integerInlineDatumCbor).asInlineData()?.hash(),
    ).toEqual(
      '4250ea713ad7ba3b121621a8d14d8e39a4300065314b7ce9a40526acf992c8e3',
    );
  });

  it.each([
    [
      27,
      HexBlob(
        '8200581b0000000000000000000000000000000000000000000000000000000000',
      ),
    ],
    [
      33,
      HexBlob(
        '82005821000000000000000000000000000000000000000000000000000000000000000000',
      ),
    ],
  ])('rejects a Datum hash of %i bytes', (size, cbor) => {
    expect(() => Datum.fromCbor(cbor)).toThrow(
      `Expected a datum hash of 32 bytes, but got ${size} bytes`,
    );
  });

  it('rejects an inline Datum that is not wrapped in an encoded CBOR data item', () => {
    expect(() => Datum.fromCbor(untaggedInlineDatumCbor)).toThrow(
      'Expected tag 24 but got 121',
    );
  });
});
