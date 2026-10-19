// chacha ships no declarations. This is the ChaCha20-Poly1305 AEAD surface
// @lace-lib/cardano-key-management's EmIP-003 encryption uses, shaped like
// Node's crypto.Cipher and crypto.Decipher.
declare module 'chacha' {
  interface AeadCipher {
    setAAD(buffer: Uint8Array, options?: { plaintextLength: number }): this;
    update(data: Uint8Array): Buffer;
    final(): Buffer;
    getAuthTag(): Buffer;
  }
  interface AeadDecipher {
    setAAD(buffer: Uint8Array, options?: { plaintextLength: number }): this;
    setAuthTag(tag: Buffer): this;
    update(data: Buffer): Buffer;
    final(): Buffer;
  }
  export function createCipher(key: Uint8Array, nonce: Buffer): AeadCipher;
  export function createDecipher(key: Uint8Array, nonce: Buffer): AeadDecipher;
}
