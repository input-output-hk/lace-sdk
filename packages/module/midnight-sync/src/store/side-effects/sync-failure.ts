import { autoDismissFailureOnSuccess } from '@lace-contract/failures';
import { isInMemoryMidnightAccount } from '@lace-contract/midnight-context';
import { Timestamp } from '@lace-lib/util';
import { from, map, mergeMap, pairwise, startWith, withLatestFrom } from 'rxjs';

import { MidnightSyncFailureId } from '../../value-objects/midnight-sync-failure-id.vo';

import type { ActionCreators, SideEffect } from '../../context';
import type { MidnightEngineClient } from '../../worker/engine-client';
import type { ActionType } from '@lace-contract/module';
import type { AccountId, AnyAccount } from '@lace-contract/wallet-repo';

type MidnightWatchAction = ActionType<ActionCreators>;

/**
 * The failure and the Failed sync operation of an account whose engine does not run. Without `retryAction`, the
 * failure offers no tap-to-retry.
 */
export const midnightSyncFailedActions = (
  actions: ActionCreators,
  accountId: AccountId,
  retryAction?: MidnightWatchAction,
): MidnightWatchAction[] => {
  const failedAt = Timestamp(Date.now());
  return [
    actions.failures.addFailure({
      failureId: MidnightSyncFailureId(accountId),
      message: 'sync.error.midnight-sync-failed',
      retryAction,
    }),
    actions.sync.addSyncOperation({
      accountId,
      operation: {
        operationId: `${accountId}-midnight-sync`,
        status: 'Failed',
        description: 'sync.operation.midnight-wallet-sync',
        error: 'sync.error.midnight-sync-failed',
        startedAt: failedAt,
        failedAt,
      },
    }),
  ];
};

/**
 * Publishes each failure the Worker-mode engine client records for an account (a refused start, a worker that cannot
 * start or run, or the end of the worker that served the account) as the watcher publishes a start whose retries ran
 * out, but without a tap-to-retry (ADR 15's natural tier). The client holds the account's next start instead of
 * failing it, so that the watcher does not retry what a retry cannot change; only a public operation asking for the
 * engine lets it start again, which `restartWalletWatch` does not do. The recorded failures replay, so a failure
 * recorded before this subscribes is still published. The failure clears once the next start syncs.
 */
export const surfaceMidnightEngineFailures =
  (client: Pick<MidnightEngineClient, 'startFailures$'>): SideEffect =>
  (_, __, { actions }) =>
    client.startFailures$.pipe(
      startWith<Readonly<Partial<Record<AccountId, Error>>>>({}),
      pairwise(),
      mergeMap(([before, after]) =>
        (Object.keys(after) as AccountId[])
          .filter(
            accountId =>
              after[accountId] !== undefined &&
              after[accountId] !== before[accountId],
          )
          .flatMap(accountId => midnightSyncFailedActions(actions, accountId)),
      ),
    );

/**
 * Dismiss a Midnight account's sync failure once its own sync recovers.
 *
 * The `completeSyncOperation` for `${accountId}-midnight-sync` is the
 * "recovered" signal, whichever route got there — transparent retry, the
 * failure's tap-to-retry `restartWalletWatch`, or the resubscription `whileActive`
 * performs on unlock.
 *
 * Keyed per-account, so no lookup is needed: a completion for a sibling Midnight
 * account (or a Cardano/Bitcoin one) maps to a different, non-existent
 * MidnightSyncFailureId and no-ops, leaving a still-broken account's failure in
 * place until its OWN sync completes.
 */
export const autoDismissMidnightSyncFailureOnSyncSuccess: SideEffect = (
  { sync: { completeSyncOperation$ } },
  { failures: { selectFailureById$ } },
) =>
  completeSyncOperation$.pipe(
    map(({ payload }) => MidnightSyncFailureId(payload.accountId)),
    autoDismissFailureOnSuccess(selectFailureById$),
  );

/**
 * On resume, clear the sync failure for every Midnight account.
 *
 * Complements the per-account recovery dismissal above by clearing a stale error
 * immediately, rather than leaving it on screen for the length of the first sync
 * after unlock. No restart is dispatched: `watchMidnightAccounts` ends its pipe
 * with `whileActive`, so resuming already resubscribes every account watcher.
 * Accounts with no failure are a no-op.
 */
export const autoDismissMidnightSyncFailureOnResume: SideEffect = (
  _,
  { wallets: { selectAll$ }, failures: { selectFailureById$ } },
  { walletResumed$ },
) =>
  walletResumed$.pipe(
    withLatestFrom(selectAll$),
    mergeMap(([, wallets]) =>
      from(
        wallets
          .flatMap((wallet): AnyAccount[] => wallet.accounts)
          .filter(isInMemoryMidnightAccount)
          .map(account => MidnightSyncFailureId(account.accountId)),
      ),
    ),
    autoDismissFailureOnSuccess(selectFailureById$),
  );
