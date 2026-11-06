import {
  hasMidnightAccount,
  isInMemoryMidnightAccount,
  midnightAccounts$,
} from '@lace-contract/midnight-context';
import { deepEquals } from '@lace-lib/cardano-util';
import { Timestamp } from '@lace-lib/util';
import {
  catchError,
  concat,
  defaultIfEmpty,
  defer,
  distinctUntilChanged,
  EMPTY,
  exhaustMap,
  filter,
  forkJoin,
  from,
  groupBy,
  ignoreElements,
  map,
  merge,
  mergeMap,
  of,
  pairwise,
  startWith,
  switchMap,
  take,
  throwError,
  throwIfEmpty,
  withLatestFrom,
} from 'rxjs';

import type { ActionCreators, SideEffect } from '../../context';
import type { MidnightEngineClient } from '../../worker/engine-client';
import type {
  MidnightAccountId,
  MidnightAccountProps,
  SerializedMidnightWallet,
} from '@lace-contract/midnight-context';
import type { CollectionStorage } from '@lace-contract/storage';
import type {
  AccountId,
  AnyWallet,
  InMemoryWalletAccount,
  WalletId,
} from '@lace-contract/wallet-repo';
import type { Observable } from 'rxjs';

const withMidnightAccounts =
  (
    makeSideEffect: (
      accounts$: Observable<InMemoryWalletAccount<MidnightAccountProps>[]>,
    ) => SideEffect,
  ): SideEffect =>
  (actionObservables, stateObservables, dependencies) =>
    makeSideEffect(midnightAccounts$(stateObservables))(
      actionObservables,
      stateObservables,
      dependencies,
    );

// Every derived store an account's checkpoint feeds.
const accountCacheResets = (actions: ActionCreators, accountId: AccountId) => [
  actions.addresses.resetAddresses({ accountId }),
  actions.tokens.resetAccountTokens({ accountId }),
  actions.activities.resetActivities({ accountId }),
  // Callers pass accounts from midnightAccounts$ or the engine, so the id is a MidnightAccountId (the dust caches'
  // key type).
  actions.midnightContext.resetAccountDust({
    accountId: accountId as MidnightAccountId,
  }),
];

const midnightResyncOperation = (
  actions: ActionCreators,
  accountId: AccountId,
  status: 'Failed' | 'Pending',
) => {
  const at = Timestamp(Date.now());
  return actions.sync.addSyncOperation({
    accountId,
    operation:
      status === 'Pending'
        ? {
            operationId: `${accountId}-midnight-sync`,
            status,
            description: 'sync.operation.midnight-resync',
            startedAt: at,
          }
        : {
            operationId: `${accountId}-midnight-sync`,
            status,
            description: 'sync.operation.midnight-resync',
            error: 'sync.error.midnight-sync-failed',
            startedAt: at,
            failedAt: at,
          },
  });
};

// What a worker reset of an account's checkpoint leaves stale on a page: the caches its engine fed, and the sync,
// shown Pending again until the replacement engine reports progress.
const midnightEngineResetActions = (
  actions: ActionCreators,
  accountId: AccountId,
) => [
  actions.addresses.resetAddresses({ accountId }),
  actions.tokens.resetAccountTokens({ accountId }),
  actions.midnightContext.resetAccountDust({
    accountId: accountId as MidnightAccountId,
  }),
  actions.sync.resetAccountSyncStatus({ accountId }),
  midnightResyncOperation(actions, accountId, 'Pending'),
  actions.activities.resetActivities({ accountId }),
];

// The removed wallet and its in-memory Midnight accounts, from the first wallet list that still holds it.
const removedMidnightWallet = (
  payload: WalletId | { readonly walletId: WalletId },
  walletLists: readonly AnyWallet[][],
) => {
  const walletId = typeof payload === 'string' ? payload : payload.walletId;
  for (const wallets of walletLists) {
    const targetWallet = wallets
      .filter(hasMidnightAccount)
      .find(w => w.walletId === walletId);
    if (targetWallet)
      return {
        walletId,
        accounts: targetWallet.accounts.filter(isInMemoryMidnightAccount),
      };
  }
  return undefined;
};

// The wallet list the removal was dispatched against.
const removedMidnightWallets = (
  removeWallet$: Parameters<SideEffect>[0]['wallets']['removeWallet$'],
  selectAll$: Observable<AnyWallet[]>,
) =>
  removeWallet$.pipe(
    withLatestFrom(selectAll$),
    map(([{ payload }, wallets]) => removedMidnightWallet(payload, [wallets])),
  );

export const requestResyncWallet = withMidnightAccounts(
  midnightAccount$ =>
    ({ midnightSync: { requestResync$ } }, _, { actions }) =>
      merge(
        requestResync$.pipe(
          withLatestFrom(midnightAccount$),
          switchMap(([_, accounts]) => {
            const syncActions = accounts.map(({ accountId }) =>
              actions.sync.addSyncOperation({
                accountId,
                operation: {
                  operationId: `${accountId}-midnight-sync`,
                  status: 'Pending',
                  description: 'sync.operation.midnight-resync',
                  startedAt: Timestamp(Date.now()),
                },
              }),
            );

            return from([...syncActions, actions.midnightSync.resync()]);
          }),
        ),
      ),
);

export const createClearWalletStateOnResync = (
  store: CollectionStorage<SerializedMidnightWallet>,
): SideEffect =>
  withMidnightAccounts(
    midnightAccounts$ =>
      (
        { midnightSync: { resync$ } },
        _,
        { actions, stopAllMidnightWallets, logger },
      ) =>
        resync$.pipe(
          withLatestFrom(midnightAccounts$),
          switchMap(([_, midnightAccounts]) =>
            stopAllMidnightWallets().pipe(
              // Deregisters every wallet before stopping it, so a rejection
              // leaves them unreachable AND unrestarted. Log and continue —
              // the restart below is the only thing that brings sync back.
              catchError((error: unknown) => {
                logger.error('Midnight resync: stop failed', error);
                return of(void 0);
              }),
              switchMap(() =>
                store.clear().pipe(
                  defaultIfEmpty(undefined),
                  // The wallets are already stopped, so the restart below must
                  // run even when the wipe fails — aborting would strand them
                  // stopped. A failed wipe leaves old state in place, which
                  // makes the resync a no-op rather than a corruption.
                  catchError((error: unknown) => {
                    logger.error('Midnight resync: state wipe failed', error);
                    return of(undefined);
                  }),
                ),
              ),
              switchMap(() => [
                // Every derived store the wiped documents fed, matching
                // createResetSyncStateSideEffect. Dust in particular is
                // persisted and keyed on a deterministic account id, so a
                // stale balance would otherwise outlive the state it came from.
                //
                // Sync status is deliberately NOT reset: requestResyncWallet
                // registers a Pending operation immediately before dispatching
                // resync, and clearing it here would drop the very marker that
                // shows the resync running.
                ...midnightAccounts.flatMap(({ accountId }) =>
                  accountCacheResets(actions, accountId),
                ),
                actions.midnightSync.restartWalletWatch(),
              ]),
            ),
          ),
        ),
  );

/**
 * Side-effect that triggers a Midnight wallet resync whenever the config change
 * is made with a feature flag override and the wallet is unlocked.
 */
export const resyncWalletOnConfigChangeFromFeatureFlags = withMidnightAccounts(
  midnightAccounts$ =>
    (
      _,
      {
        appLock: { isUnlocked$ },
        midnightContext: {
          selectCurrentNetwork$,
          selectNetworksConfigFeatureFlagsOverrides$,
        },
      },
      { actions },
    ) => {
      const configChangesCausedByFFUpdate$ =
        selectNetworksConfigFeatureFlagsOverrides$.pipe(
          withLatestFrom(isUnlocked$),
          filter(([_, isUnlocked]) => isUnlocked),
          switchMap(() => selectCurrentNetwork$.pipe(take(1))),
          map(({ config }) => config),
          distinctUntilChanged(deepEquals),
        );

      return configChangesCausedByFFUpdate$.pipe(
        withLatestFrom(midnightAccounts$),
        switchMap(([_, midnightAccounts]) =>
          from([
            ...midnightAccounts.map(({ accountId }) =>
              actions.sync.addSyncOperation({
                accountId,
                operation: {
                  operationId: `${accountId}-midnight-sync`,
                  status: 'Pending',
                  description: 'sync.operation.midnight-resync',
                  startedAt: Timestamp(Date.now()),
                },
              }),
            ),
            actions.midnightSync.resync(),
          ]),
        ),
      );
    },
);

export const createDeleteWalletSideEffect =
  (storage: CollectionStorage<SerializedMidnightWallet>): SideEffect =>
  (
    { wallets: { removeWallet$ } },
    { wallets: { selectAll$ } },
    { stopMidnightWallet, actions, logger },
  ) =>
    removedMidnightWallets(removeWallet$, selectAll$).pipe(
      switchMap(removed => {
        if (!removed) return EMPTY;
        const { walletId, accounts: allMidnightAccounts } = removed;

        const stopWallets$ =
          allMidnightAccounts.length > 0
            ? forkJoin(
                allMidnightAccounts.map(({ accountId }) =>
                  stopMidnightWallet(accountId),
                ),
              )
            : of([]);

        return stopWallets$.pipe(
          switchMap(() =>
            storage
              .removeWhere(wallet => wallet.walletId === walletId)
              .pipe(
                defaultIfEmpty(undefined),
                // The wallet is already gone from the repo, so the resets below
                // must still run; and an uncaught throw here would error the
                // merged root epic, stopping every side effect app-wide.
                catchError((error: unknown) => {
                  logger.error(
                    'Midnight delete wallet: state wipe failed',
                    error,
                  );
                  return of(undefined);
                }),
              ),
          ),
          mergeMap(() =>
            allMidnightAccounts.flatMap(({ accountId }) => [
              actions.addresses.resetAddresses({
                accountId,
              }),
              actions.tokens.resetAccountTokens({
                accountId,
              }),
              actions.activities.resetActivities({
                accountId,
              }),
            ]),
          ),
        );
      }),
    );

/**
 * Stops one Midnight account's wallet, wipes that account's persisted SDK
 * state, then emits the actions that clear every redux cache the wiped state
 * fed. Scoped to a single account, unlike `createClearWalletStateOnResync`,
 * which wipes the whole chain.
 *
 * A step that errors or completes without emitting is handed to
 * `onStepFailure`: return an observable that emits to carry on with the next
 * step, or one that errors to abort the reset with that error.
 */
export const stopAndWipeAccountState$ = ({
  accountId,
  actions,
  store,
  stop$,
  onStepFailure,
}: {
  accountId: AccountId;
  actions: ActionCreators;
  store: CollectionStorage<SerializedMidnightWallet>;
  /** Halts the account's persistence and emits once it has. */
  stop$: Observable<unknown>;
  onStepFailure: (step: 'stop' | 'wipe', error: unknown) => Observable<unknown>;
}) =>
  // Stop the wallet (which halts persistence) BEFORE wiping storage, or an
  // in-flight throttled persist write could revive the cleared state.
  // Mirrors createDeleteWalletSideEffect.
  stop$.pipe(
    take(1),
    throwIfEmpty(
      () => new Error('Midnight account stop did not acknowledge completion'),
    ),
    catchError((error: unknown) => onStepFailure('stop', error)),
    switchMap(() =>
      // removeWhere, not read-then-setAll: it touches only the keys it names,
      // so it cannot delete another account's document.
      //
      // Issue order is load-bearing: an already-issued persist write cannot be
      // cancelled, so this wipe only wins by being issued later. An adapter
      // that batches or coalesces writes breaks it.
      store
        .removeWhere(wallet => wallet?.accountId === accountId)
        .pipe(
          throwIfEmpty(
            () =>
              new Error(
                'Midnight account storage wipe did not acknowledge completion',
              ),
          ),
          catchError((error: unknown) => onStepFailure('wipe', error)),
        ),
    ),
    mergeMap(() => [
      ...accountCacheResets(actions, accountId),
      actions.sync.resetAccountSyncStatus({ accountId }),
    ]),
  );

/**
 * The extension's per-account "reset sync state": stops and wipes the account,
 * then reloads the app so every engine restarts from empty state. Stop and wipe
 * failures are logged and the reset carries on, because the reload is what
 * recovers the account.
 *
 * The reload is emitted LAST, after the storage write settles: sequencing it
 * inside this chain (rather than firing it from a separate UI tap) is what stops
 * a hard reload from preempting the wipe and leaving the old SDK document to
 * restore from.
 */
export const createResetSyncStateSideEffect = (
  store: CollectionStorage<SerializedMidnightWallet>,
): SideEffect =>
  withMidnightAccounts(
    midnightAccounts$ =>
      (
        { midnightContext: { resetSyncState$ } },
        _,
        { actions, stopMidnightWallet, logger },
      ) =>
        resetSyncState$.pipe(
          withLatestFrom(midnightAccounts$),
          // switchMap, not exhaustMap: if stop() hangs — the wedged-wallet case this
          // control exists to rescue — exhaustMap would ignore every later reset for
          // the session, while a repeat press supersedes it and skips the hung stop.
          switchMap(([{ payload }, midnightAccounts]) => {
            const account = midnightAccounts.find(
              ({ accountId }) => accountId === payload.accountId,
            );
            if (!account) return EMPTY;

            const { accountId } = account;
            return concat(
              stopAndWipeAccountState$({
                accountId,
                actions,
                store,
                stop$: stopMidnightWallet(accountId),
                // Both failures only log: the account is deregistered before
                // stop() can fail, so aborting would strand it until the user
                // retries, and stop() halts persistence before it can fail.
                onStepFailure: (step, error) => {
                  logger.error(
                    `Midnight reset sync state: ${step} failed`,
                    error,
                  );
                  return of(void 0);
                },
              }),
              of(actions.app.reloadApplication()),
            );
          }),
        ),
  );

/**
 * The headless per-account "reset sync state": stops and wipes the account,
 * then restarts that account's watcher in place, since a headless runtime has
 * no application to reload. The account's sync operation reads Pending while
 * the reset runs and Failed if a stop or wipe fails, so the caller can observe
 * the outcome and retry.
 */
export const createHeadlessResetSyncStateSideEffect = (
  store: CollectionStorage<SerializedMidnightWallet>,
): SideEffect =>
  withMidnightAccounts(
    midnightAccounts$ =>
      (
        { midnightContext: { resetSyncState$ } },
        _,
        { actions, stopMidnightWallet, logger },
      ) =>
        resetSyncState$.pipe(
          withLatestFrom(midnightAccounts$),
          groupBy(([{ payload }]) => payload.accountId),
          mergeMap(requests$ =>
            requests$.pipe(
              // exhaustMap: two wipes of one account must not overlap. A repeat
              // request while a stop hangs retries the stop below instead.
              exhaustMap(([{ payload }, midnightAccounts]) => {
                const account = midnightAccounts.find(
                  ({ accountId }) => accountId === payload.accountId,
                );
                if (!account) return EMPTY;

                const { accountId } = account;
                const pendingOperation = () =>
                  actions.sync.addSyncOperation({
                    accountId,
                    operation: {
                      operationId: `${accountId}-midnight-sync`,
                      status: 'Pending',
                      description: 'sync.operation.midnight-resync',
                      startedAt: Timestamp(Date.now()),
                    },
                  });
                // A fresh request can rescue a hung stop. Unsubscription does
                // not cancel its promise; stop halts persistence synchronously
                // before waiting for the facade. Each attempt must acknowledge
                // on its own, or an empty stop would wait for another request.
                const stop$ = merge(of(undefined), requests$).pipe(
                  switchMap(() =>
                    defer(() => stopMidnightWallet(accountId)).pipe(
                      throwIfEmpty(
                        () =>
                          new Error(
                            'Midnight account stop did not acknowledge completion',
                          ),
                      ),
                    ),
                  ),
                );
                return concat(
                  of(pendingOperation()),
                  stopAndWipeAccountState$({
                    accountId,
                    actions,
                    store,
                    stop$,
                    onStepFailure: (step, error) => {
                      logger.error(
                        `Midnight reset sync state: ${step} failed`,
                        error,
                      );
                      return throwError(() => error);
                    },
                  }),
                  // The reset cleared the account's sync status, Pending
                  // included, so it is re-registered for the restarted watch.
                  defer(() =>
                    of(
                      pendingOperation(),
                      actions.midnightSync.restartAccountWatch({ accountId }),
                    ),
                  ),
                ).pipe(
                  catchError((error: unknown) => {
                    logger.error('Midnight account resync failed', error);
                    const failedAt = Timestamp(Date.now());
                    return of(
                      actions.sync.addSyncOperation({
                        accountId,
                        operation: {
                          operationId: `${accountId}-midnight-sync`,
                          status: 'Failed',
                          description: 'sync.operation.midnight-resync',
                          error: 'sync.error.midnight-sync-failed',
                          startedAt: failedAt,
                          failedAt,
                        },
                      }),
                    );
                  }),
                );
              }),
            ),
          ),
        ),
  );

/**
 * Worker mode's per-account "reset sync state". The worker stops, wipes and restarts the account's engine for every
 * tab that uses it. Each tab clears its caches on the account's `reset` notice
 * ({@link showMidnightEngineResets}), which this tab gets also when it runs no engine of the account. The account's
 * sync operation reads Pending meanwhile, and Failed if the worker refuses the reset. A held reset whose wipe then
 * fails reads Failed only in tabs with the account's engine attached as it settles; elsewhere it completes.
 */
export const createWorkerResetSyncStateSideEffect = (
  client: Pick<MidnightEngineClient, 'resetAccount'>,
): SideEffect =>
  withMidnightAccounts(
    midnightAccounts$ =>
      ({ midnightContext: { resetSyncState$ } }, _, { actions, logger }) =>
        resetSyncState$.pipe(
          withLatestFrom(midnightAccounts$),
          groupBy(([{ payload }]) => payload.accountId),
          mergeMap(requests$ =>
            requests$.pipe(
              // exhaustMap: the worker bounds a hung stop itself, so a repeat request has nothing to rescue.
              exhaustMap(([{ payload }, midnightAccounts]) => {
                const account = midnightAccounts.find(
                  ({ accountId }) => accountId === payload.accountId,
                );
                if (!account) return EMPTY;
                const { accountId } = account;
                return concat(
                  of(midnightResyncOperation(actions, accountId, 'Pending')),
                  client.resetAccount(account).pipe(
                    ignoreElements(),
                    catchError((error: unknown) => {
                      logger.error('Midnight account resync failed', error);
                      return of(
                        midnightResyncOperation(actions, accountId, 'Failed'),
                      );
                    }),
                  ),
                );
              }),
            ),
          ),
        ),
  );

/**
 * Worker mode's bulk resync. The worker clears every checkpoint and restarts every engine some tab uses; each tab
 * clears its caches of an account on that account's `reset` notice ({@link showMidnightEngineResets}), and this tab
 * gets one for each of its selected accounts. It restarts no watch, as the worker already restarted the engines.
 * When the worker fails the resync, this tab resets the caches of all its selected accounts, shows their resync as
 * Failed and restarts the watch, which reads every engine again.
 */
export const createWorkerClearWalletStateOnResync = (
  client: Pick<MidnightEngineClient, 'resyncAll'>,
): SideEffect =>
  withMidnightAccounts(
    midnightAccounts$ =>
      ({ midnightSync: { resync$ } }, _, { actions, logger }) =>
        resync$.pipe(
          withLatestFrom(midnightAccounts$),
          // switchMap, as in page mode: the worker queues resyncs, so the newest settles last and its outcome holds.
          switchMap(([_, midnightAccounts]) =>
            client.resyncAll(midnightAccounts).pipe(
              ignoreElements(),
              catchError((error: unknown) => {
                logger.error('Midnight resync failed in the worker', error);
                return [
                  ...midnightAccounts.flatMap(({ accountId }) => [
                    ...accountCacheResets(actions, accountId),
                    midnightResyncOperation(actions, accountId, 'Failed'),
                  ]),
                  actions.midnightSync.restartWalletWatch(),
                ];
              }),
            ),
          ),
        ),
  );

/**
 * Worker mode's wallet deletion. The worker detaches this tab from the wallet's engines and, once no tab uses them,
 * stops them and wipes their checkpoints. This tab resets the wallet accounts' caches as page mode does, even when
 * the worker failed the deletion: the wallet is already gone from the repository.
 */
export const createWorkerDeleteWalletSideEffect =
  (client: Pick<MidnightEngineClient, 'deleteWallet'>): SideEffect =>
  (
    { wallets: { removeWallet$ } },
    { wallets: { selectAll$ } },
    { actions, logger },
  ) =>
    removeWallet$.pipe(
      // The store applies the removal before side effects see the action, so only the list before it still holds the
      // wallet.
      withLatestFrom(selectAll$.pipe(startWith([]), pairwise())),
      map(([{ payload }, [before, after]]) =>
        removedMidnightWallet(payload, [after, before]),
      ),
      switchMap(removed => {
        if (!removed) return EMPTY;
        const { walletId, accounts } = removed;
        return client.deleteWallet(walletId, accounts).pipe(
          defaultIfEmpty(undefined),
          take(1),
          catchError((error: unknown) => {
            logger.error('Midnight delete wallet failed in the worker', error);
            return of(undefined);
          }),
          mergeMap(() =>
            accounts.flatMap(({ accountId }) => [
              actions.addresses.resetAddresses({ accountId }),
              actions.tokens.resetAccountTokens({ accountId }),
              actions.activities.resetActivities({ accountId }),
            ]),
          ),
        );
      }),
    );

/**
 * Shows in this tab a worker reset of an account it uses. One that ran clears the account's caches and shows the
 * resync Pending until the replacement engine reports progress; one that waits for a settling submission shows
 * Pending, and one whose wipe failed shows Failed.
 */
export const showMidnightEngineResets =
  (client: Pick<MidnightEngineClient, 'notices$'>): SideEffect =>
  (_, __, { actions }) =>
    client.notices$.pipe(
      mergeMap(({ accountId, kind }) => {
        switch (kind) {
          case 'reset':
            return midnightEngineResetActions(actions, accountId);
          case 'reset-pending':
            return [midnightResyncOperation(actions, accountId, 'Pending')];
          case 'reset-failed':
            return [midnightResyncOperation(actions, accountId, 'Failed')];
        }
      }),
    );
