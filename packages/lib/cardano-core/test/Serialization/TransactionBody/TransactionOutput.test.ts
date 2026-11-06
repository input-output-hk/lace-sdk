import { HexBlob } from '@lace-lib/cardano-util';

import * as Cardano from '../../../src/Cardano';
import { TransactionOutput } from '../../../src/Serialization';

// Test data used in the following tests was generated with the cardano-serialization-lib
const legacyOutputCbor = HexBlob(
  '83583900537ba48a023f0a3c65e54977ffc2d78c143fb418ef6db058e006d78a7c16240714ea0e12b41a914f2945784ac494bb19573f0ca61a08afa8821a000f4240a2581c00000000000000000000000000000000000000000000000000000000a3443031323218644433343536186344404142420a581c11111111111111111111111111111111111111111111111111111111a3443031323218644433343536186344404142420a58200000000000000000000000000000000000000000000000000000000000000000',
);

const legacyOutputNoDatumCbor = HexBlob(
  '82583900537ba48a023f0a3c65e54977ffc2d78c143fb418ef6db058e006d78a7c16240714ea0e12b41a914f2945784ac494bb19573f0ca61a08afa8821a000f4240a2581c00000000000000000000000000000000000000000000000000000000a3443031323218644433343536186344404142420a581c11111111111111111111111111111111111111111111111111111111a3443031323218644433343536186344404142420a',
);

const babbageAllFieldsCbor = HexBlob(
  'a400583900537ba48a023f0a3c65e54977ffc2d78c143fb418ef6db058e006d78a7c16240714ea0e12b41a914f2945784ac494bb19573f0ca61a08afa801821a000f4240a2581c00000000000000000000000000000000000000000000000000000000a3443031323218644433343536186344404142420a581c11111111111111111111111111111111111111111111111111111111a3443031323218644433343536186344404142420a028201d81849d8799f0102030405ff03d8185182014e4d01000033222220051200120011',
);

const babbageInlineDatumCbor = HexBlob(
  'a300583900537ba48a023f0a3c65e54977ffc2d78c143fb418ef6db058e006d78a7c16240714ea0e12b41a914f2945784ac494bb19573f0ca61a08afa801821a000f4240a2581c00000000000000000000000000000000000000000000000000000000a3443031323218644433343536186344404142420a581c11111111111111111111111111111111111111111111111111111111a3443031323218644433343536186344404142420a028201d81849d8799f0102030405ff',
);

const babbageDatumHashCbor = HexBlob(
  '83583900537ba48a023f0a3c65e54977ffc2d78c143fb418ef6db058e006d78a7c16240714ea0e12b41a914f2945784ac494bb19573f0ca61a08afa8821a000f4240a2581c00000000000000000000000000000000000000000000000000000000a3443031323218644433343536186344404142420a581c11111111111111111111111111111111111111111111111111111111a3443031323218644433343536186344404142420a58200000000000000000000000000000000000000000000000000000000000000000',
);

const babbageRefScriptCbor = HexBlob(
  'a300583900537ba48a023f0a3c65e54977ffc2d78c143fb418ef6db058e006d78a7c16240714ea0e12b41a914f2945784ac494bb19573f0ca61a08afa801821a000f4240a2581c00000000000000000000000000000000000000000000000000000000a3443031323218644433343536186344404142420a581c11111111111111111111111111111111111111111111111111111111a3443031323218644433343536186344404142420a03d8185182014e4d01000033222220051200120011',
);

const babbageNoOptionalFieldScriptCbor = HexBlob(
  '82583900537ba48a023f0a3c65e54977ffc2d78c143fb418ef6db058e006d78a7c16240714ea0e12b41a914f2945784ac494bb19573f0ca61a08afa8821a000f4240a2581c00000000000000000000000000000000000000000000000000000000a3443031323218644433343536186344404142420a581c11111111111111111111111111111111111111111111111111111111a3443031323218644433343536186344404142420a',
);

const maryOutputPointerCbor = HexBlob(
  '825826412813b99a80cfb4024374bd0f502959485aa56e0648564ff805f2e51bbcd9819561bddc66141a02faf080',
);

const canonicallySortedAssets = new Map([
  [
    '0000000000000000000000000000000000000000000000000000000030313232' as unknown as Cardano.AssetId,
    100n,
  ],
  [
    '0000000000000000000000000000000000000000000000000000000033343536' as unknown as Cardano.AssetId,
    99n,
  ],
  [
    '0000000000000000000000000000000000000000000000000000000040414242' as unknown as Cardano.AssetId,
    10n,
  ],
  [
    '1111111111111111111111111111111111111111111111111111111130313232' as unknown as Cardano.AssetId,
    100n,
  ],
  [
    '1111111111111111111111111111111111111111111111111111111133343536' as unknown as Cardano.AssetId,
    99n,
  ],
  [
    '1111111111111111111111111111111111111111111111111111111140414242' as unknown as Cardano.AssetId,
    10n,
  ],
]);

const basicOutput = {
  address: Cardano.PaymentAddress(
    'addr_test1qpfhhfy2qgls50r9u4yh0l7z67xpg0a5rrhkmvzcuqrd0znuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q9gw0lz',
  ),
  datum: undefined,
  datumHash: undefined,
  scriptReference: undefined,
  value: {
    assets: canonicallySortedAssets,
    coins: 1_000_000n,
  },
} as Cardano.TxOut;

const outputWithInlineDataCore = {
  ...basicOutput,
  datum: {
    cbor: HexBlob('d8799f0102030405ff'),
    constructor: 0n,
    fields: { cbor: HexBlob('9f0102030405ff'), items: [1n, 2n, 3n, 4n, 5n] },
  },
} as Cardano.TxOut;

const outputWithHashDataCore = {
  ...basicOutput,
  datumHash: HexBlob(
    '0000000000000000000000000000000000000000000000000000000000000000',
  ) as unknown as Cardano.DatumHash,
} as Cardano.TxOut;

const outputWithRefScriptCore = {
  ...basicOutput,
  scriptReference: {
    __type: 'plutus',
    bytes: HexBlob('4d01000033222220051200120011'),
    version: 0,
  },
} as Cardano.TxOut;

const outputWithBothRefScriptAndDatumCore = {
  ...basicOutput,
  datum: {
    cbor: HexBlob('d8799f0102030405ff'),
    constructor: 0n,
    fields: { cbor: HexBlob('9f0102030405ff'), items: [1n, 2n, 3n, 4n, 5n] },
  },
  scriptReference: {
    __type: 'plutus',
    bytes: HexBlob('4d01000033222220051200120011'),
    version: 0,
  },
} as Cardano.TxOut;

describe('TransactionOutput', () => {
  describe('Legacy', () => {
    describe('With datum', () => {
      it('can decode TransactionOutput from CBOR', () => {
        const output = TransactionOutput.fromCbor(legacyOutputCbor);

        expect(output.address().toBech32()).toEqual(
          'addr_test1qpfhhfy2qgls50r9u4yh0l7z67xpg0a5rrhkmvzcuqrd0znuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q9gw0lz',
        );
        expect(output.amount().coin()).toEqual(1_000_000n);
        expect(output.amount().multiasset()).toEqual(canonicallySortedAssets);
        expect(output.scriptRef()).toBeUndefined();
        expect(output.datum()?.asDataHash()).toEqual(
          '0000000000000000000000000000000000000000000000000000000000000000',
        );
      });

      it('can decode TransactionOutput from Core', () => {
        const output = TransactionOutput.fromCore(outputWithHashDataCore);

        expect(output.address().toBech32()).toEqual(
          'addr_test1qpfhhfy2qgls50r9u4yh0l7z67xpg0a5rrhkmvzcuqrd0znuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q9gw0lz',
        );
        expect(output.amount().coin()).toEqual(1_000_000n);
        expect(output.amount().multiasset()).toEqual(canonicallySortedAssets);
        expect(output.scriptRef()).toBeUndefined();
        expect(output.datum()?.asDataHash()).toEqual(
          '0000000000000000000000000000000000000000000000000000000000000000',
        );
      });

      it('can encode TransactionOutput to CBOR', () => {
        const output = TransactionOutput.fromCore(outputWithHashDataCore);

        expect(output.toCbor()).toEqual(legacyOutputCbor);
      });

      it('can encode TransactionOutput to Core', () => {
        const output = TransactionOutput.fromCbor(legacyOutputCbor);
        expect(output.toCore()).toEqual(outputWithHashDataCore);
      });

      it('can decode PointerAddress Output to Core', () => {
        const output = TransactionOutput.fromCbor(maryOutputPointerCbor);
        const address = output.address();
        const hash = address.asPointer()?.getPaymentCredential().hash;
        expect(hash).toEqual(
          '2813b99a80cfb4024374bd0f502959485aa56e0648564ff805f2e51b',
        );
        const pointer = address.asPointer()?.getStakePointer();
        expect(pointer?.slot).toEqual(16_292_793_057n);
        expect(pointer?.certIndex).toEqual(20);
        expect(pointer?.txIndex).toEqual(1_011_302);
        expect(address.toBech32()).toEqual(
          'addr1gy5p8wv6sr8mgqjrwj7s75pft9y94ftwqey9vnlcqhew2xaumxqe2cdam3npgv60hqa',
        );
      });
    });

    describe('With no datum', () => {
      it('can decode TransactionOutput from CBOR', () => {
        const output = TransactionOutput.fromCbor(legacyOutputNoDatumCbor);

        expect(output.address().toBech32()).toEqual(
          'addr_test1qpfhhfy2qgls50r9u4yh0l7z67xpg0a5rrhkmvzcuqrd0znuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q9gw0lz',
        );
        expect(output.amount().coin()).toEqual(1_000_000n);
        expect(output.amount().multiasset()).toEqual(canonicallySortedAssets);
        expect(output.scriptRef()).toBeUndefined();
        expect(output.datum()).toBeUndefined();
      });

      it('can decode TransactionOutput from Core', () => {
        const output = TransactionOutput.fromCore(basicOutput);

        expect(output.address().toBech32()).toEqual(
          'addr_test1qpfhhfy2qgls50r9u4yh0l7z67xpg0a5rrhkmvzcuqrd0znuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q9gw0lz',
        );
        expect(output.amount().coin()).toEqual(1_000_000n);
        expect(output.amount().multiasset()).toEqual(canonicallySortedAssets);
        expect(output.scriptRef()).toBeUndefined();
        expect(output.datum()).toBeUndefined();
      });

      it('can encode TransactionOutput to CBOR', () => {
        const output = TransactionOutput.fromCore(basicOutput);

        expect(output.toCbor()).toEqual(legacyOutputNoDatumCbor);
      });

      it('can encode TransactionOutput to Core', () => {
        const output = TransactionOutput.fromCbor(legacyOutputNoDatumCbor);
        expect(output.toCore()).toEqual(basicOutput);
      });
    });
  });
  describe('Babbage', () => {
    describe('All fields', () => {
      it('can decode TransactionOutput from CBOR', () => {
        const output = TransactionOutput.fromCbor(babbageAllFieldsCbor);

        expect(output.address().toBech32()).toEqual(
          'addr_test1qpfhhfy2qgls50r9u4yh0l7z67xpg0a5rrhkmvzcuqrd0znuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q9gw0lz',
        );
        expect(output.amount().coin()).toEqual(1_000_000n);
        expect(output.amount().multiasset()).toEqual(canonicallySortedAssets);
        expect(output.scriptRef()!.toCore()).toEqual({
          __type: 'plutus',
          bytes: '4d01000033222220051200120011',
          version: 0,
        });
        expect(output.datum()?.asInlineData()?.toCore()).toEqual({
          cbor: HexBlob('d8799f0102030405ff'),
          constructor: 0n,
          fields: {
            cbor: HexBlob('9f0102030405ff'),
            items: [1n, 2n, 3n, 4n, 5n],
          },
        });
      });

      it('can decode TransactionOutput from Core', () => {
        const output = TransactionOutput.fromCore(
          outputWithBothRefScriptAndDatumCore,
        );

        expect(output.address().toBech32()).toEqual(
          'addr_test1qpfhhfy2qgls50r9u4yh0l7z67xpg0a5rrhkmvzcuqrd0znuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q9gw0lz',
        );
        expect(output.amount().coin()).toEqual(1_000_000n);
        expect(output.amount().multiasset()).toEqual(canonicallySortedAssets);
        expect(output.scriptRef()!.toCore()).toEqual({
          __type: 'plutus',
          bytes: '4d01000033222220051200120011',
          version: 0,
        });
        expect(output.datum()?.asInlineData()?.toCore()).toEqual({
          cbor: HexBlob('d8799f0102030405ff'),
          constructor: 0n,
          fields: {
            cbor: HexBlob('9f0102030405ff'),
            items: [1n, 2n, 3n, 4n, 5n],
          },
        });
      });

      it('can encode TransactionOutput to CBOR', () => {
        const output = TransactionOutput.fromCore(
          outputWithBothRefScriptAndDatumCore,
        );

        expect(output.toCbor()).toEqual(babbageAllFieldsCbor);
      });

      it('can encode TransactionOutput to Core', () => {
        const output = TransactionOutput.fromCbor(babbageAllFieldsCbor);
        expect(output.toCore()).toEqual(outputWithBothRefScriptAndDatumCore);
      });
    });

    describe('Inline Datum', () => {
      it('can decode TransactionOutput from CBOR', () => {
        const output = TransactionOutput.fromCbor(babbageInlineDatumCbor);

        expect(output.address().toBech32()).toEqual(
          'addr_test1qpfhhfy2qgls50r9u4yh0l7z67xpg0a5rrhkmvzcuqrd0znuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q9gw0lz',
        );
        expect(output.amount().coin()).toEqual(1_000_000n);
        expect(output.amount().multiasset()).toEqual(canonicallySortedAssets);
        expect(output.scriptRef()).toBeUndefined();
        expect(output.datum()?.asInlineData()?.toCore()).toEqual({
          cbor: HexBlob('d8799f0102030405ff'),
          constructor: 0n,
          fields: {
            cbor: HexBlob('9f0102030405ff'),
            items: [1n, 2n, 3n, 4n, 5n],
          },
        });
      });

      it('can decode TransactionOutput from Core', () => {
        const output = TransactionOutput.fromCore(outputWithInlineDataCore);

        expect(output.address().toBech32()).toEqual(
          'addr_test1qpfhhfy2qgls50r9u4yh0l7z67xpg0a5rrhkmvzcuqrd0znuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q9gw0lz',
        );
        expect(output.amount().coin()).toEqual(1_000_000n);
        expect(output.amount().multiasset()).toEqual(canonicallySortedAssets);
        expect(output.scriptRef()).toBeUndefined();
        expect(output.datum()?.asInlineData()?.toCore()).toEqual({
          cbor: HexBlob('d8799f0102030405ff'),
          constructor: 0n,
          fields: {
            cbor: HexBlob('9f0102030405ff'),
            items: [1n, 2n, 3n, 4n, 5n],
          },
        });
      });

      it('can encode TransactionOutput to CBOR', () => {
        const output = TransactionOutput.fromCore(outputWithInlineDataCore);

        expect(output.toCbor()).toEqual(babbageInlineDatumCbor);
      });

      it('can encode TransactionOutput to Core', () => {
        const output = TransactionOutput.fromCbor(babbageInlineDatumCbor);
        expect(output.toCore()).toEqual(outputWithInlineDataCore);
      });
    });

    describe('Datum Hash', () => {
      it('can decode TransactionOutput from CBOR', () => {
        const output = TransactionOutput.fromCbor(babbageDatumHashCbor);

        expect(output.address().toBech32()).toEqual(
          'addr_test1qpfhhfy2qgls50r9u4yh0l7z67xpg0a5rrhkmvzcuqrd0znuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q9gw0lz',
        );
        expect(output.amount().coin()).toEqual(1_000_000n);
        expect(output.amount().multiasset()).toEqual(canonicallySortedAssets);
        expect(output.scriptRef()).toBeUndefined();
        expect(output.datum()?.asDataHash()).toEqual(
          HexBlob(
            '0000000000000000000000000000000000000000000000000000000000000000',
          ) as unknown as Cardano.DatumHash,
        );
      });

      it('can decode TransactionOutput from Core', () => {
        const output = TransactionOutput.fromCore(outputWithHashDataCore);

        expect(output.address().toBech32()).toEqual(
          'addr_test1qpfhhfy2qgls50r9u4yh0l7z67xpg0a5rrhkmvzcuqrd0znuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q9gw0lz',
        );
        expect(output.amount().coin()).toEqual(1_000_000n);
        expect(output.amount().multiasset()).toEqual(canonicallySortedAssets);
        expect(output.scriptRef()).toBeUndefined();
        expect(output.datum()?.asDataHash()).toEqual(
          HexBlob(
            '0000000000000000000000000000000000000000000000000000000000000000',
          ) as unknown as Cardano.DatumHash,
        );
      });

      it('can encode TransactionOutput to CBOR', () => {
        const output = TransactionOutput.fromCore(outputWithHashDataCore);

        expect(output.toCbor()).toEqual(babbageDatumHashCbor);
      });

      it('can encode TransactionOutput to Core', () => {
        const output = TransactionOutput.fromCbor(babbageDatumHashCbor);
        expect(output.toCore()).toEqual(outputWithHashDataCore);
      });
    });

    describe('Script Reference', () => {
      it('can decode TransactionOutput from CBOR', () => {
        const output = TransactionOutput.fromCbor(babbageRefScriptCbor);

        expect(output.address().toBech32()).toEqual(
          'addr_test1qpfhhfy2qgls50r9u4yh0l7z67xpg0a5rrhkmvzcuqrd0znuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q9gw0lz',
        );
        expect(output.amount().coin()).toEqual(1_000_000n);
        expect(output.amount().multiasset()).toEqual(canonicallySortedAssets);
        expect(output.scriptRef()?.toCore()).toEqual({
          __type: 'plutus',
          bytes: HexBlob('4d01000033222220051200120011'),
          version: 0,
        });
        expect(output.datum()).toBeUndefined();
      });

      it('can decode TransactionOutput from Core', () => {
        const output = TransactionOutput.fromCore(outputWithRefScriptCore);

        expect(output.address().toBech32()).toEqual(
          'addr_test1qpfhhfy2qgls50r9u4yh0l7z67xpg0a5rrhkmvzcuqrd0znuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q9gw0lz',
        );
        expect(output.amount().coin()).toEqual(1_000_000n);
        expect(output.amount().multiasset()).toEqual(canonicallySortedAssets);
        expect(output.scriptRef()?.toCore()).toEqual({
          __type: 'plutus',
          bytes: HexBlob('4d01000033222220051200120011'),
          version: 0,
        });
        expect(output.datum()).toBeUndefined();
      });

      it('can encode TransactionOutput to CBOR', () => {
        const output = TransactionOutput.fromCore(outputWithRefScriptCore);

        expect(output.toCbor()).toEqual(babbageRefScriptCbor);
      });

      it('can encode TransactionOutput to Core', () => {
        const output = TransactionOutput.fromCbor(babbageRefScriptCbor);
        expect(output.toCore()).toEqual(outputWithRefScriptCore);
      });
    });

    describe('No Optional fields', () => {
      it('can decode TransactionOutput from CBOR', () => {
        const output = TransactionOutput.fromCbor(
          babbageNoOptionalFieldScriptCbor,
        );

        expect(output.address().toBech32()).toEqual(
          'addr_test1qpfhhfy2qgls50r9u4yh0l7z67xpg0a5rrhkmvzcuqrd0znuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q9gw0lz',
        );
        expect(output.amount().coin()).toEqual(1_000_000n);
        expect(output.amount().multiasset()).toEqual(canonicallySortedAssets);
        expect(output.scriptRef()).toBeUndefined();
        expect(output.datum()).toBeUndefined();
      });

      it('can encode TransactionOutput to CBOR', () => {
        const output = TransactionOutput.fromCore(basicOutput);

        expect(output.toCbor()).toEqual(babbageNoOptionalFieldScriptCbor);
      });

      it('can encode TransactionOutput to Core', () => {
        const output = TransactionOutput.fromCbor(
          babbageNoOptionalFieldScriptCbor,
        );
        expect(output.toCore()).toEqual(basicOutput);
      });
    });

    describe('isBabbageOutput', () => {
      it('cant distinguish a babbage output from a legacy output', () => {
        const babbageOut = TransactionOutput.fromCbor(babbageAllFieldsCbor);
        const legacyOutput = TransactionOutput.fromCbor(
          legacyOutputNoDatumCbor,
        );
        expect(babbageOut.isBabbageOutput()).toBe(true);
        expect(legacyOutput.isBabbageOutput()).toBe(false);
      });
    });
  });
});

describe('TransactionOutput unknown map keys', () => {
  // {0: address, 1: 10, 4: [1, 2]} - key 4 is not part of the post-alonzo output CDDL
  const cborWithUnknownKey = HexBlob(
    'a300583900537ba48a023f0a3c65e54977ffc2d78c143fb418ef6db058e006d78a7c16240714ea0e12b41a914f2945784ac494bb19573f0ca61a08afa8010a04820102',
  );

  it('skips unknown keys by default', () => {
    const output = TransactionOutput.fromCbor(cborWithUnknownKey);

    expect(output.amount().coin()).toEqual(10n);
  });

  it('throws on unknown keys when strict', () => {
    expect(() =>
      TransactionOutput.fromCbor(cborWithUnknownKey, { strict: true }),
    ).toThrow('Unknown transaction output map key: 4');
  });
});

describe('TransactionOutput repeated map keys', () => {
  const cborWithRepeatedKey = HexBlob(
    'a300583900537ba48a023f0a3c65e54977ffc2d78c143fb418ef6db058e006d78a7c16240714ea0e12b41a914f2945784ac494bb19573f0ca61a08afa8010a0114',
  );

  it('rejects a key that appears twice', () => {
    expect(() => TransactionOutput.fromCbor(cborWithRepeatedKey)).toThrow(
      'Duplicate transaction output map key: 1',
    );
  });
});

describe('TransactionOutput unknown datum kind', () => {
  it('fromCbor throws', () => {
    // {0: address, 1: 10, 2: [2, h'00']} - datum_option kind 2 is unknown
    const cborWithUnknownDatumKind = HexBlob(
      'a300583900537ba48a023f0a3c65e54977ffc2d78c143fb418ef6db058e006d78a7c16240714ea0e12b41a914f2945784ac494bb19573f0ca61a08afa8010a0282024100',
    );

    expect(() => TransactionOutput.fromCbor(cborWithUnknownDatumKind)).toThrow(
      'Unexpected datum kind 2',
    );
  });
});

describe('TransactionOutput inline datum of 0', () => {
  const outputWithTimelockScriptRefCbor = HexBlob(
    'a400583910e1aa09455c5e1f8084da98c2d4f46f044eca9b69e440546ab8c91bb90af8e74fe63a594094bfaf1de7f540ef173ba6b44172bc54f270d11201821b083c63e600c53ed5a2581c4a1c412d8e2b3015a7fb7d382808fb7cb721bf93a56e8bb6661cdebea241310354a0922852f5e796b32f5fcee0d11011098574ca9802581c60b55c3d28fe9c98bb6010d72bf626f729f50fe18455dd567d30e525a2470bbef5ca07cbe9014d7a8aa8d5fcf68b885dcb1e8a031b4560a942742c916b028201d818410003d81849820082041a00cf3bdf',
  );
  const outputWithSignatureScriptRefCbor = HexBlob(
    'a400583910532c81dfc12af857c57369069d52d256f95d6a99a8b20b9dc8fde0803f5c5f261fd45ae034dd22d6ff628d310e1f061b021fb04bd4fdad0001821b294c4e1a78cc608aa1581c467f58932b54910584a0e8ea25a225e06a14530b2e96e938c53a3f22a1581fb8ccaa71eb952baba23871de9ca2817b0d603551e00cd73ce4fad7e62b61bb1b48c612cf5ab6552d028201d818410003d818582282008200581c5ca7c5cc7508064f450bee9ae88a8f5a264d0f0473930553cf0e7a34',
  );

  it.each([
    [
      'an output with a time lock reference script',
      outputWithTimelockScriptRefCbor,
    ],
    [
      'an output with a signature reference script',
      outputWithSignatureScriptRefCbor,
    ],
  ])(
    'keeps an inline datum of 0 when %s is rebuilt from its core form',
    (_, cbor) => {
      const core = TransactionOutput.fromCbor(cbor).toCore();
      const rebuilt = TransactionOutput.fromCore(core);

      expect(core.datum).toEqual(0n);
      expect(rebuilt.toCore().datum).toEqual(0n);
      expect(rebuilt.toCbor()).toEqual(cbor);
    },
  );

  it('keeps an inline datum of 0 from a core output', () => {
    const output = TransactionOutput.fromCore({
      ...basicOutput,
      datum: 0n,
    } as Cardano.TxOut);

    expect(output.datum()?.asInlineData()?.toCore()).toEqual(0n);
    expect(output.toCore().datum).toEqual(0n);
    expect(TransactionOutput.fromCbor(output.toCbor()).toCore().datum).toEqual(
      0n,
    );
  });
});
