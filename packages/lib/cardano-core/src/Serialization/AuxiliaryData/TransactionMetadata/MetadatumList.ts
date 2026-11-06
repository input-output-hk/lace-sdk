import { HexBlob } from '@lace-lib/cardano-util';

import { bytesToHex, hexToBytes } from '../../../util/misc';
import { CborReader, CborReaderState, CborWriter } from '../../CBOR';
import {
  containerEdits,
  recordContainerEdit,
} from '../../Common/ContainerEdits';

import { TransactionMetadatum } from './TransactionMetadatum';

/** A list of metadatum. */
export class MetadatumList {
  readonly #array = new Array<TransactionMetadatum>();
  #useIndefiniteEncoding = false;
  #originalBytes: HexBlob | undefined = undefined;
  #decodedElements: HexBlob[] = [];
  #verifiedAt = -1;

  /**
   * Serializes this MetadatumList instance into its CBOR representation as a HexBlob.
   * An instance decoded from CBOR returns the bytes it was decoded from while its elements
   * still encode as they did when decoded.
   *
   * @returns The CBOR representation of this instance as a HexBlob.
   */
  toCbor(): HexBlob {
    if (this.#originalBytes && this.#verifiedAt === containerEdits())
      return this.#originalBytes;

    const elements = new Array<HexBlob>();

    for (const elem of this.#array) elements.push(elem.toCbor());

    if (this.#originalBytes && this.#elementsUnchanged(elements)) {
      this.#verifiedAt = containerEdits();
      return this.#originalBytes;
    }

    const writer = new CborWriter();

    if (this.#useIndefiniteEncoding) {
      writer.writeStartArray();
    } else {
      writer.writeStartArray(this.#array.length);
    }

    for (const elem of elements) {
      writer.writeEncodedValue(hexToBytes(elem));
    }

    if (this.#useIndefiniteEncoding) writer.writeEndArray();

    return HexBlob.fromBytes(writer.encode());
  }

  /**
   * Deserializes a MetadatumList instance from its CBOR representation.
   *
   * @param cbor The CBOR representation of this instance as a HexBlob.
   * @returns A MetadatumList instance.
   */
  static fromCbor(cbor: HexBlob): MetadatumList {
    const list = new MetadatumList();
    const reader = new CborReader(cbor);

    const length = reader.readStartArray();

    if (length === null) list.#useIndefiniteEncoding = true;

    const decodedElements: HexBlob[] = [];

    while (reader.peekState() !== CborReaderState.EndArray) {
      const element = bytesToHex(reader.readEncodedValue());
      decodedElements.push(element);
      list.#array.push(TransactionMetadatum.fromCbor(element));
    }

    reader.readEndArray();

    list.#originalBytes = cbor;
    list.#decodedElements = decodedElements;
    list.#verifiedAt = containerEdits();

    return list;
  }

  /**
   * Gets the length of the list.
   *
   * @returns the length of the list.
   */
  getLength(): number {
    return this.#array.length;
  }

  /**
   * Gets an element from the list.
   *
   * @param index The index in the list of the element to get.
   */
  get(index: number): TransactionMetadatum {
    return this.#array[index];
  }

  /**
   * Adds an element to the Metadata List.
   *
   * @param elem The element to be added.
   */
  add(elem: TransactionMetadatum): void {
    recordContainerEdit();
    this.#originalBytes = undefined;
    this.#array.push(elem);
  }

  /**
   * Indicates whether some other PlutusList is "equal to" this one.
   *
   * @param other The other object to be compared.
   * @returns true if objects are equals; otherwise false.
   */
  equals(other: MetadatumList): boolean {
    if (this.#array.length !== other.#array.length) return false;

    for (let i = 0; i < this.#array.length; ++i) {
      if (!this.#array[i].equals(other.#array[i])) return false;
    }

    return true;
  }

  /**
   * Indicates whether the elements still encode as they did when this list was decoded.
   *
   * @param elements The current CBOR of each element.
   * @returns true if every element encodes as it did when decoded; otherwise false.
   */
  #elementsUnchanged(elements: HexBlob[]): boolean {
    return (
      elements.length === this.#decodedElements.length &&
      elements.every((elem, index) => elem === this.#decodedElements[index])
    );
  }
}
