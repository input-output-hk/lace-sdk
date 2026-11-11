import { registerMidnightBlockchainNetworks } from '@lace-contract/midnight-context';
import { of, throwError } from 'rxjs';

import {
  createMidnightEngineClient,
  registerMidnightEngineClient,
} from '../worker/engine-client';

import { createMidnightRegistryDependencies } from './registry-dependencies';
import {
  assertDefaultTestnetConfigured,
  createSdkMiddleware,
} from './sdk-options';
import { createInitializeSideEffects } from './side-effects/initialize';
import { createApplyNetworkConfigOverrides } from './side-effects/network-config';
import {
  createWorkerClearWalletStateOnResync,
  createWorkerDeleteWalletSideEffect,
  createWorkerResetSyncStateSideEffect,
  showMidnightEngineResets,
} from './side-effects/resync';
import { surfaceMidnightEngineFailures } from './side-effects/sync-failure';
import { createWatchMidnightAccount } from './side-effects/watch';

import type { CreateAccountKeyManager } from './account-keys';
import type {
  MidnightSyncSdkOptions,
  MidnightSyncWorkerOptions,
} from './sdk-options';
import type { LaceInit, LaceModuleStoreInit } from '@lace-contract/module';

// Worker mode's store init: the worker runs the engines, so nothing here may import the engine or the key derivation.

/**
 * The key manager of a Worker-mode page: it holds no keys, since the worker decrypts them from the password it
 * is sent. The engine client ignores it, so only a consumer that needs ledger keys on this page reaches the error.
 */
const noKeysOnThisPage: CreateAccountKeyManager = account => () => ({
  keyManager: {
    keys$: throwError(
      () =>
        new Error(
          `The keys of Midnight account "${account.accountId}" are decrypted in the worker that runs its engine, not on this page`,
        ),
    ),
    areKeysAvailable$: of(false),
    destroy: () => undefined,
  },
  destroyAccountKeyManager: () => undefined,
});

/**
 * The store init of a headless loadout whose engines run in the worker: the page side of Worker mode. Checkpoints
 * live in the worker, so every side effect that would wipe them on this page goes to the worker, and the account
 * watcher starts each engine through the worker's client.
 */
export const createWorkerSdkStoreInit = ({
  auth,
  batchUpdates,
  createAttestedProver,
  networks = {},
  supportedNetworkIds,
  defaultProofServers,
  worker,
}: MidnightSyncSdkOptions & {
  worker: MidnightSyncWorkerOptions;
}): LaceInit<LaceModuleStoreInit> => {
  const watchAccount = createWatchMidnightAccount(noKeysOnThisPage);
  const middleware = createSdkMiddleware({
    supportedNetworkIds,
    defaultProofServers,
  });
  return (props, dependencies) => {
    assertDefaultTestnetConfigured(props.runtime.config);
    const client = createMidnightEngineClient({
      ...worker,
      accessAuthSecret: auth.accessAuthSecret,
      attestedProver: !!createAttestedProver,
      batchUpdates,
      logger: dependencies.logger,
    });
    registerMidnightEngineClient(props.runtime, client);
    return {
      middleware,
      sideEffects: createInitializeSideEffects(
        () => [
          registerMidnightBlockchainNetworks,
          createApplyNetworkConfigOverrides(networks),
          createWorkerResetSyncStateSideEffect(client),
          showMidnightEngineResets(client),
          surfaceMidnightEngineFailures(client),
        ],
        watchAccount,
        () => [
          createWorkerDeleteWalletSideEffect(client),
          createWorkerClearWalletStateOnResync(client),
        ],
      )(props, dependencies),
      sideEffectDependencies: {
        ...createMidnightRegistryDependencies(props.runtime),
        startMidnightAccountWallet: client.startAccountEngine,
        ...auth,
      },
    };
  };
};
