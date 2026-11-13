import { makeConfirmTx, makeSubmitTx } from '@lace-contract/tx-executor';
import { firstStateOfStatus } from '@lace-lib/util-store';
import { merge, mergeMap, of, switchMap, withLatestFrom } from 'rxjs';

import type { SideEffect } from '../contracts';
import type { ConfirmTx, SubmitTx } from '@lace-contract/tx-executor';

// =====================================================================
// Transaction composer — confirm + submit.
// =====================================================================
// These side-effects depend on `@lace-contract/tx-executor`
// (`makeConfirmTx` / `makeSubmitTx`), whose import chain reaches
// `@lace-contract/authentication-prompt` → react / react-i18next. That
// makes them UNSAFE for the headless SDK bundle (ADR 30), so they live
// in a file that ONLY the full module entry (`index.ts`) composes —
// never the SDK entry (`sdk.ts`) nor the shared, SDK-reachable
// `store/init.ts`.
//
// Signing and submission deliberately reuse the same
// confirmTx → signer → submitTx path a normal Send takes, so a composed
// transaction gets the identical authorisation prompt and needs no new
// host API.
//
// Wires:
//   AwaitingConfirmation → confirmTx → confirmationCompleted
//   Processing           → submitTx  → processingResulted
//
// Each orchestrator is a factory taking its tx-executor dependency
// explicitly so unit tests can substitute a mock cold observable.
// =====================================================================

export const makeComposerAwaitingConfirmation =
  ({ confirmTx }: { confirmTx: ConfirmTx }): SideEffect =>
  (_, stateObservables, { actions }) =>
    firstStateOfStatus(
      stateObservables.composerFlow.selectState$,
      'AwaitingConfirmation',
    ).pipe(
      withLatestFrom(stateObservables.wallets.selectAll$),
      switchMap(([state, wallets]) => {
        const wallet = wallets.find(w =>
          w.accounts.some(a => a.accountId === state.accountId),
        );
        if (!wallet) {
          return of(
            actions.composerFlow.confirmationCompleted({
              result: {
                success: false,
                errorTranslationKeys: {
                  title: 'v2.composer.build.error.title',
                  subtitle: 'v2.composer.build.error.subtitle',
                },
              },
            }),
          );
        }
        return confirmTx(
          {
            accountId: state.accountId,
            blockchainName: 'Cardano',
            blockchainSpecificSendFlowData: {},
            serializedTx: state.serializedTx,
            wallet,
          },
          result => actions.composerFlow.confirmationCompleted({ result }),
        );
      }),
    );

export const makeComposerProcessing =
  ({ submitTx }: { submitTx: SubmitTx }): SideEffect =>
  (_, stateObservables, { actions }) =>
    firstStateOfStatus(
      stateObservables.composerFlow.selectState$,
      'Processing',
    ).pipe(
      switchMap(state =>
        submitTx(
          {
            accountId: state.accountId,
            serializedTx: state.serializedTx,
            blockchainName: 'Cardano',
            blockchainSpecificSendFlowData: {},
          },
          result => result,
        ).pipe(
          mergeMap(value => {
            if (!('success' in value)) {
              return of(value);
            }
            return of(
              actions.composerFlow.processingResulted({ result: value }),
            );
          }),
        ),
      ),
    );

export const composerFlowTxSideEffects: SideEffect[] = [
  (actionObservables, stateObservables, dependencies) =>
    merge(
      makeComposerAwaitingConfirmation({
        confirmTx: makeConfirmTx(actionObservables.txExecutor),
      })(actionObservables, stateObservables, dependencies),
      makeComposerProcessing({
        submitTx: makeSubmitTx(actionObservables.txExecutor),
      })(actionObservables, stateObservables, dependencies),
    ),
];
