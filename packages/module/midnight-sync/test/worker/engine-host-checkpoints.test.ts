import { SerialisedWalletState } from '@lace-contract/midnight-context';
import { HexBytes } from '@lace-lib/util';
import * as WalletSdk from '@midnightntwrk/wallet-sdk';
import { of, throwError } from 'rxjs';
import { dummyLogger } from 'ts-log';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMidnightEngineHost } from '../../src/worker/engine-host';

import {
  createMemoryStore,
  PASSWORD,
  sealedAccount,
  settings,
  useFastKeyDerivation,
} from './engine-host-fakes';

import type {
  MidnightAccountProps,
  SerializedMidnightWallet,
} from '@lace-contract/midnight-context';
import type { InMemoryWalletAccount } from '@lace-contract/wallet-repo';

// The real engine start runs here, with the wallet library replaced, so that the host's injected store and its
// worker-side key derivation meet the engine's own checkpoint handling.

const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  shieldedSeeds: [] as Uint8Array[],
  dustSeeds: [] as Uint8Array[],
}));

vi.mock('@midnightntwrk/wallet-sdk', () => ({
  InMemoryTransactionHistoryStorage: Object.assign(
    // eslint-disable-next-line prefer-arrow-functions/prefer-arrow-functions -- invoked with `new`, which an arrow function cannot be
    vi.fn(function () {
      return { serialize: vi.fn(async () => 'tx-history') };
    }),
    { restore: vi.fn() },
  ),
  mergeWalletEntries: vi.fn(),
  WalletEntrySchema: {},
}));

vi.mock('@midnightntwrk/wallet-sdk/facade', () => ({
  WalletFacade: { init: sdk.init },
}));

vi.mock('@midnightntwrk/wallet-sdk/shielded', () => ({
  ShieldedWallet: vi.fn(() => ({
    restore: vi.fn(() => 'restored-shielded'),
    startWithSeed: vi.fn((seed: Uint8Array) => {
      sdk.shieldedSeeds.push(Uint8Array.from(seed));
      return 'new-shielded';
    }),
  })),
}));

vi.mock('@midnightntwrk/wallet-sdk/dust', () => ({
  DustWallet: vi.fn(() => ({
    restore: vi.fn(() => 'restored-dust'),
    startWithSeed: vi.fn((seed: Uint8Array) => {
      sdk.dustSeeds.push(Uint8Array.from(seed));
      return 'new-dust';
    }),
  })),
}));

vi.mock('@midnightntwrk/wallet-sdk/unshielded', () => ({
  PublicKey: { fromKeyStore: vi.fn() },
  UnshieldedWallet: vi.fn(() => ({
    restore: vi.fn(() => 'restored-unshielded'),
    startWithPublicKey: vi.fn(() => 'new-unshielded'),
  })),
  createKeystore: vi.fn(() => ({ getPublicKey: vi.fn(), signData: vi.fn() })),
}));

const progress = { isStrictlyComplete: () => true, isConnected: true };
const facade = {
  state: () =>
    of({
      dust: { state: { progress }, capabilities: { keys: {} } },
      shielded: { state: { progress }, totalCoins: [] },
      unshielded: {
        state: { progress },
        capabilities: { keys: { getPublicKey: () => 'night-verifying-key' } },
        availableCoins: [],
        pendingCoins: [],
      },
    }),
  stop: vi.fn(async () => undefined),
  unshielded: {
    start: vi.fn(async () => undefined),
    serializeState: vi.fn(async () => 'unshielded-state'),
  },
  shielded: {
    start: vi.fn(async () => undefined),
    serializeState: vi.fn(async () => 'shielded-state'),
  },
  dust: {
    start: vi.fn(async () => undefined),
    serializeState: vi.fn(async () => 'dust-state'),
  },
};

const seeds = [
  new Uint8Array(32).fill(0x11),
  new Uint8Array(32).fill(0x22),
  new Uint8Array(32).fill(0x33),
] as const;

const persisted = (
  account: InMemoryWalletAccount<MidnightAccountProps>,
): SerializedMidnightWallet => ({
  accountId: account.accountId,
  walletId: account.walletId,
  networkId: account.blockchainSpecific.networkId,
  serializedState: {
    dust: SerialisedWalletState(HexBytes.fromUTF8('dust')),
    shielded: SerialisedWalletState(HexBytes.fromUTF8('shielded')),
    unshielded: SerialisedWalletState(HexBytes.fromUTF8('unshielded')),
    txHistory: SerialisedWalletState(HexBytes.fromUTF8('history')),
  },
});

describe('engine-host-storage-operations', () => {
  let account: InMemoryWalletAccount<MidnightAccountProps>;
  let sibling: InMemoryWalletAccount<MidnightAccountProps>;

  const hostWith = (store: ReturnType<typeof createMemoryStore>['store']) =>
    createMidnightEngineHost({
      createStore: () => store,
      derivePendingActivity: vi.fn(),
      logger: dummyLogger,
    });
  const attach = async (host: ReturnType<typeof hostWith>) =>
    host.attach({
      clientId: 'tab-1',
      account,
      password: PASSWORD.slice(),
      settings: settings(),
    });

  beforeAll(async () => {
    useFastKeyDerivation();
    account = await sealedAccount({ seeds });
    sibling = await sealedAccount({ walletId: 'wallet-b' });
  });
  beforeEach(() => {
    vi.clearAllMocks();
    sdk.shieldedSeeds.length = 0;
    sdk.dustSeeds.length = 0;
    sdk.init.mockImplementation(
      async ({
        shielded,
        unshielded,
        dust,
      }: Record<
        'dust' | 'shielded' | 'unshielded',
        (config: object) => unknown
      >) => {
        shielded({});
        unshielded({});
        dust({});
        return facade;
      },
    );
  });

  describe('checkpoint restore (ADR 61)', () => {
    it('starts a missing checkpoint from the seed, with keys the worker decrypted with its password copy', async () => {
      const { store } = createMemoryStore('memory');

      await attach(hostWith(store));

      expect(sdk.shieldedSeeds).toEqual([seeds[2]]);
      expect(sdk.dustSeeds).toEqual([seeds[1]]);
    });

    it('restores a readable checkpoint without the keys', async () => {
      const { store, documents } = createMemoryStore('memory');
      documents.set(String(account.accountId), persisted(account));
      vi.mocked(
        WalletSdk.InMemoryTransactionHistoryStorage.restore,
      ).mockReturnValueOnce(
        {} as unknown as WalletSdk.InMemoryTransactionHistoryStorage,
      );

      await attach(hostWith(store));

      expect(sdk.shieldedSeeds).toEqual([]);
    });

    it('discards only the corrupt checkpoint of the account and rebuilds it from the seed', async () => {
      const { store, documents } = createMemoryStore('memory');
      documents.set(String(account.accountId), persisted(account));
      documents.set(String(sibling.accountId), persisted(sibling));
      const removeWhere = vi.spyOn(store, 'removeWhere');
      vi.mocked(
        WalletSdk.InMemoryTransactionHistoryStorage.restore,
      ).mockImplementationOnce(() => {
        throw new Error('Failed to decode transaction history');
      });

      await attach(hostWith(store));

      expect(removeWhere).toBeCalledTimes(1);
      const [[predicate]] = removeWhere.mock.calls;
      expect(predicate(persisted(account))).toBe(true);
      expect(predicate(persisted(sibling))).toBe(false);
      expect(documents.has(String(sibling.accountId))).toBe(true);
      expect(sdk.shieldedSeeds).toEqual([seeds[2]]);
    });

    it('refuses to start on an unreadable store rather than treating it as empty, and starts once it reads again', async () => {
      const { store } = createMemoryStore('memory');
      const get = vi
        .spyOn(store, 'get')
        .mockReturnValueOnce(throwError(() => new Error('index unreadable')));
      const removeWhere = vi.spyOn(store, 'removeWhere');
      const host = hostWith(store);

      await expect(attach(host)).rejects.toThrow('index unreadable');
      expect(sdk.init).not.toBeCalled();
      expect(removeWhere).not.toBeCalled();
      await expect(attach(host)).resolves.toMatchObject({
        accountId: account.accountId,
      });
      expect(get).toBeCalledTimes(2);
    });
  });
});
