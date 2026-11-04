import { URDecoder } from '@lace-lib/vendor';

import {
  createReader,
  peekIsByteString,
  readArrayLength,
  readUint,
} from './cbor-helpers';

/** Outcome of feeding one part into a {@link UrPartDecoder}. */
export interface UrReceiveResult {
  /** Whether the full payload has been reassembled. */
  complete: boolean;
  /** Estimated reassembly progress in the range 0..1. */
  progress: number;
}

/** A reassembled UR message: its type string and untagged CBOR body. */
export interface UrResult {
  urType: string;
  cbor: Uint8Array;
}

// Incoming limits. bc-ur sizes its state from the first part's declared
// sequence length and retains every distinct mixed part, so a frame of a few
// dozen bytes could otherwise demand gigabytes. Every part is checked against
// these BEFORE bc-ur sees it.

/**
 * The most characters one QR symbol carries (version 40, alphanumeric mode).
 * No camera read is longer, and it bounds a fragment to about 2 KB.
 */
const MAX_PART_LENGTH = 4296;

/**
 * Largest reassembled message, in bytes. The largest supported response is a
 * Keystone signed PSBT: the device accepts at most 14 KiB of request CBOR and
 * returns it re-serialized with signatures added. Cardano witness sets are
 * bounded by the 16 KiB protocol transaction limit, and account exports carry
 * at most 24 keys (about 3 KB). This leaves 3× headroom.
 */
const MAX_MESSAGE_LENGTH = 64 * 1024;

/**
 * Largest declared part count. SeedSigner's lowest QR density emits 10–19-byte
 * fragments, the smallest of any supported device, so this carries at least
 * 10 KiB at that density and 30 KiB at its default; Keystone fragments are up
 * to 240 bytes. bc-ur's work per part grows with the square of this count.
 */
const MAX_SEQUENCE_LENGTH = 1024;

/**
 * Distinct parts one reassembly may retain, per declared part. Simulated scans
 * that dropped 80% of frames completed within 2.4× the part count; parts past
 * the budget only grow the state a hostile stream can pin.
 */
const RETAINED_PARTS_PER_SEQUENCE_PART = 4;
/** Extra headroom for short streams, whose completion varies most. */
const RETAINED_PARTS_SLACK = 32;

const UINT32_MAX = 0xff_ff_ff_ff;
const UR_TYPE_PATTERN = /^[\da-z-]+$/;
const SEQUENCE_PATTERN = /^(\d{1,10})-(\d{1,10})$/;
const FOUNTAIN_PART_FIELD_COUNT = 5;

/** The fountain header of one multipart part. */
interface UrSequence {
  sequenceNumber: number;
  sequenceLength: number;
  messageLength: number;
  checksum: number;
  fragmentLength: number;
}

interface UrPartHeader {
  urType: string;
  /** Absent on a single-part UR. */
  sequence?: UrSequence;
}

const partRejected = (reason: string): Error =>
  new Error(`UR part rejected: ${reason}`);

const retainedPartBudget = (sequenceLength: number): number =>
  sequenceLength * RETAINED_PARTS_PER_SEQUENCE_PART + RETAINED_PARTS_SLACK;

/** Decodes a minimal-bytewords body, verifying its CRC32. */
const decodeBody = (urType: string, body: string): Uint8Array => {
  try {
    return URDecoder.decode(`ur:${urType}/${body}`).cbor;
  } catch (error) {
    throw partRejected(
      `invalid bytewords body: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

/**
 * Reads a BC-UR fountain part: the sequence number, sequence length, message
 * length, checksum and fragment. Only unsigned integers, a definite-length
 * fragment and no trailing bytes pass, so floats, negatives and oversized
 * integers never reach bc-ur's looser decoder.
 */
const readSequence = (cbor: Uint8Array): UrSequence => {
  try {
    const reader = createReader(cbor);
    if (readArrayLength(reader) !== FOUNTAIN_PART_FIELD_COUNT) {
      throw new Error('expected a 5-element array');
    }
    const sequenceNumber = readUint(reader);
    const sequenceLength = readUint(reader);
    const messageLength = readUint(reader);
    const checksum = readUint(reader);
    if (!peekIsByteString(reader)) {
      throw new Error('expected a definite-length fragment');
    }
    const fragmentLength = reader.readByteString().length;
    reader.readEndArray();
    if (reader.getBytesRemaining() !== 0) {
      throw new Error('trailing bytes');
    }
    return {
      sequenceNumber,
      sequenceLength,
      messageLength,
      checksum,
      fragmentLength,
    };
  } catch (error) {
    throw partRejected(
      `malformed fountain part: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

const assertSequence = (
  declared: { sequenceNumber: number; sequenceLength: number },
  sequence: UrSequence,
): void => {
  if (
    sequence.sequenceNumber !== declared.sequenceNumber ||
    sequence.sequenceLength !== declared.sequenceLength
  ) {
    throw partRejected('sequence component does not match the fountain part');
  }
  if (
    sequence.messageLength < 1 ||
    sequence.messageLength > MAX_MESSAGE_LENGTH
  ) {
    throw partRejected(
      `message length ${sequence.messageLength} is outside 1..${MAX_MESSAGE_LENGTH}`,
    );
  }
  if (sequence.checksum > UINT32_MAX) {
    throw partRejected('checksum exceeds 32 bits');
  }
  if (sequence.fragmentLength < 1) {
    throw partRejected('empty fragment');
  }
  // Every conforming encoder pads only the last fragment, so the part count is
  // pinned by the two lengths. Keystone and SeedSigner decoders enforce this too.
  if (
    sequence.sequenceLength !==
    Math.ceil(sequence.messageLength / sequence.fragmentLength)
  ) {
    throw partRejected(
      'sequence length does not match the message and fragment lengths',
    );
  }
};

/** Parses the `<seqNum>-<seqLen>` component before any body is decoded. */
const parseSequenceComponent = (
  component: string,
): { sequenceNumber: number; sequenceLength: number } => {
  const match = SEQUENCE_PATTERN.exec(component);
  if (!match) throw partRejected('invalid sequence component');
  const sequenceNumber = Number(match[1]);
  const sequenceLength = Number(match[2]);
  if (sequenceNumber < 1 || sequenceNumber > UINT32_MAX) {
    throw partRejected('sequence number is outside 1..2^32-1');
  }
  if (sequenceLength < 1 || sequenceLength > MAX_SEQUENCE_LENGTH) {
    throw partRejected(
      `sequence length ${sequenceLength} is outside 1..${MAX_SEQUENCE_LENGTH}`,
    );
  }
  return { sequenceNumber, sequenceLength };
};

/**
 * Validates one scanned part against the incoming limits.
 *
 * @throws when the part is malformed or exceeds a limit.
 */
const parsePart = (part: string): UrPartHeader => {
  if (part.length > MAX_PART_LENGTH) {
    throw partRejected(
      `${part.length} characters exceed the ${MAX_PART_LENGTH}-character QR capacity`,
    );
  }
  const lower = part.toLowerCase();
  if (!lower.startsWith('ur:')) throw partRejected('not a UR');
  const [urType = '', ...path] = lower.slice(3).split('/');
  if (!UR_TYPE_PATTERN.test(urType)) throw partRejected('invalid UR type');
  const [first, fragment] = path;
  if (first === undefined || path.length > 2) {
    throw partRejected('invalid path length');
  }
  if (fragment === undefined) {
    // Decoded here so a malformed body is refused before bc-ur latches its
    // type, and an empty one before it records a result that never completes.
    if (decodeBody(urType, first).length === 0) {
      throw partRejected('empty body');
    }
    return { urType };
  }
  const declared = parseSequenceComponent(first);
  const sequence = readSequence(decodeBody(urType, fragment));
  assertSequence(declared, sequence);
  return { urType, sequence };
};

const isSameMessage = (a: UrSequence, b: UrSequence): boolean =>
  a.sequenceLength === b.sequenceLength &&
  a.messageLength === b.messageLength &&
  a.checksum === b.checksum &&
  a.fragmentLength === b.fragmentLength;

/**
 * Accumulates scanned animated-QR part strings into a complete (urType, cbor)
 * result. Tolerates out-of-order and duplicate or redundant fountain parts;
 * each {@link receivePart} reports whether the payload is complete and the
 * current progress.
 *
 * Every part is bounded before it reaches the fountain decoder: frame length,
 * declared part count, message length, the part count those lengths imply, and
 * the number of distinct parts one reassembly retains.
 */
export class UrPartDecoder {
  private readonly decoder = new URDecoder();
  /** The UR type the fountain decoder latched from the first part it parsed. */
  private urType: string | undefined;
  /** The message the fountain decoder latched from the first multipart part. */
  private sequence: UrSequence | undefined;
  /** Sequence numbers of the distinct multipart parts already retained. */
  private readonly retainedSequenceNumbers = new Set<number>();
  private budgetFailure: string | undefined;

  /**
   * Feeds one part string into the decoder. Parts are accepted in any letter
   * case: devices emit upper-case frames for QR alphanumeric mode and the
   * underlying UR decoding is case-insensitive.
   *
   * A part of another type or message than the one already latched is
   * ignored; see {@link canAccept}. A new distinct part past the retained-part
   * budget is not fed, and the decoder fails terminally instead; see
   * {@link failureMessage}.
   *
   * @returns completion state and progress (0..1) after this part.
   * @throws when the part is malformed or exceeds an incoming limit. The
   *   decoder is left untouched, so accumulated progress survives.
   */
  public receivePart(part: string): UrReceiveResult {
    const header = parsePart(part);
    if (this.budgetFailure !== undefined) return this.receiveResult();
    const { sequence } = header;
    if (
      sequence !== undefined &&
      this.isLatchedMessage(header) &&
      !this.retainedSequenceNumbers.has(sequence.sequenceNumber)
    ) {
      const budget = retainedPartBudget(sequence.sequenceLength);
      if (this.retainedSequenceNumbers.size >= budget) {
        this.budgetFailure = `UR stream exceeded its budget of ${budget} distinct parts`;
        return this.receiveResult();
      }
    }
    this.urType ??= header.urType;
    if (this.decoder.receivePart(part) && sequence !== undefined) {
      this.sequence ??= sequence;
      this.retainedSequenceNumbers.add(sequence.sequenceNumber);
    }
    return this.receiveResult();
  }

  /**
   * Whether this decoder could still accept `part`, or is certain to ignore it.
   *
   * The fountain decoder latches the UR type of the first part and the message
   * of the first multipart part, then ignores every other one SILENTLY — no
   * error, no progress — so a caller watching progress cannot tell a decoder
   * latched onto a stale or hostile stream from a slow one. A part that fails
   * validation answers true: it belongs to {@link receivePart}'s throw path.
   */
  public canAccept(part: string): boolean {
    try {
      return this.isLatchedMessage(parsePart(part));
    } catch {
      return true;
    }
  }

  /** Whether the payload has been fully reassembled. */
  public isComplete(): boolean {
    return this.decoder.isComplete() === true;
  }

  /** Estimated reassembly progress in the range 0..1. */
  public progress(): number {
    return this.decoder.estimatedPercentComplete();
  }

  /**
   * Terminal decode failure message, or undefined while decoding can still
   * succeed. Once the underlying fountain decoder reports failure (checksum
   * mismatch on the fully reassembled message) or the stream exceeds its
   * retained-part budget, the instance can never complete and must be
   * replaced.
   */
  public failureMessage(): string | undefined {
    if (this.budgetFailure !== undefined) return this.budgetFailure;
    return this.decoder.isError() ? this.decoder.resultError() : undefined;
  }

  /**
   * Returns the reassembled (urType, cbor) result.
   *
   * @throws if called before the stream is complete or if decoding failed.
   */
  public result(): UrResult {
    if (!this.isComplete()) {
      throw new Error('UR stream is not complete');
    }
    if (!this.decoder.isSuccess()) {
      throw new Error(`UR decode failed: ${this.decoder.resultError()}`);
    }
    const ur = this.decoder.resultUR();
    return { urType: ur.type, cbor: Uint8Array.from(ur.cbor) };
  }

  private isLatchedMessage({ urType, sequence }: UrPartHeader): boolean {
    if (this.urType !== undefined && urType !== this.urType) return false;
    if (sequence === undefined || this.sequence === undefined) return true;
    return isSameMessage(sequence, this.sequence);
  }

  private receiveResult(): UrReceiveResult {
    return { complete: this.isComplete(), progress: this.progress() };
  }
}

/** Creates a fresh {@link UrPartDecoder}. */
export const createUrDecoder = (): UrPartDecoder => new UrPartDecoder();
