import { createAccountKeyManager } from '../account-keys';

import { createInitializeSideEffects } from './initialize';
import { watchProofActivities, dismissProofActivity } from './proof-activities';
import { migrateUnavailableProofServerSelection } from './proof-server-kill-switch';
import {
  createResetSyncStateSideEffect,
  resyncWalletOnConfigChangeFromFeatureFlags,
} from './resync';
import {
  clearTeeAttestationProgressOnNewTx,
  watchTeeAttestationProgress,
} from './tee-attestation-progress';
import { createWatchMidnightAccount } from './watch';

// The extension's composition. It runs the engine in this JavaScript context, so its account watcher decrypts the
// keys here, with static imports throughout (ADR 25). The extension's reset-sync-state reloads the application;
// its feature-flag resync waits for the app lock, the proof-server migration toasts, and attestation progress feeds
// the send-flow checklist, so all of them need the app shell.
export const initializeSideEffects = createInitializeSideEffects(
  storage => [
    createResetSyncStateSideEffect(storage),
    resyncWalletOnConfigChangeFromFeatureFlags,
    migrateUnavailableProofServerSelection,
    watchProofActivities,
    dismissProofActivity,
    watchTeeAttestationProgress,
    clearTeeAttestationProgressOnNewTx,
  ],
  createWatchMidnightAccount(createAccountKeyManager),
);
