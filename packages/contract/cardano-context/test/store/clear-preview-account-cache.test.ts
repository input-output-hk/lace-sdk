import { describe, expect, it } from 'vitest';

import { clearPreviewAccountCache } from '../../src/store/migrations/6-clear-preview-account-cache';

describe('clearPreviewAccountCache', () => {
  it('drops Preview data that was fetched through Preprod', () => {
    const accountTransactionHistory = {
      'wallet-0-2': {},
      'other-wallet-0-2': {},
      'wallet-0-1': {},
    };
    const accountRewardsHistory = {
      'wallet-0-2': {},
      'other-wallet-0-2': {},
      'wallet-0-1': {},
    };
    const accountUtxos = {
      'wallet-0-2': {},
      'other-wallet-0-2': {},
      'wallet-0-1': {},
    };
    const securityScanByAccount = {
      'wallet-0-2': { scannedAt: 1, exploits: [] },
      'other-wallet-0-2': { scannedAt: 2, exploits: [] },
      'wallet-0-1': { scannedAt: 1, exploits: [] },
    };
    const securityRescanDismissedByAccount = {
      'wallet-0-2': true,
      'other-wallet-0-2': true,
      'wallet-0-1': true,
    };
    const state = {
      accountTransactionHistory,
      accountRewardsHistory,
      accountUtxos,
      securityScanByAccount,
      securityRescanDismissedByAccount,
    } as unknown as Parameters<typeof clearPreviewAccountCache>[0];

    clearPreviewAccountCache(state, new Set(['wallet-0-2']));

    for (const cache of [
      accountTransactionHistory,
      accountRewardsHistory,
      accountUtxos,
      securityScanByAccount,
      securityRescanDismissedByAccount,
    ]) {
      expect(cache).not.toHaveProperty('wallet-0-2');
      expect(cache).toHaveProperty('wallet-0-1');
      expect(cache).toHaveProperty('other-wallet-0-2');
    }
  });
});
