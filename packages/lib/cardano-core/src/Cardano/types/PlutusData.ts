import type { HexBlob } from '@lace-lib/cardano-util';

export enum PlutusListEncoding {
  FixedLength,
  IndefiniteLength = 0x9f,
}

export enum PlutusMapEncoding {
  FixedLength,
  IndefiniteLength = 0xbf,
}

export type PlutusList = {
  /** This may be set when deserializing a datum. Useful for round-trip reserialization. */
  cbor?: HexBlob;
  /** This property provides granular control of how it should be serialized. Useful when constructing a new datum. */
  encoding?: PlutusListEncoding;
  items: PlutusData[];
};

/**
 * In decoded Plutus data, every entry of a repeated key in `data` takes the value of the first
 * entry, and integer keys collapse into one entry. Only `data` loses entries: `cbor`
 * keeps the exact decoded bytes and PlutusData.fromCore uses it.
 */
export type PlutusMap = {
  /** This may be set when deserializing a datum. Useful for round-trip reserialization. */
  cbor?: HexBlob;
  /** This property provides granular control of how it should be serialized. Useful when constructing a new datum. */
  encoding?: PlutusMapEncoding;
  data: Map<PlutusData, PlutusData>;
};

export type ConstrPlutusData = {
  /** This may be set when deserializing a datum. Useful for round-trip reserialization. */
  cbor?: HexBlob;
  constructor: bigint;
  fields: PlutusList;
};

export type PlutusData =
  | ConstrPlutusData
  | PlutusList
  | PlutusMap
  | Uint8Array
  | bigint;
