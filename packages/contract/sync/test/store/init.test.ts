import { AccountId } from '@lace-contract/wallet-repo';
import { Timestamp } from '@lace-lib/util';
import { describe, expect, it, vi } from 'vitest';

import store from '../../src/store/init';
import { syncActions, syncReducers } from '../../src/store/slice';

import type { SyncOperation, SyncSliceState } from '../../src/types';

describe('sync mode persistence', () => {
  it.each([true, false, undefined])(
    'restores the last known mode (%s) without restoring in-flight progress',
    async usesFastSync => {
      const initialized = await store(
        {} as never,
        {
          reduxPersistStorage: { getItem: vi.fn().mockResolvedValue(null) },
        } as never,
      );
      const transform = initialized.persistConfig?.sync?.transforms?.[0];
      if (!transform) throw new Error('Missing sync persistence transform');
      const accountId = AccountId('restored-account');
      const operation: SyncOperation = {
        operationId: 'midnight-sync',
        description: 'sync.operation.midnight-wallet-sync',
        startedAt: Timestamp(10),
        status: 'InProgress',
        type: 'Indeterminate',
      };
      const before: SyncSliceState = {
        syncStatusByAccount: {
          [accountId]: {
            lastSuccessfulSync: Timestamp(5),
            usesFastSync,
            pendingSync: {
              startedAt: Timestamp(10),
              operations: { 'midnight-sync': operation },
            },
          },
        },
      };
      const serialized = JSON.stringify(
        transform.in(before.syncStatusByAccount, 'syncStatusByAccount', {
          ...before,
          _persist: { version: 2, rehydrated: true },
        }),
      );
      const restored: SyncSliceState = {
        syncStatusByAccount: transform.out(
          JSON.parse(serialized),
          'syncStatusByAccount',
          {},
        ) as SyncSliceState['syncStatusByAccount'],
      };
      expect(restored.syncStatusByAccount[accountId]).toEqual({
        lastSuccessfulSync: 5,
        ...(usesFastSync === undefined ? {} : { usesFastSync }),
      });

      const preparing = syncReducers.sync(
        restored,
        syncActions.sync.addSyncOperation({ accountId, operation }),
      );
      const unknown = syncReducers.sync(
        preparing,
        syncActions.sync.applySyncOperationSnapshot({
          accountId,
          operation,
          usesFastSync: undefined,
        }),
      );
      expect(unknown.syncStatusByAccount[accountId].usesFastSync).toBe(
        usesFastSync,
      );
      expect(
        unknown.syncStatusByAccount[accountId].pendingSync?.operations[
          'midnight-sync'
        ].status,
      ).toBe('InProgress');
      const confirmed = syncReducers.sync(
        unknown,
        syncActions.sync.applySyncOperationSnapshot({
          accountId,
          operation,
          usesFastSync: false,
        }),
      );
      expect(confirmed.syncStatusByAccount[accountId].usesFastSync).toBe(false);
      const reset = syncReducers.sync(
        confirmed,
        syncActions.sync.resetAccountSyncStatus({ accountId }),
      );
      expect(reset.syncStatusByAccount[accountId]).toBeUndefined();
    },
  );
});
