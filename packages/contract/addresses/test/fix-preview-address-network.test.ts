import { describe, expect, it } from 'vitest';

import { fixPreviewAddressNetwork } from '../src/store/migrations/2-fix-preview-address-network';

describe('fixPreviewAddressNetwork', () => {
  it('retags only Preprod metadata on migrated Preview addresses', () => {
    const preview = {
      blockchainName: 'Cardano',
      accountId: 'wallet-0-2',
      data: { networkId: 0, networkMagic: 1 },
    };
    const preprod = {
      blockchainName: 'Cardano',
      accountId: 'wallet-0-1',
      data: { networkId: 0, networkMagic: 1 },
    };
    const validPreview = {
      blockchainName: 'Cardano',
      accountId: 'other-wallet-0-2',
      data: { networkId: 0, networkMagic: 2 },
    };
    const state = {
      addresses: [preview, preprod, validPreview],
    } as unknown as Parameters<typeof fixPreviewAddressNetwork>[0];

    fixPreviewAddressNetwork(state, new Set(['wallet-0-2']));

    expect(preview.data).toEqual({ networkId: 0, networkMagic: 2 });
    expect(preprod.data.networkMagic).toBe(1);
    expect(validPreview.data.networkMagic).toBe(2);
  });
});
