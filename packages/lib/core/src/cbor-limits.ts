import { HexBlob, Serialization } from '@lace-lib/vendor';

const { CborReader, CborReaderState, CborTag } = Serialization;

/** The size and nesting CBOR must stay within to be decoded. */
export interface CborLimits {
  /**
   * Deepest nesting of arrays and maps accepted, where each array or map is
   * one level and tags add none.
   */
  maxDepth: number;
  /** Largest encoding accepted, in bytes. Unbounded when absent. */
  maxBytes?: number;
}

/**
 * Tells whether CBOR hex stays within `limits` without decoding it. Byte
 * strings tagged as encoded CBOR, which is how an output embeds its inline
 * datum, are walked as well, since the decoders decode them. The walk keeps
 * a counter and a stack of readers instead of recursing, so its cost stays
 * linear in the input size however deep the data goes, unlike the decoders,
 * whose cost grows with the square of the depth. Every data item in the
 * input is walked, and malformed CBOR counts as beyond the limits. Never
 * throws.
 *
 * @param cbor - CBOR hex to check.
 * @param limits - The size and nesting accepted.
 */
export const isCborWithinLimits = (
  cbor: string,
  { maxDepth, maxBytes }: CborLimits,
): boolean => {
  if (maxBytes !== undefined && cbor.length > maxBytes * 2) return false;
  try {
    const readers = [new CborReader(HexBlob(cbor))];
    let depth = 0;
    while (readers.length > 0) {
      const reader = readers.at(-1)!;
      const state = reader.peekState();
      if (state === CborReaderState.Finished) {
        readers.pop();
      } else if (state === CborReaderState.StartArray) {
        reader.readStartArray();
        depth++;
      } else if (state === CborReaderState.StartMap) {
        reader.readStartMap();
        depth++;
      } else if (state === CborReaderState.EndArray) {
        reader.readEndArray();
        depth--;
      } else if (state === CborReaderState.EndMap) {
        reader.readEndMap();
        depth--;
      } else if (state === CborReaderState.Tag) {
        if (
          reader.readTag() === CborTag.EncodedCborDataItem &&
          reader.peekState() === CborReaderState.ByteString
        ) {
          readers.push(
            new CborReader(HexBlob.fromBytes(reader.readByteString())),
          );
        }
      } else {
        reader.skipValue();
      }
      if (depth > maxDepth) return false;
    }
    return true;
  } catch {
    return false;
  }
};
