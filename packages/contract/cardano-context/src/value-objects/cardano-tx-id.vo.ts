import { Serialization } from '@lace-lib/cardano-core';

import type { Cardano } from '@lace-lib/cardano-core';
import type { HexBytes } from '@lace-lib/util';

export type CardanoTxId = Cardano.TransactionId & HexBytes;

export const CardanoTxId = {
  fromCbor: (serializedTx: HexBytes): CardanoTxId =>
    Serialization.Transaction.fromCbor(
      Serialization.TxCBOR(serializedTx),
    ).getId() as CardanoTxId,
};
