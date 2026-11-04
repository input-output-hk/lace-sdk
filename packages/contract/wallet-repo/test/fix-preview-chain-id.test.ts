import { describe, expect, it } from 'vitest';

import { fixPreviewChainId } from '../src/migrations/6-fix-preview-chain-id';

describe('fixPreviewChainId', () => {
  it('repairs migrated Preview accounts while preserving other networks', () => {
    const preview = {
      blockchainName: 'Cardano',
      blockchainNetworkId: 'cardano-2',
      blockchainSpecific: { chainId: { networkId: 0, networkMagic: 1 } },
    };
    const preprod = {
      blockchainName: 'Cardano',
      blockchainNetworkId: 'cardano-1',
      blockchainSpecific: { chainId: { networkId: 0, networkMagic: 1 } },
    };
    const state = {
      entities: { wallet: { accounts: [preview, preprod] } },
    } as unknown as Parameters<typeof fixPreviewChainId>[0];

    fixPreviewChainId(state);

    expect(preview.blockchainSpecific.chainId).toEqual({
      networkId: 0,
      networkMagic: 2,
    });
    expect(preprod.blockchainSpecific.chainId.networkMagic).toBe(1);
  });
});
