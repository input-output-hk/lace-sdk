import { HexBlob } from '@lace-lib/cardano-util';

import * as Cardano from '../../src/Cardano';
import { TransactionUnspentOutput } from '../../src/Serialization';

// Test data used in the following tests was generated with the cardano-serialization-lib
const cbor = HexBlob(
  '82825820bb217abaca60fc0ca68c1555eca6a96d2478547818ae76ce6836133f3cc546e00182583900287a7e37219128cfb05322626daa8b19d1ad37c6779d21853f7b94177c16240714ea0e12b41a914f2945784ac494bb19573f0ca61a08afa8821af0078c21a2581c1ec85dcee27f2d90ec1f9a1e4ce74a667dc9be8b184463223f9c9601a14350584c05581c659f2917fb63f12b33667463ee575eeac1845bbc736b9c0bbc40ba82a14454534c410a',
);

const core = [
  {
    index: 1,
    txId: Cardano.TransactionId(
      'bb217abaca60fc0ca68c1555eca6a96d2478547818ae76ce6836133f3cc546e0',
    ),
  },
  {
    address: Cardano.PaymentAddress(
      'addr_test1qq585l3hyxgj3nas2v3xymd23vvartfhceme6gv98aaeg9muzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q2g7k3g',
    ),
    value: {
      assets: new Map([
        [
          Cardano.AssetId(
            '1ec85dcee27f2d90ec1f9a1e4ce74a667dc9be8b184463223f9c960150584c',
          ),
          5n,
        ],
        [
          Cardano.AssetId(
            '659f2917fb63f12b33667463ee575eeac1845bbc736b9c0bbc40ba8254534c41',
          ),
          10n,
        ],
      ]),
      coins: 4_027_026_465n,
    },
  },
] as Cardano.Utxo;

describe('TransactionUnspentOutput', () => {
  it('can decode TransactionUnspentOutput from CBOR', () => {
    const utxo = TransactionUnspentOutput.fromCbor(cbor);

    expect(utxo.input().toCore()).toEqual({
      index: 1,
      txId: Cardano.TransactionId(
        'bb217abaca60fc0ca68c1555eca6a96d2478547818ae76ce6836133f3cc546e0',
      ),
    });
    expect(utxo.output().toCore()).toEqual({
      address: Cardano.PaymentAddress(
        'addr_test1qq585l3hyxgj3nas2v3xymd23vvartfhceme6gv98aaeg9muzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q2g7k3g',
      ),
      value: {
        assets: new Map([
          [
            Cardano.AssetId(
              '1ec85dcee27f2d90ec1f9a1e4ce74a667dc9be8b184463223f9c960150584c',
            ),
            5n,
          ],
          [
            Cardano.AssetId(
              '659f2917fb63f12b33667463ee575eeac1845bbc736b9c0bbc40ba8254534c41',
            ),
            10n,
          ],
        ]),
        coins: 4_027_026_465n,
      },
    });
  });

  it('can decode TransactionUnspentOutput from Core', () => {
    const utxo = TransactionUnspentOutput.fromCore(core);

    expect(utxo.input().toCore()).toEqual({
      index: 1,
      txId: Cardano.TransactionId(
        'bb217abaca60fc0ca68c1555eca6a96d2478547818ae76ce6836133f3cc546e0',
      ),
    });
    expect(utxo.output().toCore()).toEqual({
      address: Cardano.PaymentAddress(
        'addr_test1qq585l3hyxgj3nas2v3xymd23vvartfhceme6gv98aaeg9muzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475q2g7k3g',
      ),
      value: {
        assets: new Map([
          [
            Cardano.AssetId(
              '1ec85dcee27f2d90ec1f9a1e4ce74a667dc9be8b184463223f9c960150584c',
            ),
            5n,
          ],
          [
            Cardano.AssetId(
              '659f2917fb63f12b33667463ee575eeac1845bbc736b9c0bbc40ba8254534c41',
            ),
            10n,
          ],
        ]),
        coins: 4_027_026_465n,
      },
    });
  });

  it('can encode TransactionUnspentOutput to CBOR', () => {
    const utxo = TransactionUnspentOutput.fromCore(core);

    expect(utxo.toCbor()).toEqual(cbor);
  });

  it('can encode TransactionUnspentOutput to Core', () => {
    const utxo = TransactionUnspentOutput.fromCbor(cbor);

    expect(utxo.toCore()).toEqual(core);
  });
});

describe('TransactionUnspentOutput inline datum of 0', () => {
  const cborWithInlineDatumOfZero = HexBlob(
    '82825820e023858050f8c136d9426f8adc8f194f08f020f96cd413cfa5806c6df31be8cd197defa400583910e1aa09455c5e1f8084da98c2d4f46f044eca9b69e440546ab8c91bb90af8e74fe63a594094bfaf1de7f540ef173ba6b44172bc54f270d11201821b083c63e600c53ed5a2581c4a1c412d8e2b3015a7fb7d382808fb7cb721bf93a56e8bb6661cdebea241310354a0922852f5e796b32f5fcee0d11011098574ca9802581c60b55c3d28fe9c98bb6010d72bf626f729f50fe18455dd567d30e525a2470bbef5ca07cbe9014d7a8aa8d5fcf68b885dcb1e8a031b4560a942742c916b028201d818410003d81849820082041a00cf3bdf',
  );

  it('keeps an inline datum of 0 when rebuilt from its core form', () => {
    const core = TransactionUnspentOutput.fromCbor(
      cborWithInlineDatumOfZero,
    ).toCore();
    const rebuilt = TransactionUnspentOutput.fromCore(core);

    expect(core[1].datum).toEqual(0n);
    expect(rebuilt.output().toCore().datum).toEqual(0n);
    expect(rebuilt.toCbor()).toEqual(cborWithInlineDatumOfZero);
  });
});
