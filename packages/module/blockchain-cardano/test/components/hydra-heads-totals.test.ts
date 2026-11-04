import { hydraHeadsIndexSelectors } from '@lace-contract/cardano-context';
import { BlockchainNetworkId } from '@lace-contract/network';
import { tokensSelectors, TokenId } from '@lace-contract/tokens';
import { AccountId } from '@lace-contract/wallet-repo';
import { BigNumber } from '@lace-lib/util';
import { describe, expect, it } from 'vitest';

import type { Address } from '@lace-contract/addresses';
import type { HydraHeadsIndexHead } from '@lace-contract/cardano-context';
import type { State } from '@lace-contract/module';

const accountId = AccountId('cardano-1');
const address = 'addr_test1' as Address;
const lovelaceId = TokenId('lovelace');

const head: HydraHeadsIndexHead = {
  headId: '324c8b8198c4c9db7526d6dccb79e992c4863b24b56453bb16995bdc',
  version: '2.0.0',
  outpoint: { txId: 'aa'.repeat(32), index: 0 },
  state: 'open',
  headValue: { coins: BigNumber(500_000_000n), assets: {} },
  participantCount: 1,
  isParticipant: true,
  isSoleParticipant: true,
  depositedValue: { coins: BigNumber(500_000_000n), assets: {} },
  withdrawnValue: { coins: BigNumber(0n), assets: {} },
};

const buildState = (heads: HydraHeadsIndexHead[]) =>
  ({
    rawTokens: {
      [accountId]: {
        [address]: {
          [lovelaceId]: {
            tokenId: lovelaceId,
            available: BigNumber(2_000_000n),
            pending: BigNumber(0n),
            accountId,
            address,
            blockchainName: 'Cardano',
          },
        },
      },
    },
    tokensMetadata: { byTokenId: {} },
    wallets: {
      ids: ['w1'],
      entities: {
        w1: {
          walletId: 'w1',
          metadata: { name: 'Wallet', order: 0 },
          accounts: [
            {
              accountId,
              walletId: 'w1',
              blockchainName: 'Cardano',
              networkType: 'testnet',
              blockchainNetworkId: BlockchainNetworkId('cardano-1'),
              metadata: { name: 'Account' },
            },
          ],
        },
      },
    },
    network: {
      networkType: 'testnet',
      blockchainNetworks: {
        Cardano: {
          mainnet: BlockchainNetworkId('cardano-764824073'),
          testnet: BlockchainNetworkId('cardano-1'),
        },
      },
    },
    hydraHeadsIndex: {
      byAccount: {
        [accountId]: {
          snapshot: {
            deposits: [],
            heads,
            lastSyncedAt: '2026-09-01T12:00:00Z',
          },
          failed: false,
        },
      },
      historyByHeadId: {},
      depositedHeadIdsByAccount: {},
    },
  } as unknown as State);

describe('Hydra head funds and balances', () => {
  const withoutHeads = buildState([]);
  const withHead = buildState([head]);

  it('lists the head for the account', () => {
    expect(
      hydraHeadsIndexSelectors.hydraHeadsIndex.selectHydraHeadsByAccount(
        withHead,
        accountId,
      ),
    ).toEqual([head]);
  });

  it('leaves the portfolio total untouched by funds in a head', () => {
    const select =
      tokensSelectors.tokens.selectAggregatedFungibleTokensForVisibleAccounts;

    const total = select(withHead);

    expect(total).toHaveLength(1);
    expect(total[0].available).toEqual(BigNumber(2_000_000n));
    expect(total).toEqual(select(withoutHeads));
  });

  it('leaves the account balance untouched by funds in a head', () => {
    const select = tokensSelectors.tokens.selectAggregatedTokensByAccountId;

    const [ada] = select(withHead, accountId);

    expect(ada.available).toEqual(BigNumber(2_000_000n));
    expect(select(withHead, accountId)).toEqual(
      select(withoutHeads, accountId),
    );
  });
});
