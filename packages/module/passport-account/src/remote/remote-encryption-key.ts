import { EncryptionKeyMismatchError } from '@lace-contract/passport';

import { MAX_INBOX_ENTRIES_PER_REQUEST } from '../acc/inbox';

import {
  decodeAccountKeys,
  decodeBytes,
  decodeDeviceDelivery,
  decodeInboxEntries,
  decodeLiveEnvelope,
  decodeOpenedEntries,
  decodeSealedEntries,
  decodeViewDelivery,
  encodeBytes,
  encodeKeyring,
  encodeLiveReader,
  encodeRemovedDevice,
  MalformedPayloadError,
} from './codec';
import { requestSigner } from './request';

import type { SignerRequester } from './request';
import type {
  AccountKeyring,
  OpenedInboxEntry,
  PassportEncryptionKey,
} from '@lace-contract/passport';

const X25519_PUBLIC_KEY_LENGTH = 32;

/**
 * `entries` in consecutive batches of at most the entries the signer
 * opens per request, in order; none for an empty list.
 */
const inboxBatches = (entries: readonly Uint8Array[]): Uint8Array[][] => {
  const batches: Uint8Array[][] = [];
  for (
    let start = 0;
    start < entries.length;
    start += MAX_INBOX_ENTRIES_PER_REQUEST
  ) {
    batches.push(entries.slice(start, start + MAX_INBOX_ENTRIES_PER_REQUEST));
  }
  return batches;
};

const encodeEntries = (entries: readonly Uint8Array[]): string[] =>
  entries.map(entry => encodeBytes(entry));

/**
 * Sends `entries` to the signer in batches through `request` and joins
 * the answers in order, refusing an answer whose length is not its
 * batch's.
 */
const inBatches = async <T>(
  entries: readonly Uint8Array[],
  field: string,
  request: (batch: Uint8Array[]) => Promise<T[]>,
): Promise<T[]> => {
  const answered: T[] = [];
  for (const batch of inboxBatches(entries)) {
    const items = await request(batch);
    if (items.length !== batch.length) throw new MalformedPayloadError(field);
    answered.push(...items);
  }
  return answered;
};

/**
 * The keyring a request carries in place of `keyring`: `keyring` itself
 * when its envelopes fit one request, otherwise its envelopes from the
 * live one on, as many as fit. The live envelope is found by paging the
 * envelopes to the signer, oldest page first, so the first page holding
 * one holds the oldest, the one the signer takes as live, however many
 * envelopes anyone appended after it; the earlier secrets beside it come
 * from the envelopes older than it that still fit. Unlike the whole
 * keyring a local key opens, it leaves out the envelopes newer than the
 * live one, which the live keys are never taken from and which add only
 * secrets sealed to this reader key after the live one landed.
 *
 * @throws {@link EncryptionKeyMismatchError} when no page holds an
 * envelope whose secret derives the keyring's `enc_key`.
 */
const liveKeyring = async (
  client: SignerRequester,
  networkId: string,
  keyring: AccountKeyring,
): Promise<AccountKeyring> => {
  const { envelopes } = keyring;
  if (envelopes.length <= MAX_INBOX_ENTRIES_PER_REQUEST) return keyring;
  for (
    let end = envelopes.length;
    end > 0;
    end -= MAX_INBOX_ENTRIES_PER_REQUEST
  ) {
    const start = Math.max(0, end - MAX_INBOX_ENTRIES_PER_REQUEST);
    const page = envelopes.slice(start, end);
    const live = decodeLiveEnvelope(
      await requestSigner(client, 'find-live-envelope', {
        networkId,
        keyring: encodeKeyring({ ...keyring, envelopes: page }),
      }),
      'live',
      page.length,
    );
    if (live !== null) {
      const from = start + live;
      return {
        ...keyring,
        envelopes: envelopes.slice(from, from + MAX_INBOX_ENTRIES_PER_REQUEST),
      };
    }
  }
  throw new EncryptionKeyMismatchError(
    "None of this device's envelopes opens the account's enc_key.",
  );
};

/**
 * A PassportEncryptionKey whose reader secret lives with the Lace signer
 * page. The signer derives this device's reader key, draws the random
 * account secrets and opens them from the envelopes it is sent, and
 * answers with public keys, inbox entries it sealed, or what the entries
 * it was sent open to, so the dApp never holds the viewing capability,
 * only what the signer opened or sealed for the flow it approved. An
 * inbox is opened or re-encrypted in batches of at most the entries the
 * signer serves per request, each answered with one item, or null, per
 * entry it sent; every batch carries the keyring. A keyring with more
 * envelopes than one request carries is sent from its live envelope on,
 * see {@link liveKeyring}, found once per keyring.
 */
export const createRemoteEncryptionKey = (
  client: SignerRequester,
): Required<PassportEncryptionKey> => {
  const carried = new WeakMap<AccountKeyring, AccountKeyring>();
  const carriedKeyring = async (
    networkId: string,
    keyring: AccountKeyring,
  ): Promise<ReturnType<typeof encodeKeyring>> => {
    const known =
      carried.get(keyring) ?? (await liveKeyring(client, networkId, keyring));
    carried.set(keyring, known);
    return encodeKeyring(known);
  };
  return {
    readerPublicKey: async networkId =>
      decodeBytes(
        await requestSigner(client, 'reader-public-key', { networkId }),
        'readerPublicKey',
        X25519_PUBLIC_KEY_LENGTH,
      ),
    createKeys: async (
      networkId,
      {
        devicePublicKey,
        keyring,
        registrations,
        readers,
        rotateRoster,
        removed,
      },
    ) =>
      decodeAccountKeys(
        await requestSigner(client, 'create-keys', {
          networkId,
          devicePublicKey,
          ...(keyring
            ? { keyring: await carriedKeyring(networkId, keyring) }
            : {}),
          ...(registrations
            ? { registrations: encodeEntries(registrations) }
            : {}),
          ...(readers
            ? { readers: readers.map(reader => encodeLiveReader(reader)) }
            : {}),
          ...(rotateRoster === undefined ? {} : { rotateRoster }),
          ...(removed ? { removed: encodeRemovedDevice(removed) } : {}),
        }),
        'keys',
      ),
    sealToDevice: async (networkId, keyring, reader) =>
      decodeDeviceDelivery(
        await requestSigner(client, 'seal-to-device', {
          networkId,
          keyring: await carriedKeyring(networkId, keyring),
          reader: encodeLiveReader(reader),
        }),
        'delivery',
      ),
    openInbox: async (networkId, keyring, entries) => {
      const sent = await carriedKeyring(networkId, keyring);
      return inBatches<OpenedInboxEntry | null>(
        entries,
        'opened',
        async batch =>
          decodeOpenedEntries(
            await requestSigner(client, 'open-inbox', {
              networkId,
              keyring: sent,
              entries: encodeEntries(batch),
            }),
            'opened',
          ),
      );
    },
    sealGrant: async (networkId, account, grant) =>
      decodeInboxEntries(
        await requestSigner(client, 'seal-grant', {
          networkId,
          account,
          grant,
        }),
        'entries',
      ),
    reencryptInbox: async (networkId, { keyring, to }, entries) => {
      const sent = await carriedKeyring(networkId, keyring);
      return inBatches<Uint8Array | null>(entries, 'entries', async batch =>
        decodeSealedEntries(
          await requestSigner(client, 'reencrypt-inbox', {
            networkId,
            keyring: sent,
            to: encodeBytes(to),
            entries: encodeEntries(batch),
          }),
          'entries',
        ),
      );
    },
    sealView: async (networkId, keyring, { grantId, account, readPublicKey }) =>
      decodeViewDelivery(
        await requestSigner(client, 'seal-view', {
          networkId,
          keyring: await carriedKeyring(networkId, keyring),
          grantId,
          account,
          readPublicKey,
        }),
        'view',
      ),
  };
};
