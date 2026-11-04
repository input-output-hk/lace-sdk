import { merge } from 'rxjs';

import { MIDNIGHT_CHECKPOINT_COLLECTION } from '../checkpoint-collection';

import { loadActivityDetails, updateActivities } from './activities';
import { watchProofActivities, dismissProofActivity } from './proof-activities';
import { migrateUnavailableProofServerSelection } from './proof-server-kill-switch';
import {
  createClearWalletStateOnResync,
  createDeleteWalletSideEffect,
  createResetSyncStateSideEffect,
  requestResyncWallet,
  resyncWalletOnConfigChangeFromFeatureFlags,
} from './resync';
import {
  autoDismissMidnightSyncFailureOnResume,
  autoDismissMidnightSyncFailureOnSyncSuccess,
} from './sync-failure';
import {
  clearTeeAttestationProgressOnNewTx,
  watchTeeAttestationProgress,
} from './tee-attestation-progress';
import { watchMidnightAccount, watchMidnightAccounts } from './watch';

import type { SideEffect } from '../../context';
import type { SerializedMidnightWallet } from '@lace-contract/midnight-context';
import type { LaceInitSync } from '@lace-contract/module';
import type { CollectionStorage } from '@lace-contract/storage';

type StorageSideEffects = (
  storage: CollectionStorage<SerializedMidnightWallet>,
) => SideEffect[];

// Where the engine keeps its checkpoints, wallet deletion and bulk resync wipe them: this page's storage unless the
// engine runs in a worker.
const pageStorageSideEffects: StorageSideEffects = storage => [
  createDeleteWalletSideEffect(storage),
  createClearWalletStateOnResync(storage),
];

/**
 * The engine's side effects plus the ones a loadout adds over the same
 * persisted wallet-state storage. The engine set reads only the contracts
 * the engine itself depends on; a loadout decides what else it can run.
 * `storageSideEffects` replaces the engine's wallet deletion and bulk resync
 * when the engine keeps its checkpoints elsewhere.
 */
export const createInitializeSideEffects =
  (
    loadoutSideEffects: StorageSideEffects,
    storageSideEffects: StorageSideEffects = pageStorageSideEffects,
  ): LaceInitSync<SideEffect[]> =>
  () =>
    [
      (actionObservables, stateObservables, dependencies) => {
        const midnightStateStorage =
          dependencies.createCollectionStorage<SerializedMidnightWallet>(
            MIDNIGHT_CHECKPOINT_COLLECTION,
          );

        return merge(
          ...[
            updateActivities,
            loadActivityDetails,
            ...storageSideEffects(midnightStateStorage),
            requestResyncWallet,
            autoDismissMidnightSyncFailureOnResume,
            autoDismissMidnightSyncFailureOnSyncSuccess,
            watchMidnightAccounts(midnightStateStorage, watchMidnightAccount),
            ...loadoutSideEffects(midnightStateStorage),
          ].map(sideEffect =>
            sideEffect(actionObservables, stateObservables, dependencies),
          ),
        );
      },
    ];

// The extension's reset-sync-state reloads the application; its feature-flag resync waits
// for the app lock, the proof-server migration toasts, and attestation
// progress feeds the send-flow checklist, so all of them need the app shell.
export const initializeSideEffects = createInitializeSideEffects(storage => [
  createResetSyncStateSideEffect(storage),
  resyncWalletOnConfigChangeFromFeatureFlags,
  migrateUnavailableProofServerSelection,
  watchProofActivities,
  dismissProofActivity,
  watchTeeAttestationProgress,
  clearTeeAttestationProgressOnNewTx,
]);
