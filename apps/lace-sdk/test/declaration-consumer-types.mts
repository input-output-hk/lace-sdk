import { createLaceWallet, m } from '@laceio/sdk/cardano';

const wallet = await createLaceWallet({
  modules: [m.featureDev, m.storageInMemory, m.blockchainCardano] as const,
  environment: 'development',
  config: {},
});

export const networks =
  wallet.stateObservables.network.selectBlockchainNetworks$;
export const failures = wallet.getState().failures;
