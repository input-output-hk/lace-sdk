import { FEATURE_FLAG_CARDANO } from '@lace-contract/cardano-context';
import { FEATURE_FLAG_NETWORK_TYPE } from '@lace-contract/network';
import { Cardano } from '@lace-lib/cardano-core';
import { HexBytes, Milliseconds } from '@lace-lib/util';
import { filter, firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { createLaceWallet } from '../../src/create-lace-wallet';
import {
  createCardanoCustodyAccountEntity,
  putCardanoCustodyAccount,
} from '../../src/custody/cardano-custody-account-entity';
import { blockchainCardanoCustody } from '../../src/custody/modules';
import { readCardanoCustodyUnsettledOperations } from '../../src/custody/read-cardano-custody-unsettled-operations';
import { submitCardanoCustodyTransaction } from '../../src/custody/submit-cardano-custody-transaction';
import * as m from '../../src/modules-cardano';

import {
  buildResultOf,
  creationResult,
  issueGrantShape,
  PREPROD,
  record,
} from './custody-fixtures';

import type {
  CardanoCustodyBuildResult,
  CardanoCustodyOperationKind,
} from '@lace-contract/cardano-context';
import type { AccountId } from '@lace-contract/wallet-repo';
import type * as CardanoProviderCore from '@lace-lib/cardano-provider-core';

// Blockfrost with a tip far below the operations' bounds and nothing on
// chain. `tx/submit` accepts every transaction with the id it was sent for,
// or never answers while silent.
const provider = vi.hoisted(() => ({ acceptedTxId: '', isSilent: false }));

vi.mock('@lace-lib/cardano-provider-core', async importActual => ({
  ...(await importActual<typeof CardanoProviderCore>()),
  getBlockfrostClient: () => ({
    request: async (endpoint: string) => {
      if (endpoint === 'tx/submit') {
        return provider.isSilent
          ? new Promise(() => {})
          : { data: provider.acceptedTxId };
      }
      if (endpoint === 'blocks/latest')
        return {
          data: { height: 100_000, hash: 'a'.repeat(64), slot: 50_000_000 },
        };
      return { data: [] };
    },
  }),
}));

/**
 * Lets the side effects act on what was dispatched so far: each action a
 * side effect emits reaches the store a macrotask later.
 */
const settle = async () => {
  for (let turn = 0; turn < 20; turn++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
};

/** A wallet that holds custody accounts only, as the SDK's custody guides build it. */
const startCustodyOnlyWallet = async () =>
  createLaceWallet({
    modules: [
      m.featureDev,
      m.storageInMemory,
      m.blockchainCardano,
      blockchainCardanoCustody,
      m.cardanoProviderBlockfrost,
      m.cryptoCardanoSdk,
    ] as const,
    environment: 'development',
    featureFlags: [
      { key: FEATURE_FLAG_CARDANO },
      { key: FEATURE_FLAG_NETWORK_TYPE, payload: 'testnet' },
    ],
    config: {
      defaultFeatureFlags: [
        { key: FEATURE_FLAG_CARDANO },
        { key: FEATURE_FLAG_NETWORK_TYPE, payload: 'testnet' },
      ],
      extraFeatureFlags: [],
      defaultTestnetChainId: Cardano.ChainIds.Preprod,
      cardanoProvider: {
        tipPollFrequency: Milliseconds(30_000),
        blockfrostConfigs: {
          1: {
            clientConfig: {
              baseUrl: 'https://cardano-preprod.blockfrost.io',
              apiVersion: 'v0',
              projectId: 'custody-submission-test',
            },
            rateLimiterConfig: {
              size: 500,
              increaseAmount: 10,
              increaseInterval: Milliseconds(1000),
            },
          },
        },
      },
      cexplorerUrls: { 1: 'https://preprod.cexplorer.io' },
    },
  });

type CustodyOnlyWallet = Awaited<ReturnType<typeof startCustodyOnlyWallet>>;

const submit = async (
  wallet: CustodyOnlyWallet,
  {
    accountId,
    operation,
    built: { transaction, bodyHash, resolvedInputs, invalidHereafter },
    reference,
  }: {
    accountId: AccountId;
    operation: CardanoCustodyOperationKind;
    built: CardanoCustodyBuildResult;
    reference?: string;
  },
) => {
  provider.acceptedTxId = bodyHash;
  return submitCardanoCustodyTransaction(wallet, {
    signedTransaction: HexBytes(transaction),
    chainId: PREPROD,
    accountId,
    address: record.address,
    resolvedInputs,
    invalidHereafter,
    operation,
    ...(reference !== undefined && { reference }),
  });
};

const inFlightTxIds = async (wallet: CustodyOnlyWallet) =>
  Object.values(
    await firstValueFrom(
      wallet.stateObservables.cardanoContext.selectInFlightTransactions$,
    ),
  ).map(({ txId }) => txId);

describe('submitCardanoCustodyTransaction on a wallet that holds custody accounts only', () => {
  it('keeps an accepted operation in flight', async () => {
    const wallet = await startCustodyOnlyWallet();
    const { entity } = await createCardanoCustodyAccountEntity(wallet, {
      record,
      name: 'Treasury',
    });
    await putCardanoCustodyAccount(wallet, entity);
    const built = buildResultOf(issueGrantShape());

    expect(
      (
        await submit(wallet, {
          accountId: entity.accounts[0].accountId,
          operation: 'issue-grant',
          built,
        })
      ).isOk(),
    ).toBe(true);
    await settle();

    expect(await inFlightTxIds(wallet)).toEqual([built.bodyHash]);
  });

  it('keeps the creation in flight when the account opens after the acceptance', async () => {
    const wallet = await startCustodyOnlyWallet();
    const { entity } = await createCardanoCustodyAccountEntity(wallet, {
      record,
      name: 'Treasury',
    });
    const built = creationResult();

    expect(
      (
        await submit(wallet, {
          accountId: entity.accounts[0].accountId,
          operation: 'create',
          built,
        })
      ).isOk(),
    ).toBe(true);
    await putCardanoCustodyAccount(wallet, entity);
    await settle();

    expect(await inFlightTxIds(wallet)).toEqual([built.bodyHash]);
  });
});

describe('submitCardanoCustodyTransaction once the wallet syncs the custody address', () => {
  /** A custody account whose address the wallet's sync has discovered. */
  const openSyncedAccount = async () => {
    const wallet = await startCustodyOnlyWallet();
    const { entity } = await createCardanoCustodyAccountEntity(wallet, {
      record,
      name: 'Treasury',
    });
    await putCardanoCustodyAccount(wallet, entity);
    const { accountId } = entity.accounts[0];
    await firstValueFrom(
      wallet.stateObservables.addresses.selectAllAddresses$.pipe(
        filter(addresses =>
          addresses.some(address => address.accountId === accountId),
        ),
      ),
    );
    return { wallet, accountId };
  };

  it('keeps the custody metadata of an accepted operation once the side effects settle', async () => {
    const { wallet, accountId } = await openSyncedAccount();

    expect(
      (
        await submit(wallet, {
          accountId,
          operation: 'issue-grant',
          built: buildResultOf(issueGrantShape()),
          reference: 'intent-42',
        })
      ).isOk(),
    ).toBe(true);
    await settle();

    expect(
      await readCardanoCustodyUnsettledOperations(wallet, accountId),
    ).toEqual([
      expect.objectContaining({
        operation: 'issue-grant',
        status: 'pending',
        reference: 'intent-42',
      }),
    ]);
  });

  it('keeps the custody metadata of an operation whose submission did not answer', async () => {
    const { wallet, accountId } = await openSyncedAccount();
    provider.isSilent = true;
    vi.useFakeTimers({
      toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'],
    });
    try {
      const submitting = submit(wallet, {
        accountId,
        operation: 'issue-grant',
        built: buildResultOf(issueGrantShape()),
        reference: 'intent-42',
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect((await submitting).isErr()).toBe(true);
      await vi.advanceTimersByTimeAsync(100);

      expect(
        await readCardanoCustodyUnsettledOperations(wallet, accountId),
      ).toEqual([
        expect.objectContaining({
          status: 'outcome-unknown',
          reference: 'intent-42',
        }),
      ]);
    } finally {
      vi.useRealTimers();
      provider.isSilent = false;
    }
  });
});
