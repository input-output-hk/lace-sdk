import { isCborWithinLimits as isWithinLimits } from '@lace-lib/core';

/**
 * Largest CBOR decoded, in bytes: four times the ledger's maximum
 * transaction size (`maxTxSize`, 16 KB on every Cardano network today). A
 * datum or a script travels in the transaction that creates it, so nothing
 * read from the chain is larger than that size, and a provider response that
 * is cannot be genuine. The parameter can be raised by a governance action,
 * so the bound carries headroom rather than following it to the byte: a
 * genuine transaction keeps decoding after such a change, while converting
 * wide maps, whose cost grows faster than their size, stays bounded.
 */
export const MAX_CBOR_SIZE = 4 * 16_384;

/**
 * Deepest nesting of arrays and maps a datum is decoded at. The decoder's
 * cost grows with the square of the depth, so anyone paying to an address
 * could otherwise stall every reader of its UTxOs with one deeply nested
 * datum. No script reads data this deep.
 */
export const MAX_DATUM_DEPTH = 64;

/**
 * Deepest nesting a transaction is decoded at: a datum at `MAX_DATUM_DEPTH`
 * sits at most a few levels inside the transaction (the body, its outputs
 * or witnesses, and the output or redeemer that holds it).
 */
export const MAX_TRANSACTION_DEPTH = MAX_DATUM_DEPTH + 8;

/**
 * Tells whether CBOR is at most `MAX_CBOR_SIZE` bytes and nests arrays and
 * maps no deeper than `maxDepth`, walking the byte strings tagged as encoded
 * CBOR an output embeds its inline datum in. Never throws.
 */
export const isCborWithinLimits = (cbor: string, maxDepth: number): boolean =>
  isWithinLimits(cbor, { maxBytes: MAX_CBOR_SIZE, maxDepth });
