import { HexBytes } from '@lace-lib/util';

/** The sha256 digest of `bytes` as lowercase hex, the form every pin uses. */
export const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return HexBytes.fromByteArray(new Uint8Array(digest));
};
