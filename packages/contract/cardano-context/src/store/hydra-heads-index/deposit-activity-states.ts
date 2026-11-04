import { featuresSelectors } from '@lace-contract/feature';
import { getHydraDepositStatus } from '@lace-lib/hydra-head';
import { createSelector, weakMapMemoize } from '@reduxjs/toolkit';

import { FEATURE_FLAG_HYDRA_HEADS } from '../../hydra-heads-feature-flag';

import { hydraHeadsIndexSelectors } from './slice';

import type { HydraHeadsIndexDeposit } from './types';
import type { CardanoHydraDepositActivityState } from '../../augmentations';
import type { ActivityStates } from '@lace-contract/activities';
import type { State } from '@lace-contract/module';
import type { AccountId } from '@lace-contract/wallet-repo';

/** The states while the Hydra Head feature flag is off: no states and no tags. */
const FLAG_OFF_ACTIVITY_STATES: ActivityStates = { byActivityId: {} };

/** The states of an account without pending deposits: tags but no states. */
const NO_DEPOSITS_ACTIVITY_STATES: ActivityStates = {
  byActivityId: {},
  isTaggingEnabled: true,
};

/**
 * Results kept per generation of the per-time caches. A list and a sheet
 * mounted together each select with their own time, and every timer tick
 * adds one, so a few entries cover the active callers.
 */
const TIME_CACHE_MAX_SIZE = 16;

/** True while the Hydra Head feature flag is on. */
const selectIsHydraHeadsEnabled = createSelector(
  featuresSelectors.features.selectLoadedFeatures,
  ({ featureFlags }) =>
    featureFlags.some(flag => flag.key === FEATURE_FLAG_HYDRA_HEADS),
);

/**
 * The states of an account's Hydra deposit activities, keyed by the deposit
 * transaction id, which is the activity id.
 */
export type HydraDepositActivityStates = ActivityStates & {
  byActivityId: Readonly<Record<string, CardanoHydraDepositActivityState>>;
};

/**
 * The states of the activities that created the deposits, keyed by the
 * deposit transaction id, which is the activity id. The status is derived
 * from the deadline and `now` rather than read from the deposit, whose status
 * was fixed when the sweep found it. While a deposit is pending the states
 * change right after its deadline, when it becomes recoverable, which
 * `nextChangeAt` gives so a consumer knows when to derive them again.
 *
 * @param deposits - The account's indexed deposits.
 * @param now - Epoch milliseconds the status is derived for.
 */
export const toHydraDepositActivityStates = (
  deposits: readonly HydraHeadsIndexDeposit[],
  now: number,
): HydraDepositActivityStates => {
  const byActivityId: Record<string, CardanoHydraDepositActivityState> = {};
  let nextChangeAt: number | undefined;
  for (const { outpoint, deadline } of deposits) {
    const deadlineMs = Date.parse(deadline);
    const status = getHydraDepositStatus(deadlineMs, now);
    byActivityId[outpoint.txId] = { status, deadline };
    if (status === 'pending') {
      nextChangeAt = Math.min(nextChangeAt ?? Infinity, deadlineMs + 1);
    }
  }
  return nextChangeAt === undefined
    ? { byActivityId, isTaggingEnabled: true }
    : { byActivityId, nextChangeAt, isTaggingEnabled: true };
};

/**
 * Selects the states of the account's activities whose Hydra deposits still
 * wait at the deposit validator, as of `now` in epoch milliseconds. Joins the
 * indexed deposits rather than the activities' Hydra marker, which anyone can
 * attach to a transaction. Allows the Hydra tags only while the Hydra Head
 * feature flag is on, and is empty while it is off.
 *
 * Each list or sheet selects with its own `now`, so the results are cached
 * per account and time rather than for the latest call only. The cache is
 * bounded: a result its caller keeps selecting stays cached, while results
 * for times nobody selects any more are released.
 */
export const selectHydraDepositActivityStates = createSelector(
  [
    (state: State, accountId: AccountId) =>
      hydraHeadsIndexSelectors.hydraHeadsIndex.selectHydraDepositsByAccount(
        state,
        accountId,
      ),
    (state: State) => selectIsHydraHeadsEnabled(state),
    (_state: State, _accountId: AccountId, now: number) => now,
  ],
  (deposits, isEnabled, now) => {
    if (!isEnabled) return FLAG_OFF_ACTIVITY_STATES;
    return deposits.length > 0
      ? toHydraDepositActivityStates(deposits, now)
      : NO_DEPOSITS_ACTIVITY_STATES;
  },
  {
    memoize: weakMapMemoize,
    memoizeOptions: { maxSize: TIME_CACHE_MAX_SIZE },
    argsMemoize: weakMapMemoize,
    argsMemoizeOptions: { maxSize: TIME_CACHE_MAX_SIZE },
  },
);
