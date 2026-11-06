import { Serialization } from '@lace-lib/cardano-core';

import type {
  HydraBlockfrostUtxo,
  HydraOutRef,
  HydraUtxo,
  HydraValue,
} from './types';
import type { Cardano } from '@lace-lib/cardano-core';

/** Blockfrost unit of the lovelace amount. */
const LOVELACE_UNIT = 'lovelace';

/** Value holding nothing. */
export const EMPTY_HYDRA_VALUE: HydraValue = { coins: 0n, assets: new Map() };

/** Adds two values asset by asset. */
export const addHydraValues = (a: HydraValue, b: HydraValue): HydraValue => {
  const assets = new Map(a.assets);
  for (const [unit, quantity] of b.assets) {
    assets.set(unit, (assets.get(unit) ?? 0n) + quantity);
  }
  return { coins: a.coins + b.coins, assets };
};

/** Sums the values of UTxOs or committed outputs. */
export const sumHydraValues = (
  items: readonly { readonly value: HydraValue }[],
): HydraValue =>
  items.reduce(
    (total, { value }) => addHydraValues(total, value),
    EMPTY_HYDRA_VALUE,
  );

/** Subtracts `b` from `a` asset by asset, dropping assets that net to zero. */
export const subtractHydraValues = (
  a: HydraValue,
  b: HydraValue,
): HydraValue => {
  const assets = new Map(a.assets);
  for (const [unit, quantity] of b.assets) {
    const difference = (assets.get(unit) ?? 0n) - quantity;
    if (difference === 0n) assets.delete(unit);
    else assets.set(unit, difference);
  }
  return { coins: a.coins - b.coins, assets };
};

/** True when the value holds nothing. */
export const isEmptyHydraValue = ({ coins, assets }: HydraValue): boolean =>
  coins === 0n && [...assets.values()].every(quantity => quantity === 0n);

/** Returns the output reference of a UTxO. */
export const toHydraOutRef = ({ txId, index }: HydraOutRef): HydraOutRef => ({
  txId,
  index,
});

/** Re-encodes an inline datum, or undefined when it cannot be serialized. */
const encodeInlineDatum = (datum: Cardano.PlutusData): string | undefined => {
  try {
    return Serialization.PlutusData.fromCore(datum).toCbor();
  } catch {
    return undefined;
  }
};

/**
 * Converts a UTxO from `@cardano-sdk/core`, as returned by a Cardano provider,
 * into the shape the Hydra matchers read. A datum that cannot be re-encoded is
 * dropped, so the matchers skip the UTxO instead of failing the whole scan.
 */
export const fromCardanoUtxo = ([txIn, txOut]: Cardano.Utxo): HydraUtxo => {
  const inlineDatum =
    txOut.datum === undefined ? undefined : encodeInlineDatum(txOut.datum);
  return {
    txId: txIn.txId,
    index: txIn.index,
    address: txOut.address,
    value: {
      coins: txOut.value.coins,
      assets: new Map(txOut.value.assets ?? []),
    },
    ...(inlineDatum === undefined ? {} : { inlineDatum }),
  };
};

/**
 * Converts a UTxO from the Blockfrost API into the shape the Hydra matchers
 * read. Expects well-formed provider JSON: a quantity that is not an integer
 * string makes it throw.
 */
export const fromBlockfrostUtxo = (utxo: HydraBlockfrostUtxo): HydraUtxo => {
  let coins = 0n;
  const assets = new Map<string, bigint>();
  for (const { unit, quantity } of utxo.amount) {
    if (unit === LOVELACE_UNIT) coins += BigInt(quantity);
    else assets.set(unit, (assets.get(unit) ?? 0n) + BigInt(quantity));
  }
  return {
    txId: utxo.tx_hash,
    index: utxo.output_index,
    address: utxo.address,
    value: { coins, assets },
    ...(utxo.inline_datum ? { inlineDatum: utxo.inline_datum } : {}),
  };
};
