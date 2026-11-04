import { Serialization } from '@cardano-sdk/core';
import { Hash32ByteBase16, blake2b } from '@cardano-sdk/crypto';
import { HexBlob } from '@cardano-sdk/util';

import { MAX_DATUM_DEPTH, isCborWithinLimits } from './cbor-limits';

import type { Cardano } from '@cardano-sdk/core';

/**
 * Decodes an inline datum reported by Blockfrost.
 *
 * @param cbor - CBOR hex of the datum.
 * @returns the datum, or undefined when it is malformed, larger than
 * `MAX_CBOR_SIZE` or nested deeper than `MAX_DATUM_DEPTH`. Never throws.
 */
export const decodeInlineDatum = (
  cbor: string,
): Cardano.PlutusData | undefined => {
  if (!isCborWithinLimits(cbor, MAX_DATUM_DEPTH)) return undefined;
  try {
    return Serialization.PlutusData.fromCbor(HexBlob(cbor)).toCore();
  } catch {
    return undefined;
  }
};

/**
 * The hash of an inline datum, computed over its CBOR bytes without
 * decoding them, for an output whose datum is refused and whose hash
 * Blockfrost did not report.
 *
 * @returns the hash, or undefined when the CBOR is not hex. Never throws.
 */
export const hashInlineDatum = (cbor: string): Hash32ByteBase16 | undefined => {
  try {
    return Hash32ByteBase16(blake2b.hash(HexBlob(cbor), 32));
  } catch {
    return undefined;
  }
};
