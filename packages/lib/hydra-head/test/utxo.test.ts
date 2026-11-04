import { describe, expect, it } from 'vitest';

import { fromBlockfrostUtxo, fromCardanoUtxo } from '../src';

import { toCardanoUtxo } from './fixtures/cardano';
import { datumOf } from './fixtures/plutus';
import { preprodUtxos } from './fixtures/preprod';

import type { Cardano } from '@cardano-sdk/core';

describe('fromBlockfrostUtxo', () => {
  it('splits lovelace from native assets and keeps the datum', () => {
    const utxo = preprodUtxos.headV2Open;
    expect(fromBlockfrostUtxo(utxo)).toEqual({
      txId: utxo.tx_hash,
      index: 0,
      address: utxo.address,
      value: {
        coins: 2_094_660n,
        assets: new Map([
          [
            '324c8b8198c4c9db7526d6dccb79e992c4863b24b56453bb16995bdc4879647261486561645632',
            1n,
          ],
          [
            '324c8b8198c4c9db7526d6dccb79e992c4863b24b56453bb16995bdcba1e067abfb07ecd833cec7005a8aa89cbdf09e10d6c87bb73da9e35',
            1n,
          ],
        ]),
      },
      inlineDatum: datumOf(utxo),
    });
  });

  it('omits a missing datum', () => {
    expect(
      fromBlockfrostUtxo({ ...preprodUtxos.depositV2, inline_datum: null }),
    ).not.toHaveProperty('inlineDatum');
  });
});

describe('fromCardanoUtxo', () => {
  it.each(Object.entries(preprodUtxos))(
    'matches the Blockfrost conversion for %s',
    (_, utxo) => {
      expect(fromCardanoUtxo(toCardanoUtxo(utxo))).toEqual(
        fromBlockfrostUtxo(utxo),
      );
    },
  );

  it('drops a datum that cannot be serialized', () => {
    const [txIn, txOut] = toCardanoUtxo(preprodUtxos.depositV2);
    const unserializable = { constructor: 0n, fields: { items: [1.5] } };
    expect(
      fromCardanoUtxo([
        txIn,
        { ...txOut, datum: unserializable as unknown as Cardano.PlutusData },
      ]),
    ).not.toHaveProperty('inlineDatum');
  });
});
