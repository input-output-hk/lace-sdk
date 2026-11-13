import { Timestamp } from '@lace-lib/util';

import { inspectCardanoTxEffects } from '../../inspect-cardano-tx-effects';

import { inFlightEffectsOf, pendingActivityOf } from './in-flight-transaction';

import type { PendingActivityExtensionProps } from '../../extensions';
import type { CardanoPaymentAddress } from '../../types';
import type { Activity } from '@lace-contract/activities';
import type { AccountId } from '@lace-contract/wallet-repo';
import type { Cardano } from '@lace-lib/cardano-core';
import type { HexBytes } from '@lace-lib/util';

type DerivePendingActivityFromCborParams = PendingActivityExtensionProps & {
  serializedTx: HexBytes;
  accountId: AccountId;
  accountAddresses: readonly CardanoPaymentAddress[];
  accountUtxos: readonly Cardano.Utxo[];
};

/**
 * The Pending display row of a signed transaction for one account, stamped
 * with the current time: {@link pendingActivityOf} over the effects of the
 * decoded body. The row carries no in-flight effects; record those with
 * `recordInFlightTransaction(inFlightTransactionOf(...))`.
 *
 * Throws when the CBOR is not a transaction.
 */
export const derivePendingActivityFromCbor = ({
  serializedTx,
  ...params
}: DerivePendingActivityFromCborParams): Activity | undefined => {
  const effects = inspectCardanoTxEffects({
    accountAddresses: [],
    accountUtxos: [],
    serializedTx,
  });
  return pendingActivityOf({
    ...params,
    effects: inFlightEffectsOf(effects),
    timestamp: Timestamp(Date.now()),
    txId: effects.txId,
  });
};
