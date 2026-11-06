import { Serialization } from '@lace-lib/cardano-core';

import { minAdaRequired } from './fees';

import type { Cardano } from '@lace-lib/cardano-core';

/** The largest quantity a 64-bit unsigned integer can hold. */
export const MAX_U64 = 18_446_744_073_709_551_615n;

/** Tells whether a token bundle is too large to fit in one output's value. */
export type TokenBundleSizeExceedsLimit = (
  tokenBundle?: Cardano.TokenMap,
) => boolean;

/** Computes the minimum lovelace an output must carry. */
export type ComputeMinimumCoinQuantity = (
  output: Cardano.TxOut,
) => Cardano.Lovelace;

/**
 * Creates a function that computes the minimum lovelace an output must carry.
 *
 * @param coinsPerUtxoByte - The protocol parameter that prices each byte of an output.
 * @returns A function from an output to its minimum lovelace.
 */
export const computeMinimumCoinQuantity =
  (
    coinsPerUtxoByte: Cardano.ProtocolParameters['coinsPerUtxoByte'],
  ): ComputeMinimumCoinQuantity =>
  output =>
    minAdaRequired(output, BigInt(coinsPerUtxoByte));

/**
 * Creates a function that tells whether a token bundle is too large for one
 * output. The bundle is sized as part of a value carrying the largest possible
 * coin quantity, so the answer holds whatever lovelace the output carries.
 *
 * @param maxValueSize - The protocol parameter that bounds the serialized size of an output's value.
 * @returns A function from a token bundle to whether it exceeds the limit.
 */
export const tokenBundleSizeExceedsLimit =
  (
    maxValueSize: Cardano.ProtocolParameters['maxValueSize'],
  ): TokenBundleSizeExceedsLimit =>
  tokenBundle => {
    if (!tokenBundle) {
      return false;
    }

    const value = new Serialization.Value(MAX_U64);
    value.setMultiasset(tokenBundle);

    return value.toCbor().length / 2 > maxValueSize;
  };
