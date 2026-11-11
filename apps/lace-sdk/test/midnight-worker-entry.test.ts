import * as fixture from '@lace-contract/midnight-context/src/stub-data';
import { CollectionStore } from '@lace-contract/storage';
import { toSerializableObject } from '@lace-lib/cardano-util';
import {
  createBackgroundMessenger,
  createSharedWorkerHostRuntime,
  SharedWorkerStartupError,
} from '@lace-lib/extension-messaging';
import { derivePendingActivityFromMidnightTx } from '@lace-module/dapp-connector-midnight/sdk';
import { MidnightWorkerError } from '@lace-module/midnight-sync/sdk';
import { filter, firstValueFrom, Subject, take, timeout, toArray } from 'rxjs';
import { dummyLogger } from 'ts-log';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import {
  connectMidnightEngineWorker,
  startMidnightEngineWorker,
} from '../src/midnight-worker/connect-engine-worker';
import { createSdkMidnightEngineHost } from '../src/midnight-worker/engine-host';
import {
  engineChannelOf,
  MIDNIGHT_WORKER_FAILED,
} from '../src/midnight-worker/engine-host-api';
import { runMidnightEngineWorker } from '../src/midnight-worker/run-engine-worker';
import {
  createMidnightClientChannels,
  serveMidnightEngineHost,
} from '../src/midnight-worker/serve-engine-host';

import {
  createFakeEngineHost,
  createLockManager,
  installFakeBrowser,
  NODE_REJECTION_MESSAGE,
  nodeRejection,
  workerFinalizedTx,
  workerRecipe,
} from './midnight-worker-fakes';

import type { MidnightEngineWorkerScope } from '../src/midnight-worker/run-engine-worker';
import type { SerializedMidnightWallet } from '@lace-contract/midnight-context';
import type { Channel, SharedWorkerPort } from '@lace-lib/extension-messaging';
import type {
  MidnightEngineHost,
  MidnightEngineRuntimeStatus,
  MidnightSessionStreams,
} from '@lace-module/midnight-sync/sdk';
import type * as MidnightSyncSdkEngine from '@lace-module/midnight-sync/sdk-engine';

const { hostDependencies } = vi.hoisted(() => ({
  hostDependencies: [] as unknown[],
}));
vi.mock('@lace-module/midnight-sync/sdk-engine', async importActual => ({
  ...(await importActual<typeof MidnightSyncSdkEngine>()),
  createMidnightEngineHost: (dependencies: unknown) => {
    hostDependencies.push(dependencies);
    return {};
  },
}));

const CLIENT = '00000000-0000-4000-8000-000000000001';
const OTHER_CLIENT = '00000000-0000-4000-8000-000000000002';
const OTHER_ACCOUNT = `${fixture.accountId}-y` as typeof fixture.accountId;
const THIRD_CLIENT = '00000000-0000-4000-8000-000000000003';
const LOAD_BOUND_MS = 60_000;

const attachRequest = (
  clientId: string,
  password: unknown = new Uint8Array([1]),
) =>
  ({
    clientId,
    account: fixture.midnightAccount,
    password,
    settings: {},
  } as unknown as Parameters<MidnightEngineHost['attach']>[0]);

/**
 * The worker side over the real Messenger and SharedWorker runtimes, serving the fake host, with pages that attach
 * and read their streams. `leftoversOf` reports what the worker still holds for a client: the channels its Messenger
 * keeps, the channels that still have a listener or a waiting post, and the host's streams it still observes.
 */
const serveWithRecordedChannels = () => {
  const { host, asHost } = createFakeEngineHost();
  const sources = new Map<string, ReturnType<typeof host.streams>[]>();
  const served: MidnightEngineHost = {
    ...asHost(),
    streams: caller => {
      // The fake shares one progress subject between callers; one per caller shows whose subscription remains.
      const streams = { ...host.streams(), progress$: new Subject<unknown>() };
      sources.set(caller.clientId, [
        ...(sources.get(caller.clientId) ?? []),
        streams,
      ]);
      return streams as unknown as MidnightSessionStreams;
    },
  };
  const locks = createLockManager();
  const runtime = createSharedWorkerHostRuntime({
    locks: locks.view('worker'),
    logger: dummyLogger,
  });
  const clientChannels = createMidnightClientChannels();
  const messenger = createBackgroundMessenger({
    logger: dummyLogger,
    runtime,
    isConnectionAuthorized: clientChannels.isAdmitted,
  });
  const handedOut = new Map<string, Channel[]>();
  const held = new Set<string>();
  serveMidnightEngineHost({
    host: served,
    runtime,
    messenger: {
      ...messenger,
      getChannel: name => {
        const channel = messenger.getChannel(name);
        const channels = handedOut.get(name) ?? [];
        if (!channels.includes(channel))
          handedOut.set(name, [...channels, channel]);
        held.add(name);
        return channel;
      },
      shutdownChannel: name => {
        messenger.shutdownChannel(name);
        held.delete(name);
      },
    },
    channels: clientChannels,
    logger: dummyLogger,
  });
  runtime.markReady();
  const pagePorts = new Map<string, MessagePort>();
  onTestFinished(() => {
    for (const port of pagePorts.values()) port.close();
  });
  const openPage = async (clientId: string) => {
    const { host: remote } = connectMidnightEngineWorker({
      startWorker: () => {
        const { port1, port2 } = new MessageChannel();
        pagePorts.set(clientId, port1);
        runtime.addClient(port2);
        return port1;
      },
      locks: () => locks.view(clientId),
      isSupported: () => true,
    })(clientId);
    await remote.attach(attachRequest(clientId));
    const streams = remote.streams({ clientId, accountId: fixture.accountId });
    await firstValueFrom(streams.status$.pipe(timeout(5000)));
    return { remote, streams };
  };
  const closePage = async (clientId: string) => {
    pagePorts.get(clientId)?.close();
    locks.kill(clientId);
    await vi.waitFor(() => {
      expect(host.detachClient).toHaveBeenCalledWith(clientId);
    });
  };
  const leftoversOf = (clientId: string) => {
    const ofClient = (name: string) =>
      name.startsWith(engineChannelOf(clientId));
    return {
      channels: [...held].filter(ofClient),
      listenedChannels: [...handedOut]
        .filter(([name]) => ofClient(name))
        .filter(([, channels]) =>
          channels.some(
            ({ ports$, message$ }) => ports$.observed || message$.observed,
          ),
        )
        .map(([name]) => name),
      observedSources: (sources.get(clientId) ?? [])
        .flatMap(streams => Object.values(streams))
        .filter(source$ => source$.observed).length,
    };
  };
  return { host, sources, openPage, closePage, leftoversOf };
};

const NOTHING_LEFT = {
  channels: [],
  listenedChannels: [],
  observedSources: 0,
};

afterEach(() => {
  vi.unstubAllGlobals();
  hostDependencies.length = 0;
});

describe('test:lace-sdk-build-checks', () => {
  it('listens for pages before it loads the engine, sets the global Buffer first, and answers a page only once the host serves', async () => {
    const steps: string[] = [];
    const scope: MidnightEngineWorkerScope = {
      addEventListener: type => {
        steps.push(`listens for ${type}`);
      },
      close: () => {
        steps.push('closes');
      },
    };
    let serve!: (host: MidnightEngineHost) => void;
    const running = runMidnightEngineWorker({
      scope,
      locks: createLockManager().view('worker'),
      buffer: Buffer,
      loadHost: async () => {
        steps.push(
          `loads the engine with Buffer ${String(scope.Buffer === Buffer)}`,
        );
        return new Promise(resolve => {
          serve = resolve;
        });
      },
      logger: dummyLogger,
    });

    expect(steps).toEqual([
      'listens for connect',
      'loads the engine with Buffer true',
    ]);
    serve(createFakeEngineHost().asHost());
    await running;
    expect(steps).not.toContain('closes');
  });

  it('tells each page it holds that the engine failed to load and closes, so the page reports a failed start without waiting for its handshake deadline', async () => {
    const locks = createLockManager();
    const steps: string[] = [];
    const listeners: Parameters<
      MidnightEngineWorkerScope['addEventListener']
    >[1][] = [];
    const scope: MidnightEngineWorkerScope = {
      addEventListener: (_type, listener) => {
        listeners.push(listener);
      },
      close: () => {
        steps.push('closes');
      },
    };
    const logger = {
      ...dummyLogger,
      error: vi.fn((..._parameters: unknown[]) => {
        steps.push('logs the failure');
      }),
    };
    let failLoad!: (error: Error) => void;
    const running = runMidnightEngineWorker({
      scope,
      locks: locks.view('worker'),
      buffer: Buffer,
      loadHost: async () =>
        new Promise<never>((_resolve, reject) => {
          failLoad = reject;
        }),
      logger,
    });
    const ports: MessagePort[] = [];
    const { host, status$ } = connectMidnightEngineWorker({
      startWorker: () => {
        const { port1, port2 } = new MessageChannel();
        ports.push(port1, port2);
        for (const listener of listeners) listener({ ports: [port2] });
        return port1;
      },
      locks: () => locks.view('page'),
      isSupported: () => true,
    })(CLIENT);
    const attached = host
      .attach(attachRequest(CLIENT))
      .catch((error: unknown) => error);

    failLoad(new Error('WebAssembly failed to load'));
    await running;
    const statuses = await firstValueFrom(
      status$.pipe(toArray(), timeout(5000)),
    );

    expect(steps).toEqual(['logs the failure', 'closes']);
    expect(logger.error).toHaveBeenCalledWith(
      'The Midnight engine worker could not load the engine',
      expect.objectContaining({ message: 'WebAssembly failed to load' }),
    );
    expect(statuses).toEqual([
      { state: 'starting' },
      {
        state: 'ended',
        reason: 'startup-failed',
        cause: expect.any(SharedWorkerStartupError) as unknown,
      },
    ]);
    expect(statuses[1]).toMatchObject({
      cause: {
        message: expect.stringContaining(
          'the worker failed and closed before it served',
        ) as unknown,
        cause: 'WebAssembly failed to load',
      },
    });
    expect(await attached).toBeInstanceOf(Error);
    for (const port of ports) port.close();
  });

  it('gives the runtime every message but a failure notice with a string message, so a malformed notice does not end the start', async () => {
    const locks = createLockManager();
    const listeners: Parameters<
      MidnightEngineWorkerScope['addEventListener']
    >[1][] = [];
    let serve!: (host: MidnightEngineHost) => void;
    const running = runMidnightEngineWorker({
      scope: {
        addEventListener: (_type, listener) => {
          listeners.push(listener);
        },
        close: () => undefined,
      },
      locks: locks.view('worker'),
      buffer: Buffer,
      loadHost: async () =>
        new Promise(resolve => {
          serve = resolve;
        }),
      logger: dummyLogger,
    });
    const ports: MessagePort[] = [];
    const { status$ } = connectMidnightEngineWorker({
      startWorker: () => {
        const { port1, port2 } = new MessageChannel();
        ports.push(port1, port2);
        for (const notice of [
          MIDNIGHT_WORKER_FAILED,
          { type: 'lace-midnight-engine:other', message: 'not a failure' },
          { type: MIDNIGHT_WORKER_FAILED, message: 42 },
          { type: MIDNIGHT_WORKER_FAILED },
          null,
        ])
          port2.postMessage(notice);
        for (const listener of listeners) listener({ ports: [port2] });
        return port1;
      },
      locks: () => locks.view('page'),
      isSupported: () => true,
    })(CLIENT);
    const statuses = firstValueFrom(
      status$.pipe(take(2), toArray(), timeout(5000)),
    );

    serve(createFakeEngineHost().asHost());
    await running;

    expect(await statuses).toEqual([{ state: 'starting' }, { state: 'ready' }]);
    for (const port of ports) port.close();
  });

  it("keeps the first 500 characters of the worker's failure message", async () => {
    const { port1, port2 } = new MessageChannel();
    const { status$ } = connectMidnightEngineWorker({
      startWorker: () => port1,
      locks: () => createLockManager().view('page'),
      isSupported: () => true,
    })(CLIENT);

    port2.postMessage({
      type: MIDNIGHT_WORKER_FAILED,
      message: `${'a'.repeat(500)}b`,
    });
    const statuses = await firstValueFrom(
      status$.pipe(toArray(), timeout(5000)),
    );

    expect(statuses.at(-1)).toMatchObject({
      state: 'ended',
      reason: 'startup-failed',
      cause: { cause: 'a'.repeat(500) },
    });
    port2.close();
  });

  describe('a worker that cannot serve', () => {
    // setImmediate stays real under the tests' clocks, and every port delivery and lock grant before it has happened.
    const settle = async () => {
      for (let turn = 0; turn < 50; turn += 1)
        await new Promise<void>(resolve => {
          setImmediate(resolve);
        });
    };
    const statusesOf = (clientId: string) => {
      const statuses: MidnightEngineRuntimeStatus[] = [];
      connectMidnightEngineWorker()(clientId).status$.subscribe(status =>
        statuses.push(status),
      );
      return statuses;
    };

    it('closes when the engine does not load within 60 s, telling each page it holds, and the next page starts a new worker', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const { asHost } = createFakeEngineHost();
      let loads = 0;
      const browser = installFakeBrowser(asHost(), {
        loadHost: async () => {
          loads += 1;
          return loads === 1 ? new Promise<never>(() => undefined) : asHost();
        },
      });
      // The first page gives up at its own 30 s handshake deadline; the second joins the worker after it.
      statusesOf(CLIENT);
      await vi.advanceTimersByTimeAsync(35_000);
      const joined = statusesOf(OTHER_CLIENT);
      await vi.advanceTimersByTimeAsync(LOAD_BOUND_MS - 35_000 - 1);
      await settle();
      const isClosedBeforeBound = browser.workers[0].isClosed;
      await vi.advanceTimersByTimeAsync(1);
      await settle();
      const next = statusesOf(THIRD_CLIENT);
      await settle();

      expect(isClosedBeforeBound).toBe(false);
      expect(browser.workers[0].isClosed).toBe(true);
      expect(joined).toEqual([
        { state: 'starting' },
        {
          state: 'ended',
          reason: 'startup-failed',
          cause: expect.any(SharedWorkerStartupError) as unknown,
        },
      ]);
      expect(joined[1]).toMatchObject({
        cause: {
          cause: `The Midnight engine did not load within ${LOAD_BOUND_MS} ms`,
        },
      });
      expect(browser.workers).toHaveLength(2);
      expect(next).toEqual([{ state: 'starting' }, { state: 'ready' }]);
    });

    it('closes at once when the browser refuses its runtime lock, telling each page it holds, and the next page starts a new worker', async () => {
      const { asHost } = createFakeEngineHost();
      const browser = installFakeBrowser(asHost(), {
        workerLocks: (locks, worker) =>
          worker > 1
            ? locks
            : {
                request: async (name, options, callback) =>
                  name.includes(':runtime:')
                    ? Promise.reject(
                        new DOMException('No locks here', 'SecurityError'),
                      )
                    : locks.request(name, options, callback),
              },
      });

      const refused = statusesOf(CLIENT);
      await settle();
      const next = statusesOf(OTHER_CLIENT);
      await settle();

      expect(browser.workers[0].isClosed).toBe(true);
      expect(refused).toEqual([
        { state: 'starting' },
        {
          state: 'ended',
          reason: 'startup-failed',
          cause: expect.any(SharedWorkerStartupError) as unknown,
        },
      ]);
      expect(refused[1]).toMatchObject({ cause: { cause: 'No locks here' } });
      expect(browser.workers).toHaveLength(2);
      expect(next).toEqual([{ state: 'starting' }, { state: 'ready' }]);
    });

    it('closes when another context steals its runtime lock once it served, telling each page it serves, which reports the worker stopped, and the next page starts a new worker', async () => {
      const { asHost } = createFakeEngineHost();
      const browser = installFakeBrowser(asHost());
      const served = statusesOf(CLIENT);
      await settle();

      browser.steal('worker-1');
      await settle();
      const next = statusesOf(OTHER_CLIENT);
      await settle();

      expect(served).toEqual([
        { state: 'starting' },
        { state: 'ready' },
        {
          state: 'ended',
          reason: 'stopped',
          cause: expect.any(Error) as unknown,
        },
      ]);
      expect(served[2]).toMatchObject({
        cause: {
          message: 'The Midnight worker failed and closed',
          cause: 'The lock was stolen',
        },
      });
      expect(browser.workers[0].isClosed).toBe(true);
      expect(browser.workers).toHaveLength(2);
      expect(next).toEqual([{ state: 'starting' }, { state: 'ready' }]);
    });
  });

  it('refuses, before the host sees it, a call on a client channel that names another client and an attach whose password is not bytes', async () => {
    const { host, asHost } = createFakeEngineHost();
    installFakeBrowser(asHost());
    const { host: remote } = connectMidnightEngineWorker()(CLIENT);

    const otherClient = await remote
      .attach(attachRequest(OTHER_CLIENT))
      .catch((error: unknown) => error);
    const textPassword = await remote
      .attach(attachRequest(CLIENT, 'password'))
      .catch((error: unknown) => error);
    const otherDetach = await remote
      .detachClient(OTHER_CLIENT)
      .catch((error: unknown) => error);
    const authority = await remote
      .resetAccount({
        clientId: CLIENT,
        accountId: fixture.accountId,
        storage: 'memory',
        authority: { account: fixture.midnightAccount, password: [1] },
      } as unknown as Parameters<MidnightEngineHost['resetAccount']>[0])
      .catch((error: unknown) => error);
    await remote.attach(attachRequest(CLIENT));

    expect(otherClient).toMatchObject({
      message: expect.stringContaining('serves another client') as unknown,
    });
    expect(otherDetach).toMatchObject({
      message: expect.stringContaining('serves another client') as unknown,
    });
    expect(textPassword).toBeInstanceOf(TypeError);
    expect(authority).toBeInstanceOf(TypeError);
    expect(host.attach).toHaveBeenCalledOnce();
    expect(host.attach.mock.calls[0][0]).toMatchObject({ clientId: CLIENT });
    expect(host.detachClient).not.toHaveBeenCalled();
    expect(host.resetAccount).not.toHaveBeenCalled();
  });

  it("gives the page a host failure with its name, message, stack and code, and the original as its cause, when the error's toJSON leaves them out, as the wallet SDK's errors do; an error without toJSON crosses as it is", async () => {
    const rejection = await nodeRejection();
    class CodedFailure extends Error {
      public readonly code = 'ECONNRESET';
      public constructor() {
        super('The proof server closed the connection');
        this.name = 'CodedFailure';
      }
      public toJSON() {
        return { detail: 'closed after the request' };
      }
    }
    const { host, asHost } = createFakeEngineHost();
    host.submit.mockRejectedValue(rejection);
    host.prove.mockRejectedValue(new CodedFailure());
    host.sign.mockRejectedValue(
      new MidnightWorkerError('stale-value', 'built by an earlier engine'),
    );
    installFakeBrowser(asHost());
    const { host: remote } = connectMidnightEngineWorker()(CLIENT);
    const caller = { clientId: CLIENT, accountId: fixture.accountId };

    const submitted = await remote
      .submit({ ...caller, transaction: workerFinalizedTx() })
      .catch((error: unknown) => error);
    const proved = await remote
      .prove({ ...caller, recipe: workerRecipe() })
      .catch((error: unknown) => error);
    const signed = await remote
      .sign({ ...caller, recipe: workerRecipe() })
      .catch((error: unknown) => error);

    expect(submitted).toBeInstanceOf(Error);
    expect(submitted).toMatchObject({
      name: '(FiberFailure) SubmissionError',
      message: 'Transaction submission error',
      stack: rejection.stack,
      cause: {
        _id: 'FiberFailure',
        cause: {
          _tag: 'Fail',
          failure: {
            _tag: 'SubmissionError',
            cause: { message: NODE_REJECTION_MESSAGE },
          },
        },
      },
    });
    expect(proved).toMatchObject({
      name: 'CodedFailure',
      message: 'The proof server closed the connection',
      code: 'ECONNRESET',
      cause: { detail: 'closed after the request' },
    });
    expect(signed).toMatchObject({
      name: 'MidnightWorkerError',
      message: 'built by an earlier engine',
      reason: 'stale-value',
    });
    expect(signed).not.toHaveProperty('cause');
  });

  it("detaches only the client of a page that closes: another page's client stays attached, and its next call reaches the host", async () => {
    const { host, asHost } = createFakeEngineHost();
    const browser = installFakeBrowser(asHost());
    const pagePorts = new Map<string, SharedWorkerPort>();
    const connectPage = (page: string, clientId: string) =>
      connectMidnightEngineWorker({
        startWorker: () => {
          const port = startMidnightEngineWorker();
          pagePorts.set(page, port);
          return port;
        },
        locks: () => browser.locksOf(page),
      })(clientId).host;
    const first = connectPage('page-1', CLIENT);
    const second = connectPage('page-2', OTHER_CLIENT);
    await first.attach(attachRequest(CLIENT));
    await second.attach(attachRequest(OTHER_CLIENT));

    pagePorts.get('page-1')?.close();
    browser.kill('page-1');
    await vi.waitFor(() => {
      expect(host.detachClient).toHaveBeenCalled();
    });
    const signed = await second.signData({
      clientId: OTHER_CLIENT,
      accountId: fixture.accountId,
      data: new Uint8Array([1]),
    });

    expect(browser.workers).toHaveLength(1);
    expect(host.detachClient.mock.calls).toEqual([[CLIENT]]);
    expect(signed).toEqual({
      signature: 'worker-signature',
      verifyingKey: 'worker-key',
    });
    expect(host.signData).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: OTHER_CLIENT }),
    );
  });

  it("refuses a page's port on another client's channel before it joins, so that page neither calls as the client nor receives its answers, and the client is detached once its own page closes", async () => {
    const { host, asHost } = createFakeEngineHost();
    const browser = installFakeBrowser(asHost());
    const pagePorts = new Map<string, SharedWorkerPort>();
    const intruderFrames: unknown[] = [];
    const recorded = (port: SharedWorkerPort): SharedWorkerPort => ({
      close: () => {
        port.close();
      },
      postMessage: message => {
        port.postMessage(message);
      },
      start: () => {
        port.start();
      },
      get onmessage() {
        return port.onmessage;
      },
      set onmessage(listener) {
        port.onmessage =
          listener &&
          ((event: MessageEvent) => {
            intruderFrames.push(event.data);
            listener(event);
          });
      },
    });
    // Both pages present the victim's client id, as a page that learned it would.
    const connectPage = (page: string) =>
      connectMidnightEngineWorker({
        startWorker: () => {
          const port = startMidnightEngineWorker();
          pagePorts.set(page, port);
          return page === 'intruder' ? recorded(port) : port;
        },
        locks: () => browser.locksOf(page),
      })(CLIENT).host;
    const accountY = { clientId: CLIENT, accountId: OTHER_ACCOUNT };
    const victim = connectPage('victim');
    await victim.attach(attachRequest(CLIENT));
    const intruder = connectPage('intruder');

    const intrusion = intruder
      .signData({ ...accountY, data: new Uint8Array([1]) })
      .then(
        () => 'answered',
        () => 'refused',
      );
    const signed = await victim.signData({
      ...accountY,
      data: new Uint8Array([2]),
    });

    expect(await intrusion).toBe('refused');
    expect(signed).toEqual({
      signature: 'worker-signature',
      verifyingKey: 'worker-key',
    });
    expect(host.signData.mock.calls).toEqual([
      [{ ...accountY, data: new Uint8Array([2]) }],
    ]);
    expect(
      intruderFrames.filter(
        frame => (frame as { kind?: unknown }).kind === 'message',
      ),
    ).toEqual([]);
    pagePorts.get('victim')?.close();
    browser.kill('victim');
    await vi.waitFor(() => {
      expect(host.detachClient).toHaveBeenCalledWith(CLIENT);
    });
  });

  it("takes no port a page opens before the worker answered its handshake, so a port opened early on a client's channel neither calls as the client nor receives its answers, and the client is detached once its page closes", async () => {
    const { host, asHost } = createFakeEngineHost();
    let finishLoad!: () => void;
    const browser = installFakeBrowser(asHost(), {
      loadHost: async () =>
        new Promise(resolve => {
          finishLoad = () => {
            resolve(asHost());
          };
        }),
    });
    const settle = async () => {
      for (let turn = 0; turn < 20; turn += 1)
        await new Promise<void>(resolve => {
          setImmediate(resolve);
        });
    };
    // A raw page that knows the victim's id, and sends `hello` and its port while the worker still loads.
    const intruder = startMidnightEngineWorker();
    const intruderFrames: unknown[] = [];
    intruder.onmessage = ({ data }: MessageEvent) => {
      intruderFrames.push(data);
    };
    intruder.start();
    void browser
      .locksOf('intruder')
      .request(
        'intruder-tab-lock',
        {},
        async () => new Promise(() => undefined),
      );
    await settle();
    intruder.postMessage({ kind: 'hello', tabLock: 'intruder-tab-lock' });
    intruder.postMessage({
      kind: 'connect',
      name: engineChannelOf(CLIENT),
      portId: 0,
    });
    await settle();
    finishLoad();
    const victimPorts: SharedWorkerPort[] = [];
    const victim = connectMidnightEngineWorker({
      startWorker: () => {
        const port = startMidnightEngineWorker();
        victimPorts.push(port);
        return port;
      },
      locks: () => browser.locksOf('victim'),
    })(CLIENT).host;
    await victim.attach(attachRequest(CLIENT));
    const accountY = { clientId: CLIENT, accountId: OTHER_ACCOUNT };

    intruder.postMessage({
      kind: 'message',
      portId: 0,
      data: {
        messageId: 'intruder-call',
        request: {
          method: 'signData',
          args: [
            toSerializableObject({ ...accountY, data: new Uint8Array([1]) }),
          ],
        },
      },
    });
    const signed = await victim.signData({
      ...accountY,
      data: new Uint8Array([2]),
    });
    await settle();

    expect(signed).toEqual({
      signature: 'worker-signature',
      verifyingKey: 'worker-key',
    });
    expect(host.signData.mock.calls).toEqual([
      [{ ...accountY, data: new Uint8Array([2]) }],
    ]);
    expect(
      intruderFrames.filter(
        frame => (frame as { kind?: unknown }).kind === 'message',
      ),
    ).toEqual([]);
    for (const port of victimPorts) port.close();
    browser.kill('victim');
    await vi.waitFor(() => {
      expect(host.detachClient).toHaveBeenCalledWith(CLIENT);
    });
  });

  it("refuses a page's port presenting a closed client's id until the host has detached that client, and serves the id again once it has", async () => {
    const { host, asHost } = createFakeEngineHost();
    let finishDetach!: () => void;
    host.detachClient.mockImplementationOnce(
      async () =>
        new Promise<void>(resolve => {
          finishDetach = resolve;
        }),
    );
    const browser = installFakeBrowser(asHost());
    const pagePorts = new Map<string, SharedWorkerPort>();
    const connectPage = (page: string) =>
      connectMidnightEngineWorker({
        startWorker: () => {
          const port = startMidnightEngineWorker();
          pagePorts.set(page, port);
          return port;
        },
        locks: () => browser.locksOf(page),
      })(CLIENT).host;
    const signAs = async (page: ReturnType<typeof connectPage>) =>
      page
        .signData({
          clientId: CLIENT,
          accountId: OTHER_ACCOUNT,
          data: new Uint8Array([1]),
        })
        .then(
          () => 'answered',
          () => 'refused',
        );
    const victim = connectPage('victim');
    await victim.attach(attachRequest(CLIENT));
    pagePorts.get('victim')?.close();
    browser.kill('victim');
    await vi.waitFor(() => {
      expect(host.detachClient).toHaveBeenCalledWith(CLIENT);
    });

    const whileDetaching = await signAs(connectPage('intruder'));
    finishDetach();
    const onceDetached = await signAs(connectPage('later'));

    expect(whileDetaching).toBe('refused');
    expect(onceDetached).toBe('answered');
    expect(host.signData).toHaveBeenCalledOnce();
  });

  it("releases every channel, stream subscription and cached value of each page that closes, while another page's streams keep working", async () => {
    const { sources, openPage, closePage, leftoversOf } =
      serveWithRecordedChannels();
    const { streams: survivor } = await openPage(OTHER_CLIENT);

    for (const round of [1, 2, 3]) {
      const clientId = `00000000-0000-4000-8000-00000000010${round}`;
      await openPage(clientId);
      expect(leftoversOf(clientId).observedSources).toBeGreaterThan(0);

      await closePage(clientId);
      sources
        .get(OTHER_CLIENT)?.[0]
        .status$.next({ engineGeneration: 'generation-1', resets: round });

      expect(leftoversOf(clientId)).toEqual(NOTHING_LEFT);
      expect(
        await firstValueFrom(
          survivor.status$.pipe(
            filter(({ resets }) => resets === round),
            timeout(5000),
          ),
        ),
      ).toEqual({ engineGeneration: 'generation-1', resets: round });
    }
  });

  it('serves a client again under the same id once its last port has closed, and keeps no id of a closed page', async () => {
    const clientIds = [
      CLIENT,
      ...[1, 2, 3].map(round => `00000000-0000-4000-8000-00000000020${round}`),
    ];
    // The served ids are the worker's own, so the test finds the sets they go into.
    const { add } = Set.prototype;
    const holding = new Set<Set<unknown>>();
    Set.prototype.add = function (this: Set<unknown>, value: unknown) {
      if (clientIds.includes(value as string)) add.call(holding, this);
      return add.call(this, value);
    };
    onTestFinished(() => {
      Set.prototype.add = add;
    });
    const idsHeld = () =>
      [...holding].reduce((total, held) => total + held.size, 0);
    const { host, openPage, closePage, leftoversOf } =
      serveWithRecordedChannels();

    await openPage(CLIENT);
    await closePage(CLIENT);
    await openPage(CLIENT);
    const attachesOfTheSameId = host.attach.mock.calls.length;
    await closePage(CLIENT);
    await vi.waitFor(() => {
      expect(host.detachClient).toHaveBeenCalledTimes(2);
    });
    for (const clientId of clientIds.slice(1)) {
      await openPage(clientId);
      await closePage(clientId);
    }

    expect(attachesOfTheSameId).toBe(2);
    expect(leftoversOf(CLIENT)).toEqual(NOTHING_LEFT);
    expect(idsHeld()).toBe(0);
  });

  it("lets a call still running when its page closes run to its end, and its late answer leaves nothing of the closed client in the worker, while another page's calls keep working", async () => {
    const { host, openPage, closePage, leftoversOf } =
      serveWithRecordedChannels();
    const { remote: survivor } = await openPage(OTHER_CLIENT);
    const { remote } = await openPage(CLIENT);
    let settle!: (result: { txId: string }) => void;
    host.submit.mockImplementationOnce(
      async () =>
        new Promise(resolve => {
          settle = resolve;
        }),
    );
    void remote
      .submit({
        clientId: CLIENT,
        accountId: fixture.accountId,
        transaction: workerFinalizedTx(),
      })
      .catch(() => undefined);
    await vi.waitFor(() => {
      expect(host.submit).toHaveBeenCalledOnce();
    });

    await closePage(CLIENT);
    settle({ txId: 'worker-tx' });
    // The late answer travels through promises alone, so the worker has handled it before this call crosses a port.
    const signed = await survivor.signData({
      clientId: OTHER_CLIENT,
      accountId: fixture.accountId,
      data: new Uint8Array([1]),
    });

    expect(leftoversOf(CLIENT)).toEqual(NOTHING_LEFT);
    expect(host.submit).toHaveBeenCalledOnce();
    expect(host.submit).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: CLIENT }),
    );
    expect(signed).toEqual({
      signature: 'worker-signature',
      verifyingKey: 'worker-key',
    });
  });

  it("composes the worker's host with the storage backends the SDK's storage modules build on, one store per storage kind keyed by account as page mode keys it, and the dApp connector's Pending activity derivation", async () => {
    createSdkMidnightEngineHost(dummyLogger);
    const [dependencies] = hostDependencies as Parameters<
      typeof MidnightSyncSdkEngine.createMidnightEngineHost
    >[0][];
    const memory = dependencies.createStore('memory');
    const checkpoint = {
      accountId: fixture.accountId,
    } as unknown as SerializedMidnightWallet;
    await firstValueFrom(memory.upsert(checkpoint), {
      defaultValue: undefined,
    });

    expect(hostDependencies).toHaveLength(1);
    expect(dependencies.derivePendingActivity).toBe(
      derivePendingActivityFromMidnightTx,
    );
    expect(await firstValueFrom(memory.get(String(fixture.accountId)))).toBe(
      checkpoint,
    );
    const indexedDb = dependencies.createStore('indexeddb');
    expect(indexedDb).toBeInstanceOf(CollectionStore);
    expect(indexedDb).not.toBe(memory);
  });
});
