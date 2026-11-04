import { ActivityType, activitiesActions } from '@lace-contract/activities';
import {
  FEATURE_FLAG_HYDRA_HEADS,
  hydraHeadsIndexActions,
  hydraHeadsIndexReducers,
} from '@lace-contract/cardano-context';
import { BehaviorSubject, of } from 'rxjs';
import { describe, expect, it } from 'vitest';

import { makeHydraActivitiesRetagging } from '../../../src/store/hydra-heads/retag-activities-side-effect';

import type { Activity } from '@lace-contract/activities';
import type { HydraHeadsIndexSliceState } from '@lace-contract/cardano-context';
import type { AccountId } from '@lace-contract/wallet-repo';
import type { Observable } from 'rxjs';

const preprod = { networkId: 0, networkMagic: 1 };

const loadedAccountId = 'acct-loaded' as AccountId;
const emptyAccountId = 'acct-empty' as AccountId;
const previewAccountId = 'acct-preview' as AccountId;

const cardanoAddress = (accountId: AccountId, networkMagic: number) => ({
  accountId,
  blockchainName: 'Cardano' as const,
  address: `addr_test_${accountId}`,
  data: { networkId: 0, networkMagic },
});

const bitcoinAddress = {
  accountId: 'acct-bitcoin' as AccountId,
  blockchainName: 'Bitcoin' as const,
  address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
  data: {},
};

const flagsOn = {
  modules: [],
  featureFlags: [{ key: FEATURE_FLAG_HYDRA_HEADS }],
};
const flagsOff = { modules: [], featureFlags: [] };

const activity = (
  accountId: AccountId,
  activityId: string,
  type = ActivityType.Send,
): Activity => ({
  accountId,
  activityId,
  timestamp: 0 as Activity['timestamp'],
  tokenBalanceChanges: [],
  type,
});

type Sources = {
  features$: Observable<unknown>;
  isWalletActive$: Observable<boolean>;
  addresses: unknown[];
  activities: Partial<Record<AccountId, Activity[]>>;
  tagged: HydraHeadsIndexSliceState['activitiesTaggedByAccount'];
};

/**
 * Runs the side effect against a store that applies the marks it dispatches
 * and drops the activities of each account it resets, as the activities
 * slice does.
 */
const run = (sources: Partial<Sources> = {}) => {
  const {
    features$ = of(flagsOn),
    isWalletActive$ = of(true),
    addresses = [
      cardanoAddress(loadedAccountId, 1),
      cardanoAddress(emptyAccountId, 1),
      cardanoAddress(previewAccountId, 2),
      bitcoinAddress,
    ],
    activities = {
      [loadedAccountId]: [activity(loadedAccountId, 'tx-1')],
      [previewAccountId]: [activity(previewAccountId, 'tx-2')],
    },
    tagged = {},
  } = sources;
  const reducer = hydraHeadsIndexReducers.hydraHeadsIndex;
  let state: HydraHeadsIndexSliceState = {
    ...reducer(undefined, { type: '@@init' }),
    activitiesTaggedByAccount: tagged,
  };
  const activities$ = new BehaviorSubject(activities);
  const tagged$ = new BehaviorSubject(state.activitiesTaggedByAccount);
  const emitted: { type: string; payload?: unknown }[] = [];
  makeHydraActivitiesRetagging()(
    {} as never,
    {
      activities: { selectAllMap$: activities$ },
      addresses: { selectAllAddresses$: of(addresses) },
      cardanoContext: { selectChainId$: of(preprod) },
      features: { selectLoadedFeatures$: features$ },
      hydraHeadsIndex: { selectActivitiesTaggedByAccount$: tagged$ },
    } as never,
    {
      actions: { ...activitiesActions, ...hydraHeadsIndexActions },
      isWalletActive$,
    } as never,
  ).subscribe(action => {
    const { type, payload } = action as { type: string; payload?: unknown };
    emitted.push({ type, payload });
    if (activitiesActions.activities.resetActivities.match(action)) {
      const { [action.payload.accountId]: _, ...rest } = activities$.value;
      activities$.next(rest);
      return;
    }
    state = reducer(state, action);
    tagged$.next(state.activitiesTaggedByAccount);
  });
  return { emitted, activities$, state: () => state };
};

const resetsOf = (emitted: { type: string; payload?: unknown }[]) =>
  emitted
    .filter(({ type }) => type === 'activities/resetActivities')
    .map(({ payload }) => (payload as { accountId: AccountId }).accountId);

describe('makeHydraActivitiesRetagging', () => {
  it('resets an account with activities loaded while the flag was off exactly once', () => {
    const { emitted, activities$, state } = run();

    activities$.next({
      ...activities$.value,
      [loadedAccountId]: [activity(loadedAccountId, 'tx-1')],
    });

    expect(resetsOf(emitted)).toEqual([loadedAccountId]);
    expect(state().activitiesTaggedByAccount).toEqual({
      [loadedAccountId]: true,
      [emptyAccountId]: true,
    });
  });

  it('resets the activities before saving the mark, so a mark saved is one whose reset happened', () => {
    const { emitted } = run();

    expect(emitted.map(({ type }) => type)).toEqual([
      'activities/resetActivities',
      'hydraHeadsIndex/activitiesTagged',
    ]);
  });

  it('marks an account without activities without resetting it', () => {
    const { emitted, state } = run({ activities: {} });

    expect(resetsOf(emitted)).toEqual([]);
    expect(state().activitiesTaggedByAccount).toEqual({
      [loadedAccountId]: true,
      [emptyAccountId]: true,
    });
  });

  it('leaves the accounts of other networks and blockchains alone', () => {
    const { emitted, state } = run();

    expect(resetsOf(emitted)).not.toContain(previewAccountId);
    expect(Object.keys(state().activitiesTaggedByAccount)).not.toContain(
      previewAccountId,
    );
    expect(Object.keys(state().activitiesTaggedByAccount)).not.toContain(
      bitcoinAddress.accountId,
    );
  });

  it('resets nothing for an account marked before a restart', () => {
    const { emitted } = run({
      tagged: { [loadedAccountId]: true, [emptyAccountId]: true },
    });

    expect(emitted).toEqual([]);
  });

  it('waits until no activity of the account is pending', () => {
    const pending = activity(loadedAccountId, 'tx-2', ActivityType.Pending);
    const { emitted, activities$ } = run({
      activities: {
        [loadedAccountId]: [pending, activity(loadedAccountId, 'tx-1')],
      },
    });

    expect(resetsOf(emitted)).toEqual([]);

    activities$.next({
      [loadedAccountId]: [
        activity(loadedAccountId, 'tx-2'),
        activity(loadedAccountId, 'tx-1'),
      ],
    });

    expect(resetsOf(emitted)).toEqual([loadedAccountId]);
  });

  it('does nothing while the flag is off', () => {
    const { emitted } = run({ features$: of(flagsOff) });

    expect(emitted).toEqual([]);
  });

  it('clears the marks when the flag is seen off', () => {
    const { emitted, state } = run({
      features$: of(flagsOff),
      tagged: { [loadedAccountId]: true },
    });

    expect(emitted.map(({ type }) => type)).toEqual([
      'hydraHeadsIndex/activitiesUntagged',
    ]);
    expect(state().activitiesTaggedByAccount).toEqual({});
  });

  it('resets the account again once the flag is turned off and on', () => {
    const features$ = new BehaviorSubject<unknown>(flagsOn);
    const { emitted, activities$ } = run({ features$ });

    activities$.next({
      [loadedAccountId]: [activity(loadedAccountId, 'tx-3')],
    });
    features$.next(flagsOff);
    features$.next(flagsOn);

    expect(resetsOf(emitted)).toEqual([loadedAccountId, loadedAccountId]);
  });

  it('does nothing while the wallet is inactive', () => {
    const { emitted } = run({ isWalletActive$: of(false) });

    expect(emitted).toEqual([]);
  });
});
