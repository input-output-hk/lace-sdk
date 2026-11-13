import { CardanoTxId } from '@lace-contract/cardano-context';
import { Err, Ok } from '@lace-lib/util';
import { filter, firstValueFrom, merge, map, timeout } from 'rxjs';

import type { HexBytes, Result } from '@lace-lib/util';
import type { PayloadAction } from '@reduxjs/toolkit';
import type { Observable } from 'rxjs';

const SUBMIT_TX_TIMEOUT_MS = 60_000;

/**
 * Structural requirement: the wallet must have been created with
 * Cardano modules loaded (blockchainCardano + cardanoProviderBlockfrost).
 */
export type WalletWithCardanoSubmit = {
  actionObservables: {
    cardanoContext: {
      submitTxCompleted$: Observable<PayloadAction<{ txId: CardanoTxId }>>;
      submitTxFailed$: Observable<
        PayloadAction<{ txId: CardanoTxId; error: string }>
      >;
    };
  };
  dispatch: (
    key: 'cardanoContext.submitTx',
    props: { serializedTx: HexBytes },
  ) => void;
};

/** The options of `submitCardanoTx`. */
export interface SubmitCardanoTxProps {
  /** The signed transaction, as CBOR hex. */
  serializedTx: HexBytes;
}

/**
 * Submits a signed transaction through the wallet's Cardano provider and
 * waits up to 60 seconds for the provider's answer.
 *
 * Once the provider accepts the transaction, the wallet records it as in
 * flight on the network it was submitted to. A transaction flagged `isValid`
 * false is recorded as spending its collateral inputs and paying its
 * collateral return, the effects the chain applies to it. Until the
 * transaction settles and the wallet's synced UTxOs reflect it, or it can no
 * longer settle:
 *
 * - `selectAvailableAccountUtxos$` leaves out the inputs it spends and
 *   includes the outputs it pays to the wallet's accounts, so a transaction
 *   built straight after picks other inputs, even one that spends the outputs
 *   of a transaction still in flight;
 * - the accounts' balances and `selectAccountUtxosWithInFlight$` reflect it;
 * - `activities.selectAllMap$` lists it as pending on each account it
 *   spends from or pays, as soon as the wallet can tell: when the provider
 *   answers, or later for an account whose input the wallet learns of only
 *   then, such as an output of another transaction still awaiting its
 *   answer.
 *
 * The wallet treats the transaction as unable to settle, and drops its
 * pending activities, about a minute after its `invalidHereafter` slot, once
 * the wallet's provider confirms the chain does not hold the transaction.
 * Set a validity interval with `expiresIn` or `setValidityInterval`: a
 * transaction without one is treated as able to settle until about two hours
 * past the first network tip the wallet receives after acceptance. A refused
 * submission records nothing.
 *
 * @param wallet - A wallet with the Cardano modules loaded (see
 *   {@link WalletWithCardanoSubmit}).
 * @param props - The signed transaction.
 * @returns `Ok` with the transaction ID once the provider accepts it, or
 *   `Err` with the provider's refusal or a timeout. It never rejects. After
 *   an `Err` from the timeout the outcome is unknown: if the provider accepts
 *   the transaction later, the wallet records it then.
 */
export const submitCardanoTx = async (
  wallet: WalletWithCardanoSubmit,
  props: SubmitCardanoTxProps,
): Promise<Result<{ txId: CardanoTxId }, Error>> => {
  const { serializedTx } = props;

  try {
    const txId = CardanoTxId.fromCbor(serializedTx);

    // --- Subscribe to result actions BEFORE dispatching ---
    const result$ = merge(
      wallet.actionObservables.cardanoContext.submitTxCompleted$.pipe(
        filter(({ payload }) => payload.txId === txId),
        map(({ payload }) => Ok({ txId: payload.txId })),
      ),
      wallet.actionObservables.cardanoContext.submitTxFailed$.pipe(
        filter(({ payload }) => payload.txId === txId),
        map(({ payload }) => Err(new Error(payload.error))),
      ),
    ).pipe(timeout(SUBMIT_TX_TIMEOUT_MS));
    const resultPromise = firstValueFrom(result$);

    // --- Dispatch submit action ---
    wallet.dispatch('cardanoContext.submitTx', { serializedTx });

    // --- Await result ---
    return await resultPromise;
  } catch (error) {
    return Err(error instanceof Error ? error : new Error(String(error)));
  }
};
