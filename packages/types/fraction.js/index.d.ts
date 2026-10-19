// fraction.js 4.0.1 ships no declarations. This is the surface
// @lace-lib/cardano-core uses; a wider use is a TypeScript error here until
// the declaration grows with it.
declare module 'fraction.js' {
  class Fraction {
    constructor(value: Fraction | number | string);
    constructor(numerator: number, denominator: number);
    /** The sign, 1 or -1. */
    s: number;
    /** The numerator, always positive. */
    n: number;
    /** The denominator, always positive. */
    d: number;
    valueOf(): number;
    toString(): string;
  }
  export = Fraction;
}
