import { inFlightTransactionOf } from '@lace-contract/cardano-context';
import { HexBytes } from '@lace-lib/util';
import { EMPTY, filter, mergeMap, of, take, withLatestFrom } from 'rxjs';

import type { SideEffect } from '../contracts';

/**
 * Records every Cardano transaction a provider accepted through the
 * tx-executor's `submitTx` phase in `cardanoContext.inFlightTransactions`, so
 * the UTxO, balance, collateral and reward views leave its spend out until it
 * settles or expires. Every flow that submits through the tx-executor gets its
 * record here; the flow itself upserts only its display row.
 *
 * The completion carries only the result and the request carries the bytes,
 * so the two are joined by `executionId`. The chain id is read when the
 * request arrives, the network `makeSubmitTx` submits to, so the entry is
 * keyed by the network the body went to. A body that does not decode is
 * logged and records nothing; the subscription stays up for the next
 * submission. The other writers of entries are listed in
 * `packages/module/cardano-sync/docs/in-flight-transactions.md`.
 */
export const recordSubmittedTransactions: SideEffect = (
  { txExecutor: { txPhaseRequested$, txPhaseCompleted$ } },
  { cardanoContext: { selectChainId$ } },
  { actions, logger },
) =>
  txPhaseRequested$.pipe(
    withLatestFrom(selectChainId$),
    mergeMap(([{ payload }, chainId]) => {
      const { executionId, config } = payload;
      if (
        config.type !== 'submitTx' ||
        config.params.blockchainName !== 'Cardano' ||
        chainId === undefined
      ) {
        return EMPTY;
      }
      const serializedTx = HexBytes(config.params.serializedTx);
      return txPhaseCompleted$.pipe(
        filter(completed => completed.payload.executionId === executionId),
        take(1),
        mergeMap(({ payload: { result } }) => {
          if (!result.success) return EMPTY;
          try {
            return of(
              actions.cardanoContext.recordInFlightTransaction(
                inFlightTransactionOf({ serializedTx, chainId }),
              ),
            );
          } catch (error) {
            logger.error(
              '[blockchain-cardano] failed to record a submitted transaction as in flight',
              error,
            );
            return EMPTY;
          }
        }),
      );
    }),
  );
