import { Cardano } from '@lace-lib/cardano-core';
import { Ed25519KeyHashHex } from '@lace-lib/cardano-crypto';
import { HexBlob } from '@lace-lib/cardano-util';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  referenceScriptFee,
  referenceScriptSize,
} from '../src/reference-scripts';

import type { Rational } from '../src/exact-fees';

const ADDRESS = Cardano.PaymentAddress(
  'addr_test1vr8nl4u0u6fmtfnawx2rxfz95dy7m46t6dhzdftp2uha87syeufdg',
);

const plutusScript = (byteLength: number): Cardano.Script => ({
  __type: Cardano.ScriptType.Plutus,
  version: Cardano.PlutusLanguageVersion.V3,
  bytes: HexBlob('ab'.repeat(byteLength)),
});

const nativeScript: Cardano.Script = {
  __type: Cardano.ScriptType.Native,
  kind: Cardano.NativeScriptKind.RequireSignature,
  keyHash: Ed25519KeyHashHex('cd'.repeat(28)),
};

const utxoCarrying = (
  index: number,
  scriptReference?: Cardano.Script,
): Cardano.Utxo => [
  { txId: Cardano.TransactionId('ef'.repeat(32)), index, address: ADDRESS },
  { address: ADDRESS, value: { coins: 2_000_000n }, scriptReference },
];

const inputOf = ([txIn]: Cardano.Utxo): Cardano.TxIn => ({
  txId: txIn.txId,
  index: txIn.index,
});

/**
 * The ledger's tiered reference-script fee, step by step: whole tiers are
 * added to an exact running total while the price grows, and the total is
 * rounded down once at the end.
 */
const ledgerTierFee = ({
  size,
  price,
  multiplier,
  stride,
}: {
  size: bigint;
  price: Rational;
  multiplier: Rational;
  stride: bigint;
}) => {
  const add = (a: Rational, b: Rational): Rational => ({
    numerator: a.numerator * b.denominator + b.numerator * a.denominator,
    denominator: a.denominator * b.denominator,
  });
  const scale = (a: Rational, by: bigint): Rational => ({
    numerator: a.numerator * by,
    denominator: a.denominator,
  });
  let total: Rational = { numerator: 0n, denominator: 1n };
  let tierPrice = price;
  let remaining = size;
  while (remaining >= stride) {
    total = add(total, scale(tierPrice, stride));
    tierPrice = {
      numerator: tierPrice.numerator * multiplier.numerator,
      denominator: tierPrice.denominator * multiplier.denominator,
    };
    remaining -= stride;
  }
  total = add(total, scale(tierPrice, remaining));
  return total.numerator / total.denominator;
};

describe('referenceScriptSize', () => {
  it('counts the raw bytes of a Plutus script and the CBOR of a native script', () => {
    const plutus = utxoCarrying(0, plutusScript(30_000));
    const native = utxoCarrying(1, nativeScript);

    expect(referenceScriptSize([inputOf(plutus)], [plutus])).toBe(30_000);
    expect(referenceScriptSize([inputOf(native)], [native])).toBe(32);
  });

  it('counts an input once however often it is listed, and a script once per output carrying it', () => {
    const first = utxoCarrying(0, plutusScript(100));
    const second = utxoCarrying(1, plutusScript(100));
    const resolved = [first, second, utxoCarrying(2)];

    expect(
      referenceScriptSize(
        [inputOf(first), inputOf(second), inputOf(first), inputOf(resolved[2])],
        resolved,
      ),
    ).toBe(200);
  });

  it('adds nothing for an input it cannot resolve', () => {
    expect(referenceScriptSize([inputOf(utxoCarrying(0))], [])).toBe(0);
  });
});

describe('referenceScriptFee', () => {
  it.each([
    [8, '15', 120n],
    [25_600, '15', 384_000n],
    [25_601, '15', 384_018n],
    [30_000, '15', 463_200n],
    [51_200, '15', 844_800n],
    [51_201, '15', 844_821n],
    [76_805, '15', 1_397_889n],
    [204_800, '15', 6_335_648n],
    [3, '12.5', 37n],
    [1000, '0.0577', 57n],
    [25_601, '12.5', 320_015n],
  ])(
    'prices %s bytes at %s per byte as the ledger does',
    (size, minFeeRefScriptCostPerByte, fee) => {
      expect(referenceScriptFee(size, { minFeeRefScriptCostPerByte })).toBe(
        fee,
      );
    },
  );

  it('is free when the protocol sets no price or there are no bytes', () => {
    expect(referenceScriptFee(1000, {})).toBe(0n);
    expect(referenceScriptFee(0, { minFeeRefScriptCostPerByte: '15' })).toBe(
      0n,
    );
  });

  it('reads the tier size and multiplier from the protocol parameters', () => {
    expect(
      referenceScriptFee(251, {
        minFeeRefScriptCostPerByte: '10',
        refScriptCostMultiplier: '1.5',
        refScriptCostStride: 100,
      }),
    ).toBe(1000n + 1500n + 1147n);
  });

  it('equals the ledger tier sum rounded down once', () => {
    const decimal = (minimum: bigint) =>
      fc
        .record({
          digits: fc.bigInt({ min: minimum, max: 99_999n }),
          decimals: fc.integer({ min: 0, max: 4 }),
        })
        .map(({ digits, decimals }) => ({
          text: `${digits}e-${decimals}`,
          numerator: digits,
          denominator: 10n ** BigInt(decimals),
        }));

    fc.assert(
      fc.property(
        fc.record({
          size: fc.integer({ min: 0, max: 250_000 }),
          price: decimal(1n),
          multiplier: decimal(10_000n),
          stride: fc.integer({ min: 5000, max: 60_000 }),
        }),
        ({ size, price, multiplier, stride }) => {
          expect(
            referenceScriptFee(size, {
              minFeeRefScriptCostPerByte: price.text,
              refScriptCostMultiplier: multiplier.text,
              refScriptCostStride: stride,
            }),
          ).toBe(
            ledgerTierFee({
              size: BigInt(size),
              price,
              multiplier,
              stride: BigInt(stride),
            }),
          );
        },
      ),
      { numRuns: 1000 },
    );
  });
});
