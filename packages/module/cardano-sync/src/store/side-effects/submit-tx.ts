import {
  CardanoTxId,
  inFlightTransactionOf,
} from '@lace-contract/cardano-context';
import { Serialization } from '@lace-lib/cardano-core';
import { from, mergeMap, of, withLatestFrom } from 'rxjs';

import { inFlightPendingActivities } from './in-flight-pending-activities';

import type { CardanoSyncAction, SideEffect } from '../../module';
import type { DecodedInFlightTransaction } from '@lace-contract/cardano-context';
import type { HexBytes } from '@lace-lib/util';

type Dependencies = Parameters<SideEffect>[2];

/** The in-flight record of accepted bytes, or `undefined` when they do not decode. */
const inFlightEntryOf = (
  serializedTx: HexBytes,
  chainId: DecodedInFlightTransaction['chainId'],
  logger: Dependencies['logger'],
): DecodedInFlightTransaction | undefined => {
  try {
    return inFlightTransactionOf({ serializedTx, chainId });
  } catch (error) {
    logger.warn(
      '[cardano-sync] could not record a submitted transaction in flight',
      { error },
    );
    return undefined;
  }
};

/**
 * Submits a signed transaction through the Cardano provider. Once the
 * provider accepts it, records it in `cardanoContext.inFlightTransactions`,
 * so every in-flight view leaves out the inputs it spends and counts its
 * outputs, and adds its Pending activity to the accounts the wallet can tell
 * it touches.
 *
 * Both are emitted before `submitTxCompleted`, the entry first: the SDK
 * resolves a submission on that action, and the reducer applies each action
 * before the next one is observed, so the available set already leaves the
 * inputs out when the caller builds its next transaction.
 *
 * The entry is keyed by the network the transaction was submitted to, read
 * when the submission arrives, and names no account. A body without an upper
 * validity bound gets the reducer's cut-off from the network tip.
 *
 * A Pending activity goes to every account on that network that the
 * transaction spends from, as resolved in the ownership set, or pays, with
 * the protection `inFlightPendingActivities` states: confirmed and feature rows
 * stay, while derived rows can be recomputed as ownership resolves. Accounts,
 * addresses, UTxOs and activities are read when the provider answers, and
 * `activities.addActivities` protects confirmed and feature rows that land after
 * that read. An account whose input ownership becomes known only later, such as
 * change from another in-flight transaction, gets its Pending activity from
 * `publishInFlightActivities` once it can.
 *
 * A refusal or a missing chain ID records nothing. A Pending activity that
 * cannot be derived is logged and skipped for that account; the entry stands
 * and the submission still completes. The other writers of entries are listed
 * in `packages/module/cardano-sync/docs/in-flight-transactions.md`.
 */
export const submitTxSideEffect: SideEffect = (
  { cardanoContext: { submitTx$ } },
  {
    cardanoContext: { selectChainId$, selectCollateralOwnershipUtxos$ },
    wallets: { selectAll$ },
    addresses: { selectAllAddresses$ },
    activities: { selectAllMap$ },
  },
  { cardanoProvider, actions, logger },
) =>
  submitTx$.pipe(
    withLatestFrom(selectChainId$),
    mergeMap(([{ payload }, chainId]) => {
      if (!chainId) {
        return of(
          actions.cardanoContext.submitTxFailed({
            txId: CardanoTxId.fromCbor(payload.serializedTx),
            error: 'Chain ID not found',
          }),
        );
      }
      return cardanoProvider
        .submitTx(
          { signedTransaction: Serialization.TxCBOR(payload.serializedTx) },
          { chainId },
        )
        .pipe(
          withLatestFrom(
            selectAll$,
            selectAllAddresses$,
            selectCollateralOwnershipUtxos$,
            selectAllMap$,
          ),
          mergeMap(
            ([
              result,
              wallets,
              allAddresses,
              ownershipUtxos,
              activitiesByAccount,
            ]) => {
              if (!result.isOk()) {
                return of(
                  actions.cardanoContext.submitTxFailed({
                    txId: CardanoTxId.fromCbor(payload.serializedTx),
                    error: result.error.message,
                  }),
                );
              }
              const txId = result.value as CardanoTxId;
              const entry = inFlightEntryOf(
                payload.serializedTx,
                chainId,
                logger,
              );
              return from<CardanoSyncAction[]>([
                ...(entry
                  ? [
                      actions.cardanoContext.recordInFlightTransaction(entry),
                      ...inFlightPendingActivities({
                        entry,
                        wallets,
                        allAddresses,
                        ownershipUtxos,
                        activitiesByAccount,
                        logger,
                      }).map(activity =>
                        actions.activities.addActivities({
                          accountId: activity.accountId,
                          activities: [activity],
                        }),
                      ),
                    ]
                  : []),
                actions.cardanoContext.submitTxCompleted({ txId }),
              ]);
            },
          ),
        );
    }),
  );
