// Headless loadouts supply their own auth secret and network registration.
// They cannot satisfy the app module's shell, prompt and transaction-flow contracts.
import { activitiesStoreContract } from '@lace-contract/activities';
import { addressesStoreContract } from '@lace-contract/addresses';
import { failuresStoreContract } from '@lace-contract/failures';
import { featureStoreContract } from '@lace-contract/feature';
import { inMemoryIntegrationAddonContract } from '@lace-contract/in-memory';
import {
  midnightContextStoreContract,
  midnightDependencyContract,
  midnightEngineAddonContract,
} from '@lace-contract/midnight-context';
import {
  combineContracts,
  inferModuleContext,
  inferStoreContext,
  ModuleName,
} from '@lace-contract/module';
import { networkStoreContract } from '@lace-contract/network';
import { signerFactoryAddonContract } from '@lace-contract/signer';
import { syncStoreContract } from '@lace-contract/sync';
import { tokensStoreContract } from '@lace-contract/tokens';
import { walletActiveStateDependencyContract } from '@lace-contract/wallet-active-state';
import { walletRepoStoreContract } from '@lace-contract/wallet-repo';

import { FEATURE_FLAG_MIDNIGHT } from './const';
import { midnightSyncActions } from './store/actions';

import type { MidnightSyncSdkOptions } from './store/sdk-init';

export {
  FEATURE_FLAG_MIDNIGHT,
  FEATURE_FLAG_MIDNIGHT_UNSHIELDED,
} from './const';
export type {
  CreateAttestedProver,
  MidnightSyncBatchUpdates,
} from './store/dependencies';
export type {
  MidnightSyncAuth,
  MidnightSyncSdkOptions,
  MidnightSyncWorkerOptions,
} from './store/sdk-init';
export type { MidnightNetworkConfigOverrides } from './store/side-effects/network-config';

export const createMidnightSyncModule = (options: MidnightSyncSdkOptions) =>
  inferModuleContext({
    moduleName: ModuleName('midnight-sync'),
    implements: combineContracts([
      inMemoryIntegrationAddonContract,
      tokensStoreContract,
      syncStoreContract,
      addressesStoreContract,
      midnightContextStoreContract,
      midnightDependencyContract,
      midnightEngineAddonContract,
      signerFactoryAddonContract,
    ] as const),
    dependsOn: combineContracts([
      activitiesStoreContract,
      failuresStoreContract,
      featureStoreContract,
      networkStoreContract,
      walletActiveStateDependencyContract,
      walletRepoStoreContract,
    ] as const),
    feature: {
      willLoad: featureFlags =>
        featureFlags.some(flag => flag.key === FEATURE_FLAG_MIDNIGHT),
      metadata: {
        name: 'MidnightSync',
        description: 'Midnight engine, wallet lifecycle and signer',
      },
    },
    store: inferStoreContext({
      load: async () => {
        const { createSdkStoreInit } = await import('./store/sdk-init');
        return { default: createSdkStoreInit(options) };
      },
      context: { actions: midnightSyncActions, selectors: {} },
    }),
    addons: {
      loadSignerFactory: async () =>
        import('./exported-modules/signer-factory'),
      loadMidnightEngine: async () =>
        import('./exported-modules/midnight-engine'),
      loadInMemoryWalletIntegration: async () =>
        import('./exported-modules/in-memory-wallet-integration').then(
          module => ({ default: module.inMemoryWalletIntegrationReactNative }),
        ),
    },
  });

export { createTemenosAttestedProver } from '@lace-lib/vendor/temenos-attested-prover';
export type {
  TemenosTrustRoots,
  TemenosVerifier,
} from '@lace-lib/vendor/temenos-attested-prover';
export type {
  AttestedProverProvider,
  AttestedProvingSession,
} from './store/attested-proving-service';
export {
  createProvingProviderFromTransport,
  createProvingProviderFromCircuits,
} from './store/proof-server-transport';
export { MIDNIGHT_CHECKPOINT_COLLECTION } from './store/checkpoint-collection';
export { dustBalancesOf, midnightStateOf$ } from './worker/state-accessors';
export { strictCompletionOf } from './worker/state-accessors';
export type {
  OpaqueMidnightFinalizedTx,
  OpaqueMidnightRecipe,
} from './worker/codec';
export {
  createMidnightEngineHost,
  MIDNIGHT_ENGINE_START_BOUND_MS,
} from './worker/engine-host';
export {
  acrossMidnightEngineResets,
  MidnightEngineClientError,
  remoteEngineClientOf,
} from './worker/engine-client';
export type {
  ConnectMidnightEngine,
  MidnightEngineConnection,
  MidnightEngineRuntimeStatus,
  MidnightPendingRow,
  MidnightRemoteEngineClient,
} from './worker/engine-client';
export {
  buildConnectorTransaction,
  buildTransaction,
  discardRecipe,
  estimateFee,
  preparePendingActivity,
  proveRecipe,
  signRecipe,
  submitTransaction,
} from './worker/engine-operations';
export {
  checkCircuitThroughPort,
  proveCircuitThroughPort,
} from './worker/prover-port';
export { MidnightWorkerError } from './worker/protocol';
export type {
  MidnightConnectorRequest,
  MidnightEngineHost,
  MidnightSessionStreams,
  MidnightWorkerStorageKind,
  MidnightWorkerTxRequest,
} from './worker/protocol';
