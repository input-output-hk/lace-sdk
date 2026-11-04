import { ActivityType } from '@lace-contract/activities';
import { isRemoteMidnightEngine } from '@lace-contract/midnight-context';
import { derivePendingActivityFromMidnightTx } from '@lace-module/dapp-connector-midnight/sdk';
import {
  preparePendingActivity,
  remoteEngineClientOf,
  submitTransaction,
} from '@lace-module/midnight-sync/sdk';
import {
  catchError,
  defer,
  of,
  ReplaySubject,
  share,
  switchMap,
  take,
  throwError,
  timeout,
} from 'rxjs';

import {
  MidnightSubmitTimeoutError,
  toMidnightSdkError,
} from './midnight-errors';
import { resolveTimeoutMs } from './midnight-timeouts';
import { withMidnightWallet } from './midnight-wallet';

import type {
  MidnightAccountProps,
  WalletWithMidnight,
} from './midnight-wallet';
import type { MidnightFinalizedTx } from './prove-midnight-tx';
import type { Activity } from '@lace-contract/activities';
import type { MidnightWallet } from '@lace-contract/midnight-context';
import type { AccountId } from '@lace-contract/wallet-repo';
import type { Result } from '@lace-lib/util';
import type { MidnightPendingRow } from '@lace-module/midnight-sync/sdk';
import type { Observable } from 'rxjs';

const DEFAULT_SUBMIT_TIMEOUT_MS = 5 * 60_000;
// The coin read that feeds the Pending row is best effort: a wallet whose state does not settle in this time is
// submitted without a row, so the read can delay a submission by at most this long and never fails it.
const PENDING_ROW_STATE_TIMEOUT_MS = 10_000;

/** The options of `submitMidnightTx`. */
export interface SubmitMidnightTxProps extends MidnightAccountProps {
  transaction: MidnightFinalizedTx;
  /**
   * How long, in milliseconds, to wait for the node to report the transaction final; 5 minutes by default. A
   * value that is not a finite positive number up to 2^31 - 1 (the longest delay a timer honours) is refused
   * with a `RangeError` before anything is submitted. It
   * bounds the wait for finality, not for broadcast: when it elapses the transaction may already be on chain,
   * and the engine's submission is not cancelled. The coin read for the Pending row has its own bound of 10
   * seconds: it never fails the submission and delays it by at most that long.
   */
  submitTimeout?: number;
}

type ActivitiesByAccount = Record<AccountId, Activity[]>;

// The latest value the store holds now, if it holds one: read once, as the store replays it to a new subscriber.
const latestOf = (
  activities$: Observable<ActivitiesByAccount>,
): ActivitiesByAccount | undefined => {
  let latest: ActivitiesByAccount | undefined;
  activities$
    .pipe(
      take(1),
      catchError(() => of(undefined)),
    )
    .subscribe(value => {
      latest = value;
    })
    .unsubscribe();
  return latest;
};

/**
 * The instance's activity tracking of a submission, if it tracks activities: `record` writes the Pending row unless
 * the history sync has confirmed the transaction already, and `remove` takes it away after a failure unless the
 * sync has confirmed it meanwhile. Tracking is best effort: neither ever fails a submission.
 */
const pendingRowOf = (
  wallet: WalletWithMidnight,
):
  | (MidnightPendingRow & { record: (activity: Activity) => boolean })
  | undefined => {
  const { dispatch } = wallet;
  const activities$ = dispatch
    ? wallet.stateObservables.activities?.selectAllMap$
    : undefined;
  if (!dispatch || !activities$) return undefined;
  const rowOf = (
    activities: ActivitiesByAccount | undefined,
    activity: Activity,
  ) =>
    activities?.[activity.accountId]?.find(
      row => row.activityId === activity.activityId,
    );
  return {
    record: activity => {
      try {
        const activities = latestOf(activities$);
        const current = rowOf(activities, activity);
        if (!activities || (current && current.type !== ActivityType.Pending))
          return false;
        dispatch('activities.upsertActivities', {
          accountId: activity.accountId,
          activities: [activity],
        });
        return true;
      } catch {
        return false;
      }
    },
    remove: activity => {
      if (rowOf(latestOf(activities$), activity)?.type !== ActivityType.Pending)
        return;
      try {
        dispatch('activities.removeActivities', {
          accountId: activity.accountId,
          activityIds: [activity.activityId],
        });
      } catch {
        // The engine's error, not a tracking failure, is the result.
      }
    },
  };
};

// Bounds the wait for finality; the submission itself runs on.
const waitForFinality = (
  outcome$: Observable<{ txId: string }>,
  transaction: MidnightFinalizedTx,
  submitTimeout: number,
): Observable<{ txId: string }> =>
  outcome$.pipe(
    timeout({
      first: submitTimeout,
      with: () =>
        throwError(
          () =>
            new MidnightSubmitTimeoutError(
              transaction.activityHash,
              submitTimeout,
            ),
        ),
    }),
  );

// The engine settles a submission only at finality, so the call is issued first, then the Pending row is recorded
// (a row the history sync confirmed meanwhile is never overwritten), then the caller waits. The submission is
// subscribed once and its outcome replayed: a later failure removes the row even after the caller stopped waiting,
// and a cold engine observable is never submitted twice.
const submitOnPage = ({
  engine,
  transaction,
  pendingRow,
  pendingRowTimeout,
  submitTimeout,
}: {
  engine: MidnightWallet;
  transaction: MidnightFinalizedTx;
  pendingRow: ReturnType<typeof pendingRowOf>;
  pendingRowTimeout: number;
  submitTimeout: number;
}): Observable<{ txId: string }> =>
  (pendingRow
    ? preparePendingActivity(
        engine,
        transaction,
        derivePendingActivityFromMidnightTx,
      ).pipe(
        timeout({
          first: pendingRowTimeout,
          with: () => of(undefined),
        }),
      )
    : of(undefined)
  ).pipe(
    switchMap(activity => {
      const outcome$ = submitTransaction(engine, transaction).pipe(
        share({
          connector: () => new ReplaySubject<{ txId: string }>(1),
          resetOnError: false,
          resetOnComplete: false,
          resetOnRefCountZero: false,
        }),
      );
      outcome$.subscribe({ error: () => undefined });
      if (activity && pendingRow?.record(activity))
        outcome$.subscribe({
          error: () => {
            pendingRow.remove(activity);
          },
        });
      return waitForFinality(outcome$, transaction, submitTimeout);
    }),
  );

/**
 * Submits a proved transaction after consumer authorization and resolves once the node reports it final: the
 * engine submits at its `Finalized` stage, so `Ok` means the transaction is on chain. `txId` is the engine's
 * identifier, which is not the activity hash; the activity hash is `transaction.activityHash`.
 *
 * On an instance that tracks activities, the transaction's Pending activity, keyed by the activity hash, is
 * recorded when the submission is handed to the engine, before finality; the history sync then replaces it with
 * the confirmed row. The engine reports no acceptance before finality, so the row is written as soon as the call
 * is issued. When the engine fails the submission it releases the transaction's coins and the Pending row is
 * removed; if the transaction reaches the chain anyway, the history sync records it. Tracking failures never fail
 * a submission.
 *
 * An `Err` does not prove that nothing was broadcast. {@link MidnightSubmitTimeoutError} (`code`
 * `midnight-submit-timeout`) means the node did not report finality within `submitTimeout`: the transaction may
 * still reach the chain, and its Pending row stays. The SDK keeps listening to the engine's submission after the
 * timeout, for as long as that submission runs in this process: a failure it reports later removes the row, a
 * confirmation reaches the history sync. A row whose outcome this process never learns (it ends first) stays
 * until the history sync confirms it or the consumer removes it. The account-resolution errors
 * (`MidnightAccountNotFoundError`, `MidnightWalletNotReadyError`) precede the call and so precede any broadcast,
 * as do the refusals of a transaction of another account and of one proved before the account's engine restarted or
 * was reset (`MidnightStaleTxError`); any other error is the engine's, and may also arrive after broadcast.
 * Before retrying, check the account's activities for the activity hash.
 *
 * In Worker mode the worker derives the Pending row, within the same bound as on the page, and the page records it
 * before the submission is posted; the wait for finality is timed from the post, as on the page. A
 * `MidnightStaleTxError` also comes when no running engine of the account took the submission (none ran, as while
 * the engine restarts, or the one that ran had failed): nothing was broadcast and the row is removed.
 * {@link MidnightSubmitInterruptedError} (`code`
 * `midnight-submit-interrupted`) means the worker ended after the submission was handed to it and before it reported
 * the outcome: the transaction may still reach the chain, its Pending row stays, and the SDK never submits it again.
 * A worker that ended before the submission was handed to it returns `MidnightWorkerStoppedError` and removes the
 * row; `MidnightEngineResetError` means a reset of the account refused the submission before anything was broadcast.
 */
export const submitMidnightTx = async (
  wallet: WalletWithMidnight,
  {
    transaction,
    submitTimeout: requestedSubmitTimeout,
    ...account
  }: SubmitMidnightTxProps,
): Promise<Result<{ txId: string }, Error>> =>
  withMidnightWallet(wallet, account, engine =>
    defer(() => {
      const submitTimeout = resolveTimeoutMs(
        'submitTimeout',
        requestedSubmitTimeout,
        DEFAULT_SUBMIT_TIMEOUT_MS,
      );
      const pendingRow = pendingRowOf(wallet);
      const pendingRowTimeout = Math.min(
        PENDING_ROW_STATE_TIMEOUT_MS,
        submitTimeout,
      );
      // In Worker mode the engine client derives and records the row, posts the submission and hands over its
      // outcome as it posts, so the wait for finality starts there, as on the page. The client removes the row itself
      // when the live worker fails the submission, also after a timeout here.
      return isRemoteMidnightEngine(engine)
        ? remoteEngineClientOf(engine)
            .submit(transaction, { pendingRow, pendingRowTimeout })
            .pipe(
              switchMap(outcome$ =>
                waitForFinality(outcome$, transaction, submitTimeout),
              ),
              catchError((error: unknown) =>
                throwError(() =>
                  toMidnightSdkError(error, {
                    accountId: engine.accountId,
                    activityHash: transaction.activityHash,
                  }),
                ),
              ),
            )
        : submitOnPage({
            engine,
            transaction,
            pendingRow,
            pendingRowTimeout,
            submitTimeout,
          });
    }),
  );
