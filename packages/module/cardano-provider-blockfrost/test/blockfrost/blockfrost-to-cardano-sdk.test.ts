import { Cardano, Serialization } from '@lace-lib/cardano-core';
import { Hash28ByteBase16, Hash32ByteBase16 } from '@lace-lib/cardano-crypto';
import { classifyCustodyAccountUtxos } from '@lace-lib/cardano-custody';
import { BlockfrostToCardanoSDK } from '@lace-lib/cardano-provider-core';
import { HexBlob } from '@lace-lib/cardano-util';
import { describe, expect, it } from 'vitest';

import type { BlockfrostUtxo } from '@lace-lib/cardano-provider-core';

const ADDRESS =
  'addr_test1wpnlxv2xv9a9ucvnvzqakwepzl9ltx7jzgm53av2e9ncv4sysemm8';
// The unit datum, Plutus Constr 0 [], and the hash the ledger gives it, which
// Blockfrost reports as data_hash for an output that carries the datum inline.
// Pinned from the chain, not computed, so the hashing is held to the ledger.
const INLINE_DATUM = 'd87980';
const DATUM_HASH = Hash32ByteBase16(
  '923918e403bf43c34b4ef6b48eb2ee04babed17320d8d1b9ff9ad086e86f44ec',
);

const blockfrostUtxo = (
  datum: Pick<BlockfrostUtxo, 'data_hash' | 'inline_datum'>,
): BlockfrostUtxo => ({
  address: ADDRESS,
  tx_hash: '39a7a284c2a0948189dc45dec670211cd4d72f7b66c5726c08d9b3df11e44d58',
  tx_index: 0,
  output_index: 0,
  amount: [{ unit: 'lovelace', quantity: '5000000' }],
  block: '7eb8e27d18686c7db9a18f8bbcfe34e3fed6e047afaa2d969904d15e934847e6',
  reference_script_hash: null,
  ...datum,
});

describe('BlockfrostToCardanoSDK.addressUtxoContent', () => {
  it('keeps the inline datum when Blockfrost also reports its hash', () => {
    const [, output] = BlockfrostToCardanoSDK.addressUtxoContent(
      ADDRESS,
      blockfrostUtxo({ inline_datum: INLINE_DATUM, data_hash: DATUM_HASH }),
    );

    expect(output.datumHash).toBeUndefined();
    const serialized = Serialization.TransactionOutput.fromCore(output);
    expect(serialized.datum()?.kind()).toBe(Serialization.DatumKind.InlineData);
    expect(serialized.toCore().datum).toEqual(
      Serialization.PlutusData.fromCbor(HexBlob(INLINE_DATUM)).toCore(),
    );
  });

  it('keeps the datum hash of an output that carries no inline datum', () => {
    const [, output] = BlockfrostToCardanoSDK.addressUtxoContent(
      ADDRESS,
      blockfrostUtxo({ inline_datum: null, data_hash: DATUM_HASH }),
    );

    expect(output.datum).toBeUndefined();
    expect(output.datumHash).toBe(DATUM_HASH);
    expect(Serialization.TransactionOutput.fromCore(output).toCore()).toEqual({
      address: Cardano.PaymentAddress(ADDRESS),
      value: { coins: 5_000_000n },
      datumHash: DATUM_HASH,
    });
  });

  it.each([
    ['nested 64 levels deep', '81'.repeat(64) + '00'],
    [
      'of 16 KB, the largest a transaction holds today',
      '59' + '3ffd' + '00'.repeat(16_381),
    ],
    [
      'of 64 KB, the headroom over the transaction size',
      '59' + 'fffd' + '00'.repeat(65_533),
    ],
  ])('decodes an inline datum %s', (_, datum) => {
    const [, output] = BlockfrostToCardanoSDK.addressUtxoContent(
      ADDRESS,
      blockfrostUtxo({ inline_datum: datum, data_hash: null }),
    );

    expect(output.datum).toEqual(
      Serialization.PlutusData.fromCbor(HexBlob(datum)).toCore(),
    );
  });

  /**
   * Datums the converter refuses, each with the BLAKE2b-256 hash of its
   * bytes, pinned so the test does not derive its expectation from the code
   * under test.
   */
  const refusedDatums = [
    [
      'nested deeper than 64 levels',
      '81'.repeat(65) + '00',
      'ab02a2f320bac6517c7aefe03e8a60b4eab6a9b5ae3e38d79a8f51d65f4d99cb',
    ],
    [
      'nested 2,000 levels deep',
      '81'.repeat(2000) + '00',
      'c86bbaa91ac8fb830da2ef35c567c3f865e39f0a8c9ee25c3ca056a2aa125464',
    ],
    [
      'larger than 64 KB',
      '5a' + '00010001' + '00'.repeat(65_537),
      '66c3cb64b5b98b0ee71fe564d9739146ae873571b76834ec9432b09bbb050248',
    ],
    [
      'malformed',
      'ff',
      'ac4e4076a883937282f1377ef5cacb8edd00e3c79629e43532464eb3be277367',
    ],
    ['not hex', 'not-hex', undefined],
  ] as const;

  it.each(refusedDatums)(
    'keeps the datum hash Blockfrost reports for an output whose inline datum is %s',
    (_, datum) => {
      const start = performance.now();
      const [, output] = BlockfrostToCardanoSDK.addressUtxoContent(
        ADDRESS,
        blockfrostUtxo({ inline_datum: datum, data_hash: DATUM_HASH }),
      );

      expect(performance.now() - start).toBeLessThan(1000);
      expect(output).toEqual({
        address: Cardano.PaymentAddress(ADDRESS),
        value: { coins: 5_000_000n },
        datumHash: DATUM_HASH,
      });
    },
  );

  it.each(refusedDatums.slice(0, -1))(
    'hashes the refused inline datum %s itself when Blockfrost reports no hash',
    (_, datum, hash) => {
      const [, output] = BlockfrostToCardanoSDK.addressUtxoContent(
        ADDRESS,
        blockfrostUtxo({ inline_datum: datum, data_hash: null }),
      );

      expect(output.datum).toBeUndefined();
      expect(output.datumHash).toBe(hash);
    },
  );

  it('reads as stranded for a custody account at the address, never as spendable funds', () => {
    const account = {
      accountValidatorHash: Hash28ByteBase16('ab'.repeat(28)),
      address: Cardano.PaymentAddress(ADDRESS),
      stakeScriptHash: Hash28ByteBase16('cd'.repeat(28)),
    };
    const classify = (
      datum: Pick<BlockfrostUtxo, 'data_hash' | 'inline_datum'>,
    ) =>
      classifyCustodyAccountUtxos(account, [
        BlockfrostToCardanoSDK.addressUtxoContent(
          ADDRESS,
          blockfrostUtxo(datum),
        ),
      ]);

    const refused = classify({
      inline_datum: '81'.repeat(65) + '00',
      data_hash: null,
    });
    expect(refused.stranded).toHaveLength(1);
    expect(refused.funds).toEqual([]);
    expect(refused.reserves.foreign).toEqual([]);

    const decoded = classify({ inline_datum: INLINE_DATUM, data_hash: null });
    expect(decoded.reserves.own).toHaveLength(1);
    expect(decoded.stranded).toEqual([]);

    const plain = classify({ inline_datum: null, data_hash: null });
    expect(plain.funds).toHaveLength(1);
  });

  it('keeps only the address and value when a refused inline datum is not hex and no hash is reported', () => {
    const [, output] = BlockfrostToCardanoSDK.addressUtxoContent(
      ADDRESS,
      blockfrostUtxo({ inline_datum: 'not-hex', data_hash: null }),
    );

    expect(output).toEqual({
      address: Cardano.PaymentAddress(ADDRESS),
      value: { coins: 5_000_000n },
    });
  });
});
