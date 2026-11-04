import type { SyncSliceState } from '../../types';
import type { PersistedState } from '@lace-contract/module';
import type { PersistedState as ReduxPersistedState } from 'redux-persist';

/** Require a fresh sync for the Preview repair targets. */
export const clearPreviewSyncStatus = (
  state: ReduxPersistedState,
  misroutedAccountIds: ReadonlySet<string>,
) => {
  const typedState = state as PersistedState<SyncSliceState>;
  const statuses = typedState.syncStatusByAccount;
  if (!statuses) return typedState;
  const syncStatusByAccount = { ...statuses };
  for (const accountId of Object.keys(statuses)) {
    if (misroutedAccountIds.has(accountId)) {
      delete syncStatusByAccount[accountId as keyof typeof syncStatusByAccount];
    }
  }
  return { ...typedState, syncStatusByAccount };
};
