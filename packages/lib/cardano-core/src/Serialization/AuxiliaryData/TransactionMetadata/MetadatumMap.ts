import { HexBlob } from '@lace-lib/cardano-util';

import { bytesToHex, hexToBytes } from '../../../util/misc';
import { CborReader, CborReaderState, CborWriter } from '../../CBOR';
import {
  containerEdits,
  recordContainerEdit,
} from '../../Common/ContainerEdits';

import { MetadatumList } from './MetadatumList';
import { TransactionMetadatum } from './TransactionMetadatum';

/**
 * Represents a Map of Metadatum.
 *
 * It keeps repeated keys. In the core form (Cardano.MetadatumMap) every entry of a repeated key
 * takes the value of the first entry, and integer or text keys collapse into one entry. Use
 * TransactionMetadatum.toCbor for the exact decoded bytes.
 */
export class MetadatumMap {
  readonly #map = new Map<TransactionMetadatum, TransactionMetadatum>();
  #useIndefiniteEncoding = false;
  #originalBytes: HexBlob | undefined = undefined;
  #decodedEntries: HexBlob[] = [];
  #verifiedAt = -1;

  /**
   * Serializes this MetadatumMap instance into its CBOR representation as a HexBlob.
   * An instance decoded from CBOR returns the bytes it was decoded from while its keys and
   * values still encode as they did when decoded.
   *
   * @returns The CBOR representation of this instance as a HexBlob.
   */
  toCbor(): HexBlob {
    if (this.#originalBytes && this.#verifiedAt === containerEdits())
      return this.#originalBytes;

    const entries = new Array<HexBlob>();

    for (const [key, value] of this.#map.entries())
      entries.push(key.toCbor(), value.toCbor());

    if (this.#originalBytes && this.#entriesUnchanged(entries)) {
      this.#verifiedAt = containerEdits();
      return this.#originalBytes;
    }

    const writer = new CborWriter();

    if (this.#useIndefiniteEncoding) {
      writer.writeStartMap();
    } else {
      writer.writeStartMap(this.#map.size);
    }

    for (const entry of entries) {
      writer.writeEncodedValue(hexToBytes(entry));
    }

    if (this.#useIndefiniteEncoding) writer.writeEndMap();

    return HexBlob.fromBytes(writer.encode());
  }

  /**
   * Deserializes a MetadatumMap instance from its CBOR representation.
   *
   * @param cbor The CBOR representation of this instance as a HexBlob.
   * @returns A MetadatumMap instance.
   */
  static fromCbor(cbor: HexBlob): MetadatumMap {
    const map = new MetadatumMap();
    const reader = new CborReader(cbor);

    const size = reader.readStartMap();

    if (size === null) map.#useIndefiniteEncoding = true;

    const decodedEntries: HexBlob[] = [];

    while (reader.peekState() !== CborReaderState.EndMap) {
      const key = bytesToHex(reader.readEncodedValue());
      const value = bytesToHex(reader.readEncodedValue());
      decodedEntries.push(key, value);
      map.#map.set(
        TransactionMetadatum.fromCbor(key),
        TransactionMetadatum.fromCbor(value),
      );
    }

    reader.readEndMap();

    map.#originalBytes = cbor;
    map.#decodedEntries = decodedEntries;
    map.#verifiedAt = containerEdits();

    return map;
  }

  /**
   * Gets the length of the map.
   *
   * @returns the length of the map.
   */
  getLength(): number {
    return this.#map.size;
  }

  /**
   * Adds an element to the map.
   *
   * @param key The key of the element in the map.
   * @param value The value of the element.
   */
  insert(key: TransactionMetadatum, value: TransactionMetadatum) {
    recordContainerEdit();
    this.#originalBytes = undefined;
    this.#map.set(key, value);
  }

  /**
   * Returns the specified element from the map.
   *
   * @param key The key of the element to return from the map.
   * @returns The element associated with the specified key in the map, or undefined
   * if there is no element with the given key.
   */
  get(key: TransactionMetadatum): TransactionMetadatum | undefined {
    if (!this.#map) return undefined;

    const element = [...this.#map.entries()].find(entry =>
      entry[0].equals(key),
    );

    if (!element) return undefined;

    return element[1];
  }

  /**
   * Gets all the keys from the map as a metadatum list.
   *
   * @returns The keys of the map as a metadatum list.
   */
  getKeys(): MetadatumList {
    const list = new MetadatumList();

    for (const elem of this.#map.keys()) {
      list.add(elem);
    }

    return list;
  }

  /**
   * Indicates whether some other PlutusMap is "equal to" this one.
   *
   * @param other The other object to be compared.
   * @returns true if objects are equals; otherwise false.
   */
  equals(other: MetadatumMap): boolean {
    if (this.#useIndefiniteEncoding !== other.#useIndefiniteEncoding)
      return false;
    if (this.#map.size !== other.#map.size) return false;

    const thisEntries = [...this.#map.entries()];
    const otherEntries = [...other.#map.entries()];

    for (let i = 0; i < this.#map.size; ++i) {
      if (!thisEntries[i][0].equals(otherEntries[i][0])) return false;
      if (!thisEntries[i][1].equals(otherEntries[i][1])) return false;
    }

    return true;
  }

  /**
   * Indicates whether the keys and values still encode as they did when this map was decoded.
   *
   * @param entries The current CBOR of each key followed by its value.
   * @returns true if every key and value encodes as it did when decoded; otherwise false.
   */
  #entriesUnchanged(entries: HexBlob[]): boolean {
    return (
      entries.length === this.#decodedEntries.length &&
      entries.every((entry, index) => entry === this.#decodedEntries[index])
    );
  }
}
