import type * as Crypto from '@lace-lib/cardano-crypto';
import type { Transform } from '@lace-lib/cardano-util';
import type * as Trezor from '@trezor/connect';

export const mapAuxiliaryData: Transform<
  Crypto.Hash32ByteBase16,
  Trezor.CardanoAuxiliaryData
> = auxiliaryDataHash => ({
  cVoteRegistrationParameters: undefined, // Voting is not handled for now
  hash: auxiliaryDataHash,
});
