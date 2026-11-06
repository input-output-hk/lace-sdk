import { Cardano } from '@lace-lib/cardano-core';
import { blake2b } from '@lace-lib/cardano-crypto';
import { HexBlob } from '@lace-lib/cardano-util';

import { findHydraHeadMintingScriptTemplate } from './registry';

import type { HydraSeedEncoding } from './types';

/** Hex length of the seed transaction id inside the script. */
const SEED_TX_ID_LENGTH = 64;

/** Hex length of a head id, a policy id. */
const HEAD_ID_PATTERN = /^[0-9a-f]{56}$/;

/** Lowercase hex made of whole bytes. */
const HEX_PATTERN = /^(?:[0-9a-f]{2})*$/;

/** Hex byte that precedes a script of the language when it is hashed. */
const languageTag = (language: Cardano.PlutusLanguageVersion): string =>
  language === Cardano.PlutusLanguageVersion.V2 ? '02' : '03';

/** Flat bits that close the seed transaction id byte string. */
const END_OF_TX_ID_BITS = '00000000';

/** Flat bits that open the integer constant holding the seed output index. */
const INTEGER_CONSTANT_BITS = '0100' + '1' + '0000' + '0';

/**
 * Most 7-bit groups read for the seed output index, enough for any index a
 * transaction can have.
 */
const MAX_INDEX_GROUPS = 3;

/** Bits a seed encoding puts before and after the seed output index. */
const indexFraming = (
  seedEncoding: HydraSeedEncoding,
): { readonly before: string; readonly after: string } =>
  seedEncoding === 'constrFields'
    ? { before: END_OF_TX_ID_BITS + '1' + INTEGER_CONSTANT_BITS, after: '0' }
    : { before: END_OF_TX_ID_BITS + INTEGER_CONSTANT_BITS, after: '' };

/**
 * Encodes a natural number as flat does: 7-bit groups, least significant
 * first, each prefixed with 1 when another group follows and 0 for the last.
 */
const encodeNatural = (value: number): string => {
  const groups: string[] = [];
  let rest = value;
  do {
    groups.push((rest % 128).toString(2).padStart(7, '0'));
    rest = Math.floor(rest / 128);
  } while (rest > 0);
  return groups
    .map((group, index) => (index < groups.length - 1 ? '1' : '0') + group)
    .join('');
};

/** Converts a bit string whose length is a multiple of 8 to hex. */
const bitsToHex = (bits: string): string => {
  let hex = '';
  for (let offset = 0; offset < bits.length; offset += 8) {
    hex += Number.parseInt(bits.slice(offset, offset + 8), 2)
      .toString(16)
      .padStart(2, '0');
  }
  return hex;
};

/** Converts hex to a bit string, most significant bit first. */
const hexToBits = (hex: string): string => {
  let bits = '';
  for (let offset = 0; offset < hex.length; offset += 2) {
    bits += Number.parseInt(hex.slice(offset, offset + 2), 16)
      .toString(2)
      .padStart(8, '0');
  }
  return bits;
};

/**
 * Encodes the end of a head minting script after the seed transaction id:
 * the seed output index as a flat integer constant, followed by flat
 * padding.
 *
 * @param seedEncoding - How the release applies the seed.
 * @param index - Seed output index.
 * @returns The hex tail.
 */
export const encodeSeedIndexTail = (
  seedEncoding: HydraSeedEncoding,
  index: number,
): string => {
  const { before, after } = indexFraming(seedEncoding);
  const bits = before + encodeNatural(2 * index) + after;
  return bitsToHex(bits + '0'.repeat(7 - (bits.length % 8)) + '1');
};

/**
 * Reads the seed output index out of a script tail, without checking the
 * rest of the tail. Returns undefined when no index can be read.
 */
const readSeedIndex = (
  seedEncoding: HydraSeedEncoding,
  tail: string,
): number | undefined => {
  const bits = hexToBits(tail);
  const { before } = indexFraming(seedEncoding);
  let offset = before.length;
  let value = 0;
  for (let group = 0; group < MAX_INDEX_GROUPS; group++) {
    const groupBits = bits.slice(offset, offset + 8);
    if (groupBits.length < 8) return undefined;
    value += Number.parseInt(groupBits.slice(1), 2) * 128 ** group;
    offset += 8;
    if (groupBits.startsWith('0')) {
      return value % 2 === 0 ? value / 2 : undefined;
    }
  }
  return undefined;
};

/**
 * Bytes that follow the initial byte to give the length of a definite-length
 * byte string, by its additional information. Values below 24 are the length
 * itself and need none.
 */
const BYTE_STRING_LENGTH_BYTES: ReadonlyMap<number, number> = new Map([
  [24, 1],
  [25, 2],
  [26, 4],
]);

/**
 * Returns the payload of a definite-length CBOR byte string that spans the
 * whole input, or undefined for anything else.
 */
const readByteStringPayload = (cbor: string): string | undefined => {
  const initial = Number.parseInt(cbor.slice(0, 2), 16);
  if (Number.isNaN(initial) || initial >> 5 !== 2) return undefined;
  const info = initial & 0x1f;
  const lengthBytes = info < 24 ? 0 : BYTE_STRING_LENGTH_BYTES.get(info);
  if (lengthBytes === undefined) return undefined;
  const headerLength = 2 + lengthBytes * 2;
  const length =
    lengthBytes === 0 ? info : Number.parseInt(cbor.slice(2, headerLength), 16);
  const payload = cbor.slice(headerLength);
  return payload.length === length * 2 ? payload : undefined;
};

/**
 * Tells whether a script is the Hydra head minting script of a head, which
 * proves the head genuine: only that script can mint the state and
 * participation tokens of the head id.
 *
 * The head address gives the release, and with it the language and the
 * template of the script, so the script bytes are all a caller needs. The
 * script must be the release's fixed prefix, a seed transaction id and the
 * exact tail for the seed output index it encodes, with nothing after it, and
 * its hash under the release's language must be the head id. Anything else,
 * including native scripts, scripts of another release and malformed or
 * uppercase hex, gives false.
 *
 * @param headId - Hex policy id of the head state token.
 * @param headAddress - Bech32 head validator address holding the head UTxO.
 * @param scriptCbor - Hex CBOR of the script, as a CBOR byte string around
 *   the flat code: the `bytes` of a `Cardano.PlutusScript`, or the `cbor`
 *   Blockfrost returns for the head id.
 */
export const isHydraHeadMintingScript = (
  headId: string,
  headAddress: string,
  scriptCbor: string,
): boolean => {
  const template = findHydraHeadMintingScriptTemplate(headAddress);
  if (
    template === undefined ||
    !HEAD_ID_PATTERN.test(headId) ||
    !HEX_PATTERN.test(scriptCbor)
  ) {
    return false;
  }
  const payload = readByteStringPayload(scriptCbor);
  if (payload === undefined) return false;
  const prefixEnd = template.prefixLength * 2;
  const tail = payload.slice(prefixEnd + SEED_TX_ID_LENGTH);
  const index = readSeedIndex(template.seedEncoding, tail);
  if (
    index === undefined ||
    encodeSeedIndexTail(template.seedEncoding, index) !== tail
  ) {
    return false;
  }
  if (
    blake2b.hash(HexBlob(payload.slice(0, prefixEnd)), 32) !==
    template.prefixDigest
  ) {
    return false;
  }
  return (
    blake2b.hash(HexBlob(languageTag(template.language) + scriptCbor), 28) ===
    headId
  );
};
