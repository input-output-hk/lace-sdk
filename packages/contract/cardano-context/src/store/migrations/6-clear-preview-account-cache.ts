import type { CardanoContextSliceState } from '../slice';
import type { PersistedState } from '@lace-contract/module';
import type { PersistedState as ReduxPersistedState } from 'redux-persist';

/** Discard cached data for the Preview repair targets. */
export const clearPreviewAccountCache = (
  state: ReduxPersistedState,
  misroutedAccountIds: ReadonlySet<string>,
) => {
  const typedState = state as PersistedState<CardanoContextSliceState>;
  for (const cache of [
    typedState.accountTransactionHistory,
    typedState.accountRewardsHistory,
    typedState.accountUtxos,
    typedState.securityScanByAccount,
    typedState.securityRescanDismissedByAccount,
  ]) {
    if (!cache) continue;
    for (const accountId of Object.keys(cache)) {
      if (misroutedAccountIds.has(accountId)) {
        delete cache[accountId as keyof typeof cache];
      }
    }
  }
  return typedState;
};
