import { registerMidnightBlockchainNetworks } from '@lace-contract/midnight-context';

import { createAccountKeyManager } from './account-keys';
import { createMidnightSideEffectDependencies } from './dependencies';
import {
  assertDefaultTestnetConfigured,
  createSdkMiddleware,
} from './sdk-options';
import { createInitializeSideEffects } from './side-effects/initialize';
import { createApplyNetworkConfigOverrides } from './side-effects/network-config';
import { createHeadlessResetSyncStateSideEffect } from './side-effects/resync';
import { createWatchMidnightAccount } from './side-effects/watch';

import type { MidnightSyncSdkOptions } from './sdk-options';
import type { LaceInit, LaceModuleStoreInit } from '@lace-contract/module';

// Page mode's store init: the engine runs in this JavaScript context, so this module imports it.

/**
 * The store init of a headless loadout whose engines run on this page: the engine's side effects and dependencies
 * with the loadout's auth, and the account watcher that decrypts the keys here.
 */
export const createSdkStoreInit = ({
  auth,
  batchUpdates,
  createAttestedProver,
  networks = {},
  supportedNetworkIds,
  defaultProofServers,
}: Omit<MidnightSyncSdkOptions, 'worker'>): LaceInit<LaceModuleStoreInit> => {
  const initializeSideEffects = createInitializeSideEffects(
    storage => [
      registerMidnightBlockchainNetworks,
      createApplyNetworkConfigOverrides(networks),
      createHeadlessResetSyncStateSideEffect(storage),
    ],
    createWatchMidnightAccount(createAccountKeyManager),
  );
  const initializeDependencies = createMidnightSideEffectDependencies({
    batchUpdates,
    createAttestedProver,
  });
  const middleware = createSdkMiddleware({
    supportedNetworkIds,
    defaultProofServers,
  });
  return (props, dependencies) => {
    assertDefaultTestnetConfigured(props.runtime.config);
    return {
      middleware,
      sideEffects: initializeSideEffects(props, dependencies),
      sideEffectDependencies: {
        ...initializeDependencies(props, dependencies),
        ...auth,
      },
    };
  };
};
