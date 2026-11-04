import type { ActivitiesSliceState } from '../slice';
import type { PersistedState } from '@lace-contract/module';
import type { PersistedState as ReduxPersistedState } from 'redux-persist';

/** Discard activity for the Preview repair targets. */
export const clearPreviewActivities = (
  state: ReduxPersistedState,
  misroutedAccountIds: ReadonlySet<string>,
) => {
  const typedState = state as PersistedState<ActivitiesSliceState>;
  if (!typedState.activities) return typedState;
  const activities = { ...typedState.activities };
  for (const accountId of Object.keys(activities)) {
    if (misroutedAccountIds.has(accountId)) {
      delete activities[accountId as keyof typeof activities];
    }
  }
  return { ...typedState, activities };
};
