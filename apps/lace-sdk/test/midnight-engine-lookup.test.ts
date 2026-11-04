import { Percent } from '@cardano-sdk/util';
import { FailureId } from '@lace-contract/failures';
import {
  isRemoteMidnightEngine,
  MidnightAccountId,
  NIGHT_TOKEN_ID,
} from '@lace-contract/midnight-context';
import * as fixture from '@lace-contract/midnight-context/src/stub-data';
import { Timestamp } from '@lace-lib/util';
import {
  BehaviorSubject,
  filter,
  firstValueFrom,
  map,
  NEVER,
  timeout,
} from 'rxjs';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import {
  createLaceWallet,
  createMidnightModule,
  FEATURE_FLAG_MIDNIGHT,
  FEATURE_FLAG_MIDNIGHT_UNSHIELDED,
  FEATURE_FLAG_NETWORK_TYPE,
  m,
  MidnightAttestedProverUnsupportedError,
  MidnightWalletNotReadyError,
  MidnightWorkerSettingsConflictError,
  MidnightWorkerStartupError,
  MidnightWorkerStoppedError,
  MidnightWorkerUnsupportedError,
  observeMidnightBalances,
  signMidnightData,
} from '../src/midnight';
import { midnightWalletFor } from '../src/midnight-wallet';

// Test-only engine boundary: the package deliberately does not export its internals.
// eslint-disable-next-line @nx/enforce-module-boundaries
import type * as SdkInit from '../../../packages/module/midnight-sync/src/store/sdk-init';
import type {
  MidnightEngineConnection,
  MidnightEngineRuntimeStatus,
} from '@lace-module/midnight-sync/sdk';
import type { WalletEntry } from '@midnightntwrk/wallet-sdk';
import type { Observable } from 'rxjs';

const { workerConnect } = vi.hoisted(() => ({
  workerConnect: { current: undefined as unknown },
}));
vi.mock(
  '../../../packages/module/midnight-sync/src/store/sdk-init',
  async importActual => {
    const actual = await importActual<typeof SdkInit>();
    return {
      ...actual,
      createSdkStoreInit: (
        options: Parameters<typeof actual.createSdkStoreInit>[0],
      ) =>
        actual.createSdkStoreInit({
          ...options,
          worker: {
            connect: clientId =>
              (
                workerConnect.current as (
                  clientId: string,
                ) => MidnightEngineConnection
              )(clientId),
            storage: 'memory',
          },
        }),
    };
  },
);

vi.setConfig({ testTimeout: 30_000 });
const { accountId, networkId, midnightAccount } = fixture;
const siblingId = MidnightAccountId(fixture.walletId, 1, networkId);
const flagList = [
  { key: FEATURE_FLAG_MIDNIGHT },
  { key: FEATURE_FLAG_MIDNIGHT_UNSHIELDED },
  { key: FEATURE_FLAG_NETWORK_TYPE, payload: 'testnet' },
];
const synced = {
  shielded: Percent(1),
  unshielded: Percent(1),
  dust: Percent(1),
  isStrictlyComplete: { shielded: true, unshielded: true, dust: true },
};
const address = {
  shielded: fixture.midnightShieldedAddress,
  unshielded: fixture.midnightUnshieldedAddress,
  dust: fixture.midnightDustAddress,
};
const stateView = {
  unshielded: {
    availableCoins: [
      {
        utxo: { type: NIGHT_TOKEN_ID, value: 5n },
        meta: { ctime: new Date(0), registeredForDustGeneration: false },
      },
    ],
    pendingCoins: [],
  },
  dust: { balance: 7n, available: 3n, generation: undefined },
  shieldedPublicKeys: { coin: '11'.repeat(32), encryption: '22'.repeat(32) },
  isStrictlyComplete: synced.isStrictlyComplete,
};

type Attach = () => Promise<unknown>;
type EngineValue<T> = { engineGeneration: string; value: T };
type EndReason = Extract<
  MidnightEngineRuntimeStatus,
  { state: 'ended' }
>['reason'];

/**
 * The SharedWorker as the engine client sees it: each connection is a runtime, and its host answers attaches
 * as the test scripts. A connection ends as a runtime does: `status$` first, then every pending call rejects.
 */
const createWorkers = () => {
  const attaches: { clientId: string; account: { accountId: string } }[] = [];
  const storageCalls: { method: string; request: unknown }[] = [];
  const control: {
    attach: Attach;
    /** Ends each new connection at once, as a runtime that cannot start does. */
    endEachConnection?: EndReason;
  } = {
    attach: async () => undefined,
  };
  const connections: {
    clientId: string;
    end: (reason: EndReason) => void;
  }[] = [];
  /** The streams of the engine attached last, which Messenger replays as a BehaviorSubject does. */
  const latest: {
    engineGeneration?: string;
    address$?: BehaviorSubject<EngineValue<unknown>>;
    syncProgress$?: BehaviorSubject<EngineValue<unknown>>;
    stateView$?: BehaviorSubject<EngineValue<unknown>>;
    transactionHistory$?: BehaviorSubject<EngineValue<WalletEntry[]>>;
    status$?: BehaviorSubject<Record<string, unknown>>;
  } = {};
  const connect = vi.fn((clientId: string): MidnightEngineConnection => {
    const status = new BehaviorSubject<MidnightEngineRuntimeStatus>({
      state: 'ready',
    });
    const rejects = new Set<(error: unknown) => void>();
    const isEnded = () => status.value.state === 'ended';
    const pending = async <T>(call: () => Promise<T>): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        if (isEnded()) {
          reject(new Error('RemoteApiShutdownError'));
          return;
        }
        rejects.add(reject);
        call()
          .then(resolve, reject)
          .finally(() => rejects.delete(reject));
      });
    const live = <T>(source$: Observable<T>) =>
      source$.pipe(filter(() => !isEnded()));
    const end = (reason: EndReason) => {
      if (isEnded()) return;
      status.next({ state: 'ended', reason });
      queueMicrotask(() => {
        for (const reject of rejects)
          reject(new Error('RemoteApiShutdownError'));
      });
    };
    const host = {
      attach: vi.fn(
        async (request: {
          clientId: string;
          account: { accountId: string };
        }) => {
          attaches.push(request);
          return pending(async () => {
            await control.attach();
            latest.engineGeneration = `generation-${attaches.length}`;
            return {
              accountId: request.account.accountId,
              walletId: fixture.walletId,
              networkId,
              nightVerifyingKey: 'night-key',
              engineGeneration: latest.engineGeneration,
              resets: 0,
              settings: {},
            };
          });
        },
      ),
      detach: vi.fn(async () => undefined),
      resetAccount: vi.fn(async (request: unknown) => {
        storageCalls.push({ method: 'resetAccount', request });
      }),
      resyncAll: vi.fn(async (request: unknown) => {
        storageCalls.push({ method: 'resyncAll', request });
      }),
      deleteWallet: vi.fn(async (request: unknown) => {
        storageCalls.push({ method: 'deleteWallet', request });
      }),
      // Messenger's hot streams replay their last value and never complete.
      streams: () => {
        const engineGeneration = latest.engineGeneration ?? '';
        const ofEngine = <T>(value: T) =>
          new BehaviorSubject<EngineValue<T>>({ engineGeneration, value });
        latest.address$ = ofEngine<unknown>(address);
        latest.syncProgress$ = ofEngine<unknown>(synced);
        latest.stateView$ = ofEngine<unknown>(stateView);
        latest.transactionHistory$ = ofEngine<WalletEntry[]>([]);
        latest.status$ = new BehaviorSubject<Record<string, unknown>>({
          resets: 0,
        });
        return {
          address$: live(latest.address$),
          areKeysAvailable$: live(ofEngine(true)),
          coinsByTokenType$: live(ofEngine({ shielded: {}, unshielded: {} })),
          syncProgress$: live(latest.syncProgress$),
          transactionHistory$: live(latest.transactionHistory$),
          stateView$: live(latest.stateView$),
          progress$: NEVER,
          status$: live(latest.status$),
        };
      },
    };
    connections.push({ clientId, end });
    if (control.endEachConnection) {
      const reason = control.endEachConnection;
      queueMicrotask(() => {
        end(reason);
      });
    }
    return {
      host: host as unknown as MidnightEngineConnection['host'],
      status$: status,
    };
  });
  workerConnect.current = connect;
  return { connect, attaches, control, connections, storageCalls, latest };
};

const refusal = (reason: string) =>
  Object.assign(new Error(`refused: ${reason}`), {
    name: 'MidnightWorkerError',
    reason,
  });

const createWallet = async () => {
  const wallet = await createLaceWallet({
    modules: [
      m.featureDev,
      m.storageInMemory,
      createMidnightModule({
        password: new Uint8Array([1]),
        networks: {
          [networkId]: {
            nodeAddress: 'http://localhost:9944',
            indexerAddress: 'http://localhost:8088/graphql',
          },
        },
      }),
    ] as const,
    environment: 'development',
    featureFlags: flagList,
    config: {
      defaultFeatureFlags: flagList,
      extraFeatureFlags: [],
      defaultMidnightTestnetNetworkId: networkId,
    },
  });
  await firstValueFrom(
    wallet.stateObservables.midnightContext.selectCurrentNetwork$.pipe(
      // Store side effects apply the loadout's overrides asynchronously; a later change would restart the watch.
      filter(
        network =>
          network.config.nodeAddress === 'http://localhost:9944' &&
          network.config.indexerAddress === 'http://localhost:8088/graphql',
      ),
      timeout(5000),
    ),
  );
  onTestFinished(() => {
    wallet.dispatch('wallets.removeWallet', fixture.walletId, [
      accountId,
      siblingId,
    ]);
  });
  return wallet;
};

type Wallet = Awaited<ReturnType<typeof createWallet>>;

const addAccounts = (wallet: Wallet) => {
  wallet.dispatch('wallets.addWallet', {
    ...fixture.midnightWallet,
    accounts: [midnightAccount],
  });
};

const syncOperation = async (wallet: Wallet) =>
  firstValueFrom(
    wallet.stateObservables.sync.selectSyncStatusByAccount$.pipe(
      map(
        statuses =>
          statuses[accountId]?.pendingSync?.operations[
            `${accountId}-midnight-sync`
          ],
      ),
    ),
  );

const lastSuccessfulSyncOf = async (wallet: Wallet) =>
  firstValueFrom(
    wallet.stateObservables.sync.selectSyncStatusByAccount$.pipe(
      map(statuses => statuses[accountId]?.lastSuccessfulSync),
    ),
  );

const syncFailureOf = async (wallet: Wallet) =>
  firstValueFrom(
    wallet.stateObservables.failures.selectAllFailures$.pipe(
      map(failures => failures[FailureId(`midnight-sync-${accountId}`)]),
    ),
  );

const activityRowsOf = async (wallet: Wallet) =>
  firstValueFrom(
    wallet.stateObservables.activities.selectByAccountId$.pipe(
      map(select => select({ accountId })),
    ),
  );

const receiveEntry = (hash: string): WalletEntry => ({
  hash,
  protocolVersion: 1,
  identifiers: [],
  timestamp: new Date(123000),
  fees: 4n,
  status: 'SUCCESS',
  unshielded: {
    id: 1,
    createdUtxos: [
      {
        value: 10n,
        owner: 'destination',
        tokenType: NIGHT_TOKEN_ID,
        intentHash: 'intent',
        outputIndex: 0,
      },
    ],
    spentUtxos: [],
  },
});

/** Resolves once a public call has subscribed to the engine lookup of the account. */
const lookupsOf = async (wallet: Wallet) => {
  const [access] = await wallet._loadModules('addons.loadMidnightEngine');
  return vi.spyOn(access, 'requestEngine');
};

/** Collects what one subscription to the public balances stream saw. */
const watchBalances = (wallet: Wallet) => {
  const seen: { values: unknown[]; error?: unknown } = { values: [] };
  const subscription = observeMidnightBalances(wallet, {
    accountId,
    startTimeout: 20_000,
  }).subscribe({
    next: value => seen.values.push(value),
    error: (error: unknown) => {
      seen.error = error;
    },
  });
  onTestFinished(() => {
    subscription.unsubscribe();
  });
  return seen;
};

// Longer than the watcher's first retry delay (300 ms), so a retry would have attached again.
const pastRetryDelay = async () =>
  new Promise(resolve => {
    setTimeout(resolve, 700);
  });

// The SDK error each engine-client reason reaches public callers as.
const NAMED_ERRORS: Partial<Record<string, new (...args: never[]) => Error>> = {
  'attested-prover': MidnightAttestedProverUnsupportedError,
  'not-supported': MidnightWorkerUnsupportedError,
  'runtime-stopped': MidnightWorkerStoppedError,
  'settings-conflict': MidnightWorkerSettingsConflictError,
  'startup-failed': MidnightWorkerStartupError,
};

const expectNamed = (error: unknown, reason: string) => {
  if (reason === 'start-timeout') {
    expect(error).toBeInstanceOf(MidnightWalletNotReadyError);
    expect((error as Error).message).toContain('within 120000ms');
  } else if (reason === 'wrong-password') {
    // The SDK has no named authentication error: the host's refusal arrives as a plain error with its message.
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toHaveProperty('reason');
    expect((error as Error).message).toBe('refused: wrong-password');
  } else expect(error).toBeInstanceOf(NAMED_ERRORS[reason]);
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('test:engine-client-failures', () => {
  it.each([
    'wrong-password',
    'settings-conflict',
    'attested-prover',
    'start-timeout',
  ])(
    'a refused first start (%s) reaches every public helper through the shared lookup, without a watcher retry, and publishes the Failed sync operation',
    async reason => {
      const workers = createWorkers();
      let refuse!: () => void;
      workers.control.attach = async () =>
        new Promise((_, reject) => {
          refuse = () => {
            reject(refusal(reason));
          };
        });
      const wallet = await createWallet();
      addAccounts(wallet);
      await vi.waitFor(() => {
        expect(workers.attaches).toHaveLength(1);
      });
      const lookups = await lookupsOf(wallet);
      const early = watchBalances(wallet);
      await vi.waitFor(() => {
        expect(lookups).toHaveBeenCalledOnce();
      });

      workers.control.attach = async () => {
        throw refusal(reason);
      };
      refuse();
      await vi.waitFor(() => {
        expect(early.error).toBeDefined();
      });
      await pastRetryDelay();
      const attachesWithoutRetry = workers.attaches.length;
      const failedOperation = await syncOperation(wallet);
      const fromWalletFor = await midnightWalletFor(wallet, {
        accountId,
        startTimeout: 10_000,
      }).catch((error: unknown) => error);
      const fromHelper = await signMidnightData(wallet, {
        accountId,
        data: '00ff80',
        options: { encoding: 'hex', keyType: 'unshielded' },
        startTimeout: 10_000,
      });
      const late = watchBalances(wallet);
      await vi.waitFor(() => {
        expect(late.error).toBeDefined();
      });

      expectNamed(early.error, reason);
      expect(early.values).toEqual([]);
      expect(attachesWithoutRetry).toBe(1);
      expect(failedOperation).toMatchObject({ status: 'Failed' });
      expectNamed(fromWalletFor, reason);
      expect(fromHelper.isErr()).toBe(true);
      expectNamed(fromHelper.isErr() && fromHelper.error, reason);
      expectNamed(late.error, reason);
      // Each public call asks for the engine once more, and only once.
      expect(workers.attaches).toHaveLength(4);
      expect(workers.connect).toHaveBeenCalledOnce();
    },
  );

  it.each(['startup-failed', 'not-supported'] as const)(
    'a worker that cannot start (%s) reaches the public helpers and is started again only by a public call',
    async reason => {
      const workers = createWorkers();
      const wallet = await createWallet();
      addAccounts(wallet);
      await vi.waitFor(() => {
        expect(workers.attaches).toHaveLength(1);
      });
      const lookups = await lookupsOf(wallet);
      const early = watchBalances(wallet);
      await vi.waitFor(() => {
        expect(lookups).toHaveBeenCalledOnce();
      });
      workers.control.endEachConnection = reason;
      workers.connections[0].end(reason);
      await vi.waitFor(() => {
        expect(early.error).toBeDefined();
      });
      await pastRetryDelay();
      const connectsWithoutRetry = workers.connect.mock.calls.length;
      const fromWalletFor = await midnightWalletFor(wallet, {
        accountId,
        startTimeout: 10_000,
      }).catch((error: unknown) => error);

      expectNamed(early.error, reason);
      expect(connectsWithoutRetry).toBe(1);
      expectNamed(fromWalletFor, reason);
      expect(workers.connect).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    { reason: 'startup-failed', isRestored: false },
    { reason: 'startup-failed', isRestored: true },
    { reason: 'not-supported', isRestored: false },
    { reason: 'not-supported', isRestored: true },
  ] as const)(
    'a worker that cannot start ($reason) publishes the Failed sync operation without a retry, also over a restored successful sync ($isRestored), reconnects only on a public call and clears it once that call recovers the engine',
    async ({ reason, isRestored }) => {
      const workers = createWorkers();
      workers.control.endEachConnection = reason;
      const wallet = await createWallet();
      if (isRestored)
        wallet.dispatch('sync.markAccountAsSynced', { accountId });
      const syncFailureId = FailureId(`midnight-sync-${accountId}`);
      const failureOf = async () =>
        firstValueFrom(
          wallet.stateObservables.failures.selectAllFailures$.pipe(
            map(failures => failures[syncFailureId]),
          ),
        );

      addAccounts(wallet);
      await vi.waitFor(async () => {
        expect(await syncOperation(wallet)).toMatchObject({
          status: 'Failed',
          error: 'sync.error.midnight-sync-failed',
        });
      });
      const failure = await failureOf();
      await pastRetryDelay();
      const connectsWithoutPublicCall = workers.connect.mock.calls.length;

      workers.control.endEachConnection = undefined;
      const recovered = watchBalances(wallet);
      await vi.waitFor(() => {
        expect(recovered.values.length).toBeGreaterThan(0);
      });
      await vi.waitFor(async () => {
        expect(await syncOperation(wallet)).toBeUndefined();
      });

      expect(failure).toEqual({
        failureId: syncFailureId,
        message: 'sync.error.midnight-sync-failed',
      });
      expect(connectsWithoutPublicCall).toBe(1);
      expect(workers.connect).toHaveBeenCalledTimes(2);
      expect(await failureOf()).toBeUndefined();
      expect(recovered.error).toBeUndefined();
    },
  );

  it('clears the Failed sync operation once a public call recovers the engine', async () => {
    const workers = createWorkers();
    workers.control.attach = async () => {
      throw refusal('wrong-password');
    };
    const wallet = await createWallet();
    addAccounts(wallet);
    await vi.waitFor(async () => {
      expect(await syncOperation(wallet)).toMatchObject({ status: 'Failed' });
    });

    workers.control.attach = async () => undefined;
    const recovered = watchBalances(wallet);
    await vi.waitFor(() => {
      expect(recovered.values.length).toBeGreaterThan(0);
    });

    await vi.waitFor(async () => {
      expect(await syncOperation(wallet)).toBeUndefined();
    });
    expect(recovered.error).toBeUndefined();
  });

  it('clears a Failed sync operation restored with the Redux state once the engine runs', async () => {
    createWorkers();
    const wallet = await createWallet();
    const failedAt = Timestamp(0);
    wallet.dispatch('sync.addSyncOperation', {
      accountId,
      operation: {
        operationId: `${accountId}-midnight-sync`,
        status: 'Failed',
        description: 'sync.operation.midnight-wallet-sync',
        error: 'sync.error.midnight-sync-failed',
        startedAt: failedAt,
        failedAt,
      },
    });
    const restored = await syncOperation(wallet);
    addAccounts(wallet);

    expect(restored).toMatchObject({ status: 'Failed' });
    await vi.waitFor(async () => {
      expect(await syncOperation(wallet)).toBeUndefined();
    });
  });

  it.each([
    { failure: 'ws lost', message: 'a message' },
    { failure: '', message: 'an empty message' },
  ])(
    "a failure with $message that the live worker reports for a running engine leaves the store running: the watcher attaches again, the fresh engine's history reaches the store and a later action still reaches its side effect",
    async ({ failure }) => {
      const workers = createWorkers();
      const wallet = await createWallet();
      addAccounts(wallet);
      await vi.waitFor(() => {
        expect(workers.latest.status$).toBeDefined();
      });

      // The host's status once a stream of the running engine failed.
      workers.latest.status$?.next({
        resets: 0,
        engineGeneration: 'generation-1',
        failure,
      });
      await vi.waitFor(
        () => {
          expect(workers.attaches).toHaveLength(2);
        },
        { timeout: 5000 },
      );
      workers.latest.transactionHistory$?.next({
        engineGeneration: 'generation-2',
        value: [receiveEntry('fresh')],
      });
      await vi.waitFor(async () => {
        expect(await activityRowsOf(wallet)).toHaveLength(1);
      });
      wallet.dispatch('midnightSync.resync');
      await vi.waitFor(() => {
        expect(workers.storageCalls.map(({ method }) => method)).toEqual([
          'resyncAll',
        ]);
      });

      expect(workers.latest.engineGeneration).toBe('generation-2');
      expect(await activityRowsOf(wallet)).toMatchObject([
        { activityId: 'fresh' },
      ]);
    },
  );

  it('a history entry that the page cannot map ends only the activities of the worker engine and leaves the store running: the watcher keeps the engine and a later action still reaches its side effect', async () => {
    const workers = createWorkers();
    const wallet = await createWallet();
    addAccounts(wallet);
    await vi.waitFor(() => {
      expect(workers.latest.transactionHistory$).toBeDefined();
    });

    workers.latest.transactionHistory$?.next({
      engineGeneration: 'generation-1',
      value: [{ ...receiveEntry('unmappable'), timestamp: {} as Date }],
    });
    await pastRetryDelay();
    wallet.dispatch('midnightSync.resync');
    await vi.waitFor(() => {
      expect(workers.storageCalls.map(({ method }) => method)).toEqual([
        'resyncAll',
      ]);
    });

    expect(workers.attaches).toHaveLength(1);
    expect(await activityRowsOf(wallet)).toEqual([]);
  });

  it.each([
    { failure: 'the replacement engine did not start', message: 'a message' },
    { failure: '', message: 'an empty message' },
  ])(
    "a worker reset whose replacement engine fails to start with $message leaves the store running and restores none of the replaced engine's activities: the watcher attaches again and maps the new engine's history",
    async ({ failure }) => {
      const workers = createWorkers();
      const wallet = await createWallet();
      addAccounts(wallet);
      await vi.waitFor(() => {
        expect(workers.latest.transactionHistory$).toBeDefined();
      });
      workers.latest.transactionHistory$?.next({
        engineGeneration: 'generation-1',
        value: [receiveEntry('replaced')],
      });
      await vi.waitFor(async () => {
        expect(await activityRowsOf(wallet)).toHaveLength(1);
      });

      // The host's status after a wipe whose replacement engine failed to start: no engine runs.
      workers.latest.status$?.next({ resets: 1, failure });
      await vi.waitFor(
        () => {
          expect(workers.attaches).toHaveLength(2);
        },
        { timeout: 5000 },
      );
      await pastRetryDelay();
      const afterRecovery = await activityRowsOf(wallet);
      workers.latest.transactionHistory$?.next({
        engineGeneration: 'generation-2',
        value: [receiveEntry('fresh')],
      });
      await vi.waitFor(async () => {
        expect(await activityRowsOf(wallet)).toHaveLength(1);
      });
      wallet.dispatch('midnightSync.resync');
      await vi.waitFor(() => {
        expect(workers.storageCalls.map(({ method }) => method)).toEqual([
          'resyncAll',
        ]);
      });

      expect(afterRecovery).toEqual([]);
      expect(await activityRowsOf(wallet)).toMatchObject([
        { activityId: 'fresh' },
      ]);
    },
  );

  it('at a worker death ends public subscriptions with runtime-stopped, completes the watcher without a retry, publishes the Failed sync operation without a retry action, and re-attaches once on the next public call, whose sync clears it', async () => {
    const workers = createWorkers();
    const wallet = await createWallet();
    addAccounts(wallet);
    const before = watchBalances(wallet);
    await vi.waitFor(async () => {
      expect(before.values).toHaveLength(1);
      expect(await lastSuccessfulSyncOf(wallet)).toBeDefined();
    });
    expect(before.values[0]).toMatchObject({
      night: { available: 5n, pending: 0n },
      dust: { balance: 7n, available: 3n },
    });

    workers.connections[0].end('stopped');
    await vi.waitFor(() => {
      expect(before.error).toBeDefined();
    });
    await pastRetryDelay();
    const afterDeath = {
      connects: workers.connect.mock.calls.length,
      attaches: workers.attaches.length,
      operation: await syncOperation(wallet),
      failure: await syncFailureOf(wallet),
    };
    const next = watchBalances(wallet);
    await vi.waitFor(() => {
      expect(next.values).toHaveLength(1);
    });
    await vi.waitFor(async () => {
      expect(await syncOperation(wallet)).toBeUndefined();
    });
    await pastRetryDelay();

    expectNamed(before.error, 'runtime-stopped');
    expect(afterDeath).toEqual({
      connects: 1,
      attaches: 1,
      operation: expect.objectContaining({
        status: 'Failed',
        description: 'sync.operation.midnight-wallet-sync',
        error: 'sync.error.midnight-sync-failed',
      }) as unknown,
      failure: {
        failureId: FailureId(`midnight-sync-${accountId}`),
        message: 'sync.error.midnight-sync-failed',
      },
    });
    expect(workers.connect).toHaveBeenCalledTimes(2);
    expect(workers.attaches).toHaveLength(2);
    expect(await syncFailureOf(wallet)).toBeUndefined();
    expect(next.error).toBeUndefined();
  });

  it('keeps the Failed sync operation of a worker death when the dead engine still held a synced progress, until the next public call syncs again', async () => {
    const workers = createWorkers();
    const wallet = await createWallet();
    addAccounts(wallet);
    await vi.waitFor(async () => {
      expect(await lastSuccessfulSyncOf(wallet)).toBeDefined();
    });

    // Fresh values, as the engine emits them: the watcher drops a value that is the object it saw last.
    const { engineGeneration = '', syncProgress$ } = workers.latest;
    syncProgress$?.next({ engineGeneration, value: { ...synced } });
    syncProgress$?.next({ engineGeneration, value: { ...synced } });
    workers.connections[0].end('stopped');
    await pastRetryDelay();
    const afterDeath = await syncOperation(wallet);
    const next = watchBalances(wallet);
    await vi.waitFor(async () => {
      expect(await syncOperation(wallet)).toBeUndefined();
    });

    expect(afterDeath).toMatchObject({ status: 'Failed' });
    expect(next.error).toBeUndefined();
  });

  it('returns the startup error of a failed re-attach and keeps the gate closed', async () => {
    const workers = createWorkers();
    const wallet = await createWallet();
    addAccounts(wallet);
    await vi.waitFor(() => {
      expect(workers.attaches).toHaveLength(1);
    });
    workers.connections[0].end('stopped');
    await pastRetryDelay();

    workers.control.endEachConnection = 'startup-failed';
    const failing = watchBalances(wallet);
    await vi.waitFor(() => {
      expect(failing.error).toBeDefined();
    });
    wallet.dispatch('wallets.updateWallet', {
      id: fixture.walletId,
      changes: {
        accounts: [
          midnightAccount,
          { ...midnightAccount, accountId: siblingId },
        ],
      },
    });
    await pastRetryDelay();

    expectNamed(failing.error, 'startup-failed');
    expect(workers.connect).toHaveBeenCalledTimes(2);
  });

  it('after a death, starts no worker for an account-list re-emission until a public call opens the gate, then exactly one', async () => {
    const workers = createWorkers();
    const wallet = await createWallet();
    addAccounts(wallet);
    await vi.waitFor(() => {
      expect(workers.attaches).toHaveLength(1);
    });
    workers.connections[0].end('stopped');
    await pastRetryDelay();

    wallet.dispatch('wallets.updateWallet', {
      id: fixture.walletId,
      changes: {
        accounts: [
          midnightAccount,
          { ...midnightAccount, accountId: siblingId },
        ],
      },
    });
    await pastRetryDelay();
    const connectsAfterReEmission = workers.connect.mock.calls.length;
    const next = watchBalances(wallet);
    await vi.waitFor(() => {
      expect(next.values.length).toBeGreaterThan(0);
    });
    await pastRetryDelay();

    expect(connectsAfterReEmission).toBe(1);
    expect(workers.connect).toHaveBeenCalledTimes(2);
  });
});

describe('test:engine-client-consumers', () => {
  it('SDK row: balances read the worker engine view through the shared lookup, and the helpers lookup resolves the worker engine', async () => {
    createWorkers();
    const wallet = await createWallet();
    addAccounts(wallet);
    const balances = watchBalances(wallet);
    await vi.waitFor(() => {
      expect(balances.values).toHaveLength(1);
    });

    expect(balances.values[0]).toMatchObject({
      accountId,
      night: { available: 5n, pending: 0n },
      dust: { balance: 7n, available: 3n },
      synced: { unshielded: true, shielded: true, dust: true },
    });
    const engine = await midnightWalletFor(wallet, {
      accountId,
      startTimeout: 10_000,
    });
    expect(isRemoteMidnightEngine(engine)).toBe(true);
    expect(engine.accountId).toBe(accountId);
  });

  it('SDK row: balances of a worker engine turn synced only with a state view of a synced state, not when the sync progress gets there before the view', async () => {
    const workers = createWorkers();
    const wallet = await createWallet();
    addAccounts(wallet);
    const balances = watchBalances(wallet);
    await vi.waitFor(() => {
      expect(balances.values).toHaveLength(1);
    });
    const [before] = balances.values as object[];
    const notSynced = { unshielded: false, shielded: false, dust: false };
    const ofEngine = <T>(value: T) => ({
      engineGeneration: 'generation-1',
      value,
    });
    workers.latest.stateView$?.next(
      ofEngine({ ...stateView, isStrictlyComplete: notSynced }),
    );
    workers.latest.syncProgress$?.next(
      ofEngine({ ...synced, isStrictlyComplete: notSynced }),
    );
    await vi.waitFor(() => {
      expect(balances.values).toHaveLength(2);
    });

    // The worker's throttled view still holds an older state when the progress of a newer one arrives.
    workers.latest.syncProgress$?.next(ofEngine(synced));
    await pastRetryDelay();
    const aheadOfView = balances.values.slice(2);
    workers.latest.stateView$?.next(
      ofEngine({
        ...stateView,
        unshielded: {
          availableCoins: [
            {
              ...stateView.unshielded.availableCoins[0],
              utxo: { type: NIGHT_TOKEN_ID, value: 9n },
            },
          ],
          pendingCoins: [],
        },
      }),
    );
    await vi.waitFor(() => {
      expect(balances.values.at(-1)).toMatchObject({
        night: { available: 9n },
      });
    });

    expect(aheadOfView).toEqual([]);
    expect(balances.values.slice(1)).toEqual([
      { ...before, synced: notSynced },
      {
        ...before,
        night: { available: 9n, pending: 0n },
        synced: synced.isStrictlyComplete,
      },
    ]);
  });
  it('SDK row: balances watched before the worker engine starts follow the watcher across a failure the live worker reports, instead of erroring', async () => {
    const workers = createWorkers();
    let releaseAttach = () => undefined as void;
    workers.control.attach = async () =>
      new Promise<void>(resolve => {
        releaseAttach = resolve;
      });
    const wallet = await createWallet();
    addAccounts(wallet);
    await vi.waitFor(() => {
      expect(workers.attaches).toHaveLength(1);
    });
    const balances = watchBalances(wallet);
    await pastRetryDelay();
    workers.control.attach = async () => undefined;
    releaseAttach();
    await vi.waitFor(() => {
      expect(balances.values).toHaveLength(1);
    });
    const [before] = balances.values as object[];

    workers.latest.status$?.next({
      resets: 0,
      engineGeneration: 'generation-1',
      failure: 'ws lost',
    });
    await vi.waitFor(
      () => {
        expect(workers.attaches).toHaveLength(2);
      },
      { timeout: 5000 },
    );
    await vi.waitFor(() => {
      expect(balances.values).toHaveLength(3);
    });

    expect(balances.error).toBeUndefined();
    expect(balances.values).toEqual([
      before,
      {
        ...before,
        synced: { unshielded: false, shielded: false, dust: false },
      },
      before,
    ]);
  });

  it('SDK row: balances of a worker engine error the subscriber with a failure of their own reading, such as a state view they cannot read, instead of holding it not synced', async () => {
    const workers = createWorkers();
    const wallet = await createWallet();
    addAccounts(wallet);
    const balances = watchBalances(wallet);
    await vi.waitFor(() => {
      expect(balances.values).toHaveLength(1);
    });

    workers.latest.stateView$?.next({
      engineGeneration: 'generation-1',
      value: { ...stateView, unshielded: undefined },
    });
    await vi.waitFor(() => {
      expect(balances.error).toBeDefined();
    });

    expect(balances.error).toBeInstanceOf(TypeError);
    expect(balances.values).toHaveLength(1);
  });
});

describe('test:engine-client-storage-routing', () => {
  it('SDK row: after a worker reset, balances are not synced until the replacement engine reports its own state synced, as in page mode', async () => {
    const workers = createWorkers();
    const wallet = await createWallet();
    addAccounts(wallet);
    const balances = watchBalances(wallet);
    await vi.waitFor(() => {
      expect(balances.values).toHaveLength(1);
    });
    const [before] = balances.values as object[];
    const notSynced = { unshielded: false, shielded: false, dust: false };
    const replacementView = (isStrictlyComplete: typeof notSynced) => ({
      engineGeneration: 'generation-2',
      value: {
        ...stateView,
        unshielded: { availableCoins: [], pendingCoins: [] },
        isStrictlyComplete,
      },
    });

    workers.latest.status$?.next({
      resets: 1,
      engineGeneration: 'generation-2',
    });
    workers.latest.address$?.next({
      engineGeneration: 'generation-2',
      value: address,
    });
    workers.latest.stateView$?.next(replacementView(notSynced));
    await pastRetryDelay();
    const beforeSynced = balances.values.slice(1);
    workers.latest.stateView$?.next(replacementView(synced.isStrictlyComplete));
    await pastRetryDelay();

    const replacement = { ...before, night: { available: 0n, pending: 0n } };
    expect(beforeSynced).toEqual([
      { ...before, synced: notSynced },
      { ...replacement, synced: notSynced },
    ]);
    expect(balances.values.slice(1)).toEqual([
      { ...before, synced: notSynced },
      { ...replacement, synced: notSynced },
      { ...replacement, synced: synced.isStrictlyComplete },
    ]);
  });

  it('a worker reset never restores the activities or the sync of the replaced engine that the transport replays, once the fresh history arrives later', async () => {
    const workers = createWorkers();
    const wallet = await createWallet();
    addAccounts(wallet);
    await vi.waitFor(() => {
      expect(workers.latest.transactionHistory$).toBeDefined();
    });
    const rows = async () => activityRowsOf(wallet);
    workers.latest.transactionHistory$?.next({
      engineGeneration: 'generation-1',
      value: [receiveEntry('replaced')],
    });
    await vi.waitFor(async () => {
      expect(await rows()).toHaveLength(1);
    });

    // The host's status after a reset: the replacement engine runs, before it has loaded any history.
    workers.latest.status$?.next({
      resets: 1,
      engineGeneration: 'generation-2',
    });
    await pastRetryDelay();
    workers.latest.transactionHistory$?.next({
      engineGeneration: 'generation-2',
      value: [],
    });
    await pastRetryDelay();

    expect(await rows()).toEqual([]);
    expect(await syncOperation(wallet)).toMatchObject({ status: 'Pending' });
  });

  it.each([
    {
      failure: `The reset of Midnight account "${accountId}" did not wipe its checkpoint: disk full`,
      message: 'a message',
    },
    { failure: '', message: 'an empty message' },
  ])(
    'a held worker reset whose wipe fails with $message shows the resync as Failed',
    async ({ failure }) => {
      const workers = createWorkers();
      const wallet = await createWallet();
      addAccounts(wallet);
      await vi.waitFor(() => {
        expect(workers.latest.status$).toBeDefined();
      });
      const operations: unknown[] = [];
      const subscription =
        wallet.stateObservables.sync.selectSyncStatusByAccount$
          .pipe(
            map(
              statuses =>
                statuses[accountId]?.pendingSync?.operations[
                  `${accountId}-midnight-sync`
                ],
            ),
          )
          .subscribe(operation => operations.push(operation));
      onTestFinished(() => {
        subscription.unsubscribe();
      });
      const resync = (status: string) =>
        expect.objectContaining({
          status,
          description: 'sync.operation.midnight-resync',
        }) as unknown;

      // The host's status while the reset waits for a settling submission, then once its wipe failed.
      workers.latest.status$?.next({
        resets: 0,
        engineGeneration: 'generation-1',
        resetPending: true,
      });
      await vi.waitFor(() => {
        expect(operations).toContainEqual(resync('Pending'));
      });
      workers.latest.status$?.next({
        resets: 0,
        engineGeneration: 'generation-1',
        failure,
      });

      await vi.waitFor(() => {
        expect(operations).toContainEqual(resync('Failed'));
      });
    },
  );

  it('routes a reset, a bulk resync and a wallet deletion dispatched through the existing actions to the worker', async () => {
    const workers = createWorkers();
    const wallet = await createWallet();
    addAccounts(wallet);
    await vi.waitFor(() => {
      expect(workers.attaches).toHaveLength(1);
    });
    const clientId = workers.attaches[0].clientId;

    wallet.dispatch('midnightContext.resetSyncState', { accountId });
    await vi.waitFor(() => {
      expect(workers.storageCalls).toHaveLength(1);
    });
    wallet.dispatch('midnightSync.resync');
    await vi.waitFor(() => {
      expect(workers.storageCalls).toHaveLength(2);
    });
    wallet.dispatch('wallets.removeWallet', fixture.walletId, [accountId]);
    await vi.waitFor(() => {
      expect(workers.storageCalls).toHaveLength(3);
    });

    expect(workers.storageCalls.map(({ method }) => method)).toEqual([
      'resetAccount',
      'resyncAll',
      'deleteWallet',
    ]);
    const [reset, resync, deletion] = workers.storageCalls.map(
      ({ request }) =>
        request as { authority?: { account: { accountId: string } } },
    );
    expect(reset).toMatchObject({ clientId, accountId, storage: 'memory' });
    expect(reset.authority?.account.accountId).toBe(accountId);
    expect(resync).toMatchObject({ clientId, storage: 'memory' });
    expect(deletion).toMatchObject({
      clientId,
      walletId: fixture.walletId,
      storage: 'memory',
    });
  });
});
