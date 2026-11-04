import { describe, expect, it } from 'vitest';

import { clearPreviewActivities } from '../src/store/migrations/4-clear-preview-activities';

describe('clearPreviewActivities', () => {
  it('discards only activity for repaired accounts, preserving a valid Preview pending activity', () => {
    const activities = {
      'wallet-0-2': [{ id: 'wrong-network' }],
      'other-wallet-0-2': [{ id: 'pending' }],
      'wallet-0-1': [{ id: 'preprod' }],
    };
    const state = { activities } as unknown as Parameters<
      typeof clearPreviewActivities
    >[0];

    const migrated = clearPreviewActivities(state, new Set(['wallet-0-2']));

    expect(migrated.activities).not.toHaveProperty('wallet-0-2');
    expect(migrated.activities).toHaveProperty('wallet-0-1');
    expect(migrated.activities).toHaveProperty('other-wallet-0-2');
    expect(activities).toHaveProperty('wallet-0-2');
  });
});
