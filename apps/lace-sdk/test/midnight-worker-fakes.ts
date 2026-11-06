import { NIGHT_TOKEN_ID } from '@lace-contract/midnight-context';
import * as fixture from '@lace-contract/midnight-context/src/stub-data';
import { Percent } from '@lace-lib/cardano-util';
import { SubmissionError } from '@midnightntwrk/wallet-sdk/capabilities/submission';
import { NodeClientError } from '@midnightntwrk/wallet-sdk/node-client/effect';
import { Effect } from 'effect';
import {
  BehaviorSubject,
  filter,
  firstValueFrom,
  Subject,
  timeout,
} from 'rxjs';
import { dummyLogger } from 'ts-log';
import { onTestFinished, vi } from 'vitest';

import {
  createLaceWallet,
  createMidnightModule,
  FEATURE_FLAG_MIDNIGHT,
  FEATURE_FLAG_MIDNIGHT_UNSHIELDED,
  FEATURE_FLAG_NETWORK_TYPE,
  m,
} from '../src/midnight';
import { resolveMidnightAccountId } from '../src/midnight-wallet';
import { runMidnightEngineWorker } from '../src/midnight-worker/run-engine-worker';

import type { CreateMidnightModuleProps } from '../src/midnight';
import type { MidnightEngineWorkerScope } from '../src/midnight-worker/run-engine-worker';
import type { MidnightAccountId } from '@lace-contract/midnight-context';
import type { SharedWorkerLocks } from '@lace-lib/extension-messaging';
import type {
  MidnightEngineHost,
  OpaqueMidnightFinalizedTx,
  OpaqueMidnightRecipe,
} from '@lace-module/midnight-sync/sdk';

type LockRequest = {
  readonly agent: string;
  readonly mode: LockMode;
  readonly grant: () => void;
};

type HeldLock = {
  readonly agent: string;
  readonly mode: LockMode;
  readonly reject: (reason: unknown) => void;
};

/**
 * One origin's Web Locks, seen by several agents (a page, the worker). A lock is held until its callback settles or
 * its agent dies; requests are granted in order when compatible.
 */
export const createLockManager = () => {
  const held = new Map<string, HeldLock[]>();
  const queued = new Map<string, LockRequest[]>();
  const pump = (name: string) => {
    const queue = queued.get(name) ?? [];
    while (queue.length > 0) {
      const holders = held.get(name) ?? [];
      const [next] = queue;
      const isCompatible =
        holders.length === 0 ||
        (next.mode === 'shared' &&
          holders.every(holder => holder.mode === 'shared'));
      if (!isCompatible) return;
      queue.shift();
      next.grant();
    }
  };
  const release = (name: string, lock: HeldLock) => {
    const holders = held.get(name) ?? [];
    if (!holders.includes(lock)) return;
    held.set(
      name,
      holders.filter(holder => holder !== lock),
    );
    pump(name);
  };
  const view = (agent: string): SharedWorkerLocks => ({
    request: async (name, options, callback) =>
      new Promise((resolve, reject) => {
        const mode = options.mode ?? 'exclusive';
        const request: LockRequest = {
          agent,
          mode,
          grant: () => {
            const lock: HeldLock = { agent, mode, reject };
            held.set(name, [...(held.get(name) ?? []), lock]);
            Promise.resolve()
              .then(async () => callback({ name, mode } as Lock))
              .then(resolve, reject)
              .finally(() => {
                release(name, lock);
              });
          },
        };
        options.signal?.addEventListener('abort', () => {
          const queue = queued.get(name) ?? [];
          if (!queue.includes(request)) return;
          queued.set(
            name,
            queue.filter(candidate => candidate !== request),
          );
          reject(new DOMException('The request was aborted', 'AbortError'));
        });
        queued.set(name, [...(queued.get(name) ?? []), request]);
        pump(name);
      }),
  });
  /** Ends an agent as the browser does when it dies: its locks go and its requests are dropped. */
  const kill = (agent: string) => {
    for (const [name, holders] of held) {
      for (const lock of holders.filter(holder => holder.agent === agent))
        release(name, lock);
    }
    for (const [name, queue] of queued)
      queued.set(
        name,
        queue.filter(request => request.agent !== agent),
      );
  };
  /**
   * What `request(name, { steal: true })` from another context does: every lock the agent holds passes to that
   * context, which keeps it, and the agent's request for it rejects with an `AbortError`.
   */
  const steal = (agent: string) => {
    for (const [name, holders] of held) {
      const stolen = holders.filter(holder => holder.agent === agent);
      if (stolen.length === 0) continue;
      held.set(name, [
        ...holders.filter(holder => holder.agent !== agent),
        { agent: 'thief', mode: 'exclusive', reject: () => undefined },
      ]);
      for (const lock of stolen)
        lock.reject(new DOMException('The lock was stolen', 'AbortError'));
    }
  };
  return { view, kill, steal };
};

const tag = <T>(value: T) => ({ engineGeneration: 'generation-1', value });

/** An opaque recipe as the worker returns it: plain data only. */
export const workerRecipe = (
  accountId = fixture.accountId,
): OpaqueMidnightRecipe =>
  ({
    accountId,
    engineGeneration: 'generation-1',
    type: 'UNPROVEN_TRANSACTION',
    transaction: new Uint8Array([1, 2, 3]),
  } as unknown as OpaqueMidnightRecipe);

/** An opaque proved transaction as the worker returns it. */
export const workerFinalizedTx = (
  accountId = fixture.accountId,
): OpaqueMidnightFinalizedTx =>
  ({
    accountId,
    engineGeneration: 'generation-1',
    transaction: new Uint8Array([4, 5, 6]),
    activityHash: 'worker-hash',
  } as unknown as OpaqueMidnightFinalizedTx);

/** The node's reason in {@link nodeRejection}. */
export const NODE_REJECTION_MESSAGE =
  'Transaction is invalid and was rejected by the node';

/**
 * The error the engine's submission fails with when the node rejects the transaction, built as the wallet SDK builds
 * it: its submission service runs an Effect to a promise, which rejects with Effect's `FiberFailure` around the
 * service's `SubmissionError`, whose cause is the node client's error.
 */
export const nodeRejection = async (): Promise<Error> =>
  Effect.runPromise(
    Effect.fail(
      new SubmissionError({
        message: 'Transaction submission error',
        cause: new NodeClientError.TransactionInvalidError({
          message: NODE_REJECTION_MESSAGE,
          txData: new Uint8Array([4, 5, 6]),
        }),
      }),
    ),
  ).catch((error: Error) => error);

/** The state view a worker engine of a funded account publishes. */
export const workerStateView = {
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
  isStrictlyComplete: { shielded: true, unshielded: true, dust: true },
};

/**
 * The engine host of the worker, answering each operation with plain data as the real host does. Its streams are
 * those of one running engine of the fixture account.
 */
export const createFakeEngineHost = () => {
  const progress$ = new Subject<unknown>();
  const host = {
    attach: vi.fn<MidnightEngineHost['attach']>(async request => ({
      accountId: request.account.accountId as MidnightAccountId,
      walletId: fixture.walletId,
      networkId: fixture.networkId,
      nightVerifyingKey: 'night-key',
      engineGeneration: 'generation-1',
      resets: 0,
      settings: request.settings,
    })),
    detach: vi.fn<MidnightEngineHost['detach']>(async () => undefined),
    detachClient: vi.fn<MidnightEngineHost['detachClient']>(
      async () => undefined,
    ),
    streams: vi.fn(() => ({
      address$: new BehaviorSubject(
        tag({
          shielded: fixture.midnightShieldedAddress,
          unshielded: fixture.midnightUnshieldedAddress,
          dust: fixture.midnightDustAddress,
        }),
      ),
      areKeysAvailable$: new BehaviorSubject(tag(true)),
      coinsByTokenType$: new BehaviorSubject(
        tag({ shielded: {}, unshielded: {} }),
      ),
      syncProgress$: new BehaviorSubject(
        tag({
          shielded: Percent(1),
          unshielded: Percent(1),
          dust: Percent(1),
          isStrictlyComplete: { shielded: true, unshielded: true, dust: true },
        }),
      ),
      transactionHistory$: new BehaviorSubject(tag([])),
      stateView$: new BehaviorSubject(tag(workerStateView)),
      progress$,
      status$: new BehaviorSubject({
        engineGeneration: 'generation-1',
        resets: 0,
      }),
    })),
    build: vi.fn<MidnightEngineHost['build']>(async () => workerRecipe()),
    estimate: vi.fn<MidnightEngineHost['estimate']>(async () => ({
      dustFee: 2n,
      availableDust: 9n,
    })),
    sign: vi.fn<MidnightEngineHost['sign']>(async () => workerRecipe()),
    prove: vi.fn<MidnightEngineHost['prove']>(async () => workerFinalizedTx()),
    discard: vi.fn<MidnightEngineHost['discard']>(async () => undefined),
    preparePendingActivity: vi.fn<MidnightEngineHost['preparePendingActivity']>(
      async () => undefined,
    ),
    submit: vi.fn<MidnightEngineHost['submit']>(async () => ({
      txId: 'worker-tx',
    })),
    signData: vi.fn<MidnightEngineHost['signData']>(async () => ({
      signature: 'worker-signature',
      verifyingKey: 'worker-key',
    })),
    buildConnectorTransaction: vi.fn<
      MidnightEngineHost['buildConnectorTransaction']
    >(async () => workerFinalizedTx()),
    checkCircuit: vi.fn<MidnightEngineHost['checkCircuit']>(async () => [
      1n,
      undefined,
    ]),
    proveCircuit: vi.fn<MidnightEngineHost['proveCircuit']>(
      async () => new Uint8Array([7, 8, 9]),
    ),
    transactionHistoryEntry: vi.fn<
      MidnightEngineHost['transactionHistoryEntry']
    >(async () => undefined),
    signTransaction: vi.fn<MidnightEngineHost['signTransaction']>(
      async () => ({ type: 'signed' } as never),
    ),
    resetAccount: vi.fn<MidnightEngineHost['resetAccount']>(
      async () => undefined,
    ),
    resyncAll: vi.fn<MidnightEngineHost['resyncAll']>(async () => undefined),
    deleteWallet: vi.fn<MidnightEngineHost['deleteWallet']>(
      async () => undefined,
    ),
  };
  return {
    host,
    progress$,
    asHost: () => host as unknown as MidnightEngineHost,
  };
};

/** A browser's SharedWorker as a Node test can host it. */
type FakeSharedWorkerOptions = {
  /** A browser whose SharedWorker runs classic scripts only, and so never reads `type`. */
  readonly isClassicOnly?: boolean;
  /** Each worker's load of its engine host; by default it serves `host`. */
  readonly loadHost?: () => Promise<MidnightEngineHost>;
  /** The locks each worker uses, by its number from 1; by default the origin's. */
  readonly workerLocks?: (
    locks: SharedWorkerLocks,
    worker: number,
  ) => SharedWorkerLocks;
};

type FakeWorker = {
  readonly agent: string;
  readonly scope: MidnightEngineWorkerScope;
  readonly listeners: Parameters<
    MidnightEngineWorkerScope['addEventListener']
  >[1][];
  readonly ports: MessagePort[];
  /** Whether the worker closed itself. */
  isClosed: boolean;
};

/**
 * Installs a browser around the test: a `SharedWorker` constructor whose worker runs the SDK's real worker side
 * (`runMidnightEngineWorker`) over `MessageChannel` ports and serves `host`, and `navigator.locks` shared with it.
 * Pages share the running worker, as the browser shares one by name; `killWorker()` ends it as the browser would,
 * a worker that closes itself ends the same way, and the next construction starts a new one. Every page uses the
 * lock agent `'page'` unless it takes the locks of its own agent from `locksOf(agent)`; `kill(agent)` closes that
 * page, and `steal(agent)` takes its locks, such as the runtime lock of the worker `'worker-1'`, as another context
 * would. The test's end closes every port.
 */
export const installFakeBrowser = (
  host: MidnightEngineHost,
  {
    isClassicOnly = false,
    loadHost = async () => host,
    workerLocks = locks => locks,
  }: FakeSharedWorkerOptions = {},
) => {
  const locks = createLockManager();
  const workers: FakeWorker[] = [];
  const pagePorts: MessagePort[] = [];
  const started: { url: string; options: unknown }[] = [];
  let running: FakeWorker | undefined;
  const end = (worker: FakeWorker) => {
    locks.kill(worker.agent);
    for (const port of worker.ports) port.close();
    if (running === worker) running = undefined;
  };
  const startWorker = (): FakeWorker => {
    const worker: FakeWorker = {
      agent: `worker-${workers.length + 1}`,
      listeners: [],
      ports: [],
      isClosed: false,
      scope: {
        addEventListener: (_type, listener) => {
          worker.listeners.push(listener);
        },
        close: () => {
          worker.isClosed = true;
          end(worker);
        },
      },
    };
    workers.push(worker);
    void runMidnightEngineWorker({
      scope: worker.scope,
      locks: workerLocks(locks.view(worker.agent), workers.length),
      buffer: Buffer,
      loadHost,
      logger: dummyLogger,
    });
    return worker;
  };
  class FakeSharedWorker {
    public readonly port: MessagePort;

    public constructor(url: URL | string, options?: WorkerOptions | string) {
      const type =
        typeof options === 'object' && !isClassicOnly
          ? options.type
          : undefined;
      if (String(url) === 'blob://')
        throw new DOMException('Script cannot be accessed', 'SecurityError');
      started.push({
        url: String(url),
        options: { ...(options as object), type },
      });
      running ??= startWorker();
      const { port1, port2 } = new MessageChannel();
      pagePorts.push(port1);
      running.ports.push(port2);
      for (const listener of running.listeners) listener({ ports: [port2] });
      this.port = port1;
    }
  }
  vi.stubGlobal('SharedWorker', FakeSharedWorker);
  vi.stubGlobal('navigator', { locks: locks.view('page') });
  onTestFinished(() => {
    for (const port of [
      ...pagePorts,
      ...workers.flatMap(worker => worker.ports),
    ])
      port.close();
    vi.unstubAllGlobals();
  });
  return {
    started,
    workers,
    kill: locks.kill,
    steal: locks.steal,
    locksOf: locks.view,
    killWorker: () => {
      if (running) end(running);
    },
  };
};

const flagList = [
  { key: FEATURE_FLAG_MIDNIGHT },
  { key: FEATURE_FLAG_MIDNIGHT_UNSHIELDED },
  { key: FEATURE_FLAG_NETWORK_TYPE, payload: 'testnet' },
];

/** The module's password in these tests. */
export const PASSWORD = new Uint8Array([1]);

/** An SDK wallet with the Midnight module, created with `props` over local endpoints for the fixture network. */
export const createMidnightWallet = async (
  props: Partial<CreateMidnightModuleProps> = {},
) => {
  const wallet = await createLaceWallet({
    modules: [
      m.featureDev,
      m.storageInMemory,
      createMidnightModule({
        password: PASSWORD,
        networks: {
          [fixture.networkId]: {
            nodeAddress: 'http://localhost:9944',
            indexerAddress: 'http://localhost:8088/graphql',
          },
        },
        ...props,
      }),
    ] as const,
    environment: 'development',
    featureFlags: flagList,
    config: {
      defaultFeatureFlags: flagList,
      extraFeatureFlags: [],
      defaultMidnightTestnetNetworkId: fixture.networkId,
    },
  });
  await firstValueFrom(
    wallet.stateObservables.midnightContext.selectCurrentNetwork$.pipe(
      // Store side effects apply the loadout's overrides asynchronously; a later change would restart the watch.
      filter(network => network.config.nodeAddress === 'http://localhost:9944'),
      timeout(5000),
    ),
  );
  onTestFinished(() => {
    wallet.dispatch('wallets.removeWallet', fixture.walletId, [
      fixture.accountId,
    ]);
  });
  return wallet;
};

/** Adds the fixture's in-memory Midnight account, whose engine the module then starts, once helpers can find it. */
export const addMidnightAccount = async (
  wallet: Awaited<ReturnType<typeof createMidnightWallet>>,
) => {
  wallet.dispatch('wallets.addWallet', {
    ...fixture.midnightWallet,
    accounts: [fixture.midnightAccount],
  });
  await vi.waitFor(async () =>
    resolveMidnightAccountId(wallet, fixture.accountId),
  );
};
