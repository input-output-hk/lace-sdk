import { Cardano, Serialization } from '@cardano-sdk/core';
import { Hash28ByteBase16 } from '@cardano-sdk/crypto';
import { HexBlob } from '@cardano-sdk/util';
import { isCborWithinLimits } from '@lace-lib/core';

import type { HydraOutRef, HydraValue } from './types';

/** Byte length of key, script and policy hashes. */
const HASH_28_LENGTH = 28;

/**
 * Latest instant in milliseconds that a JavaScript `Date` can represent, so
 * an instant read from a datum can always be shown.
 */
const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000n;

/** Largest index read as a JavaScript number without losing precision. */
const MAX_INDEX = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Deepest nesting of arrays and maps decoded. Hydra datums nest a handful of
 * levels, while the decoder's cost grows with the square of the depth.
 */
const MAX_DATA_DEPTH = 32;

/**
 * Largest CBOR decoded, in bytes. Genuine Hydra datums take a few hundred
 * bytes, or more for commits of many assets, while decoding and reading
 * wide maps costs time that grows faster than their size.
 */
const MAX_DATA_SIZE = 4096;

/** Ledger API `TxOut` record: address, value, datum and reference script. */
const TX_OUT_FIELD_COUNT = 4;

/** Plutus data fields of one constructor alternative. */
type Fields = readonly Serialization.PlutusData[];

/** Address decoded from its Plutus ledger API encoding. */
export interface PlutusAddress {
  readonly address: string;
  readonly paymentKeyHash?: string;
}

/** Output decoded from its Plutus ledger API encoding. */
export interface PlutusTxOut extends PlutusAddress {
  readonly value: HydraValue;
}

/**
 * Parses CBOR hex into Plutus data. Throws on malformed CBOR and on data too
 * large or nested too deep for any Hydra datum, which it refuses before
 * decoding so that a crafted datum cannot stall the caller.
 */
export const parsePlutusData = (cbor: string): Serialization.PlutusData => {
  if (
    !isCborWithinLimits(cbor, {
      maxBytes: MAX_DATA_SIZE,
      maxDepth: MAX_DATA_DEPTH,
    })
  ) {
    throw new Error('Plutus data is too large, malformed or nested too deep');
  }
  return Serialization.PlutusData.fromCbor(HexBlob(cbor));
};

/**
 * Returns the fields of a constructor, or undefined when the data is not a
 * constructor with the expected alternative and field count.
 */
export const readConstr = (
  data: Serialization.PlutusData,
  alternative: bigint,
  fieldCount: number,
): Fields | undefined => {
  const constr = data.asConstrPlutusData();
  if (!constr || constr.getAlternative() !== alternative) return undefined;
  const fields = readList(constr.getData());
  return fields.length === fieldCount ? fields : undefined;
};

/** Returns the alternative and fields of any constructor. */
export const readAnyConstr = (
  data: Serialization.PlutusData,
): { alternative: bigint; fields: Fields } | undefined => {
  const constr = data.asConstrPlutusData();
  if (!constr) return undefined;
  return {
    alternative: constr.getAlternative(),
    fields: readList(constr.getData()),
  };
};

/** Returns the elements of a Plutus list. */
const readList = (list: Serialization.PlutusList): Fields =>
  Array.from({ length: list.getLength() }, (_, index) => list.get(index));

/** Returns the elements of list data, or undefined when it is not a list. */
export const readListData = (
  data: Serialization.PlutusData,
): Fields | undefined => {
  const list = data.asList();
  return list ? readList(list) : undefined;
};

/** Returns the bytes as hex, or undefined when the data is not bytes. */
export const readBytesHex = (
  data: Serialization.PlutusData,
): string | undefined => {
  const bytes = data.asBoundedBytes();
  return bytes ? HexBlob.fromBytes(bytes) : undefined;
};

/** Returns a 28-byte hash as hex, or undefined for any other data. */
export const readHash28 = (
  data: Serialization.PlutusData,
): string | undefined => {
  const bytes = data.asBoundedBytes();
  return bytes?.length === HASH_28_LENGTH
    ? HexBlob.fromBytes(bytes)
    : undefined;
};

/**
 * Reads a POSIX time in milliseconds since the epoch, as Plutus data holds
 * it, or undefined when the data is not an integer or names an instant
 * before the epoch or beyond the range a `Date` can represent.
 */
export const readPosixTime = (
  data: Serialization.PlutusData,
): number | undefined => {
  const milliseconds = data.asInteger();
  if (milliseconds === undefined || milliseconds < 0n) return undefined;
  if (milliseconds > MAX_DATE_MILLISECONDS) return undefined;
  return Number(milliseconds);
};

/**
 * Reads an output or pointer index, or undefined when it is not an
 * integer between zero and the largest safe JavaScript integer.
 */
const readIndex = (data: Serialization.PlutusData): number | undefined => {
  const index = data.asInteger();
  if (index === undefined || index < 0n || index > MAX_INDEX) return undefined;
  return Number(index);
};

/**
 * Reads a ledger API `TxId`. Plutus V1 and V2 wrap the id bytes in a
 * constructor, Plutus V3 carries the bytes directly.
 */
const readTxId = (data: Serialization.PlutusData): string | undefined => {
  const bytes = readBytesHex(data);
  if (bytes !== undefined) return bytes;
  const wrapped = readConstr(data, 0n, 1);
  return wrapped && readBytesHex(wrapped[0]);
};

/** Reads a ledger API `TxOutRef` of any Plutus version. */
export const readOutRef = (
  data: Serialization.PlutusData,
): HydraOutRef | undefined => {
  const fields = readConstr(data, 0n, 2);
  if (!fields) return undefined;
  const txId = readTxId(fields[0]);
  const index = readIndex(fields[1]);
  if (txId === undefined || index === undefined) return undefined;
  return { txId, index };
};

/**
 * Reads a ledger API `Value`, a map from policy id to a map from asset name to
 * quantity. Lovelace sits under the empty policy id and asset name, so any
 * other asset name under the empty policy id is rejected.
 *
 * The ledger never stores a zero or negative quantity in an output, and every
 * output holds a positive amount of lovelace, so the value is rejected when it
 * has no lovelace entry, when any quantity is zero or negative, or when a
 * policy id or an asset name under one policy repeats, or when a policy holds
 * no tokens at all. Committed values can then only add up to the value of the
 * UTxO holding them when each of them is genuinely part of it.
 */
const readValue = (data: Serialization.PlutusData): HydraValue | undefined => {
  const policies = data.asMap();
  if (!policies) return undefined;
  let coins: bigint | undefined;
  const assets = new Map<string, bigint>();
  const policyIds = new Set<string>();
  for (const policyKey of readList(policies.getKeys())) {
    const policyId = readBytesHex(policyKey);
    const tokens = policies.get(policyKey)?.asMap();
    if (policyId === undefined || !tokens || policyIds.has(policyId)) {
      return undefined;
    }
    policyIds.add(policyId);
    const nameKeys = readList(tokens.getKeys());
    if (nameKeys.length === 0) return undefined;
    const assetNames = new Set<string>();
    for (const nameKey of nameKeys) {
      const assetName = readBytesHex(nameKey);
      const quantity = tokens.get(nameKey)?.asInteger();
      if (assetName === undefined || quantity === undefined) return undefined;
      if (quantity <= 0n || assetNames.has(assetName)) return undefined;
      if (policyId === '' && assetName !== '') return undefined;
      assetNames.add(assetName);
      if (policyId === '') coins = quantity;
      else assets.set(policyId + assetName, quantity);
    }
  }
  return coins === undefined ? undefined : { coins, assets };
};

/** Credential types by constructor alternative: key hash (0), script hash (1). */
const CREDENTIAL_TYPES = [
  Cardano.CredentialType.KeyHash,
  Cardano.CredentialType.ScriptHash,
] as const;

/** Reads a ledger API `Credential`. */
const readCredential = (
  data: Serialization.PlutusData,
): Cardano.Credential | undefined => {
  const constr = readAnyConstr(data);
  if (!constr || constr.fields.length !== 1) return undefined;
  const type = CREDENTIAL_TYPES[Number(constr.alternative)];
  const hash = readHash28(constr.fields[0]);
  if (type === undefined || hash === undefined) return undefined;
  return { type, hash: Hash28ByteBase16(hash) };
};

/**
 * Reads a ledger API pointer as a non negative slot and two indexes within
 * the safe integer range.
 */
const readPointer = ([slotData, txIndexData, certIndexData]: Fields):
  | Cardano.Pointer
  | undefined => {
  const slot = slotData.asInteger();
  const txIndex = readIndex(txIndexData);
  const certIndex = readIndex(certIndexData);
  if (slot === undefined || txIndex === undefined || certIndex === undefined) {
    return undefined;
  }
  if (slot < 0n) return undefined;
  return {
    slot,
    txIndex: Cardano.TxIndex(txIndex),
    certIndex: Cardano.CertIndex(certIndex),
  };
};

/**
 * Reads a ledger API `Address` and rebuilds its bech32 form for the network.
 * The staking part is `Maybe StakingCredential`, where a staking credential is
 * either a hash (0) or a pointer (1).
 */
const readAddress = (
  data: Serialization.PlutusData,
  networkId: Cardano.NetworkId,
): PlutusAddress | undefined => {
  const fields = readConstr(data, 0n, 2);
  if (!fields) return undefined;
  const payment = readCredential(fields[0]);
  if (!payment) return undefined;
  const paymentKeyHash =
    payment.type === Cardano.CredentialType.KeyHash ? payment.hash : undefined;
  const withKeyHash = (address: Cardano.Address): PlutusAddress => ({
    address: address.toBech32(),
    ...(paymentKeyHash === undefined ? {} : { paymentKeyHash }),
  });

  if (readConstr(fields[1], 1n, 0)) {
    return withKeyHash(
      Cardano.EnterpriseAddress.fromCredentials(networkId, payment).toAddress(),
    );
  }
  const [staking] = readConstr(fields[1], 0n, 1) ?? [];
  const stakingConstr = staking && readAnyConstr(staking);
  if (!stakingConstr) return undefined;

  if (stakingConstr.alternative === 0n && stakingConstr.fields.length === 1) {
    const stake = readCredential(stakingConstr.fields[0]);
    if (!stake) return undefined;
    return withKeyHash(
      Cardano.BaseAddress.fromCredentials(
        networkId,
        payment,
        stake,
      ).toAddress(),
    );
  }
  if (stakingConstr.alternative === 1n && stakingConstr.fields.length === 3) {
    const pointer = readPointer(stakingConstr.fields);
    if (!pointer) return undefined;
    return withKeyHash(
      Cardano.PointerAddress.fromCredentials(
        networkId,
        payment,
        pointer,
      ).toAddress(),
    );
  }
  return undefined;
};

/**
 * Reads a ledger API `TxOut`. The datum and reference script fields are
 * checked for presence only, since nothing here needs them.
 */
export const readTxOut = (
  data: Serialization.PlutusData,
  networkId: Cardano.NetworkId,
): PlutusTxOut | undefined => {
  const fields = readConstr(data, 0n, TX_OUT_FIELD_COUNT);
  if (!fields) return undefined;
  const address = readAddress(fields[0], networkId);
  const value = readValue(fields[1]);
  if (!address || !value) return undefined;
  return { ...address, value };
};
