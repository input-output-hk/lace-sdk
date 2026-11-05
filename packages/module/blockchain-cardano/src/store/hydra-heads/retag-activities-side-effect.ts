import { ActivityType } from '@lace-contract/activities';
import {
  FEATURE_FLAG_HYDRA_HEADS,
  isCardanoAddressOfSupportedNetwork,
} from '@lace-contract/cardano-context';
import { whileActive } from '@lace-contract/wallet-active-state';
import {
  combineLatest,
  distinctUntilChanged,
  filter,
  from,
  map,
  switchMap,
  take,
} from 'rxjs';

import type { SideEffect } from '../../sdk-contracts';
import type { Cardano } from '@cardano-sdk/core';
import type { Activity } from '@lace-contract/activities';
import type { AnyAddress } from '@lace-contract/addresses';
import type { HydraHeadsIndexSliceState } from '@lace-contract/cardano-context';
import type { AccountId } from '@lace-contract/wallet-repo';

/** The accounts marked as holding tagged activities. */
type TaggedAccounts = HydraHeadsIndexSliceState['activitiesTaggedByAccount'];

/** The accounts to mark, and those of them whose activities to reload. */
type RetagPlan = {
  accountIds: AccountId[];
  resetAccountIds: AccountId[];
};

/** The distinct Cardano accounts with an address on the network. */
const accountIdsOn = (
  chainId: Cardano.ChainId,
  addresses: readonly AnyAddress[],
): AccountId[] => [
  ...new Set(
    addresses
      .filter(address => isCardanoAddressOfSupportedNetwork(address, chainId))
      .map(({ accountId }) => accountId),
  ),
];

/**
 * The unmarked accounts of the network: one without activities is only
 * marked, one with activities is reset and marked. An account with a pending
 * activity waits, since a reset would drop that activity until it confirms.
 */
const toRetagPlan = ({
  accountIds,
  activitiesByAccount,
  tagged,
}: {
  accountIds: readonly AccountId[];
  activitiesByAccount: Partial<Record<AccountId, Activity[]>>;
  tagged: TaggedAccounts;
}): RetagPlan => {
  const plan: RetagPlan = { accountIds: [], resetAccountIds: [] };
  for (const accountId of accountIds) {
    if (tagged[accountId]) continue;
    const activities = activitiesByAccount[accountId] ?? [];
    if (activities.some(({ type }) => type === ActivityType.Pending)) continue;
    plan.accountIds.push(accountId);
    if (activities.length > 0) plan.resetAccountIds.push(accountId);
  }
  return plan;
};

/**
 * Reloads, once, the activities of the Cardano accounts of the active network
 * that were loaded while the Hydra Head feature flag was off.
 *
 * Activities carry the Hydra Head tags only when they are loaded with the
 * flag on, and the activity tracker loads only the activities missing from
 * the store. A deposit the account sent before the flag was on would never
 * name its head, so the sweep would never find a head the account deposited
 * into without a participation token. Resetting the account's activities
 * makes the tracker load them again, now tagged, and the next sweep picks
 * the deposits up.
 *
 * While the flag is on, each account not marked yet is marked, and reset
 * first when it has activities; an account with a pending activity waits
 * until none is pending. The marks are persisted, so the reset happens once
 * per account rather than on every start. While the flag is off the marks
 * are cleared, so turning it on again reloads the activities loaded in
 * between.
 */
export const makeHydraActivitiesRetagging =
  (): SideEffect =>
  (
    _,
    {
      activities: { selectAllMap$ },
      addresses: { selectAllAddresses$ },
      cardanoContext: { selectChainId$ },
      features: { selectLoadedFeatures$ },
      hydraHeadsIndex: { selectActivitiesTaggedByAccount$ },
    },
    { actions, isWalletActive$ },
  ) =>
    selectLoadedFeatures$.pipe(
      map(({ featureFlags }) =>
        featureFlags.some(flag => flag.key === FEATURE_FLAG_HYDRA_HEADS),
      ),
      distinctUntilChanged(),
      switchMap(enabled =>
        enabled
          ? combineLatest([
              selectChainId$.pipe(filter(Boolean)),
              selectAllAddresses$,
              selectAllMap$,
              selectActivitiesTaggedByAccount$,
            ]).pipe(
              map(([chainId, addresses, activitiesByAccount, tagged]) =>
                toRetagPlan({
                  accountIds: accountIdsOn(chainId, addresses),
                  activitiesByAccount,
                  tagged,
                }),
              ),
              filter(({ accountIds }) => accountIds.length > 0),
              switchMap(({ accountIds, resetAccountIds }) =>
                from([
                  ...resetAccountIds.map(accountId =>
                    actions.activities.resetActivities({ accountId }),
                  ),
                  actions.hydraHeadsIndex.activitiesTagged({ accountIds }),
                ]),
              ),
            )
          : selectActivitiesTaggedByAccount$.pipe(
              take(1),
              filter(tagged => Object.keys(tagged).length > 0),
              map(() => actions.hydraHeadsIndex.activitiesUntagged()),
            ),
      ),
      whileActive(isWalletActive$),
    );
