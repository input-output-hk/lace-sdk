import { failuresActions } from '@lace-contract/failures';
import { MidnightSDKNetworkIds } from '@lace-contract/midnight-context';
import { syncActions } from '@lace-contract/sync';
import { filter, firstValueFrom, NEVER, Subject, throwError } from 'rxjs';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { midnightSyncActions } from '../../src/store/actions';
import { surfaceMidnightEngineFailures } from '../../src/store/side-effects/watch';
import { MidnightSyncFailureId } from '../../src/value-objects/midnight-sync-failure-id.vo';
import { MidnightEngineClientError } from '../../src/worker/engine-client';

import {
  createClient,
  createFakeWorkers,
  flush,
  passwordAuth,
  startParams,
  until,
} from './engine-client-fakes';
import {
  createMemoryStore,
  events,
  fakeEngines,
  PASSWORD,
  sealedAccount,
  useFastKeyDerivation,
  WRONG_PASSWORD,
} from './engine-host-fakes';

import type { SideEffect } from '../../src/context';
import type {
  MidnightEngineClient,
  MidnightRemoteEngineClient,
} from '../../src/worker/engine-client';
import type { MidnightAccountProps } from '@lace-contract/midnight-context';
import type { InMemoryWalletAccount } from '@lace-contract/wallet-repo';
import type { Action } from '@reduxjs/toolkit';
import type { Subscription } from 'rxjs';

vi.mock('../../src/store/dependencies', async importOriginal => {
  const fakes = await import('./engine-host-fakes');
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    createStartMidnightAccountWallet: fakes.fakeEngines.createStart,
  };
});

type Account = InMemoryWalletAccount<MidnightAccountProps>;

const actions = {
  ...midnightSyncActions,
  ...failuresActions,
  ...syncActions,
};

/** A watcher's view of one start: what it emitted, and whether it ended. */
const watchStart = (client: MidnightEngineClient, account: Account) => {
  const engines: MidnightRemoteEngineClient[] = [];
  const outcome: { error?: unknown; completed: boolean } = { completed: false };
  const subscription = client
    .startAccountEngine(startParams(account))
    .subscribe({
      next: engine => engines.push(engine),
      error: (error: unknown) => {
        outcome.error = error;
      },
      complete: () => {
        outcome.completed = true;
      },
    });
  return { engines, outcome, subscription };
};

const synced = {
  shielded: 1,
  unshielded: 1,
  dust: 1,
  isStrictlyComplete: { shielded: true, unshielded: true, dust: true },
};

const failuresOf = async (client: MidnightEngineClient) =>
  firstValueFrom(client.startFailures$);

const attachCalls = (workers: ReturnType<typeof createFakeWorkers>) =>
  workers.connections.flatMap(({ calls }) =>
    calls.filter(({ method }) => method === 'attach'),
  );

/** The failure and the Failed sync operation the watcher publishes for an account whose engine did not start. */
const failedSyncOf = (account: Account): unknown[] => [
  actions.failures.addFailure({
    failureId: MidnightSyncFailureId(account.accountId),
    message: 'sync.error.midnight-sync-failed',
  }),
  {
    type: actions.sync.addSyncOperation.type,
    payload: {
      accountId: account.accountId,
      operation: {
        operationId: `${account.accountId}-midnight-sync`,
        status: 'Failed',
        description: 'sync.operation.midnight-wallet-sync',
        error: 'sync.error.midnight-sync-failed',
        startedAt: expect.any(Number) as unknown,
        failedAt: expect.any(Number) as unknown,
      },
    },
  },
];

describe('test:engine-client-failures', () => {
  let a: Account;
  let b: Account;
  const subscriptions: Subscription[] = [];

  beforeAll(async () => {
    useFastKeyDerivation();
    a = await sealedAccount({ walletId: 'wallet-a' });
    b = await sealedAccount({
      walletId: 'wallet-a',
      accountIndex: 1,
      network: MidnightSDKNetworkIds.Preview,
    });
  });
  beforeEach(() => {
    fakeEngines.reset();
    useFastKeyDerivation();
  });
  afterEach(() => {
    for (const subscription of subscriptions.splice(0))
      subscription.unsubscribe();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const started = (client: MidnightEngineClient, account: Account) => {
    const start = watchStart(client, account);
    subscriptions.push(start.subscription);
    return start;
  };

  /** What the side effect that publishes start failures emits for this client. */
  const surfaced = (client: MidnightEngineClient) => {
    const emitted: Action[] = [];
    subscriptions.push(
      surfaceMidnightEngineFailures(client)(
        {} as Parameters<SideEffect>[0],
        {} as Parameters<SideEffect>[1],
        { actions } as unknown as Parameters<SideEffect>[2],
      ).subscribe(action => emitted.push(action)),
    );
    return emitted;
  };

  it('emits the remote engine once attached, sending the host a copy of the password that it then zeroes', async () => {
    const workers = createFakeWorkers();
    const auth = passwordAuth();
    const client = createClient(workers, {
      accessAuthSecret: auth.accessAuthSecret,
    });

    const { engines, outcome } = started(client, a);
    await until(() => engines.length === 1);

    const [engine] = engines;
    expect(engine.remote).toBe(true);
    expect(engine.accountId).toBe(a.accountId);
    expect(engine.walletId).toBe(a.walletId);
    expect(outcome).toEqual({ completed: false });
    const [attach] = attachCalls(workers);
    const sent = (attach.request as { password: Uint8Array }).password;
    expect(sent).not.toBe(auth.lent[0]);
    expect(sent.every(byte => byte === 0)).toBe(true);
    expect(auth.lent[0].every(byte => byte === 0)).toBe(true);
    expect(workers.connect).toHaveBeenCalledOnce();
  });

  describe('a refused first start', () => {
    const refusals: {
      reason: string;
      setUp: (
        workers: ReturnType<typeof createFakeWorkers>,
      ) => Promise<MidnightEngineClient>;
    }[] = [
      {
        reason: 'wrong-password',
        setUp: async workers =>
          createClient(workers, {
            accessAuthSecret: passwordAuth(WRONG_PASSWORD).accessAuthSecret,
          }),
      },
      {
        reason: 'settings-conflict',
        setUp: async workers => {
          await workers.worker.host.attach({
            clientId: 'other-tab',
            account: a,
            password: PASSWORD.slice(),
            settings: {
              config: {
                ...startParams(a).config,
                proofServer: {
                  kind: 'delegated',
                  url: 'https://prover.example',
                  label: 'prover.example',
                },
              },
              attestedProver: false,
              storage: 'memory',
            },
          });
          return createClient(workers);
        },
      },
      {
        reason: 'attested-prover',
        setUp: async workers => createClient(workers, { attestedProver: true }),
      },
    ];

    it.each(refusals)(
      'records $reason for the account, publishes its Failed sync for each refused attach, neither errors nor emits, and holds every later start until a public operation requests the engine',
      async ({ reason, setUp }) => {
        const workers = createFakeWorkers();
        const client = await setUp(workers);
        const emitted = surfaced(client);

        let failures: Awaited<ReturnType<typeof failuresOf>> = {};
        subscriptions.push(
          client.startFailures$.subscribe(current => {
            failures = current;
          }),
        );

        const first = started(client, a);
        await until(() => !!failures[a.accountId]);
        const failure = failures[a.accountId];
        const again = started(client, a);
        await flush();
        await flush();
        const attachesBeforeRequest = attachCalls(workers).length;
        client.requestEngine(a.accountId);
        const isClearedOnRequest = !failures[a.accountId];
        await until(
          () => attachCalls(workers).length === 3 && !!failures[a.accountId],
        );
        await until(() => emitted.length === 6);

        expect(failure).toBeInstanceOf(MidnightEngineClientError);
        expect((failure as MidnightEngineClientError).reason).toBe(reason);
        expect(emitted).toEqual([
          ...failedSyncOf(a),
          ...failedSyncOf(a),
          ...failedSyncOf(a),
        ]);
        expect(first.engines).toEqual([]);
        expect(first.outcome).toEqual({ completed: false });
        expect(again.engines).toEqual([]);
        expect(attachesBeforeRequest).toBe(1);
        expect(isClearedOnRequest).toBe(true);
        expect(failures[a.accountId]).toMatchObject({ reason });
      },
    );

    it('records start-timeout when the worker cancels a start at its bound, and never restarts that restore by itself', async () => {
      const workers = createFakeWorkers();
      const client = createClient(workers);
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
      });
      fakeEngines.hold = new Promise(() => undefined);

      const start = started(client, a);
      await until(() => fakeEngines.of(a.accountId).length === 1);
      await vi.advanceTimersByTimeAsync(120_000);
      await flush();
      const failure = (await failuresOf(client))[a.accountId];
      await vi.advanceTimersByTimeAsync(10 * 120_000);
      await flush();
      const startsWithoutRequest = fakeEngines.of(a.accountId).length;
      client.requestEngine(a.accountId);
      await until(() => fakeEngines.of(a.accountId).length === 2);

      expect(failure).toMatchObject({ reason: 'start-timeout' });
      expect(startsWithoutRequest).toBe(1);
      expect(attachCalls(workers)).toHaveLength(2);
      expect(start.outcome).toEqual({ completed: false });
    });

    it('lets a transient failure error the start, so the watcher retries it, and records nothing', async () => {
      const workers = createFakeWorkers();
      const client = createClient(workers);
      const indexerDown = new Error('indexer down');
      fakeEngines.failNextStart = indexerDown;

      const start = started(client, a);
      await until(() => start.outcome.error !== undefined);

      expect(start.outcome.error).toMatchObject({ message: 'indexer down' });
      expect(await failuresOf(client)).toEqual({});
    });
  });

  describe('the death of the worker', () => {
    it('records runtime-stopped for every served account before their streams complete, without an error', async () => {
      const workers = createFakeWorkers();
      const client = createClient(workers);
      const startA = started(client, a);
      const startB = started(client, b);
      await until(
        () => startA.engines.length === 1 && startB.engines.length === 1,
      );
      const order: string[] = [];
      subscriptions.push(
        client.startFailures$.subscribe(failures => {
          for (const accountId of Object.keys(failures))
            if (!order.includes(`failure:${accountId}`))
              order.push(`failure:${accountId}`);
        }),
      );
      const ends: Record<string, string> = {};
      for (const engine of [startA.engines[0], startB.engines[0]])
        subscriptions.push(
          engine.address$.subscribe({
            error: () => {
              ends[engine.accountId] = 'error';
            },
            complete: () => {
              ends[engine.accountId] = 'complete';
              order.push(`complete:${engine.accountId}`);
            },
          }),
        );

      workers.kill();
      await flush();

      const failures = await failuresOf(client);
      expect(failures[a.accountId]).toMatchObject({
        reason: 'runtime-stopped',
      });
      expect(failures[b.accountId]).toMatchObject({
        reason: 'runtime-stopped',
      });
      expect(ends).toEqual({
        [a.accountId]: 'complete',
        [b.accountId]: 'complete',
      });
      expect(order.indexOf(`failure:${a.accountId}`)).toBeLessThan(
        order.indexOf(`complete:${a.accountId}`),
      );
      expect(startA.outcome).toEqual({ completed: false });
    });

    it('fails a call in flight with runtime-stopped', async () => {
      const workers = createFakeWorkers();
      const client = createClient(workers);
      const { engines } = started(client, a);
      await until(() => engines.length === 1);
      vi.mocked(
        fakeEngines.current(a.accountId).engine.signData,
      ).mockReturnValue(NEVER);

      const signing = firstValueFrom(engines[0].signData(new Uint8Array([1])));
      await until(() =>
        workers.connections[0].calls.some(
          ({ method }) => method === 'signData',
        ),
      );
      workers.kill();

      await expect(signing).rejects.toMatchObject({
        reason: 'runtime-stopped',
        accountId: a.accountId,
      });
    });

    it('keeps the running start waiting, then re-attaches it once through one new worker when a public operation requests the engine', async () => {
      const workers = createFakeWorkers();
      const client = createClient(workers);
      const start = started(client, a);
      await until(() => start.engines.length === 1);

      workers.kill();
      await flush();
      await flush();
      const connectsAfterDeath = workers.connect.mock.calls.length;
      client.requestEngine(a.accountId);
      await until(() => start.engines.length === 2);

      expect(connectsAfterDeath).toBe(1);
      expect(workers.connect).toHaveBeenCalledTimes(2);
      expect(workers.connections[1].clientId).not.toBe(
        workers.connections[0].clientId,
      );
      expect(
        workers.connections[1].calls.filter(
          ({ method }) => method === 'attach',
        ),
      ).toHaveLength(1);
      expect((await failuresOf(client))[a.accountId]).toBeUndefined();
      expect(start.outcome).toEqual({ completed: false });
    });

    it('starts no worker for a start requested after the death, until a public operation requests an engine', async () => {
      const workers = createFakeWorkers();
      const client = createClient(workers);
      const startA = started(client, a);
      await until(() => startA.engines.length === 1);
      workers.kill();
      await flush();

      const startB = started(client, b);
      await flush();
      await flush();
      const connectsBeforeRequest = workers.connect.mock.calls.length;
      client.requestEngine(a.accountId);
      await until(
        () => startA.engines.length === 2 && startB.engines.length === 1,
      );

      expect(connectsBeforeRequest).toBe(1);
      expect(workers.connect).toHaveBeenCalledTimes(2);
    });

    it('records the startup error of a failed re-attach and closes the gate again', async () => {
      const workers = createFakeWorkers();
      const client = createClient(workers);
      const start = started(client, a);
      await until(() => start.engines.length === 1);
      workers.kill();
      await flush();
      workers.control.startReady = false;

      client.requestEngine(a.accountId);
      await until(() => workers.connections.length === 2);
      workers.connections[1].end('startup-failed');
      await flush();
      await flush();
      const failure = (await failuresOf(client))[a.accountId];
      started(client, b);
      await flush();
      await flush();

      expect(failure).toMatchObject({ reason: 'startup-failed' });
      expect(workers.connect).toHaveBeenCalledTimes(2);
      expect(start.engines).toHaveLength(1);
      expect(start.outcome).toEqual({ completed: false });
    });

    it('publishes the Failed sync operation without a retry action for every account the worker served at its death, and nothing when a public operation re-attaches one', async () => {
      const workers = createFakeWorkers();
      const client = createClient(workers);
      const emitted = surfaced(client);
      const startA = started(client, a);
      const startB = started(client, b);
      await until(
        () => startA.engines.length === 1 && startB.engines.length === 1,
      );

      workers.kill();
      await until(() => emitted.length === 4);
      const atDeath = [...emitted];
      client.requestEngine(a.accountId);
      await until(() => startA.engines.length === 2);
      await flush();

      expect(atDeath).toEqual([...failedSyncOf(a), ...failedSyncOf(b)]);
      expect(emitted).toEqual(atDeath);
    });

    it('publishes nothing for an end this page chose, also when the worker dies afterwards: a reset and a bulk resync it requested, an engine it stopped, and a start it cancelled before its attach answered', async () => {
      const workers = createFakeWorkers();
      const client = createClient(workers);
      const emitted = surfaced(client);
      const start = started(client, a);
      await until(() => start.engines.length === 1);

      await firstValueFrom(client.resetAccount(a));
      await firstValueFrom(client.resyncAll([a]));
      await firstValueFrom(start.engines[0].stop(), {
        defaultValue: undefined,
      });
      fakeEngines.hold = new Promise(() => undefined);
      const cancelled = watchStart(client, b);
      await until(() => fakeEngines.of(b.accountId).length === 1);
      cancelled.subscription.unsubscribe();
      workers.kill();
      await flush();
      await flush();

      expect(await failuresOf(client)).toEqual({});
      expect(emitted).toEqual([]);
    });

    it('records not-supported when no worker can run', async () => {
      const workers = createFakeWorkers();
      workers.control.startReady = false;
      const client = createClient(workers);

      const start = started(client, a);
      await until(() => workers.connections.length === 1);
      workers.connections[0].end('not-supported');
      await flush();
      await flush();

      expect((await failuresOf(client))[a.accountId]).toMatchObject({
        reason: 'not-supported',
      });
      expect(start.outcome).toEqual({ completed: false });
    });

    it("restarts the account's engine through the next worker once a reset there wiped its checkpoint, and the engine reports the sync progress that settles the Pending resync", async () => {
      const workers = createFakeWorkers();
      const client = createClient(workers);
      const notices: unknown[] = [];
      subscriptions.push(
        client.notices$.subscribe(notice => notices.push(notice)),
      );
      const start = started(client, a);
      await until(() => start.engines.length === 1);
      workers.kill();
      await flush();
      events.length = 0;

      await firstValueFrom(client.resetAccount(a));
      await until(() => start.engines.length === 2);
      fakeEngines.current(a.accountId).syncProgress$.next(synced);
      const progress = await firstValueFrom(
        start.engines[1].syncProgress$.pipe(filter(value => value === synced)),
      );

      expect(notices).toEqual([{ accountId: a.accountId, kind: 'reset' }]);
      expect(events.indexOf('memory:removeWhere')).toBeGreaterThanOrEqual(0);
      expect(events.indexOf('memory:removeWhere')).toBeLessThan(
        events.indexOf(`start:${a.accountId}`),
      );
      expect(workers.connect).toHaveBeenCalledTimes(2);
      expect(attachCalls(workers)).toHaveLength(2);
      expect(await failuresOf(client)).toEqual({});
      expect(progress).toBe(synced);
    });

    it("restarts every account's engine through the next worker once a bulk resync there cleared the checkpoints", async () => {
      const workers = createFakeWorkers();
      const client = createClient(workers);
      const notices: unknown[] = [];
      subscriptions.push(
        client.notices$.subscribe(notice => notices.push(notice)),
      );
      const startA = started(client, a);
      const startB = started(client, b);
      await until(
        () => startA.engines.length === 1 && startB.engines.length === 1,
      );
      workers.kill();
      await flush();
      events.length = 0;

      await firstValueFrom(client.resyncAll([a, b]));
      await until(
        () => startA.engines.length === 2 && startB.engines.length === 2,
      );

      expect(notices).toEqual([
        { accountId: a.accountId, kind: 'reset' },
        { accountId: b.accountId, kind: 'reset' },
      ]);
      for (const { accountId } of [a, b])
        expect(events.indexOf('memory:clear')).toBeLessThan(
          events.indexOf(`start:${accountId}`),
        );
      expect(workers.connect).toHaveBeenCalledTimes(2);
      expect(await failuresOf(client)).toEqual({});
    });

    it('starts the engine through the next worker once a reset there ran, after a death that ended no attached engine', async () => {
      const workers = createFakeWorkers();
      workers.control.startReady = false;
      const client = createClient(workers);
      const cancelled = watchStart(client, a);
      await until(() => attachCalls(workers).length === 1);
      cancelled.subscription.unsubscribe();
      workers.connections[0].end('stopped');
      await flush();
      await flush();
      workers.control.startReady = true;
      const start = started(client, a);
      await flush();
      await flush();
      const attachesBeforeReset = attachCalls(workers).length;

      await firstValueFrom(client.resetAccount(a));
      await until(() => start.engines.length === 1);

      expect(attachesBeforeReset).toBe(1);
      expect(workers.connect).toHaveBeenCalledTimes(2);
      expect(workers.connections[1].calls.map(({ method }) => method)).toEqual([
        'resetAccount',
        'attach',
      ]);
    });

    it('starts no engine through the next worker for a bulk resync there that cannot clear the checkpoints, so the account keeps its Failed sync', async () => {
      const workers = createFakeWorkers();
      const client = createClient(workers);
      const emitted = surfaced(client);
      const start = started(client, a);
      await until(() => start.engines.length === 1);
      workers.kill();
      await until(() => emitted.length === 2);
      vi.mocked(workers.worker.createStore).mockImplementationOnce(kind => ({
        ...createMemoryStore(kind).store,
        clear: () => throwError(() => new Error('disk full')),
      }));

      await expect(firstValueFrom(client.resyncAll([a]))).rejects.toThrow(
        'disk full',
      );
      await flush();
      await flush();

      expect(workers.connections[1].calls.map(({ method }) => method)).toEqual([
        'resyncAll',
      ]);
      expect(start.engines).toHaveLength(1);
      expect((await failuresOf(client))[a.accountId]).toMatchObject({
        reason: 'runtime-stopped',
      });
      expect(emitted).toEqual(failedSyncOf(a));
    });

    it('starts no engine through the next worker for a wallet deletion there', async () => {
      const workers = createFakeWorkers();
      const client = createClient(workers);
      const start = started(client, a);
      await until(() => start.engines.length === 1);
      workers.kill();
      await flush();

      await firstValueFrom(client.deleteWallet(a.walletId, [a]));
      await flush();
      await flush();

      expect(workers.connect).toHaveBeenCalledTimes(2);
      expect(workers.connections[1].calls.map(({ method }) => method)).toEqual([
        'deleteWallet',
      ]);
      expect(start.engines).toHaveLength(1);
      expect((await failuresOf(client))[a.accountId]).toMatchObject({
        reason: 'runtime-stopped',
      });
    });
  });

  describe('a worker that cannot start', () => {
    type EndReason = 'not-supported' | 'startup-failed';
    type Workers = ReturnType<typeof createFakeWorkers>;
    const ends: Record<
      string,
      {
        before: (workers: Workers, reason: EndReason) => void;
        afterStart?: (workers: Workers, reason: EndReason) => Promise<void>;
      }
    > = {
      'already ended when connect returns it': {
        before: (workers, reason) => {
          workers.control.endAtConnect = reason;
        },
      },
      'ending right after connect, before the attach answers': {
        before: (workers, reason) => {
          workers.control.startReady = false;
          workers.control.endAfterConnect = reason;
        },
      },
      'ending while the attach waits for the worker': {
        before: workers => {
          workers.control.startReady = false;
        },
        afterStart: async (workers, reason) => {
          await until(() => attachCalls(workers).length === 1);
          await flush();
          workers.connections[0].end(reason);
        },
      },
    };

    it.each(
      (['startup-failed', 'not-supported'] as const).flatMap(reason =>
        Object.keys(ends).map(timing => ({ reason, timing })),
      ),
    )(
      'publishes the Failed sync operation without a retry action for $reason, $timing, and starts no worker until a public operation requests the engine',
      async ({ reason, timing }) => {
        const workers = createFakeWorkers();
        const { before, afterStart } = ends[timing];
        before(workers, reason);
        const client = createClient(workers);
        const emitted = surfaced(client);

        const start = started(client, a);
        await afterStart?.(workers, reason);
        await until(() => emitted.length === 2);
        const failure = (await failuresOf(client))[a.accountId];
        started(client, b);
        await flush();
        await flush();

        expect(failure).toMatchObject({ reason });
        expect(emitted).toEqual(failedSyncOf(a));
        expect(start.outcome).toEqual({ completed: false });
        expect(workers.connect).toHaveBeenCalledOnce();
      },
    );

    it('publishes a start failure recorded before it subscribed', async () => {
      const workers = createFakeWorkers();
      workers.control.endAtConnect = 'not-supported';
      const client = createClient(workers);
      started(client, a);
      await until(() => workers.connect.mock.calls.length === 1);

      const emitted = surfaced(client);
      await flush();

      expect(emitted).toEqual(failedSyncOf(a));
    });

    it.each([
      ['no crypto', undefined],
      [
        'no crypto.randomUUID, as on a page outside a secure context',
        { getRandomValues: crypto.getRandomValues.bind(crypto) },
      ],
    ])(
      'records not-supported as the start subscribes, connects to no worker and refuses a reset, when the default client id cannot be minted: %s',
      async (_case, environment) => {
        const workers = createFakeWorkers();
        const client = createClient(workers, { createClientId: undefined });
        vi.stubGlobal('crypto', environment);
        const emitted = surfaced(client);

        const start = started(client, a);
        const failure = (await failuresOf(client))[a.accountId];
        const reset = await firstValueFrom(client.resetAccount(a)).catch(
          (error: unknown) => error,
        );

        expect(failure).toMatchObject({
          reason: 'not-supported',
          cause: expect.any(TypeError) as unknown,
        });
        expect(reset).toMatchObject({
          reason: 'not-supported',
          accountId: a.accountId,
        });
        await until(() => emitted.length === 2);
        expect(emitted).toEqual(failedSyncOf(a));
        expect(start.outcome).toEqual({ completed: false });
        expect(workers.connect).not.toHaveBeenCalled();
      },
    );
  });

  it('errors the engine streams when the worker reports the engine failed, so the watcher retries', async () => {
    const workers = createFakeWorkers();
    const client = createClient(workers);
    const { engines } = started(client, a);
    await until(() => engines.length === 1);
    const ended = new Subject<unknown>();
    subscriptions.push(
      engines[0].syncProgress$.subscribe({
        error: (error: unknown) => {
          ended.next(error);
        },
      }),
    );
    const ending = firstValueFrom(ended);

    fakeEngines.current(a.accountId).syncProgress$.error(new Error('ws lost'));

    await expect(ending).resolves.toBeInstanceOf(Error);
    expect(await failuresOf(client)).toEqual({});
  });

  it('errors the engine streams with an engine-failed client error naming the account and the failure, so that a reader tells it apart from its own failures', async () => {
    const workers = createFakeWorkers();
    const client = createClient(workers);
    const { engines } = started(client, a);
    await until(() => engines.length === 1);
    const ended = new Subject<unknown>();
    subscriptions.push(
      engines[0].transactionHistory$.subscribe({
        error: (error: unknown) => {
          ended.next(error);
        },
      }),
    );
    const ending = firstValueFrom(ended);

    fakeEngines
      .current(a.accountId)
      .transactionHistory$.error(new Error('ws lost'));

    const error = await ending;
    expect(error).toBeInstanceOf(MidnightEngineClientError);
    expect(error).toMatchObject({
      reason: 'engine-failed',
      accountId: a.accountId,
      message: 'ws lost',
    });
  });

  it('errors the engine streams with an engine-failed client error naming the account when the engine fails with an empty message, and the next start gets a fresh engine', async () => {
    const workers = createFakeWorkers();
    const client = createClient(workers);
    const first = started(client, a);
    await until(() => first.engines.length === 1);
    const failedGeneration = first.engines[0].engineGeneration;
    const errors: unknown[] = [];
    subscriptions.push(
      first.engines[0].transactionHistory$.subscribe({
        error: (error: unknown) => errors.push(error),
      }),
    );

    fakeEngines.current(a.accountId).transactionHistory$.error(new Error());
    await until(() => errors.length === 1);
    const retried = started(client, a);
    await until(() => retried.engines.length === 1);

    expect(errors[0]).toBeInstanceOf(MidnightEngineClientError);
    expect(errors[0]).toMatchObject({
      reason: 'engine-failed',
      accountId: a.accountId,
      message: expect.stringContaining(a.accountId) as unknown,
    });
    expect(fakeEngines.of(a.accountId)).toHaveLength(2);
    expect(retried.engines[0].engineGeneration).toBeDefined();
    expect(retried.engines[0].engineGeneration).not.toBe(failedGeneration);
    await expect(
      firstValueFrom(retried.engines[0].transactionHistory$),
    ).resolves.toEqual([]);
  });

  it('detaches this page and completes the engine streams on stop', async () => {
    const workers = createFakeWorkers();
    const client = createClient(workers);
    const { engines } = started(client, a);
    await until(() => engines.length === 1);
    const complete = vi.fn();
    subscriptions.push(engines[0].address$.subscribe({ complete }));

    await firstValueFrom(engines[0].stop(), { defaultValue: undefined });
    await flush();

    expect(complete).toHaveBeenCalledOnce();
    expect(
      workers.connections[0].calls.filter(({ method }) => method === 'detach'),
    ).toEqual([
      {
        method: 'detach',
        request: { clientId: 'client-1', accountId: a.accountId },
      },
    ]);
    expect(fakeEngines.current(a.accountId).tornDown).toBe(true);
  });

  it('detaches a start cancelled before its attach answered once the attach answers', async () => {
    const workers = createFakeWorkers();
    const client = createClient(workers);
    let release!: () => void;
    fakeEngines.hold = new Promise(resolve => {
      release = resolve;
    });
    const start = watchStart(client, a);
    await until(() => fakeEngines.of(a.accountId).length === 1);

    start.subscription.unsubscribe();
    release();
    await until(() =>
      workers.connections[0].calls.some(({ method }) => method === 'detach'),
    );

    expect(start.engines).toEqual([]);
    expect(fakeEngines.current(a.accountId).tornDown).toBe(true);
  });

  it('keeps a replacement start attached and usable when the start it replaced was cancelled before its attach answered', async () => {
    const workers = createFakeWorkers();
    const client = createClient(workers);
    let release!: () => void;
    fakeEngines.hold = new Promise(resolve => {
      release = resolve;
    });
    const cancelled = watchStart(client, a);
    await until(() => fakeEngines.of(a.accountId).length === 1);

    cancelled.subscription.unsubscribe();
    const replacement = started(client, a);
    await flush();
    release();
    await until(() => replacement.engines.length === 1);
    const signed = await firstValueFrom(
      replacement.engines[0].signData(new Uint8Array([1])),
    );
    const membership = workers.connections[0].calls.filter(
      ({ method }) => method === 'attach' || method === 'detach',
    );

    expect(signed).toMatchObject({ signature: 'signature' });
    expect(membership.map(({ method }) => method)).toEqual([
      'attach',
      'detach',
      'attach',
    ]);
    expect(
      membership.every(
        ({ request }) =>
          (request as { clientId: string }).clientId === 'client-1',
      ),
    ).toBe(true);
    expect(cancelled.engines).toEqual([]);
    expect(replacement.outcome).toEqual({ completed: false });
    expect(workers.connect).toHaveBeenCalledOnce();
  });

  it('never sends the attach of a replacement cancelled while it waited, and keeps the next replacement attached', async () => {
    const workers = createFakeWorkers();
    const client = createClient(workers);
    let release!: () => void;
    fakeEngines.hold = new Promise(resolve => {
      release = resolve;
    });
    const cancelled = watchStart(client, a);
    await until(() => fakeEngines.of(a.accountId).length === 1);
    cancelled.subscription.unsubscribe();
    const waiting = watchStart(client, a);
    await flush();

    waiting.subscription.unsubscribe();
    const replacement = started(client, a);
    await flush();
    release();
    await until(() => replacement.engines.length === 1);
    const signed = await firstValueFrom(
      replacement.engines[0].signData(new Uint8Array([1])),
    );

    expect(signed).toMatchObject({ signature: 'signature' });
    expect(
      workers.connections[0].calls
        .map(({ method }) => method)
        .filter(method => method === 'attach' || method === 'detach'),
    ).toEqual(['attach', 'detach', 'attach']);
    expect(waiting.engines).toEqual([]);
  });

  it('sends no attach for a replacement waiting behind a cancelled attach when the worker dies, records runtime-stopped for it, and re-attaches it through a new worker only once a public operation requests the engine', async () => {
    const workers = createFakeWorkers();
    const client = createClient(workers);
    let release!: () => void;
    fakeEngines.hold = new Promise(resolve => {
      release = resolve;
    });
    const cancelled = watchStart(client, a);
    await until(() => fakeEngines.of(a.accountId).length === 1);
    cancelled.subscription.unsubscribe();
    const replacement = started(client, a);
    await flush();

    workers.kill();
    release();
    await flush();
    await flush();
    const failure = (await failuresOf(client))[a.accountId];
    const attachesOnDeadConnection = workers.connections[0].calls.filter(
      ({ method }) => method === 'attach',
    ).length;
    const connectsBeforeRequest = workers.connect.mock.calls.length;
    const engineCountBeforeRequest = replacement.engines.length;
    client.requestEngine(a.accountId);
    await until(() => replacement.engines.length === 1);

    expect(failure).toMatchObject({
      reason: 'runtime-stopped',
      accountId: a.accountId,
    });
    expect(attachesOnDeadConnection).toBe(1);
    expect(connectsBeforeRequest).toBe(1);
    expect(engineCountBeforeRequest).toBe(0);
    expect(workers.connect).toHaveBeenCalledTimes(2);
    expect(
      workers.connections[1].calls.filter(({ method }) => method === 'attach'),
    ).toHaveLength(1);
    expect(cancelled.engines).toEqual([]);
    expect(replacement.outcome).toEqual({ completed: false });
  });

  it('keeps a replacement start attached and usable when the start it replaced was cancelled and its attach then refused, recording and publishing nothing for that refusal', async () => {
    const workers = createFakeWorkers();
    const client = createClient(workers);
    const emitted = surfaced(client);
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    fakeEngines.hold = new Promise(() => undefined);
    const cancelled = watchStart(client, a);
    await until(() => fakeEngines.of(a.accountId).length === 1);
    cancelled.subscription.unsubscribe();
    const replacement = started(client, a);
    await flush();
    const attachesWhileHeld = attachCalls(workers).length;

    fakeEngines.hold = undefined;
    await vi.advanceTimersByTimeAsync(120_000);
    await until(() => replacement.engines.length === 1);
    const signed = await firstValueFrom(
      replacement.engines[0].signData(new Uint8Array([1])),
    );
    const membership = workers.connections[0].calls.filter(
      ({ method }) => method === 'attach' || method === 'detach',
    );

    expect(signed).toMatchObject({ signature: 'signature' });
    expect(attachesWhileHeld).toBe(1);
    expect(membership.map(({ method }) => method)).toEqual([
      'attach',
      'attach',
    ]);
    expect(
      membership.every(
        ({ request }) =>
          (request as { clientId: string }).clientId === 'client-1',
      ),
    ).toBe(true);
    expect(await failuresOf(client)).toEqual({});
    expect(emitted).toEqual([]);
    expect(cancelled.engines).toEqual([]);
    expect(replacement.outcome).toEqual({ completed: false });
    expect(workers.connect).toHaveBeenCalledOnce();
  });

  it('records nothing at a death for a start cancelled before its attach answered', async () => {
    const workers = createFakeWorkers();
    workers.control.startReady = false;
    const client = createClient(workers);
    const start = watchStart(client, a);
    await until(() => attachCalls(workers).length === 1);

    start.subscription.unsubscribe();
    workers.connections[0].end('stopped');
    await flush();
    await flush();

    expect(await failuresOf(client)).toEqual({});
  });

  it('keeps the failures of other accounts when one account is requested', async () => {
    const workers = createFakeWorkers();
    const client = createClient(workers);
    const startA = started(client, a);
    const startB = started(client, b);
    await until(
      () => startA.engines.length === 1 && startB.engines.length === 1,
    );
    workers.kill();
    await flush();

    client.requestEngine(a.accountId);
    await until(() => startA.engines.length === 2);
    await flush();

    expect(Object.keys(await failuresOf(client))).toEqual([b.accountId]);
    expect(startB.engines).toHaveLength(1);
  });
});
