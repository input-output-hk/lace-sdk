import { isMisroutedPreviewAccount } from './misrouted-preview-accounts';

import type { WalletsState } from '../store';
import type { PersistedState } from '@lace-contract/module';
import type { PersistedState as ReduxPersistedState } from 'redux-persist';

/** Repair Preview accounts created by the V1 migration with a Preprod chain ID. */
export const fixPreviewChainId = (state: ReduxPersistedState) => {
  const typedState = state as PersistedState<WalletsState['wallets']>;
  if (!typedState.entities) return typedState;

  for (const wallet of Object.values(typedState.entities)) {
    for (const account of wallet.accounts) {
      if (!isMisroutedPreviewAccount(account)) continue;
      const specific = account.blockchainSpecific as {
        chainId?: { networkId: number; networkMagic: number };
      };
      specific.chainId = { ...specific.chainId, networkId: 0, networkMagic: 2 };
    }
  }
  return typedState;
};
