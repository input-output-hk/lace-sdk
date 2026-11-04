import type { AddressesSliceState } from '../slice';
import type { PersistedState } from '@lace-contract/module';
import type { PersistedState as ReduxPersistedState } from 'redux-persist';

/** Retag addresses for the Preview repair targets. */
export const fixPreviewAddressNetwork = (
  state: ReduxPersistedState,
  misroutedAccountIds: ReadonlySet<string>,
) => {
  const typedState = state as PersistedState<AddressesSliceState>;
  for (const address of typedState.addresses ?? []) {
    if (
      address.blockchainName !== 'Cardano' ||
      !misroutedAccountIds.has(address.accountId)
    ) {
      continue;
    }
    const data = address.data as { networkMagic?: number } | undefined;
    if (data?.networkMagic === 1) data.networkMagic = 2;
  }
  return typedState;
};
