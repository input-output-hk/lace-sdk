import { Cardano } from '@lace-lib/cardano-core';
import { AssetId } from '@lace-lib/cardano-util-dev';
import { describe, expect, it } from 'vitest';

import { minAdaRequired } from '../src/fees';
import {
  computeMinimumCoinQuantity,
  tokenBundleSizeExceedsLimit,
} from '../src/output-limits';

const COINS_PER_UTXO_BYTE = 4310;
const MAX_VALUE_SIZE = 5000;

const address = Cardano.PaymentAddress(
  'addr_test1qqydn46r6mhge0kfpqmt36m6q43knzsd9ga32n96m89px3nuzcjqw982pcftgx53fu5527z2cj2tkx2h8ux2vxsg475qypp3m9',
);

describe('computeMinimumCoinQuantity', () => {
  it('requires more coin of an output that carries assets', () => {
    const assets = new Map([
      [AssetId.TSLA, 5000n],
      [AssetId.PXL, 3000n],
    ]);
    const computeMinimum = computeMinimumCoinQuantity(COINS_PER_UTXO_BYTE);

    const minCoinWithAssets = computeMinimum({
      address,
      value: { assets, coins: 0n },
    });
    const minCoinWithoutAssets = computeMinimum({
      address,
      value: { coins: 0n },
    });

    expect(typeof minCoinWithAssets).toBe('bigint');
    expect(typeof minCoinWithoutAssets).toBe('bigint');
    expect(minCoinWithAssets).toBeGreaterThan(minCoinWithoutAssets);
  });

  it('is minAdaRequired at the given coins per UTxO byte', () => {
    const output: Cardano.TxOut = { address, value: { coins: 0n } };

    expect(computeMinimumCoinQuantity(COINS_PER_UTXO_BYTE)(output)).toBe(
      minAdaRequired(output, BigInt(COINS_PER_UTXO_BYTE)),
    );
  });
});

describe('tokenBundleSizeExceedsLimit', () => {
  it('empty bundle', () => {
    expect(tokenBundleSizeExceedsLimit(MAX_VALUE_SIZE)()).toBe(false);
  });

  it("doesn't exceed max value size", () => {
    expect(tokenBundleSizeExceedsLimit(1_000_000_000)(new Map())).toBe(false);
  });

  it('exceeds max value size', () => {
    expect(tokenBundleSizeExceedsLimit(1)(new Map())).toBe(true);
  });
});
