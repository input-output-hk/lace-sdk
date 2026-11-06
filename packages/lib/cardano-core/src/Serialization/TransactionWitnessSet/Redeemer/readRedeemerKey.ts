import { InvalidArgumentError } from '@lace-lib/cardano-util';

import { RedeemerTag } from './RedeemerTag';

import type { CborReader } from '../../CBOR';

const MAX_WORD32 = 4_294_967_295n;

/**
 * Reads the redeemer tag and index pair that identifies a redeemer. The tag must be one
 * of the known redeemer purposes and the index must fit in an unsigned 32 bit integer.
 *
 * @param reader The reader positioned at the redeemer tag.
 * @returns The redeemer tag and index.
 */
export const readRedeemerKey = (
  reader: CborReader,
): { tag: RedeemerTag; index: bigint } => {
  const tag = reader.readUInt();

  if (!Object.values(RedeemerTag).includes(Number(tag)))
    throw new InvalidArgumentError(
      'cbor',
      `Unknown redeemer tag ${tag}, expected a value between ${RedeemerTag.Spend} and ${RedeemerTag.Guarding}`,
    );

  const index = reader.readUInt();

  if (index > MAX_WORD32)
    throw new InvalidArgumentError(
      'cbor',
      `Redeemer index should fit in 32 bits, but got ${index}`,
    );

  return { index, tag: Number(tag) as RedeemerTag };
};
