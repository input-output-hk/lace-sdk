import { Cardano, Serialization } from '@lace-lib/cardano-core';
import { HexBlob } from '@lace-lib/cardano-util';

import type { HydraBlockfrostUtxo } from '../../src';

/** Builds the `@cardano-sdk/core` UTxO equivalent to a Blockfrost one. */
export const toCardanoUtxo = (utxo: HydraBlockfrostUtxo): Cardano.Utxo => {
  const assets = new Map<Cardano.AssetId, bigint>();
  let coins = 0n;
  for (const { unit, quantity } of utxo.amount) {
    if (unit === 'lovelace') coins = BigInt(quantity);
    else assets.set(Cardano.AssetId(unit), BigInt(quantity));
  }
  const address = Cardano.PaymentAddress(utxo.address);
  return [
    {
      txId: Cardano.TransactionId(utxo.tx_hash),
      index: utxo.output_index,
      address,
    },
    {
      address,
      value: { coins, assets },
      ...(utxo.inline_datum
        ? {
            datum: Serialization.PlutusData.fromCbor(
              HexBlob(utxo.inline_datum),
            ).toCore(),
          }
        : {}),
    },
  ];
};
