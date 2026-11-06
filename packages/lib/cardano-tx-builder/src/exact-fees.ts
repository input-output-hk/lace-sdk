import type { Cardano } from '@lace-lib/cardano-core';

/** A non-negative rational number held exactly as two integers. */
export interface Rational {
  numerator: bigint;
  denominator: bigint;
}

/** Non-negative decimal text with an optional fraction and exponent, as String writes a number. */
const DECIMAL_PATTERN = /^(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i;

/**
 * Reads a protocol parameter price as an exact rational number.
 *
 * Protocol parameters carry prices as JavaScript numbers (execution unit
 * prices) or as decimal text (the reference-script price and multiplier). A
 * number is read through its shortest decimal text, the text `String` gives
 * for it, so 0.0577 reads as 577/10000 and 0.00000721 as 721/100000000, the
 * fractions written on chain, rather than the binary value of the float.
 *
 * @param value - The price as a number or as decimal text, such as `15`,
 * `0.0577` or `7.21e-7`.
 * @throws `RangeError` When the value is not a non-negative decimal number.
 */
export const toRational = (value: number | string): Rational => {
  const text = String(value).trim();
  const match = DECIMAL_PATTERN.exec(text);
  if (!match) {
    throw new RangeError(`Expected a non-negative decimal number, got ${text}`);
  }
  const [, whole, fraction = '', exponent = '0'] = match;
  const scale = Number(exponent) - fraction.length;
  const digits = BigInt(whole + fraction);
  return scale >= 0
    ? { numerator: digits * 10n ** BigInt(scale), denominator: 1n }
    : { numerator: digits, denominator: 10n ** BigInt(-scale) };
};

/**
 * Integer division of non-negative numbers rounded up.
 *
 * @param dividend - The number divided.
 * @param divisor - The number it is divided by, above zero.
 */
const divideRoundingUp = (dividend: bigint, divisor: bigint) =>
  (dividend + divisor - 1n) / divisor;

/**
 * The fee for running scripts with the given execution units: memory and
 * steps priced at the exact rational prices, summed, then rounded up once,
 * as the ledger prices them.
 *
 * @param exUnits - The execution units summed over every redeemer.
 * @param prices - The price of one unit of memory and of one step.
 */
export const executionUnitsFee = (
  exUnits: Cardano.ExUnits,
  prices: Cardano.Prices,
): bigint => {
  const memoryPrice = toRational(prices.memory);
  const stepsPrice = toRational(prices.steps);
  return divideRoundingUp(
    BigInt(exUnits.memory) * memoryPrice.numerator * stepsPrice.denominator +
      BigInt(exUnits.steps) * stepsPrice.numerator * memoryPrice.denominator,
    memoryPrice.denominator * stepsPrice.denominator,
  );
};
