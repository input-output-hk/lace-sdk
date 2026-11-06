import {
  InvalidArgumentError,
  InvalidStateError,
} from '@lace-lib/cardano-util';

import { SerializationError, SerializationFailure } from '../../errors';
import { CborReader, CborReaderState, CborWriter } from '../CBOR';

import type * as Cardano from '../../Cardano';
import type { HexBlob } from '@lace-lib/cardano-util';

const INTERVAL_ARRAY_SIZE = 2;
const BOTH_NIL_MESSAGE = 'Both interval bounds cannot be nil.';
const EXACT_WITH_BOUNDS_MESSAGE =
  'An exact balance cannot be combined with interval bounds.';

/**
 * A condition on an account balance b checked at validation time (Dijkstra
 * account_balance_interval). It is either a half-open range asserting that
 * inclusiveLowerBound <= b < exclusiveUpperBound, or an exact balance that b must equal.
 *
 * On the wire a range is a 2-element array [inclusive_lower_bound, exclusive_upper_bound]
 * where an absent bound encodes as CBOR null (nil). At most one bound may be nil; a bound of 0
 * is a valid coin value distinct from nil. An exact balance is a bare coin.
 */
export class AccountBalanceInterval {
  #inclusiveLowerBound: Cardano.Lovelace | undefined;
  #exclusiveUpperBound: Cardano.Lovelace | undefined;
  #exactBalance: Cardano.Lovelace | undefined;
  #originalBytes: HexBlob | undefined = undefined;

  /**
   * Initializes a new instance of the AccountBalanceInterval class as a half-open range.
   *
   * @param inclusiveLowerBound The inclusive lower bound in lovelace, or undefined for no lower bound.
   * @param exclusiveUpperBound The exclusive upper bound in lovelace, or undefined for no upper bound.
   */
  constructor(
    inclusiveLowerBound?: Cardano.Lovelace,
    exclusiveUpperBound?: Cardano.Lovelace,
  ) {
    this.#inclusiveLowerBound = inclusiveLowerBound;
    this.#exclusiveUpperBound = exclusiveUpperBound;
  }

  /**
   * Creates an interval asserting that the account balance equals the given amount.
   *
   * @param exactBalance The exact balance in lovelace.
   * @returns The new AccountBalanceInterval instance.
   */
  static newExact(exactBalance: Cardano.Lovelace): AccountBalanceInterval {
    const interval = new AccountBalanceInterval();
    interval.#exactBalance = exactBalance;

    return interval;
  }

  /**
   * Serializes an AccountBalanceInterval into CBOR format.
   *
   * @returns The AccountBalanceInterval in CBOR format.
   */
  toCbor(): HexBlob {
    if (this.#originalBytes) return this.#originalBytes;

    const writer = new CborWriter();

    if (this.#exactBalance !== undefined) {
      writer.writeInt(this.#exactBalance);
      return writer.encodeAsHex();
    }

    if (
      this.#inclusiveLowerBound === undefined &&
      this.#exclusiveUpperBound === undefined
    )
      throw new InvalidStateError(BOTH_NIL_MESSAGE);

    // CDDL
    // account_balance_interval =
    //   [  inclusive_lower_bound : coin, exclusive_upper_bound : coin/ nil
    //   // inclusive_lower_bound : coin/ nil, exclusive_upper_bound : coin
    //   ]
    //   / coin
    writer.writeStartArray(INTERVAL_ARRAY_SIZE);

    if (this.#inclusiveLowerBound === undefined) {
      writer.writeNull();
    } else {
      writer.writeInt(this.#inclusiveLowerBound);
    }

    if (this.#exclusiveUpperBound === undefined) {
      writer.writeNull();
    } else {
      writer.writeInt(this.#exclusiveUpperBound);
    }

    return writer.encodeAsHex();
  }

  /**
   * Deserializes an AccountBalanceInterval from a CBOR byte array. Accepts the bare coin form
   * and both definite and indefinite length arrays.
   *
   * @param cbor The CBOR encoded AccountBalanceInterval object.
   * @returns The new AccountBalanceInterval instance.
   */
  static fromCbor(cbor: HexBlob): AccountBalanceInterval {
    const reader = new CborReader(cbor);

    if (reader.peekState() === CborReaderState.UnsignedInteger) {
      const exact = AccountBalanceInterval.newExact(reader.readInt());
      exact.#originalBytes = cbor;

      return exact;
    }

    const length = reader.readStartArray();
    if (length !== null && length !== INTERVAL_ARRAY_SIZE)
      throw new SerializationError(
        SerializationFailure.InvalidType,
        `account_balance_interval must be an array of ${INTERVAL_ARRAY_SIZE} elements, but got ${length}`,
      );

    let inclusiveLowerBound;
    if (reader.peekState() === CborReaderState.Null) {
      reader.readNull();
    } else {
      inclusiveLowerBound = reader.readInt();
    }

    let exclusiveUpperBound;
    if (reader.peekState() === CborReaderState.Null) {
      reader.readNull();
    } else {
      exclusiveUpperBound = reader.readInt();
    }

    reader.readEndArray();

    if (inclusiveLowerBound === undefined && exclusiveUpperBound === undefined)
      throw new SerializationError(
        SerializationFailure.InvalidType,
        BOTH_NIL_MESSAGE,
      );

    const interval = new AccountBalanceInterval(
      inclusiveLowerBound,
      exclusiveUpperBound,
    );
    interval.#originalBytes = cbor;

    return interval;
  }

  /**
   * Creates a Core AccountBalanceInterval object from the current AccountBalanceInterval object.
   *
   * @returns The Core AccountBalanceInterval object.
   */
  toCore(): Cardano.AccountBalanceInterval {
    if (this.#exactBalance !== undefined)
      return { exactBalance: this.#exactBalance };

    return {
      ...(this.#inclusiveLowerBound !== undefined && {
        inclusiveLowerBound: this.#inclusiveLowerBound,
      }),
      ...(this.#exclusiveUpperBound !== undefined && {
        exclusiveUpperBound: this.#exclusiveUpperBound,
      }),
    };
  }

  /**
   * Creates an AccountBalanceInterval object from the given Core AccountBalanceInterval object.
   *
   * @param interval The core AccountBalanceInterval object.
   * @returns The new AccountBalanceInterval instance.
   */
  static fromCore(
    interval: Cardano.AccountBalanceInterval,
  ): AccountBalanceInterval {
    if (interval.exactBalance !== undefined) {
      if (
        interval.inclusiveLowerBound !== undefined ||
        interval.exclusiveUpperBound !== undefined
      )
        throw new InvalidArgumentError('interval', EXACT_WITH_BOUNDS_MESSAGE);

      return AccountBalanceInterval.newExact(interval.exactBalance);
    }

    if (
      interval.inclusiveLowerBound === undefined &&
      interval.exclusiveUpperBound === undefined
    )
      throw new InvalidArgumentError('interval', BOTH_NIL_MESSAGE);

    return new AccountBalanceInterval(
      interval.inclusiveLowerBound,
      interval.exclusiveUpperBound,
    );
  }

  /**
   * Sets the inclusive lower bound of this interval, turning an exact balance into a range.
   *
   * @param inclusiveLowerBound The inclusive lower bound in lovelace, or undefined for no lower bound.
   */
  setInclusiveLowerBound(inclusiveLowerBound?: Cardano.Lovelace): void {
    this.#inclusiveLowerBound = inclusiveLowerBound;
    this.#exactBalance = undefined;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the inclusive lower bound of this interval.
   *
   * @returns The inclusive lower bound in lovelace, or undefined when the bound is nil.
   */
  inclusiveLowerBound(): Cardano.Lovelace | undefined {
    return this.#inclusiveLowerBound;
  }

  /**
   * Sets the exclusive upper bound of this interval, turning an exact balance into a range.
   *
   * @param exclusiveUpperBound The exclusive upper bound in lovelace, or undefined for no upper bound.
   */
  setExclusiveUpperBound(
    exclusiveUpperBound: Cardano.Lovelace | undefined,
  ): void {
    this.#exclusiveUpperBound = exclusiveUpperBound;
    this.#exactBalance = undefined;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the exclusive upper bound of this interval.
   *
   * @returns The exclusive upper bound in lovelace, or undefined when the bound is nil.
   */
  exclusiveUpperBound(): Cardano.Lovelace | undefined {
    return this.#exclusiveUpperBound;
  }

  /**
   * Sets the exact balance the account must hold, replacing any range bounds.
   *
   * @param exactBalance The exact balance in lovelace.
   */
  setExactBalance(exactBalance: Cardano.Lovelace): void {
    this.#exactBalance = exactBalance;
    this.#inclusiveLowerBound = undefined;
    this.#exclusiveUpperBound = undefined;
    this.#originalBytes = undefined;
  }

  /**
   * Gets the exact balance the account must hold.
   *
   * @returns The exact balance in lovelace, or undefined when this interval is a range.
   */
  exactBalance(): Cardano.Lovelace | undefined {
    return this.#exactBalance;
  }
}
