import * as ledger from '@midnight-ntwrk/ledger-v8';
import { vi } from 'vitest';

type LedgerFake = {
  serialize: () => Uint8Array;
  transactionHash: () => string;
};

const fakesByBytes = new Map<string, object>();
const keyOf = (raw: Uint8Array) => Buffer.from(raw).toString('hex');
const deserialize = ledger.Transaction.deserialize.bind(ledger.Transaction);

/**
 * Lets a plain object stand in for a ledger transaction behind the SDK's opaque values: it gets bytes of its own, and
 * a hash unless it has one, and `decodeLedgerFakes` maps those bytes back to the same object. A helper then hands the
 * fake engine the very object it returned, so the tests keep comparing engine calls by identity.
 */
export const ledgerFake = <T extends object>(
  fake: T,
): Pick<LedgerFake, 'serialize'> & T => {
  const bytes = new TextEncoder().encode(`fake-${fakesByBytes.size}`);
  fakesByBytes.set(keyOf(bytes), fake);
  return Object.assign(fake, {
    serialize: () => bytes,
    ...('transactionHash' in fake
      ? {}
      : { transactionHash: () => `hash-${keyOf(bytes)}` }),
  });
};

/** Routes `Transaction.deserialize` of a fake's bytes to the fake; any other bytes reach the ledger. */
export const decodeLedgerFakes = () =>
  vi
    .spyOn(ledger.Transaction, 'deserialize')
    .mockImplementation(
      ((...markersAndBytes: [never, never, never, Uint8Array]) =>
        fakesByBytes.get(keyOf(markersAndBytes[3])) ??
        deserialize(...markersAndBytes)) as never,
    );
