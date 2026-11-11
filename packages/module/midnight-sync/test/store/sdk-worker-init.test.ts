import { registerMidnightBlockchainNetworks } from '@lace-contract/midnight-context';
import * as stubData from '@lace-contract/midnight-context/src/stub-data';
import { firstValueFrom, of } from 'rxjs';
import { dummyLogger } from 'ts-log';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createWorkerSdkStoreInit } from '../../src/store/sdk-worker-init';
import * as initialize from '../../src/store/side-effects/initialize';
import * as resync from '../../src/store/side-effects/resync';
import * as syncFailure from '../../src/store/side-effects/sync-failure';
import * as watch from '../../src/store/side-effects/watch';
import * as engineClient from '../../src/worker/engine-client';

import type { SideEffect } from '../../src';
import type { CreateAccountKeyManager } from '../../src/store/account-keys';
import type { MidnightEngineClient } from '../../src/worker/engine-client';
import type { SerializedMidnightWallet } from '@lace-contract/midnight-context';
import type { ModuleInitProps } from '@lace-contract/module';
import type { CollectionStorage } from '@lace-contract/storage';

const spies = vi.hoisted(() => {
  const sideEffect = (name: string) =>
    Object.assign(vi.fn(), { sideEffectName: name });
  return {
    workerReset: sideEffect('worker-reset'),
    showResets: sideEffect('show-resets'),
    surfaceFailures: sideEffect('surface-failures'),
    workerDelete: sideEffect('worker-delete'),
    workerClear: sideEffect('worker-clear'),
    client: {
      startAccountEngine: vi.fn(),
    } as unknown as MidnightEngineClient,
  };
});

vi.mock('../../src/store/side-effects/initialize', () => ({
  createInitializeSideEffects: vi.fn(() => () => []),
}));
vi.mock('../../src/store/side-effects/resync', () => ({
  createWorkerResetSyncStateSideEffect: vi.fn(() => spies.workerReset),
  showMidnightEngineResets: vi.fn(() => spies.showResets),
  createWorkerDeleteWalletSideEffect: vi.fn(() => spies.workerDelete),
  createWorkerClearWalletStateOnResync: vi.fn(() => spies.workerClear),
}));
vi.mock('../../src/store/side-effects/sync-failure', () => ({
  surfaceMidnightEngineFailures: vi.fn(() => spies.surfaceFailures),
}));
// The watcher factory hands back its key manager factory, so the test reads what Worker mode gives it.
vi.mock('../../src/store/side-effects/watch', () => ({
  createWatchMidnightAccount: vi.fn(
    (createKeyManager: unknown) => createKeyManager,
  ),
}));
vi.mock('../../src/worker/engine-client', () => ({
  createMidnightEngineClient: vi.fn(() => spies.client),
  registerMidnightEngineClient: vi.fn(),
}));

const auth = {
  authenticate: () => of(true),
  accessAuthSecret: vi.fn(),
};
const worker = { connect: vi.fn(), storage: 'memory' as const };
const props = {
  runtime: { config: { defaultMidnightTestnetNetworkId: 'preview' } },
} as unknown as ModuleInitProps;
const storage = {} as CollectionStorage<SerializedMidnightWallet>;

describe('createWorkerSdkStoreInit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates the engine client from the worker options and the loadout's auth, registers it for the instance and starts engines through it", async () => {
    const init = createWorkerSdkStoreInit({
      auth,
      worker,
      batchUpdates: { size: 3, spacing: 1 },
    });

    const loaded = await init(props, { logger: dummyLogger });

    expect(engineClient.createMidnightEngineClient).toHaveBeenCalledWith({
      connect: worker.connect,
      storage: 'memory',
      accessAuthSecret: auth.accessAuthSecret,
      attestedProver: false,
      batchUpdates: { size: 3, spacing: 1 },
      logger: dummyLogger,
    });
    expect(engineClient.registerMidnightEngineClient).toHaveBeenCalledWith(
      props.runtime,
      spies.client,
    );
    expect(loaded.sideEffectDependencies?.startMidnightAccountWallet).toBe(
      spies.client.startAccountEngine,
    );
    expect(loaded.sideEffectDependencies?.authenticate).toBe(auth.authenticate);
    expect(loaded.sideEffectDependencies?.midnightEngines$).toBeDefined();
    expect(loaded.middleware).toHaveLength(1);
  });

  it('sends every side effect that would wipe checkpoints to the worker and publishes its failures and resets', async () => {
    await createWorkerSdkStoreInit({ auth, worker })(props, {
      logger: dummyLogger,
    });

    const [[loadout, , storageSideEffects]] = vi.mocked(
      initialize.createInitializeSideEffects,
    ).mock.calls;
    expect(loadout(storage)).toEqual([
      registerMidnightBlockchainNetworks,
      expect.any(Function),
      spies.workerReset,
      spies.showResets,
      spies.surfaceFailures,
    ]);
    expect(storageSideEffects?.(storage)).toEqual([
      spies.workerDelete,
      spies.workerClear,
    ]);
    expect(resync.createWorkerResetSyncStateSideEffect).toHaveBeenCalledWith(
      spies.client,
    );
    expect(syncFailure.surfaceMidnightEngineFailures).toHaveBeenCalledWith(
      spies.client,
    );
  });

  it('gives the account watcher a key manager that holds no keys on this page', async () => {
    await createWorkerSdkStoreInit({ auth, worker })(props, {
      logger: dummyLogger,
    });

    const [[createKeyManager]] = vi.mocked(watch.createWatchMidnightAccount)
      .mock.calls as unknown as [[CreateAccountKeyManager]];
    const { keyManager, destroyAccountKeyManager } = createKeyManager(
      stubData.midnightAccount,
    )(
      {} as Parameters<SideEffect>[0],
      {} as Parameters<SideEffect>[1],
      {} as Parameters<SideEffect>[2],
    );

    expect(await firstValueFrom(keyManager.areKeysAvailable$)).toBe(false);
    await expect(firstValueFrom(keyManager.keys$)).rejects.toThrow(
      'decrypted in the worker',
    );
    expect(() => {
      destroyAccountKeyManager();
    }).not.toThrow();
  });

  it('refuses to start without a valid testnet for a wallet to start on', () => {
    const init = createWorkerSdkStoreInit({ auth, worker });

    expect(() => {
      void init({ runtime: { config: {} } } as ModuleInitProps, {
        logger: dummyLogger,
      });
    }).toThrow('config.defaultMidnightTestnetNetworkId');
  });
});
