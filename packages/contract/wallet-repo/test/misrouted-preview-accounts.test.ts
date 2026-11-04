import { describe, expect, it } from 'vitest';

import { readMisroutedPreviewAccountIds } from '../src/migrations/misrouted-preview-accounts';

import type { Storage } from 'redux-persist';

describe('readMisroutedPreviewAccountIds', () => {
  it('finds only accounts carrying the V1 Preview chain-ID defect', async () => {
    const accounts = [
      {
        accountId: 'v1-wallet-0-2',
        blockchainName: 'Cardano',
        blockchainNetworkId: 'cardano-2',
        blockchainSpecific: { chainId: { networkId: 0, networkMagic: 1 } },
      },
      {
        accountId: 'v2-wallet-0-2',
        blockchainName: 'Cardano',
        blockchainNetworkId: 'cardano-2',
        blockchainSpecific: { chainId: { networkId: 0, networkMagic: 2 } },
      },
      {
        accountId: 'v1-wallet-0-1',
        blockchainName: 'Cardano',
        blockchainNetworkId: 'cardano-1',
        blockchainSpecific: { chainId: { networkId: 0, networkMagic: 1 } },
      },
    ];
    const getItem = async (key: string) => {
      expect(key).toBe('persist:wallets');
      return JSON.stringify({
        entities: JSON.stringify({ wallet: { accounts } }),
        _persist: JSON.stringify({ version: 5, rehydrated: true }),
      });
    };

    const ids = await readMisroutedPreviewAccountIds({
      getItem,
      setItem: async () => undefined,
      removeItem: async () => undefined,
    } satisfies Storage);

    expect([...ids]).toEqual(['v1-wallet-0-2']);
  });

  it('preserves unrelated data when the wallets envelope is unreadable', async () => {
    const ids = await readMisroutedPreviewAccountIds({
      getItem: async () => '{broken',
      setItem: async () => undefined,
      removeItem: async () => undefined,
    } satisfies Storage);

    expect([...ids]).toEqual([]);
  });

  it('recovers a partial write after wallets reached v6', async () => {
    const targets = await readMisroutedPreviewAccountIds({
      getItem: async () =>
        JSON.stringify({
          entities: JSON.stringify({
            wallet: {
              accounts: [
                {
                  accountId: 'wallet-0-2',
                  blockchainName: 'Cardano',
                  blockchainNetworkId: 'cardano-2',
                  blockchainSpecific: {
                    chainId: { networkId: 0, networkMagic: 2 },
                  },
                },
                {
                  accountId: 'wallet-0-1',
                  blockchainName: 'Cardano',
                  blockchainNetworkId: 'cardano-1',
                  blockchainSpecific: {
                    chainId: { networkId: 0, networkMagic: 1 },
                  },
                },
                {
                  accountId: 'bitcoin-0-2',
                  blockchainName: 'Bitcoin',
                  blockchainNetworkId: 'bitcoin-testnet',
                },
              ],
            },
          }),
          _persist: JSON.stringify({ version: 6, rehydrated: true }),
        }),
      setItem: async () => undefined,
      removeItem: async () => undefined,
    } satisfies Storage);

    expect([...targets]).toEqual(['wallet-0-2']);
  });
});
