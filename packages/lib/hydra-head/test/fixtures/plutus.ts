import { Serialization } from '@cardano-sdk/core';

/** Builds constructor data from its alternative and fields. */
export const constr = (
  alternative: bigint,
  ...fields: Serialization.PlutusData[]
) => {
  const list = new Serialization.PlutusList();
  for (const field of fields) list.add(field);
  return Serialization.PlutusData.newConstrPlutusData(
    new Serialization.ConstrPlutusData(alternative, list),
  );
};

/** Builds bytes data from hex. */
export const bytes = (hex: string) =>
  Serialization.PlutusData.newBytes(Buffer.from(hex, 'hex'));

/** Builds integer data. */
export const integer = (value: bigint) =>
  Serialization.PlutusData.newInteger(value);

/** Builds list data. */
export const list = (...items: Serialization.PlutusData[]) => {
  const plutusList = new Serialization.PlutusList();
  for (const item of items) plutusList.add(item);
  return Serialization.PlutusData.newList(plutusList);
};

/** Returns the inline datum of a fixture, failing when it has none. */
export const datumOf = (utxo: { inline_datum?: string | null }) => {
  if (!utxo.inline_datum) throw new Error('fixture has no inline datum');
  return utxo.inline_datum;
};

/** Plutus `Nothing`, the absent staking part of an enterprise address. */
export const nothing = () => constr(1n);

/**
 * Builds a ledger API `TxOut` paying lovelace and assets to a payment key
 * hash, with the given staking part and no datum or reference script.
 */
export const txOutData = ({
  paymentKeyHash,
  coins,
  assets = [],
  staking = nothing(),
}: {
  paymentKeyHash: string;
  coins: bigint;
  assets?: [policyId: string, assetName: string, quantity: bigint][];
  staking?: Serialization.PlutusData;
}) => {
  const value = new Serialization.PlutusMap();
  const lovelace = new Serialization.PlutusMap();
  lovelace.insert(bytes(''), integer(coins));
  value.insert(bytes(''), Serialization.PlutusData.newMap(lovelace));
  for (const [policyId, assetName, quantity] of assets) {
    const tokens = new Serialization.PlutusMap();
    tokens.insert(bytes(assetName), integer(quantity));
    value.insert(bytes(policyId), Serialization.PlutusData.newMap(tokens));
  }
  return constr(
    0n,
    constr(0n, constr(0n, bytes(paymentKeyHash)), staking),
    Serialization.PlutusData.newMap(value),
    constr(0n),
    nothing(),
  );
};

/** Builds the `Commit` records of the outputs, serialized as Hydra does. */
const commits = (outputs: Serialization.PlutusData[]) =>
  list(
    ...outputs.map((output, index) =>
      constr(
        0n,
        constr(0n, bytes('00'.repeat(32)), integer(BigInt(index))),
        bytes(output.toCbor()),
      ),
    ),
  );

/** Builds a deposit datum committing the outputs, serialized as Hydra does. */
export const depositDatum = (
  headId: string,
  deadline: number,
  outputs: Serialization.PlutusData[],
) =>
  constr(
    0n,
    bytes(headId),
    integer(BigInt(deadline)),
    commits(outputs),
  ).toCbor();

/**
 * Builds the datum of a commit UTxO of releases up to 1.3.0 committing the
 * outputs, with a placeholder party key.
 */
export const commitDatum = (
  headId: string,
  outputs: Serialization.PlutusData[],
) =>
  constr(0n, bytes('00'.repeat(32)), commits(outputs), bytes(headId)).toCbor();

/** Builds the CBOR hex of a zero wrapped in lists nested `depth` deep. */
export const nestedListCbor = (depth: number) => '81'.repeat(depth) + '00';
