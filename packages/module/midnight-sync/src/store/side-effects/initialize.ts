import { merge } from 'rxjs';

import { MIDNIGHT_CHECKPOINT_COLLECTION } from '../checkpoint-collection';

import { loadActivityDetails, updateActivities } from './activities';
import {
  createClearWalletStateOnResync,
  createDeleteWalletSideEffect,
  requestResyncWallet,
} from './resync';
import {
  autoDismissMidnightSyncFailureOnResume,
  autoDismissMidnightSyncFailureOnSyncSuccess,
} from './sync-failure';
import { watchMidnightAccounts } from './watch';

import type { WatchMidnightAccount } from './watch';
import type { SideEffect } from '../../context';
import type { SerializedMidnightWallet } from '@lace-contract/midnight-context';
import type { LaceInitSync } from '@lace-contract/module';
import type { CollectionStorage } from '@lace-contract/storage';

// The composition only: the account watcher and the loadout's side effects come from the caller.

export type StorageSideEffects = (
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
 * `watchAccount` watches one account with the key manager the loadout
 * builds. `storageSideEffects` replaces the engine's wallet deletion and
 * bulk resync when the engine keeps its checkpoints elsewhere.
 */
export const createInitializeSideEffects =
  (
    loadoutSideEffects: StorageSideEffects,
    watchAccount: WatchMidnightAccount,
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
            watchMidnightAccounts(midnightStateStorage, watchAccount),
            ...loadoutSideEffects(midnightStateStorage),
          ].map(sideEffect =>
            sideEffect(actionObservables, stateObservables, dependencies),
          ),
        );
      },
    ];
