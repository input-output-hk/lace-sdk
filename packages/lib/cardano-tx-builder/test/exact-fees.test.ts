import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { executionUnitsFee, toRational } from '../src/exact-fees';

import type { Cardano } from '@lace-lib/cardano-core';

const MAINNET_PRICES = { memory: 0.0577, steps: 0.000_072_1 };

/** A price written as `digits / 10^decimals`. */
interface DecimalPrice {
  digits: bigint;
  decimals: number;
}

/** Scale every price is brought to by {@link referenceExecutionUnitsFee}. */
const REFERENCE_SCALE = 10n ** 30n;

/**
 * Exact execution-unit fee for decimal prices, computed over a fixed decimal
 * scale.
 */
const referenceExecutionUnitsFee = (
  { memory, steps }: Cardano.ExUnits,
  prices: { memory: DecimalPrice; steps: DecimalPrice },
) => {
  const scaled = ({ digits, decimals }: DecimalPrice) =>
    (digits * REFERENCE_SCALE) / 10n ** BigInt(decimals);
  const total =
    BigInt(memory) * scaled(prices.memory) +
    BigInt(steps) * scaled(prices.steps);
  const fee = total / REFERENCE_SCALE;
  return fee * REFERENCE_SCALE === total ? fee : fee + 1n;
};

const decimalPrice: fc.Arbitrary<DecimalPrice> = fc.record({
  digits: fc.bigInt({ min: 0n, max: 999_999_999n }),
  decimals: fc.integer({ min: 0, max: 12 }),
});

describe('toRational', () => {
  it.each([
    [0.0577, 577n, 10_000n],
    [0.000_072_1, 721n, 10_000_000n],
    [0.000_007_21, 721n, 100_000_000n],
    [0.07, 7n, 100n],
    [12.5, 125n, 10n],
    [15, 15n, 1n],
    ['15', 15n, 1n],
    ['1.2', 12n, 10n],
    ['7.21e-7', 721n, 1_000_000_000n],
    [1e21, 10n ** 21n, 1n],
  ])('reads %s as %s/%s', (value, numerator, denominator) => {
    expect(toRational(value)).toEqual({ numerator, denominator });
  });

  it.each(['-1', 'abc', '', '1/2', Number.NaN])('refuses %s', value => {
    expect(() => toRational(value)).toThrow(RangeError);
  });
});

describe('executionUnitsFee', () => {
  it.each([
    [{ memory: 7000, steps: 1_000_000 }, MAINNET_PRICES, 476n],
    [{ memory: 1_000_000, steps: 400_000_000 }, MAINNET_PRICES, 86_540n],
    [{ memory: 14_000_000, steps: 10_000_000_000 }, MAINNET_PRICES, 1_528_800n],
    [{ memory: 468_974, steps: 12_611_362_000 }, MAINNET_PRICES, 936_339n],
    [{ memory: 264_742, steps: 9_786_746_000 }, MAINNET_PRICES, 720_900n],
    [{ memory: 1, steps: 1 }, MAINNET_PRICES, 1n],
    [{ memory: 100, steps: 0 }, { memory: 0.07, steps: 0.000_07 }, 7n],
    [
      { memory: 1_142_700, steps: 1_000_000 },
      { memory: 0.0577, steps: 0.000_007_21 },
      65_941n,
    ],
  ])('prices %o at %o as the ledger does', (exUnits, prices, fee) => {
    expect(executionUnitsFee(exUnits, prices)).toBe(fee);
  });

  it('equals the exact fee rounded up once', () => {
    fc.assert(
      fc.property(
        fc.record({
          memory: fc.integer({ min: 0, max: 100_000_000 }),
          steps: fc.integer({ min: 0, max: 100_000_000_000 }),
        }),
        fc.record({ memory: decimalPrice, steps: decimalPrice }),
        (exUnits, decimalPrices) => {
          const asNumber = ({ digits, decimals }: DecimalPrice) =>
            Number(`${digits}e-${decimals}`);
          const prices = {
            memory: asNumber(decimalPrices.memory),
            steps: asNumber(decimalPrices.steps),
          };

          expect(executionUnitsFee(exUnits, prices)).toBe(
            referenceExecutionUnitsFee(exUnits, decimalPrices),
          );
        },
      ),
      { numRuns: 2000 },
    );
  });
});
