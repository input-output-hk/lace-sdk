import FractionJs from 'fraction.js';

/**
 * Numerator and denominator are numbers. Decoded values above 2^53, which only arbitrary 64 bit
 * rationals reach, are rounded; use UnitInterval.toCbor for exact data.
 */
export interface Fraction {
  numerator: number;
  denominator: number;
}

const toFractionJs = (value: Fraction | number): FractionJs => {
  if (typeof value === 'number') {
    return new FractionJs(value);
  }
  const { numerator, denominator } = value;
  return new FractionJs(numerator, denominator);
};

export const FractionUtils = {
  toFraction(value: Fraction | number): Fraction {
    const fractionJs = toFractionJs(value);
    const { n: numerator, d: denominator } = fractionJs;
    return { denominator, numerator };
  },
  toNumber(value: Fraction | number): number {
    const fractionJs = toFractionJs(value);
    return fractionJs.valueOf();
  },
};
