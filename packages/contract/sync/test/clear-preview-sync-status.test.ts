import { describe, expect, it } from 'vitest';

import { clearPreviewSyncStatus } from '../src/store/migrations/2-clear-preview-sync-status';

describe('clearPreviewSyncStatus', () => {
  it('requires a fresh Preview sync and keeps Preprod status', () => {
    const syncStatusByAccount = {
      'wallet-0-2': { lastSuccessfulSync: 1 },
      'other-wallet-0-2': { lastSuccessfulSync: 1 },
      'wallet-0-1': { lastSuccessfulSync: 1 },
    };
    const state = { syncStatusByAccount } as unknown as Parameters<
      typeof clearPreviewSyncStatus
    >[0];

    const migrated = clearPreviewSyncStatus(state, new Set(['wallet-0-2']));

    expect(migrated.syncStatusByAccount).not.toHaveProperty('wallet-0-2');
    expect(migrated.syncStatusByAccount).toHaveProperty('wallet-0-1');
    expect(migrated.syncStatusByAccount).toHaveProperty('other-wallet-0-2');
    expect(syncStatusByAccount).toHaveProperty('wallet-0-2');
  });
});
