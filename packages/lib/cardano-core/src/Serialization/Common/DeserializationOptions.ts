/** Options controlling CBOR deserialization behavior. */
export interface DeserializationOptions {
  /**
   * When true, deserialization throws on unknown map keys instead of silently skipping them, so that
   * constructs from a newer era than this build understands are detected rather than under-rendered.
   *
   * It also rejects encodings the current ledger rejects but earlier eras accepted: transaction
   * body guards that repeat a key hash, and a protocol version whose minor component does not fit
   * in 32 bits.
   *
   * Defaults to false (unknown keys are skipped and the encodings above are accepted).
   */
  strict?: boolean;
}
