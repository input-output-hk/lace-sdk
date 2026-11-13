import { TokenId } from '@lace-contract/tokens';
import {
  AccountId,
  WalletId,
  walletsActions,
} from '@lace-contract/wallet-repo';
import { BigNumber, Timestamp } from '@lace-lib/util';
import { Serializable } from '@lace-lib/util-store';
import { REHYDRATE } from 'redux-persist';
import { describe, expect, it } from 'vitest';

import {
  ACTIVITIES_PER_PAGE,
  activitiesActions as actions,
  ActivitiesPaginationFailureId,
  ActivityType,
  MAX_ACTIVITIES_PER_ACCOUNT,
} from '../../src/index';
import { activitiesReducers, activitiesSelectors } from '../../src/store/slice';

import type { ActivitiesSliceState } from '../../src/store/slice';
import type { ActivityDetail } from '../../src/types';
import type { Failure } from '@lace-contract/failures';

describe('activities slice', () => {
  const initialState: ActivitiesSliceState = {
    activities: {},
    desiredLoadedActivitiesCountPerAccount: {},
    hasLoadedOldestEntry: {},
  };
  const accountId = AccountId('account1');
  const account2Id = AccountId('account2');
  const activity1 = {
    accountId,
    activityId: 'activity1',
    timestamp: Timestamp(1746526784955),
    tokenBalanceChanges: [{ tokenId: TokenId('tDust'), amount: BigNumber(0n) }],
    type: ActivityType.Send,
  };
  const activity2 = {
    accountId: account2Id,
    activityId: 'activity2',
    timestamp: Timestamp(1746526784956),
    tokenBalanceChanges: [{ tokenId: TokenId('other'), amount: BigNumber(0n) }],
    type: ActivityType.Send,
  };

  describe('reducers', () => {
    describe('setActivities', () => {
      it('sets activities', () => {
        const state = activitiesReducers.activities(
          initialState,
          actions.activities.setActivities({
            accountId,
            activities: [activity1],
          }),
        );
        expect(state.activities).toStrictEqual({
          [accountId]: [activity1],
        });
      });

      it('sets activities with different timestamp and sorts them', () => {
        const state = activitiesReducers.activities(
          initialState,
          actions.activities.setActivities({
            accountId,
            activities: [activity1, activity2],
          }),
        );

        expect(state.activities[accountId]).toStrictEqual([
          activity2,
          activity1,
        ]);
      });
    });

    describe('upsertActivities', () => {
      it('inserts new activities', () => {
        const state = activitiesReducers.activities(
          {
            activities: {
              [accountId]: [activity1],
            },
            desiredLoadedActivitiesCountPerAccount: {
              [accountId]: ACTIVITIES_PER_PAGE,
            },
            hasLoadedOldestEntry: {
              [accountId]: false,
            },
          },
          actions.activities.upsertActivities({
            accountId,
            activities: [activity2],
          }),
        );
        expect(state.activities).toStrictEqual({
          [accountId]: [activity2, activity1],
        });
      });

      it('updates existing activities', () => {
        const updatedActivity1 = {
          ...activity1,
          timestamp: Timestamp(activity1.timestamp + 2),
        };
        const state = activitiesReducers.activities(
          {
            activities: {
              [accountId]: [activity1],
            },
            desiredLoadedActivitiesCountPerAccount: {
              [accountId]: ACTIVITIES_PER_PAGE,
            },
            hasLoadedOldestEntry: {
              [accountId]: false,
            },
          },
          actions.activities.upsertActivities({
            accountId,
            activities: [activity2, updatedActivity1],
          }),
        );
        expect(state.activities).toStrictEqual({
          [accountId]: [updatedActivity1, activity2],
        });
      });

      it('replaces an activity that addActivities added', () => {
        const added = activitiesReducers.activities(
          initialState,
          actions.activities.addActivities({
            accountId,
            activities: [activity1],
          }),
        );
        const updatedActivity1 = { ...activity1, type: ActivityType.Receive };
        const state = activitiesReducers.activities(
          added,
          actions.activities.upsertActivities({
            accountId,
            activities: [updatedActivity1],
          }),
        );
        expect(state.activities).toStrictEqual({
          [accountId]: [updatedActivity1],
        });
      });
    });

    describe('addActivities', () => {
      const held = { ...activity1, type: ActivityType.Send };

      describe('retained provisional balance evidence', () => {
        const contribution = (amount: bigint) => [
          { tokenId: TokenId('tDust'), amount: BigNumber(amount) },
        ];
        const outputOnly = {
          ...activity1,
          type: ActivityType.Pending,
          provisional: { output: contribution(9_600_000n) },
          tokenBalanceChanges: contribution(9_600_000n),
        };
        const resolved = {
          ...outputOnly,
          provisional: {
            ...outputOnly.provisional,
            input: contribution(-9_800_000n),
          },
          tokenBalanceChanges: contribution(-200_000n),
        };

        it.each([
          ['shrinking ownership after reload', resolved, outputOnly],
          [
            'an older publication reduced after the corrected publication',
            resolved,
            outputOnly,
          ],
          ['new ownership evidence', outputOnly, resolved],
        ])('keeps the resolved balance with %s', (_name, first, second) => {
          const persisted = JSON.parse(
            JSON.stringify({
              ...initialState,
              activities: { [accountId]: [first] },
            }),
          ) as ActivitiesSliceState;
          const state = activitiesReducers.activities(
            persisted,
            actions.activities.addActivities({
              accountId,
              activities: [second],
            }),
          );
          expect(state.activities[accountId]).toStrictEqual([resolved]);
        });

        it('unions disjoint partial input evidence instead of freezing or replacing the earlier partial amount', () => {
          const first = {
            ...outputOnly,
            provisional: {
              ...outputOnly.provisional,
              firstInput: contribution(-4_800_000n),
            },
            tokenBalanceChanges: contribution(4_800_000n),
          };
          const second = {
            ...outputOnly,
            provisional: {
              ...outputOnly.provisional,
              secondInput: contribution(-5_000_000n),
            },
            tokenBalanceChanges: contribution(4_600_000n),
          };
          const before = JSON.parse(
            JSON.stringify({
              ...initialState,
              activities: { [accountId]: [first] },
            }),
          ) as ActivitiesSliceState;
          const after = activitiesReducers.activities(
            before,
            actions.activities.addActivities({
              accountId,
              activities: [second, first, second],
            }),
          );
          expect(after.activities[accountId][0]).toStrictEqual({
            ...resolved,
            provisional: { ...first.provisional, ...second.provisional },
          });
        });

        it('merges each token once per source and omits zero nets', () => {
          const asset = (amount: bigint) => ({
            tokenId: TokenId('asset'),
            amount: BigNumber(amount),
          });
          const first = {
            ...outputOnly,
            provisional: {
              output: [...contribution(9_600_000n), asset(3n)],
              firstInput: [...contribution(-4_800_000n), asset(-2n)],
            },
          };
          const second = {
            ...outputOnly,
            provisional: {
              output: [...contribution(9_600_000n), asset(3n)],
              secondInput: [...contribution(-5_000_000n), asset(-1n)],
            },
          };
          const state = activitiesReducers.activities(
            initialState,
            actions.activities.addActivities({
              accountId,
              activities: [first, second, first],
            }),
          );
          expect(
            state.activities[accountId][0].tokenBalanceChanges,
          ).toStrictEqual(contribution(-200_000n));
        });
      });

      it('refreshes a provisional pending row with a corrected derived balance', () => {
        const provisional = {
          ...activity1,
          type: ActivityType.Pending,
          provisional: { output: activity1.tokenBalanceChanges },
        };
        const corrected = {
          ...provisional,
          provisional: {
            ...provisional.provisional,
            input: [
              { tokenId: TokenId('tDust'), amount: BigNumber(-200_000n) },
            ],
          },
          tokenBalanceChanges: [
            { tokenId: TokenId('tDust'), amount: BigNumber(-200_000n) },
          ],
        };
        const state = activitiesReducers.activities(
          { ...initialState, activities: { [accountId]: [provisional] } },
          actions.activities.addActivities({
            accountId,
            activities: [corrected],
          }),
        );
        expect(state.activities[accountId]).toStrictEqual([corrected]);
      });

      it('preserves references for an unchanged provisional publication', () => {
        const row = {
          ...activity1,
          type: ActivityType.Pending,
          provisional: {},
          tokenBalanceChanges: [],
        };
        const before = { ...initialState, activities: { [accountId]: [row] } };
        const after = activitiesReducers.activities(
          before,
          actions.activities.addActivities({
            accountId,
            activities: [{ ...row }],
          }),
        );
        expect(after).toBe(before);
      });

      it.each([
        { ...activity1, type: ActivityType.Send, provisional: {} },
        { ...activity1, type: ActivityType.Pending },
        {
          ...activity1,
          type: ActivityType.Pending,
          provisional: {},
          blockchainSpecific: { Cardano: { custom: 'feature metadata' } },
        },
      ])(
        'keeps a confirmed or feature row that lands before a delayed provisional publication: %j',
        current => {
          const delayed = actions.activities.addActivities({
            accountId,
            activities: [
              {
                ...activity1,
                type: ActivityType.Pending,
                provisional: {},
              },
            ],
          });
          const arrived = activitiesReducers.activities(
            initialState,
            actions.activities.upsertActivities({
              accountId,
              activities: [current],
            }),
          );
          const state = activitiesReducers.activities(arrived, delayed);
          expect(state).toBe(arrived);
        },
      );

      it('adds activities with new IDs, sorted newest first', () => {
        const newer = {
          ...activity1,
          activityId: 'activity3',
          timestamp: Timestamp(activity1.timestamp + 10),
        };
        const state = activitiesReducers.activities(
          { ...initialState, activities: { [accountId]: [activity1] } },
          actions.activities.addActivities({
            accountId,
            activities: [newer],
          }),
        );
        expect(state.activities).toStrictEqual({
          [accountId]: [newer, activity1],
        });
      });

      it('adds activities to an account that holds none', () => {
        const state = activitiesReducers.activities(
          initialState,
          actions.activities.addActivities({
            accountId,
            activities: [activity1],
          }),
        );
        expect(state.activities).toStrictEqual({ [accountId]: [activity1] });
      });

      it('keeps an activity the account holds, whatever the incoming one carries', () => {
        const incoming = {
          ...held,
          type: ActivityType.Pending,
          timestamp: Timestamp(held.timestamp + 10),
          blockchainSpecific: { Cardano: { fee: 1n } },
        };
        const other = { ...activity1, activityId: 'activity3' };
        const state = activitiesReducers.activities(
          { ...initialState, activities: { [accountId]: [held] } },
          actions.activities.addActivities({
            accountId,
            activities: [incoming, other],
          }),
        );
        expect(state.activities).toStrictEqual({
          [accountId]: [held, other],
        });
      });

      it('keeps the first of two incoming activities with the same ID', () => {
        const second = { ...activity1, type: ActivityType.Receive };
        const state = activitiesReducers.activities(
          initialState,
          actions.activities.addActivities({
            accountId,
            activities: [activity1, second],
          }),
        );
        expect(state.activities).toStrictEqual({ [accountId]: [activity1] });
      });

      it('preserves the array reference when the account holds every activity', () => {
        const activities = [held];
        const state = activitiesReducers.activities(
          { ...initialState, activities: { [accountId]: activities } },
          actions.activities.addActivities({
            accountId,
            activities: [{ ...held, type: ActivityType.Pending }],
          }),
        );
        expect(state.activities[accountId]).toBe(activities);
      });

      it('encodes chain-specific metadata as upsertActivities does', () => {
        const blockchainSpecific = { Cardano: { fee: 1n } };
        const encoded = actions.activities.upsertActivities({
          accountId,
          activities: [{ ...activity1, blockchainSpecific }],
        }).payload.activities;
        expect(
          actions.activities.addActivities({
            accountId,
            activities: [{ ...activity1, blockchainSpecific }],
          }).payload.activities,
        ).toStrictEqual(encoded);
        expect(encoded[0].blockchainSpecific).toStrictEqual(
          Serializable.to(blockchainSpecific),
        );
      });
    });

    describe('removeActivities', () => {
      it('removes only Pending rows when expiry requests it', () => {
        const pending = { ...activity1, type: ActivityType.Pending };
        const state = activitiesReducers.activities(
          {
            ...initialState,
            activities: { [accountId]: [pending, activity2] },
          },
          actions.activities.removeActivities({
            accountId,
            activityIds: [pending.activityId, activity2.activityId],
            onlyPending: true,
          }),
        );
        expect(state.activities[accountId]).toEqual([activity2]);
      });

      it('keeps a row confirmed after the expiry action was created, without changing references', () => {
        const expiry = actions.activities.removeActivities({
          accountId,
          activityIds: [activity1.activityId],
          onlyPending: true,
        });
        const pending = activitiesReducers.activities(
          initialState,
          actions.activities.upsertActivities({
            accountId,
            activities: [{ ...activity1, type: ActivityType.Pending }],
          }),
        );
        const confirmed = activitiesReducers.activities(
          pending,
          actions.activities.upsertActivities({
            accountId,
            activities: [activity1],
          }),
        );
        expect(activitiesReducers.activities(confirmed, expiry)).toBe(
          confirmed,
        );
      });

      it('removes the listed activities and keeps the rest', () => {
        const otherActivity = { ...activity1, activityId: 'activity3' };
        const state = activitiesReducers.activities(
          {
            ...initialState,
            activities: { [accountId]: [activity1, otherActivity] },
          },
          actions.activities.removeActivities({
            accountId,
            activityIds: ['activity1'],
          }),
        );
        expect(state.activities).toStrictEqual({
          [accountId]: [otherActivity],
        });
      });

      it('leaves state unchanged when the account has no activities', () => {
        const state = activitiesReducers.activities(
          initialState,
          actions.activities.removeActivities({
            accountId,
            activityIds: ['activity1'],
          }),
        );
        expect(state.activities).toStrictEqual({});
      });

      it('preserves the array reference when nothing matches', () => {
        const activities = [activity1];
        const initial: ActivitiesSliceState = {
          ...initialState,
          activities: { [accountId]: activities },
        };
        const state = activitiesReducers.activities(
          initial,
          actions.activities.removeActivities({
            accountId,
            activityIds: ['not-present'],
          }),
        );
        expect(state.activities[accountId]).toBe(activities);
      });

      it('does not disturb other accounts', () => {
        const otherAccountActivity = { ...activity2, accountId: account2Id };
        const state = activitiesReducers.activities(
          {
            ...initialState,
            activities: {
              [accountId]: [activity1],
              [account2Id]: [otherAccountActivity],
            },
          },
          actions.activities.removeActivities({
            accountId,
            activityIds: ['activity1'],
          }),
        );
        expect(state.activities).toStrictEqual({
          [accountId]: [],
          [account2Id]: [otherAccountActivity],
        });
      });
    });

    describe('resetActivities', () => {
      it('resets activities', () => {
        const state = activitiesReducers.activities(
          { ...initialState, activities: { [accountId]: [activity1] } },
          actions.activities.resetActivities({
            accountId,
          }),
        );
        expect(state.activities).toStrictEqual(initialState.activities);
      });
    });

    describe('setHasLoadedOldestEntry', () => {
      it('sets loading state', () => {
        const state = activitiesReducers.activities(
          initialState,
          actions.activities.setHasLoadedOldestEntry({
            accountId: accountId,
            hasLoadedOldestEntry: true,
          }),
        );
        expect(state.hasLoadedOldestEntry).toStrictEqual({
          [accountId]: true,
        });
      });
    });

    describe('clearActivities', () => {
      it('clears all activities', () => {
        const state = activitiesReducers.activities(
          { ...initialState, activities: { [accountId]: [activity1] } },
          actions.activities.clearActivities(),
        );
        expect(state.activities).toStrictEqual(initialState.activities);
      });
    });

    describe('setDesiredLoadedActivitiesCount', () => {
      it('sets desired loaded activities count for account', () => {
        const desiredCount = 15;
        const state = activitiesReducers.activities(
          initialState,
          actions.activities.setDesiredLoadedActivitiesCount({
            accountId,
            desiredLoadedActivitiesCount: desiredCount,
          }),
        );
        expect(state.desiredLoadedActivitiesCountPerAccount).toStrictEqual({
          [accountId]: desiredCount,
        });
      });
    });

    describe('incrementDesiredLoadedActivitiesCount', () => {
      it('increments desired loaded activities count', () => {
        const state = activitiesReducers.activities(
          initialState,
          actions.activities.incrementDesiredLoadedActivitiesCount({
            accountId,
          }),
        );
        expect(state.desiredLoadedActivitiesCountPerAccount).toStrictEqual({
          [accountId]: ACTIVITIES_PER_PAGE,
        });
      });

      it('increments desired loaded activities count for the same account', () => {
        const previousCount = 1;

        const state = activitiesReducers.activities(
          {
            ...initialState,
            activities: {
              // Simulate activity loaded previously
              [accountId]: [activity1],
            },
            desiredLoadedActivitiesCountPerAccount: {
              [accountId]: previousCount,
            },
          },
          actions.activities.incrementDesiredLoadedActivitiesCount({
            accountId,
          }),
        );
        expect(state.desiredLoadedActivitiesCountPerAccount).toStrictEqual({
          [accountId]: ACTIVITIES_PER_PAGE + previousCount,
        });
      });

      it('does not increment desired loaded activities while loading', () => {
        const previousCount = ACTIVITIES_PER_PAGE + 1;

        const state = activitiesReducers.activities(
          {
            ...initialState, // no activities loaded yet
            desiredLoadedActivitiesCountPerAccount: {
              [accountId]: previousCount,
            },
          },
          actions.activities.incrementDesiredLoadedActivitiesCount({
            accountId,
          }),
        );
        expect(state.desiredLoadedActivitiesCountPerAccount).toStrictEqual({
          [accountId]: previousCount,
        });
      });

      it('anchors increment on loaded count when desired has drifted behind', () => {
        // Newer-tx polling can populate `activities` before anyone has
        // incremented `desired`; anchoring on the larger of the two ensures
        // the first increment actually lifts desired above loaded and fires
        // a fetch, rather than just catching desired up to loaded.
        const state = activitiesReducers.activities(
          {
            ...initialState,
            activities: {
              [accountId]: [activity1, activity1, activity1],
            },
            desiredLoadedActivitiesCountPerAccount: {
              [accountId]: 0,
            },
          },
          actions.activities.incrementDesiredLoadedActivitiesCount({
            accountId,
          }),
        );
        expect(state.desiredLoadedActivitiesCountPerAccount).toStrictEqual({
          [accountId]: 3 + ACTIVITIES_PER_PAGE,
        });
      });

      // Immer must return the same state reference when the guard skips
      // the mutation. createStateObservables (packages/contract/module)
      // applies distinctUntilChanged to every selector, so consumers rely
      // on this identity to avoid spurious re-emissions.
      it('returns the same state reference when the guard skips the mutation', () => {
        const previousCount = ACTIVITIES_PER_PAGE + 1;
        const inputState = {
          ...initialState,
          desiredLoadedActivitiesCountPerAccount: {
            [accountId]: previousCount,
          },
        };

        const state = activitiesReducers.activities(
          inputState,
          actions.activities.incrementDesiredLoadedActivitiesCount({
            accountId,
            incrementBy: 0,
          }),
        );

        expect(state).toBe(inputState);
        expect(state.desiredLoadedActivitiesCountPerAccount).toBe(
          inputState.desiredLoadedActivitiesCountPerAccount,
        );
      });
    });

    describe('REHYDRATE extraReducer', () => {
      it('should handle REHYDRATE action with activities key and payload', () => {
        const rehydrateAction = {
          type: REHYDRATE,
          key: 'activities',
          payload: {
            activities: {
              [accountId]: [activity1, activity2],
              [account2Id]: [activity2],
            },
          },
        };

        const state = activitiesReducers.activities(
          initialState,
          rehydrateAction,
        );

        expect(state.desiredLoadedActivitiesCountPerAccount).toStrictEqual({
          [accountId]: 2,
          [account2Id]: 1,
        });
      });

      it('should set hasLoadedOldestEntry to false when activities count equals MAX_ACTIVITIES_PER_ACCOUNT', () => {
        const maxActivities = Array.from(
          { length: MAX_ACTIVITIES_PER_ACCOUNT },
          (_, index) => ({ ...activity1, activityId: `id-${index}` }),
        );
        const rehydrateAction = {
          type: REHYDRATE,
          key: 'activities',
          payload: {
            activities: {
              [accountId]: maxActivities,
            },
          },
        };

        const state = activitiesReducers.activities(
          initialState,
          rehydrateAction,
        );

        expect(state.hasLoadedOldestEntry).toStrictEqual({
          [accountId]: false,
        });
      });

      it('should not modify state when REHYDRATE action has different key', () => {
        const rehydrateAction = {
          type: REHYDRATE,
          key: 'different-key',
          payload: {
            activities: {
              [accountId]: [activity1, activity2],
            },
          },
        };

        const state = activitiesReducers.activities(
          initialState,
          rehydrateAction,
        );

        expect(state).toStrictEqual(initialState);
      });

      it('should not modify state when REHYDRATE action has no payload', () => {
        const rehydrateAction = {
          type: REHYDRATE,
          key: 'activities',
          payload: null,
        };

        const state = activitiesReducers.activities(
          initialState,
          rehydrateAction,
        );

        expect(state).toStrictEqual(initialState);
      });

      it('should handle REHYDRATE action with empty activities', () => {
        const rehydrateAction = {
          type: REHYDRATE,
          key: 'activities',
          payload: {
            activities: {},
          },
        };

        const state = activitiesReducers.activities(
          initialState,
          rehydrateAction,
        );

        expect(state.desiredLoadedActivitiesCountPerAccount).toStrictEqual({});
      });

      it('restores desiredLoadedActivitiesCountPerAccount from the payload hint instead of the (shrunken) activities length', () => {
        const rehydrateAction = {
          type: REHYDRATE,
          key: 'activities',
          payload: {
            activities: {
              [accountId]: [activity1], // 1 survives after the migration drops rewards
            },
            desiredLoadedActivitiesCountPerAccount: {
              [accountId]: 4, // pre-migration count: 1 tx + 3 dropped rewards
            },
          },
        };

        const state = activitiesReducers.activities(
          initialState,
          rehydrateAction,
        );

        expect(state.desiredLoadedActivitiesCountPerAccount).toStrictEqual({
          [accountId]: 4,
        });
      });

      it('falls back to activities length for accounts missing from the payload hint', () => {
        const rehydrateAction = {
          type: REHYDRATE,
          key: 'activities',
          payload: {
            activities: {
              [accountId]: [activity1],
              [account2Id]: [
                activity2,
                { ...activity2, activityId: 'activity2b' },
              ],
            },
            desiredLoadedActivitiesCountPerAccount: {
              [accountId]: 4,
            },
          },
        };

        const state = activitiesReducers.activities(
          initialState,
          rehydrateAction,
        );

        expect(state.desiredLoadedActivitiesCountPerAccount).toStrictEqual({
          [accountId]: 4,
          [account2Id]: 2,
        });
      });
    });

    describe('removeAccount extraReducer', () => {
      const walletId = WalletId('wallet1');
      const state = {
        ...initialState,
        activities: {
          [accountId]: [activity1],
          [account2Id]: [activity2],
        },
        desiredLoadedActivitiesCountPerAccount: {
          [accountId]: 1,
          [account2Id]: 1,
        },
        hasLoadedOldestEntry: {
          [accountId]: false,
          [account2Id]: false,
        },
      } as unknown as ActivitiesSliceState;

      it('should remove all the activities data for the account', () => {
        const newState = activitiesReducers.activities(
          state,
          walletsActions.wallets.removeAccount(walletId, accountId),
        );
        expect(newState.activities).toStrictEqual({
          [account2Id]: [activity2],
        });
        expect(newState.hasLoadedOldestEntry).toStrictEqual({
          [account2Id]: false,
        });
        expect(newState.desiredLoadedActivitiesCountPerAccount).toStrictEqual({
          [account2Id]: 1,
        });
      });
    });

    describe('removeWallet extraReducer', () => {
      const walletId = WalletId('wallet1');
      const state = {
        ...initialState,
        activities: {
          [accountId]: [activity1],
          [account2Id]: [activity2],
        },
        desiredLoadedActivitiesCountPerAccount: {
          [accountId]: 1,
          [account2Id]: 1,
        },
        hasLoadedOldestEntry: {
          [accountId]: false,
          [account2Id]: false,
        },
      } as unknown as ActivitiesSliceState;

      it('should remove activities for all accounts provided', () => {
        const newState = activitiesReducers.activities(
          state,
          walletsActions.wallets.removeWallet(walletId, [
            accountId,
            account2Id,
          ]),
        );
        expect(newState.activities).toStrictEqual({});
        expect(newState.hasLoadedOldestEntry).toStrictEqual({});
        expect(newState.desiredLoadedActivitiesCountPerAccount).toStrictEqual(
          {},
        );
      });
    });
  });

  describe('selectors', () => {
    describe('selectAllFlat', () => {
      it('returns flatten activities', () => {
        const state = {
          activities: {
            ...initialState,
            activities: {
              [accountId]: [activity1],
              [account2Id]: [activity2],
            },
          },
        };

        expect(
          activitiesSelectors.activities.selectAllFlat(state),
        ).toStrictEqual([activity1, activity2]);
      });
    });

    describe('selectByTokenIdFlat', () => {
      it('returns flatten activities for a given tokenId', () => {
        const state = {
          activities: {
            ...initialState,
            activities: {
              [accountId]: [activity1],
              [account2Id]: [activity2],
            },
          },
        };

        expect(
          activitiesSelectors.activities.selectByTokenIdFlat(state, {
            limit: 10,
            tokenId: TokenId('tDust'),
          }),
        ).toStrictEqual([activity1]);
      });

      it('returns flatten activities in maximum amount specified by limit property', () => {
        const state = {
          activities: {
            ...initialState,
            activities: {
              [accountId]: [activity1],
              [account2Id]: [activity1, activity2],
            },
          },
        };

        expect(
          activitiesSelectors.activities.selectByTokenIdFlat(state, {
            limit: 10,
            tokenId: TokenId('tDust'),
          }),
        ).toStrictEqual([activity1, activity1]);
        expect(
          activitiesSelectors.activities.selectByTokenIdFlat(state, {
            limit: 1,
            tokenId: TokenId('tDust'),
          }),
        ).toStrictEqual([activity1]);
      });
    });

    describe('selectByAccountId', () => {
      it('returns activities filtered by accountId', () => {
        const state = {
          activities: {
            ...initialState,
            activities: {
              [accountId]: [activity1],
              [account2Id]: [activity2],
            },
          },
        };

        expect(
          activitiesSelectors.activities.selectByAccountId(state, {
            accountId,
          }),
        ).toStrictEqual([activity1]);
      });

      it('returns empty array when no activities exist for the accountId', () => {
        const state = {
          activities: {
            ...initialState,
            activities: {
              [account2Id]: [activity2],
            },
          },
        };

        expect(
          activitiesSelectors.activities.selectByAccountId(state, {
            accountId,
          }),
        ).toStrictEqual([]);
      });

      it('returns multiple activities for the same accountId', () => {
        const activity3 = {
          accountId,
          activityId: 'activity3',
          timestamp: Timestamp(1746526784957),
          tokenBalanceChanges: [
            { tokenId: TokenId('tDust'), amount: BigNumber(0n) },
          ],
          type: ActivityType.Send,
        };

        const state = {
          activities: {
            ...initialState,
            activities: {
              [accountId]: [activity1, activity3],
              [account2Id]: [activity2],
            },
          },
        };

        expect(
          activitiesSelectors.activities.selectByAccountId(state, {
            accountId,
          }),
        ).toStrictEqual([activity1, activity3]);
      });
    });

    describe('selectActivityDetails', () => {
      const activityDetail: ActivityDetail = {
        ...activity1,
        address: 'addr_test1',
        fee: '0',
      };

      it('returns the deserialized activity details', () => {
        const state = {
          activities: {
            ...initialState,
            activityDetails: Serializable.to<ActivityDetail>(activityDetail),
          },
        };

        expect(
          activitiesSelectors.activities.selectActivityDetails(state),
        ).toStrictEqual(activityDetail);
      });

      it('returns undefined when no activity details are set', () => {
        const state = { activities: initialState };

        expect(
          activitiesSelectors.activities.selectActivityDetails(state),
        ).toBeUndefined();
      });

      it('returns the same reference across calls when the serialized payload is unchanged', () => {
        const state = {
          activities: {
            ...initialState,
            activityDetails: Serializable.to<ActivityDetail>(activityDetail),
          },
        };

        const first =
          activitiesSelectors.activities.selectActivityDetails(state);
        const second =
          activitiesSelectors.activities.selectActivityDetails(state);

        expect(second).toBe(first);
      });

      it('returns a new reference when the serialized payload changes', () => {
        const stateA = {
          activities: {
            ...initialState,
            activityDetails: Serializable.to<ActivityDetail>(activityDetail),
          },
        };
        const stateB = {
          activities: {
            ...initialState,
            activityDetails: Serializable.to<ActivityDetail>({
              ...activityDetail,
              fee: '1',
            }),
          },
        };

        const first =
          activitiesSelectors.activities.selectActivityDetails(stateA);
        const second =
          activitiesSelectors.activities.selectActivityDetails(stateB);

        expect(second).not.toBe(first);
        expect(second).toStrictEqual({ ...activityDetail, fee: '1' });
      });
    });
  });

  describe('selectHasLoadedOldestEntry', () => {
    it('returns loading state', () => {
      const state = {
        activities: {
          ...initialState,
          hasLoadedOldestEntry: {
            [accountId]: true,
          },
        },
      };
      expect(
        activitiesSelectors.activities.selectHasLoadedOldestEntry(state),
      ).toStrictEqual({ [accountId]: true });
    });
  });

  describe('selectHasLoadedOldestEntryByAccount', () => {
    it('returns loading state for a specific account', () => {
      const state = {
        activities: {
          ...initialState,
          hasLoadedOldestEntry: {
            [accountId]: true,
            [account2Id]: false,
          },
        },
      };
      expect(
        activitiesSelectors.activities.selectHasLoadedOldestEntryByAccount(
          state,
          accountId,
        ),
      ).toBe(true);
      expect(
        activitiesSelectors.activities.selectHasLoadedOldestEntryByAccount(
          state,
          account2Id,
        ),
      ).toBe(false);
    });
  });

  describe('selectIsLoadingOlderActivities', () => {
    it('returns loading state for a specific account', () => {
      const state = {
        activities: {
          ...initialState,
          activities: {
            [accountId]: [activity1, activity1, activity1],
            [account2Id]: [
              activity2,
              activity2,
              activity2,
              activity2,
              activity2,
            ],
          },
          desiredLoadedActivitiesCountPerAccount: {
            [accountId]: 4,
            [account2Id]: 5,
          },
        },
        failures: { byId: {} },
      };
      expect(
        activitiesSelectors.activities.selectIsLoadingOlderActivitiesByAccount(
          state,
          accountId,
        ),
      ).toBe(true);
      expect(
        activitiesSelectors.activities.selectIsLoadingOlderActivitiesByAccount(
          state,
          account2Id,
        ),
      ).toBe(false);
    });

    it('returns false when the oldest entry has been loaded even if desired count exceeds stored activities', () => {
      const state = {
        activities: {
          ...initialState,
          activities: {
            [accountId]: [activity1, activity1, activity1],
          },
          desiredLoadedActivitiesCountPerAccount: {
            [accountId]: 20,
          },
          hasLoadedOldestEntry: {
            [accountId]: true,
          },
        },
        failures: { byId: {} },
      };
      expect(
        activitiesSelectors.activities.selectIsLoadingOlderActivitiesByAccount(
          state,
          accountId,
        ),
      ).toBe(false);
    });

    it('returns false when a pagination failure exists for the account even if desired count exceeds stored activities', () => {
      const failureId = ActivitiesPaginationFailureId(accountId);
      const failure: Failure = {
        failureId,
        message: 'sync.error.midnight-wallet-start-failed',
      };
      const state = {
        activities: {
          ...initialState,
          activities: {
            [accountId]: [activity1],
          },
          desiredLoadedActivitiesCountPerAccount: {
            [accountId]: 10,
          },
        },
        failures: {
          byId: { [failureId]: failure },
        },
      };
      expect(
        activitiesSelectors.activities.selectIsLoadingOlderActivitiesByAccount(
          state,
          accountId,
        ),
      ).toBe(false);
    });

    it('returns true when no pagination failure exists for the account and desired count exceeds stored activities', () => {
      const otherFailureId = ActivitiesPaginationFailureId(account2Id);
      const failure: Failure = {
        failureId: otherFailureId,
        message: 'sync.error.midnight-wallet-start-failed',
      };
      const state = {
        activities: {
          ...initialState,
          activities: {
            [accountId]: [activity1],
          },
          desiredLoadedActivitiesCountPerAccount: {
            [accountId]: 10,
          },
        },
        failures: {
          byId: { [otherFailureId]: failure },
        },
      };
      expect(
        activitiesSelectors.activities.selectIsLoadingOlderActivitiesByAccount(
          state,
          accountId,
        ),
      ).toBe(true);
    });
  });

  describe('selectPendingActivitiesByAccount', () => {
    const pendingActivity = (id: string, acct: AccountId) => ({
      accountId: acct,
      activityId: id,
      timestamp: Timestamp(1_000_000_000),
      tokenBalanceChanges: [],
      type: ActivityType.Pending,
    });

    const confirmedActivity = (id: string, acct: AccountId) => ({
      accountId: acct,
      activityId: id,
      timestamp: Timestamp(1_000_000_000),
      tokenBalanceChanges: [],
      type: ActivityType.Send,
    });

    const wrapState = (activities: ActivitiesSliceState['activities']) => ({
      activities: {
        ...initialState,
        activities,
      },
    });

    it('returns only pending activities grouped by account', () => {
      const state = wrapState({
        [accountId]: [
          pendingActivity('tx1', accountId),
          confirmedActivity('tx2', accountId),
          pendingActivity('tx3', accountId),
        ],
        [account2Id]: [confirmedActivity('tx4', account2Id)],
      });

      expect(
        activitiesSelectors.activities.selectPendingActivitiesByAccount(state),
      ).toEqual({
        [accountId]: [
          pendingActivity('tx1', accountId),
          pendingActivity('tx3', accountId),
        ],
      });
    });

    it('omits accounts with no pending activities', () => {
      const state = wrapState({
        [accountId]: [confirmedActivity('tx1', accountId)],
      });

      expect(
        activitiesSelectors.activities.selectPendingActivitiesByAccount(state),
      ).toEqual({});
    });

    it('memoizes output when the slice reference is unchanged', () => {
      const state = wrapState({
        [accountId]: [pendingActivity('tx1', accountId)],
      });

      const first =
        activitiesSelectors.activities.selectPendingActivitiesByAccount(state);
      const second =
        activitiesSelectors.activities.selectPendingActivitiesByAccount(state);
      expect(first).toBe(second);
    });
  });
});
