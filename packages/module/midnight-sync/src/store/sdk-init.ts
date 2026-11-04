import {
  MidnightSDKTestNetworkId,
  registerMidnightBlockchainNetworks,
} from '@lace-contract/midnight-context';

import {
  createMidnightEngineClient,
  registerMidnightEngineClient,
} from '../worker/engine-client';

import { createMidnightSideEffectDependencies } from './dependencies';
import { createInitializeSideEffects } from './side-effects';
import {
  createApplyNetworkConfigOverrides,
  createApplyNetworkDefaultsMiddleware,
} from './side-effects/network-config';
import {
  createHeadlessResetSyncStateSideEffect,
  createWorkerClearWalletStateOnResync,
  createWorkerDeleteWalletSideEffect,
  createWorkerResetSyncStateSideEffect,
  showMidnightEngineResets,
} from './side-effects/resync';
import { surfaceMidnightEngineFailures } from './side-effects/watch';

import type { MidnightEngineOptions } from './dependencies';
import type { MidnightNetworkStartupConfig } from './side-effects/network-config';
import type { ConnectMidnightEngine } from '../worker/engine-client';
import type { MidnightWorkerStorageKind } from '../worker/protocol';
import type {
  AccessAuthSecret,
  Authenticate,
} from '@lace-contract/authentication-prompt';
import type {
  AppConfig,
  LaceInit,
  LaceModuleStoreInit,
} from '@lace-contract/module';

/**
 * What the engine needs to decrypt account keys. The app shell serves these
 * from the authentication prompt; a headless loadout serves them itself.
 */
export type MidnightSyncAuth = {
  accessAuthSecret: AccessAuthSecret;
  authenticate: Authenticate;
};

/** Runs every account's engine in a worker shared by the app's pages instead of on this page. */
export type MidnightSyncWorkerOptions = {
  /** Opens a connection to the worker's engine host. */
  connect: ConnectMidnightEngine;
  /** Where the worker keeps the engines' checkpoints. */
  storage: MidnightWorkerStorageKind;
  /** Attach to an engine already running with other settings, adopting them, instead of failing. */
  adopt?: boolean;
};

export type MidnightSyncSdkOptions = MidnightNetworkStartupConfig &
  Pick<MidnightEngineOptions, 'batchUpdates' | 'createAttestedProver'> & {
    auth: MidnightSyncAuth;
    /** Absent: the engine runs on this page. */
    worker?: MidnightSyncWorkerOptions;
  };

// The contract starts the wallet on this testnet and reads it without a
// fallback, so a headless loadout without it would sync a network named
// "undefined". The application shells always set it.
const assertDefaultTestnetConfigured = (
  config: Partial<AppConfig> | undefined,
) => {
  const networkId = config?.defaultMidnightTestnetNetworkId;
  if (!networkId || !MidnightSDKTestNetworkId.includes(networkId))
    throw new Error(
      `createLaceWallet needs config.defaultMidnightTestnetNetworkId, the Midnight testnet a wallet starts on: one of ${MidnightSDKTestNetworkId.join(
        ', ',
      )}; got ${String(networkId)}`,
    );
};

export const createSdkStoreInit = ({
  auth,
  batchUpdates,
  createAttestedProver,
  networks = {},
  supportedNetworkIds,
  defaultProofServers,
  worker,
}: MidnightSyncSdkOptions): LaceInit<LaceModuleStoreInit> => {
  const initializePageSideEffects = createInitializeSideEffects(storage => [
    registerMidnightBlockchainNetworks,
    createApplyNetworkConfigOverrides(networks),
    createHeadlessResetSyncStateSideEffect(storage),
  ]);
  const initializeDependencies = createMidnightSideEffectDependencies({
    batchUpdates,
    createAttestedProver,
  });
  return (props, dependencies) => {
    assertDefaultTestnetConfigured(props.runtime.config);
    const pageDependencies = initializeDependencies(props, dependencies);
    const middleware = [
      createApplyNetworkDefaultsMiddleware({
        supportedNetworkIds,
        defaultProofServers,
      }),
    ];
    if (!worker)
      return {
        middleware,
        sideEffects: initializePageSideEffects(props, dependencies),
        sideEffectDependencies: { ...pageDependencies, ...auth },
      };
    // Checkpoints live in the worker, so every side effect that would wipe them on this page goes to the worker.
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
        () => [
          createWorkerDeleteWalletSideEffect(client),
          createWorkerClearWalletStateOnResync(client),
        ],
      )(props, dependencies),
      sideEffectDependencies: {
        ...pageDependencies,
        startMidnightAccountWallet: client.startAccountEngine,
        ...auth,
      },
    };
  };
};
