import { Buffer, UR, URDecoder, UREncoder } from '@lace-lib/vendor';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createUrDecoder,
  encodeToParts,
} from '../../../src/air-gapped/ur-transport';

const URTYPE = 'bytes';
const MAX_SEQUENCE_LENGTH = 1024;
const MAX_MESSAGE_LENGTH = 64 * 1024;

const buildPayload = (length: number, seed = 13): Uint8Array =>
  Uint8Array.from({ length }, (_, index) => (index * 7 + seed) % 256);

/** Minimal-bytewords body (with CRC32) for arbitrary bytes. */
const bytewordsOf = (bytes: Uint8Array): string =>
  UREncoder.encodeSinglePart(new UR(Buffer.from(bytes), URTYPE)).split('/')[1];

/** A CBOR head: major type plus its argument in the shortest encoding. */
const head = (majorType: number, value: bigint): number[] => {
  const prefix = majorType << 5;
  if (value < 24n) return [prefix | Number(value)];
  for (const [info, size] of [
    [24, 1],
    [25, 2],
    [26, 4],
    [27, 8],
  ]) {
    if (value < 1n << BigInt(size * 8)) {
      const bytes = Array.from({ length: size }, (_, index) =>
        Number((value >> BigInt((size - 1 - index) * 8)) & 0xffn),
      );
      return [prefix | info, ...bytes];
    }
  }
  throw new Error(`value too large: ${value}`);
};

const uint = (value: bigint | number): number[] => head(0, BigInt(value));

interface FountainFields {
  sequenceNumber: number[];
  sequenceLength: number[];
  messageLength: number[];
  checksum: number[];
  fragment: number[];
  trailing?: number[];
}

const fountainCbor = (fields: FountainFields): Uint8Array =>
  Uint8Array.from([
    0x85,
    ...fields.sequenceNumber,
    ...fields.sequenceLength,
    ...fields.messageLength,
    ...fields.checksum,
    ...fields.fragment,
    ...(fields.trailing ?? []),
  ]);

const byteString = (length: number): number[] => [
  ...head(2, BigInt(length)),
  ...buildPayload(length),
];

/**
 * A compact, transport-valid first part declaring `sequenceLength` parts of
 * one byte each: its sequence component and fountain body agree.
 */
const oversizedDeclaration = (sequenceLength: number): string =>
  `ur:${URTYPE}/1-${sequenceLength}/${bytewordsOf(
    fountainCbor({
      sequenceNumber: uint(1),
      sequenceLength: uint(sequenceLength),
      messageLength: uint(sequenceLength),
      checksum: uint(1),
      fragment: byteString(1),
    }),
  )}`;

const spyOnFountainDecoder = () => vi.spyOn(URDecoder.prototype, 'receivePart');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('UrPartDecoder incoming limits', () => {
  it('refuses an oversized sequence declaration in a compact frame before bc-ur sees it', () => {
    const fountainDecoder = spyOnFountainDecoder();
    const frame = oversizedDeclaration(4_000_000_000);
    expect(frame.length).toBeLessThan(100);

    expect(() => createUrDecoder().receivePart(frame)).toThrow(
      /sequence length 4000000000 is outside/,
    );
    expect(fountainDecoder).not.toHaveBeenCalled();
  });

  it('accepts the largest supported message and part count', () => {
    const payload = buildPayload(MAX_MESSAGE_LENGTH);
    const parts = encodeToParts(URTYPE, payload, { maxFragmentLength: 64 });
    expect(parts).toHaveLength(MAX_SEQUENCE_LENGTH);
    const decoder = createUrDecoder();

    for (const part of parts) decoder.receivePart(part);

    expect(decoder.result()).toEqual({ urType: URTYPE, cbor: payload });
  });

  it('refuses one part past the sequence cap', () => {
    const parts = encodeToParts(
      URTYPE,
      buildPayload((MAX_SEQUENCE_LENGTH + 1) * 10),
      { maxFragmentLength: 10 },
    );
    expect(parts).toHaveLength(MAX_SEQUENCE_LENGTH + 1);

    expect(() => createUrDecoder().receivePart(parts[0])).toThrow(
      /sequence length 1025 is outside/,
    );
  });

  it('refuses one byte past the message cap', () => {
    const parts = encodeToParts(URTYPE, buildPayload(MAX_MESSAGE_LENGTH + 1), {
      maxFragmentLength: 100,
    });

    expect(() => createUrDecoder().receivePart(parts[0])).toThrow(
      /message length 65537 is outside/,
    );
  });

  it('refuses a frame longer than a QR symbol can carry', () => {
    expect(() =>
      createUrDecoder().receivePart(`ur:${URTYPE}/${'ae'.repeat(2200)}`),
    ).toThrow(/QR capacity/);
  });

  it.each([
    ['text that is not a UR', 'https://example.com/not-a-ur', /not a UR/],
    ['an invalid UR type', 'ur:by_tes/aeae', /invalid UR type/],
    ['an extra path component', 'ur:bytes/1-2/aeae/aeae', /path length/],
    ['a zero sequence number', 'ur:bytes/0-2/aeae', /sequence number/],
    [
      'a sequence number past 32 bits',
      'ur:bytes/4294967296-2/aeae',
      /sequence number/,
    ],
    ['a non-decimal sequence', 'ur:bytes/1e0-2/aeae', /sequence component/],
    ['a corrupt bytewords body', 'ur:bytes/xxnotbytewordsxx', /bytewords/],
    [
      'an empty single-part body',
      `ur:${URTYPE}/${bytewordsOf(new Uint8Array())}`,
      /empty body/,
    ],
  ])('refuses %s', (_, frame, reason) => {
    const fountainDecoder = spyOnFountainDecoder();

    expect(() => createUrDecoder().receivePart(frame)).toThrow(reason);
    expect(fountainDecoder).not.toHaveBeenCalled();
  });

  const valid: FountainFields = {
    sequenceNumber: uint(1),
    sequenceLength: uint(2),
    messageLength: uint(20),
    checksum: uint(1),
    fragment: byteString(10),
  };

  it.each<[string, Partial<FountainFields>, RegExp]>([
    [
      'a float sequence number',
      { sequenceNumber: [0xfb, 0x3f, 0xf0, 0, 0, 0, 0, 0, 0] },
      /malformed fountain part/,
    ],
    ['a negative message length', { messageLength: [0x20] }, /malformed/],
    [
      'a 64-bit message length',
      { messageLength: uint(0xff_ff_ff_ff_ff_ff_ff_ffn) },
      /malformed/,
    ],
    ['a checksum past 32 bits', { checksum: uint(2 ** 33) }, /checksum/],
    [
      'an indefinite-length fragment',
      { fragment: [0x5f, 0x4a, ...buildPayload(10), 0xff] },
      /definite-length fragment/,
    ],
    ['trailing bytes', { trailing: [0x00] }, /trailing bytes/],
    [
      'a body disagreeing with its sequence component',
      { sequenceLength: uint(3), messageLength: uint(30) },
      /does not match the fountain part/,
    ],
    ['a zero message length', { messageLength: uint(0) }, /message length 0/],
    [
      'a part count the lengths do not imply',
      { messageLength: uint(100) },
      /does not match the message and fragment lengths/,
    ],
  ])('refuses %s', (_, override, reason) => {
    const fountainDecoder = spyOnFountainDecoder();
    const frame = `ur:${URTYPE}/1-2/${bytewordsOf(
      fountainCbor({ ...valid, ...override }),
    )}`;

    expect(() => createUrDecoder().receivePart(frame)).toThrow(reason);
    expect(fountainDecoder).not.toHaveBeenCalled();
  });

  it('keeps reassembly progress across repeated hostile frames', () => {
    const payload = buildPayload(260);
    const parts = encodeToParts(URTYPE, payload, { maxFragmentLength: 90 });
    const decoder = createUrDecoder();
    decoder.receivePart(parts[0]);
    const progress = decoder.progress();
    const hostile = oversizedDeclaration(4_000_000_000);

    for (let index = 0; index < 100; index++) {
      expect(() => decoder.receivePart(hostile)).toThrow();
    }
    expect(decoder.progress()).toBe(progress);
    for (const part of parts.slice(1)) decoder.receivePart(part);

    expect(decoder.result()).toEqual({ urType: URTYPE, cbor: payload });
  });

  it('fails terminally instead of retaining parts past its budget', () => {
    // Parts that never cover the last fragment can never complete, so a stream
    // of them grows retained state for as long as it is fed.
    const fragmentCount = 10;
    const encoder = new UREncoder(
      new UR(Buffer.from(buildPayload(100)), URTYPE),
      10,
    );
    const hostile: string[] = [];
    while (hostile.length < 100) {
      const part = encoder.nextPart();
      const probe = new URDecoder();
      probe.receivePart(part);
      if (!probe.lastPartIndexes().includes(fragmentCount - 1)) {
        hostile.push(part);
      }
    }
    const budget = fragmentCount * 4 + 32;
    const fountainDecoder = spyOnFountainDecoder();
    const decoder = createUrDecoder();

    for (const part of hostile) decoder.receivePart(part);

    expect(fountainDecoder).toHaveBeenCalledTimes(budget);
    expect(decoder.isComplete()).toBe(false);
    expect(decoder.failureMessage()).toBe(
      `UR stream exceeded its budget of ${budget} distinct parts`,
    );
  });

  it('does not count repeats of a retained part against the budget', () => {
    const payload = buildPayload(260);
    const parts = encodeToParts(URTYPE, payload, { maxFragmentLength: 90 });
    const decoder = createUrDecoder();

    for (let index = 0; index < 100; index++) decoder.receivePart(parts[0]);
    for (const part of parts.slice(1)) decoder.receivePart(part);

    expect(decoder.failureMessage()).toBeUndefined();
    expect(decoder.result().cbor).toEqual(payload);
  });
});

describe('UrPartDecoder.canAccept', () => {
  const parts = encodeToParts(URTYPE, buildPayload(260), {
    maxFragmentLength: 90,
  });

  it('accepts any valid part before latching', () => {
    expect(createUrDecoder().canAccept(parts[0])).toBe(true);
  });

  it('defers a part that fails validation to receivePart', () => {
    expect(createUrDecoder().canAccept('https://example.com')).toBe(true);
  });

  it('refuses another UR type once latched', () => {
    const decoder = createUrDecoder();
    decoder.receivePart(parts[0]);

    expect(
      decoder.canAccept(encodeToParts('crypto-psbt', buildPayload(4))[0]),
    ).toBe(false);
  });

  it('refuses another message of the same type once latched', () => {
    const decoder = createUrDecoder();
    decoder.receivePart(parts[0]);
    const other = encodeToParts(URTYPE, buildPayload(260, 99), {
      maxFragmentLength: 90,
    });

    expect(decoder.canAccept(parts[1])).toBe(true);
    expect(decoder.canAccept(other[1])).toBe(false);
  });
});
