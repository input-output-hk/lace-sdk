import {
  genericErrorResults,
  type TxExecutorImplementation,
} from '@lace-contract/tx-executor';
import { Serialization } from '@lace-lib/cardano-core';
import { map, mergeMap, of, take } from 'rxjs';

import type { SideEffectDependencies } from '@lace-contract/module';

/**
 * Submits a signed transaction through the Cardano provider and returns the
 * provider's transaction id. The result carries no activity metadata:
 * `recordSubmittedTransactions` records an accepted transaction's spend in
 * `cardanoContext.inFlightTransactions` from the request's bytes.
 *
 * Submits once, to the network current when the submission starts. A network
 * switch before the provider answers starts no second submission: the other
 * network would refuse the transaction, and a refusal that answered first
 * would report a failure for a transaction the first network accepted.
 */
export const makeSubmitTx =
  (
    dependencies: SideEffectDependencies,
  ): TxExecutorImplementation['submitTx'] =>
  props =>
    dependencies.txExecutorCardano.cardanoChainId$.pipe(
      take(1),
      mergeMap(chainId => {
        if (!chainId) {
          return of(
            genericErrorResults.submitTx({
              error: new Error('Chain ID not found'),
            }),
          );
        }
        return dependencies.cardanoProvider
          .submitTx(
            { signedTransaction: Serialization.TxCBOR(props.serializedTx) },
            { chainId },
          )
          .pipe(
            map(result =>
              result.isOk()
                ? ({ success: true, txId: result.value } as const)
                : genericErrorResults.submitTx({ error: result.error }),
            ),
          );
      }),
    );
