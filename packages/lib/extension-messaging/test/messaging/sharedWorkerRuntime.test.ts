import { BehaviorSubject, filter, firstValueFrom, of } from 'rxjs';
import { dummyLogger } from 'ts-log';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import {
  ChannelName,
  FinalizationRegistryDestructor,
  RemoteApiPropertyType,
  RemoteApiShutdownError,
  SharedWorkerStartupError,
  consumeMessengerRemoteApi,
  createBackgroundMessenger,
  createNonBackgroundMessenger,
  createSharedWorkerClientRuntime,
  createSharedWorkerHostRuntime,
  exposeMessengerApi,
  generalizeBackgroundMessenger,
} from '../../src';

import type {
  MessengerPort,
  MinimalRuntime,
  RemoteApiProperties,
  SharedWorkerLocks,
  SharedWorkerPort,
} from '../../src';
import type { Observable, ObservedValueOf } from 'rxjs';
import type { Logger } from 'ts-log';

// The package exports only what production code uses, so the tests derive the runtimes' types from their factories
// and know the stop error by its name.
type SharedWorkerClientRuntime = ReturnType<
  typeof createSharedWorkerClientRuntime
>;
type SharedWorkerClientRuntimeOptions = Parameters<
  typeof createSharedWorkerClientRuntime
>[0];
type SharedWorkerHostRuntime = ReturnType<typeof createSharedWorkerHostRuntime>;
type SharedWorkerRuntimeStatus = ObservedValueOf<
  SharedWorkerClientRuntime['status$']
>;

// setImmediate runs after every queued microtask, so each fake delivery and
// lock grant before it has happened.
const flush = async () =>
  new Promise<void>(resolve => {
    setImmediate(resolve);
  });

/**
 * One end of a `MessageChannel`: a message is cloned when posted, delivered
 * asynchronously, held until `start()`, and dropped once either end is closed.
 */
class FakePort implements SharedWorkerPort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  peer: FakePort | undefined;
  isClosed = false;
  #isStarted = false;
  readonly #inbox: unknown[] = [];

  close() {
    this.isClosed = true;
  }

  postMessage(message: unknown) {
    const data = structuredClone(message);
    if (this.isClosed) return;
    const peer = this.peer;
    queueMicrotask(() => {
      if (peer) peer.#receive(data);
    });
  }

  start() {
    this.#isStarted = true;
    this.#drain();
  }

  #receive(data: unknown) {
    if (this.isClosed) return;
    this.#inbox.push(data);
    this.#drain();
  }

  #drain() {
    while (this.#isStarted && !this.isClosed && this.#inbox.length > 0) {
      const event = new MessageEvent('message', { data: this.#inbox.shift() });
      this.onmessage?.(event);
    }
  }
}

const createChannel = (): [FakePort, FakePort] => {
  const one = new FakePort();
  const other = new FakePort();
  one.peer = other;
  other.peer = one;
  return [one, other];
};

interface LockRequestRecord {
  agent: string;
  /** The agent that held the lock when the request was made. */
  heldBy: string | undefined;
  name: string;
}

interface QueuedLockRequest {
  agent: string;
  callback: (lock: Lock | null) => unknown;
  mode: LockMode;
  reject: (reason: unknown) => void;
  resolve: (value: unknown) => void;
}

interface HeldLock {
  agent: string;
  mode: LockMode;
  reject: (reason: unknown) => void;
}

/**
 * The lock manager the tabs and the worker of one origin share. Locks, exclusive
 * or shared, are granted asynchronously, in request order; when an agent dies its
 * locks are released and its queued requests dropped, as the browser does when a
 * document or a worker ends.
 */
class FakeLockManager {
  readonly requests: LockRequestRecord[] = [];
  readonly #held = new Map<string, HeldLock[]>();
  readonly #queues = new Map<string, QueuedLockRequest[]>();
  readonly #dead = new Set<string>();
  readonly #paused = new Set<string>();
  readonly #pausedCallbacks = new Map<string, (() => void)[]>();

  forAgent(agent: string): SharedWorkerLocks {
    return {
      request: async (name, { mode = 'exclusive', signal }, callback) =>
        new Promise((resolve, reject) => {
          if (this.#dead.has(agent)) return;
          this.requests.push({ agent, heldBy: this.holderOf(name), name });
          const request: QueuedLockRequest = {
            agent,
            callback,
            mode,
            reject,
            resolve,
          };
          this.#queue(name).push(request);
          signal?.addEventListener('abort', () => {
            const queue = this.#queue(name);
            if (!queue.includes(request)) return;
            queue.splice(queue.indexOf(request), 1);
            reject(new DOMException('The request was aborted', 'AbortError'));
            this.#grant(name);
          });
          queueMicrotask(() => {
            this.#grant(name);
          });
        }),
    };
  }

  holderOf(name: string) {
    return this.#held.get(name)?.at(0)?.agent;
  }

  pauseGrants(agent: string) {
    this.#paused.add(agent);
  }

  resumeGrants(agent: string) {
    this.#paused.delete(agent);
    for (const name of this.#queues.keys()) this.#grant(name);
  }

  /** The agent is still granted locks, but runs no callback until resumed, as a frozen page. */
  pauseCallbacks(agent: string) {
    this.#pausedCallbacks.set(agent, this.#pausedCallbacks.get(agent) ?? []);
  }

  resumeCallbacks(agent: string) {
    const callbacks = this.#pausedCallbacks.get(agent) ?? [];
    this.#pausedCallbacks.delete(agent);
    for (const callback of callbacks) callback();
  }

  kill(agent: string) {
    this.#dead.add(agent);
    this.#pausedCallbacks.delete(agent);
    this.#cancel(agent, () => undefined);
  }

  /**
   * What WebKit does when it suspends a page or keeps it in the back/forward cache:
   * the agent's locks are released and its requests, held or queued, rejected. The
   * agent lives on and may request again.
   */
  suspend(agent: string) {
    const error = new DOMException(
      'Promise was rejected because the browsing context is going away',
      'AbortError',
    );
    this.#cancel(agent, reject => {
      reject(error);
    });
  }

  /**
   * What `request(name, { steal: true })` from another context does: every lock the agent holds passes to that
   * context, which keeps it, and the agent's request for it rejects with an `AbortError`.
   */
  steal(agent: string) {
    for (const [name, held] of this.#held) {
      const stolen = held.filter(lock => lock.agent === agent);
      if (stolen.length === 0) continue;
      this.#held.set(name, [
        ...held.filter(lock => lock.agent !== agent),
        { agent: 'thief', mode: 'exclusive', reject: () => undefined },
      ]);
      for (const lock of stolen)
        lock.reject(new DOMException('The lock was stolen', 'AbortError'));
    }
  }

  #cancel(agent: string, settle: (reject: (reason: unknown) => void) => void) {
    for (const [name, queue] of this.#queues) {
      for (const request of queue)
        if (request.agent === agent) settle(request.reject);
      this.#queues.set(
        name,
        queue.filter(request => request.agent !== agent),
      );
    }
    for (const [name, held] of this.#held) {
      if (!held.some(lock => lock.agent === agent)) continue;
      this.#held.set(
        name,
        held.filter(lock => lock.agent !== agent),
      );
      for (const lock of held) if (lock.agent === agent) settle(lock.reject);
      this.#grant(name);
    }
  }

  #queue(name: string) {
    let queue = this.#queues.get(name);
    if (!queue) this.#queues.set(name, (queue = []));
    return queue;
  }

  #grant(name: string) {
    const queue = this.#queue(name);
    for (const request of [...queue]) {
      const held = this.#held.get(name) ?? [];
      const isGrantable =
        request.mode === 'shared'
          ? held.every(lock => lock.mode === 'shared')
          : held.length === 0;
      if (!isGrantable || this.#paused.has(request.agent)) return;
      queue.shift();
      this.#hold(name, request);
    }
  }

  #hold(name: string, request: QueuedLockRequest) {
    const lock: HeldLock = {
      agent: request.agent,
      mode: request.mode,
      reject: request.reject,
    };
    this.#held.set(name, [...(this.#held.get(name) ?? []), lock]);
    const isHeld = () => this.#held.get(name)?.includes(lock) ?? false;
    const release = () => {
      if (!isHeld()) return;
      this.#held.set(
        name,
        (this.#held.get(name) ?? []).filter(other => other !== lock),
      );
      this.#grant(name);
    };
    const runCallback = () => {
      if (!isHeld()) return;
      Promise.resolve()
        .then(() => request.callback({ mode: request.mode, name }))
        .then(
          value => {
            release();
            request.resolve(value);
          },
          (error: unknown) => {
            release();
            request.reject(error);
          },
        );
    };
    const pausedCallbacks = this.#pausedCallbacks.get(request.agent);
    if (pausedCallbacks) pausedCallbacks.push(runCallback);
    else runCallback();
  }
}

interface WatchedPort {
  messages: unknown[];
  onDisconnect: ReturnType<typeof vi.fn>;
  port: MessengerPort;
}

const watchPort = (port: MessengerPort): WatchedPort => {
  const messages: unknown[] = [];
  const onDisconnect = vi.fn();
  port.onMessage.addListener(data => messages.push(data));
  port.onDisconnect.addListener(onDisconnect);
  return { messages, onDisconnect, port };
};

interface StatusRecord {
  completed: boolean;
  error?: unknown;
  values: SharedWorkerRuntimeStatus[];
}

const recordStatus = (runtime: SharedWorkerClientRuntime): StatusRecord => {
  const record: StatusRecord = { completed: false, values: [] };
  runtime.status$.subscribe({
    complete: () => {
      record.completed = true;
    },
    error: (error: unknown) => {
      record.error = error;
    },
    next: value => record.values.push(value),
  });
  return record;
};

interface WorkerInstance {
  agent: string;
  /** The worker's ends of its tabs' ports. */
  clientPorts: FakePort[];
  host: SharedWorkerHostRuntime;
  /** The named ports the host has served, in order, watched from the moment they arrive. */
  hostPorts: WatchedPort[];
}

/**
 * One origin: its lock manager and the SharedWorker its tabs attach to. As with
 * `new SharedWorker()`, a worker starts on the first connection while none runs;
 * `startWorker` plays the worker's script once its host runtime exists.
 */
const createOrigin = ({
  logger = dummyLogger,
  startWorker = host => {
    host.markReady();
  },
}: {
  logger?: Logger;
  startWorker?: (host: SharedWorkerHostRuntime, agent: string) => void;
} = {}) => {
  const locks = new FakeLockManager();
  const tabPorts = new Map<string, FakePort[]>();
  let startedWorkers = 0;
  let worker: WorkerInstance | undefined;

  const connectWorker = (tab: string) => {
    if (!worker) {
      const agent = `worker-${++startedWorkers}`;
      const host = createSharedWorkerHostRuntime({
        locks: locks.forAgent(agent),
        logger,
      });
      const instance: WorkerInstance = {
        agent,
        clientPorts: [],
        host,
        hostPorts: [],
      };
      host.onConnect.addListener(port => {
        instance.hostPorts.push(watchPort(port));
      });
      worker = instance;
      startWorker(host, agent);
    }
    const [tabSide, workerSide] = createChannel();
    worker.clientPorts.push(workerSide);
    tabPorts.set(tab, [...(tabPorts.get(tab) ?? []), tabSide]);
    worker.host.addClient(workerSide);
    return tabSide;
  };

  return {
    closeTab: (tab: string) => {
      locks.kill(tab);
      for (const port of tabPorts.get(tab) ?? []) port.close();
    },
    killWorker: () => {
      if (!worker) throw new Error('No worker runs');
      locks.kill(worker.agent);
      for (const port of worker.clientPorts) port.close();
      worker = undefined;
    },
    locks,
    openTab: (
      tab: string,
      options: Omit<SharedWorkerClientRuntimeOptions, 'connectWorker'> = {},
    ) =>
      createSharedWorkerClientRuntime(
        { connectWorker: () => connectWorker(tab), ...options },
        { locks: locks.forAgent(tab), logger },
      ),
    get startedWorkers() {
      return startedWorkers;
    },
    get worker() {
      return worker;
    },
  };
};

const runningWorker = (origin: ReturnType<typeof createOrigin>) => {
  const { worker } = origin;
  if (!worker) throw new Error('No worker runs');
  return worker;
};

interface TestApi {
  counter$: Observable<number>;
  /** Never settles, like a proof that is still running. */
  wait(): Promise<void>;
  whoAmI(tab: string): Promise<string>;
}

const testApiProperties: RemoteApiProperties<TestApi> = {
  counter$: RemoteApiPropertyType.HotObservable,
  wait: RemoteApiPropertyType.MethodReturningPromise,
  whoAmI: RemoteApiPropertyType.MethodReturningPromise,
};

const baseChannel = ChannelName('shared-worker-runtime-test');

const exposeTestApi = (host: SharedWorkerHostRuntime, api: TestApi) => {
  const messenger = generalizeBackgroundMessenger(
    baseChannel,
    createBackgroundMessenger({ logger: dummyLogger, runtime: host }),
    dummyLogger,
  );
  exposeMessengerApi(
    { api$: of(api), properties: testApiProperties },
    { logger: dummyLogger, messenger },
  );
  host.markReady();
};

const consumeTestApi = (runtime: MinimalRuntime) =>
  consumeMessengerRemoteApi<TestApi>(
    { properties: testApiProperties },
    {
      destructor: new FinalizationRegistryDestructor(dummyLogger),
      logger: dummyLogger,
      messenger: createNonBackgroundMessenger(
        { baseChannel },
        { logger: dummyLogger, runtime },
      ),
    },
  );

afterEach(() => {
  vi.useRealTimers();
});

describe('shared-worker-runtime', () => {
  it('accepts the browser MessagePort and LockManager', () => {
    expectTypeOf<MessagePort>().toExtend<SharedWorkerPort>();
    expectTypeOf<LockManager>().toExtend<SharedWorkerLocks>();
  });

  it('connects named ports from two tabs to one worker and routes each message to its own port', async () => {
    const origin = createOrigin();
    const tab1 = origin.openTab('tab-1');
    const alpha1 = watchPort(tab1.connect({ name: 'alpha' }));
    const beta1 = watchPort(tab1.connect({ name: 'beta' }));
    alpha1.port.postMessage('from tab 1');
    await flush();
    const tab2 = origin.openTab('tab-2');
    const alpha2 = watchPort(tab2.connect({ name: 'alpha' }));
    alpha2.port.postMessage('from tab 2');
    await flush();

    const worker = runningWorker(origin);
    expect(origin.startedWorkers).toBe(1);
    expect(worker.hostPorts.map(({ port }) => port.name)).toEqual([
      'alpha',
      'beta',
      'alpha',
    ]);
    expect(worker.hostPorts.map(({ messages }) => messages)).toEqual([
      ['from tab 1'],
      [],
      ['from tab 2'],
    ]);

    const [hostAlpha1, hostBeta1, hostAlpha2] = worker.hostPorts;
    hostAlpha1.port.postMessage('to tab 1, alpha');
    hostBeta1.port.postMessage('to tab 1, beta');
    hostAlpha2.port.postMessage('to tab 2, alpha');
    await flush();

    expect(alpha1.messages).toEqual(['to tab 1, alpha']);
    expect(beta1.messages).toEqual(['to tab 1, beta']);
    expect(alpha2.messages).toEqual(['to tab 2, alpha']);
  });

  it('answers the handshake only once the worker is marked ready, holding earlier frames until then', async () => {
    let started: SharedWorkerHostRuntime | undefined;
    const origin = createOrigin({
      startWorker: host => {
        started = host;
      },
    });
    const tab = origin.openTab('tab-1');
    const status = recordStatus(tab);
    const alpha = watchPort(tab.connect({ name: 'alpha' }));
    alpha.port.postMessage('first');
    alpha.port.postMessage('second');
    await flush();

    expect(status.values).toEqual(['starting']);
    expect(runningWorker(origin).hostPorts).toEqual([]);

    started?.markReady();
    await flush();

    expect(status.values).toEqual(['starting', 'ready']);
    expect(
      runningWorker(origin).hostPorts.map(({ messages }) => messages),
    ).toEqual([['first', 'second']]);
  });

  it('sends its handshake only once it holds its tab lock, so the worker cannot take the tab for closed', async () => {
    const origin = createOrigin();
    origin.locks.pauseGrants('tab-1');
    const tab = origin.openTab('tab-1');
    const status = recordStatus(tab);
    await flush();
    const tabLock = origin.locks.requests.find(
      ({ agent }) => agent === 'tab-1',
    )?.name;
    const workerRequestsForTabLock = () =>
      origin.locks.requests.filter(
        ({ agent, name }) => agent === 'worker-1' && name === tabLock,
      );

    expect(tabLock).toBeDefined();
    expect(workerRequestsForTabLock()).toEqual([]);

    origin.locks.resumeGrants('tab-1');
    await flush();

    expect(workerRequestsForTabLock()).toEqual([
      { agent: 'worker-1', heldBy: 'tab-1', name: tabLock },
    ]);
    expect(status.values).toEqual(['starting', 'ready']);
  });

  it('answers the handshake only once the worker holds its runtime lock, so no tab takes the worker for dead', async () => {
    const origin = createOrigin();
    origin.locks.pauseGrants('worker-1');
    const tab = origin.openTab('tab-1');
    const status = recordStatus(tab);
    await flush();

    expect(status.values).toEqual(['starting']);

    origin.locks.resumeGrants('worker-1');
    await flush();

    expect(status).toEqual({ completed: false, values: ['starting', 'ready'] });
  });

  it("takes a tab's ports only once it has answered the tab's handshake, and ignores a port the tab opened before", async () => {
    const locks = new FakeLockManager();
    const host = createSharedWorkerHostRuntime({
      locks: locks.forAgent('worker-1'),
      logger: dummyLogger,
    });
    const served: string[] = [];
    host.onConnect.addListener(port => served.push(port.name));
    const [tabSide, workerSide] = createChannel();
    const received: unknown[] = [];
    tabSide.onmessage = ({ data }) => received.push(data);
    tabSide.start();
    host.addClient(workerSide);
    void locks
      .forAgent('tab-1')
      .request('tab-1-lock', {}, async () => new Promise(() => undefined));
    await flush();

    // A tab's own runtime never sends these before `ready`; a raw tab can.
    tabSide.postMessage({ kind: 'hello', tabLock: 'tab-1-lock' });
    tabSide.postMessage({ kind: 'connect', name: 'early', portId: 0 });
    await flush();
    const servedBeforeReady = [...served];
    host.markReady();
    await flush();
    tabSide.postMessage({ kind: 'connect', name: 'late', portId: 1 });
    await flush();

    expect(servedBeforeReady).toEqual([]);
    expect(received).toEqual([
      { kind: 'ready', runtimeLock: expect.any(String) as string },
    ]);
    expect(served).toEqual(['late']);
  });

  describe('a worker without its runtime lock', () => {
    const openTabOf =
      (host: SharedWorkerHostRuntime, locks: FakeLockManager) =>
      (tab: string) => {
        const [tabSide, workerSide] = createChannel();
        host.addClient(workerSide);
        return recordStatus(
          createSharedWorkerClientRuntime(
            { connectWorker: () => tabSide },
            { locks: locks.forAgent(tab), logger: dummyLogger },
          ),
        );
      };

    it('reports a runtime lock that another context steals once held, and answers no handshake after it', async () => {
      const locks = new FakeLockManager();
      const onRuntimeLockLost = vi.fn();
      const host = createSharedWorkerHostRuntime({
        locks: locks.forAgent('worker'),
        logger: dummyLogger,
        onRuntimeLockLost,
      });
      host.markReady();
      const openTab = openTabOf(host, locks);
      const before = openTab('tab-1');
      await flush();

      locks.steal('worker');
      await flush();
      const after = openTab('tab-2');
      await flush();

      expect(before.values).toEqual(['starting', 'ready']);
      expect(onRuntimeLockLost).toHaveBeenCalledOnce();
      expect(onRuntimeLockLost).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'AbortError' }),
      );
      expect(after.values).toEqual(['starting']);
    });

    it('reports a runtime lock the browser refuses, and answers no handshake', async () => {
      const locks = new FakeLockManager();
      const refusal = new DOMException('No locks here', 'SecurityError');
      const onRuntimeLockLost = vi.fn();
      const host = createSharedWorkerHostRuntime({
        locks: {
          request: async (name, options, callback) =>
            name.includes(':runtime:')
              ? Promise.reject(refusal)
              : locks.forAgent('worker').request(name, options, callback),
        },
        logger: dummyLogger,
        onRuntimeLockLost,
      });
      host.markReady();
      const status = openTabOf(host, locks)('tab-1');
      await flush();

      expect(onRuntimeLockLost.mock.calls).toEqual([[refusal]]);
      expect(status.values).toEqual(['starting']);
    });
  });

  it("releases a closed tab's ports in the worker and keeps the other tab's ports open", async () => {
    const origin = createOrigin();
    const tab1 = origin.openTab('tab-1');
    tab1.connect({ name: 'alpha' });
    tab1.connect({ name: 'beta' });
    await flush();
    const tab2 = origin.openTab('tab-2');
    const alpha2 = watchPort(tab2.connect({ name: 'alpha' }));
    await flush();
    const [hostAlpha1, hostBeta1, hostAlpha2] = runningWorker(origin).hostPorts;

    origin.closeTab('tab-1');
    await flush();

    expect(hostAlpha1.onDisconnect).toHaveBeenCalledTimes(1);
    expect(hostAlpha1.onDisconnect).toHaveBeenCalledWith(hostAlpha1.port);
    expect(hostBeta1.onDisconnect).toHaveBeenCalledTimes(1);
    expect(hostAlpha2.onDisconnect).not.toHaveBeenCalled();
    // The pattern BackgroundMessenger matches to release a dead port.
    expect(() => {
      hostAlpha1.port.postMessage('to a closed tab');
    }).toThrow(/disconnected port/i);

    hostAlpha2.port.postMessage('still served');
    await flush();
    expect(alpha2.messages).toEqual(['still served']);
  });

  it('releases its ports on both sides when a tab shuts its runtime down, and the worker keeps serving', async () => {
    const origin = createOrigin();
    const tab1 = origin.openTab('tab-1');
    const status1 = recordStatus(tab1);
    const alpha1 = watchPort(tab1.connect({ name: 'alpha' }));
    await flush();
    const tab2 = origin.openTab('tab-2');
    const alpha2 = watchPort(tab2.connect({ name: 'alpha' }));
    await flush();

    tab1.shutdown();
    await flush();

    const [hostAlpha1, hostAlpha2] = runningWorker(origin).hostPorts;
    expect(status1).toEqual({ completed: true, values: ['starting', 'ready'] });
    expect(alpha1.onDisconnect).toHaveBeenCalledTimes(1);
    expect(hostAlpha1.onDisconnect).toHaveBeenCalledTimes(1);
    expect(hostAlpha2.onDisconnect).not.toHaveBeenCalled();
    hostAlpha2.port.postMessage('still served');
    await flush();
    expect(alpha2.messages).toEqual(['still served']);
    expect(origin.startedWorkers).toBe(1);
  });

  it('fails every port of every tab exactly once when the worker dies', async () => {
    const origin = createOrigin();
    const tabs = [origin.openTab('tab-1'), origin.openTab('tab-2')];
    const statuses = tabs.map(recordStatus);
    const ports = tabs.flatMap(tab => [
      watchPort(tab.connect({ name: 'alpha' })),
      watchPort(tab.connect({ name: 'beta' })),
    ]);
    await flush();

    origin.killWorker();
    await flush();
    for (const tab of tabs) tab.shutdown();
    await flush();

    for (const { onDisconnect, port } of ports) {
      expect(onDisconnect).toHaveBeenCalledTimes(1);
      expect(onDisconnect).toHaveBeenCalledWith(port);
    }
    for (const status of statuses) {
      expect(status.values).toEqual(['starting', 'ready']);
      expect(status.error).toHaveProperty(
        'name',
        'SharedWorkerRuntimeStoppedError',
      );
      expect(status.completed).toBe(false);
    }
  });

  it('tells a tab that the worker died while another tab runs no lock callback, and no tab while the worker holds its lock', async () => {
    const origin = createOrigin();
    const tab1 = origin.openTab('tab-1');
    const status1 = recordStatus(tab1);
    const alpha1 = watchPort(tab1.connect({ name: 'alpha' }));
    await flush();
    const tab2 = origin.openTab('tab-2');
    const status2 = recordStatus(tab2);
    const alpha2 = watchPort(tab2.connect({ name: 'alpha' }));
    await flush();
    const runtimeLock = origin.locks.requests.find(
      ({ agent }) => agent === 'worker-1',
    )?.name;

    expect(
      origin.locks.requests.filter(
        ({ agent, name }) => agent !== 'worker-1' && name === runtimeLock,
      ),
    ).toEqual([
      { agent: 'tab-1', heldBy: 'worker-1', name: runtimeLock },
      { agent: 'tab-2', heldBy: 'worker-1', name: runtimeLock },
    ]);
    expect(status1).toEqual({
      completed: false,
      values: ['starting', 'ready'],
    });
    expect(status2).toEqual({
      completed: false,
      values: ['starting', 'ready'],
    });

    origin.locks.pauseCallbacks('tab-1');
    origin.killWorker();
    await flush();

    expect(status2.error).toHaveProperty(
      'name',
      'SharedWorkerRuntimeStoppedError',
    );
    expect(alpha2.onDisconnect).toHaveBeenCalledTimes(1);
    expect(status1).toEqual({
      completed: false,
      values: ['starting', 'ready'],
    });
    expect(alpha1.onDisconnect).not.toHaveBeenCalled();

    origin.locks.resumeCallbacks('tab-1');
    await flush();

    expect(status1.error).toHaveProperty(
      'name',
      'SharedWorkerRuntimeStoppedError',
    );
    expect(alpha1.onDisconnect).toHaveBeenCalledTimes(1);
    expect(alpha2.onDisconnect).toHaveBeenCalledTimes(1);
  });

  it('fails a port connected after the worker died, without starting a worker', async () => {
    const origin = createOrigin();
    const tab = origin.openTab('tab-1');
    await flush();
    origin.killWorker();
    await flush();

    const late = watchPort(tab.connect({ name: 'alpha' }));
    late.port.postMessage('before its disconnect fires');
    expect(late.onDisconnect).not.toHaveBeenCalled();
    await flush();

    expect(late.onDisconnect).toHaveBeenCalledTimes(1);
    expect(late.onDisconnect).toHaveBeenCalledWith(late.port);
    expect(() => {
      late.port.postMessage('to nobody');
    }).toThrow(/disconnected port/i);
    expect(origin.worker).toBeUndefined();
    expect(origin.startedWorkers).toBe(1);
  });

  it('reaches a new worker through a new runtime after a death', async () => {
    const origin = createOrigin();
    const stopped = origin.openTab('tab-1');
    await flush();
    origin.killWorker();
    await flush();

    const restarted = origin.openTab('tab-1');
    const status = recordStatus(restarted);
    const alpha = watchPort(restarted.connect({ name: 'alpha' }));
    alpha.port.postMessage('after the restart');
    await flush();

    const worker = runningWorker(origin);
    expect(status.values).toEqual(['starting', 'ready']);
    expect(worker.agent).toBe('worker-2');
    expect(worker.hostPorts.map(({ messages }) => messages)).toEqual([
      ['after the restart'],
    ]);
    const late = watchPort(stopped.connect({ name: 'alpha' }));
    await flush();
    expect(late.onDisconnect).toHaveBeenCalledTimes(1);
    expect(worker.hostPorts).toHaveLength(1);
  });

  it('ends with SharedWorkerRuntimeStoppedError, failing each port once, when the browser cancels its locks, and a new runtime attaches after', async () => {
    const error = vi.fn();
    const origin = createOrigin({ logger: { ...dummyLogger, error } });
    const tab1 = origin.openTab('tab-1');
    const status1 = recordStatus(tab1);
    const ports1 = [
      watchPort(tab1.connect({ name: 'alpha' })),
      watchPort(tab1.connect({ name: 'beta' })),
    ];
    await flush();
    const tab2 = origin.openTab('tab-2');
    const alpha2 = watchPort(tab2.connect({ name: 'alpha' }));
    await flush();
    const [hostAlpha1, hostBeta1, hostAlpha2] = runningWorker(origin).hostPorts;

    origin.locks.suspend('tab-1');
    await flush();
    const late = watchPort(tab1.connect({ name: 'alpha' }));
    await flush();
    tab1.shutdown();
    await flush();

    expect(status1.values).toEqual(['starting', 'ready']);
    expect(status1.error).toHaveProperty(
      'name',
      'SharedWorkerRuntimeStoppedError',
    );
    expect(status1.error).toHaveProperty('cause.name', 'AbortError');
    for (const { onDisconnect } of [...ports1, late])
      expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(hostAlpha1.onDisconnect).toHaveBeenCalledTimes(1);
    expect(hostBeta1.onDisconnect).toHaveBeenCalledTimes(1);
    expect(hostAlpha2.onDisconnect).not.toHaveBeenCalled();

    const restored = origin.openTab('tab-1');
    const status = recordStatus(restored);
    const alpha = watchPort(restored.connect({ name: 'alpha' }));
    alpha.port.postMessage('after the restore');
    hostAlpha2.port.postMessage('still served');
    await flush();

    expect(status).toEqual({ completed: false, values: ['starting', 'ready'] });
    expect(origin.startedWorkers).toBe(1);
    expect(runningWorker(origin).hostPorts.at(-1)?.messages).toEqual([
      'after the restore',
    ]);
    expect(alpha2.messages).toEqual(['still served']);

    restored.shutdown();
    await flush();
    // Only the cancellation is logged, not the aborts that stop() causes.
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('ends with SharedWorkerStartupError when the worker does not answer its handshake in time, and fails its ports', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const origin = createOrigin({ startWorker: () => undefined });
    const tab = origin.openTab('tab-1', { handshakeTimeoutMs: 5000 });
    const status = recordStatus(tab);
    const alpha = watchPort(tab.connect({ name: 'alpha' }));

    await vi.advanceTimersByTimeAsync(4999);
    expect(status).toEqual({ completed: false, values: ['starting'] });
    expect(alpha.onDisconnect).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(status.error).toBeInstanceOf(SharedWorkerStartupError);
    expect(status.error).toHaveProperty(
      'message',
      'The SharedWorker runtime did not start: the worker did not answer the handshake within 5000 ms',
    );
    expect(alpha.onDisconnect).toHaveBeenCalledTimes(1);

    const worker = runningWorker(origin);
    worker.host.markReady();
    await flush();
    expect(status.values).toEqual(['starting']);
    expect(worker.hostPorts).toEqual([]);
    expect(worker.clientPorts[0].isClosed).toBe(true);
  });

  it('ends with SharedWorkerStartupError after 30 s when the worker script never runs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const locks = new FakeLockManager();
    const [tabSide] = createChannel();
    const tab = createSharedWorkerClientRuntime(
      { connectWorker: () => tabSide },
      { locks: locks.forAgent('tab-1'), logger: dummyLogger },
    );
    const status = recordStatus(tab);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(status.error).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(status.error).toBeInstanceOf(SharedWorkerStartupError);
    expect(tabSide.isClosed).toBe(true);
    const [tabLockRequest] = locks.requests;
    expect(locks.holderOf(tabLockRequest.name)).toBeUndefined();
  });

  it('ends with SharedWorkerStartupError at once when the browser cancels its tab lock during the handshake', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const origin = createOrigin({ startWorker: () => undefined });
    const tab = origin.openTab('tab-1');
    const status = recordStatus(tab);
    const alpha = watchPort(tab.connect({ name: 'alpha' }));
    await flush();

    origin.locks.suspend('tab-1');
    await flush();

    expect(status.values).toEqual(['starting']);
    expect(status.error).toBeInstanceOf(SharedWorkerStartupError);
    expect(status.error).toHaveProperty('cause.name', 'AbortError');
    expect(alpha.onDisconnect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('becomes ready when its port delivers the handshake answer from start(), and the deadline never fires', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const locks = new FakeLockManager();
    void locks
      .forAgent('worker-1')
      .request('runtime-lock', {}, async () => new Promise(() => undefined));
    const [tabSide, workerSide] = createChannel();
    // FakePort delivers what its inbox holds synchronously from start().
    workerSide.postMessage({ kind: 'ready', runtimeLock: 'runtime-lock' });
    await flush();

    const tab = createSharedWorkerClientRuntime(
      { connectWorker: () => tabSide },
      { locks: locks.forAgent('tab-1'), logger: dummyLogger },
    );
    const status = recordStatus(tab);

    expect(status.values).toEqual(['ready']);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(status).toEqual({ completed: false, values: ['ready'] });
    expect(tabSide.isClosed).toBe(false);
  });

  it('disconnects the matching port on the other side, without firing the own side, and refuses later posts', async () => {
    const origin = createOrigin();
    const tab = origin.openTab('tab-1');
    const alpha = watchPort(tab.connect({ name: 'alpha' }));
    const beta = watchPort(tab.connect({ name: 'beta' }));
    await flush();
    const [hostAlpha, hostBeta] = runningWorker(origin).hostPorts;

    hostAlpha.port.disconnect();
    beta.port.disconnect();
    beta.port.disconnect();
    await flush();

    expect(alpha.onDisconnect).toHaveBeenCalledTimes(1);
    expect(hostAlpha.onDisconnect).not.toHaveBeenCalled();
    expect(hostBeta.onDisconnect).toHaveBeenCalledTimes(1);
    expect(beta.onDisconnect).not.toHaveBeenCalled();
    expect(() => {
      alpha.port.postMessage('late');
    }).toThrow(/disconnected port/i);
    expect(() => {
      hostBeta.port.postMessage('late');
    }).toThrow(/disconnected port/i);
  });

  it('still fails the other ports when an onDisconnect listener throws', async () => {
    const error = vi.fn();
    const origin = createOrigin({ logger: { ...dummyLogger, error } });
    const tab = origin.openTab('tab-1');
    tab.connect({ name: 'alpha' }).onDisconnect.addListener(() => {
      throw new Error('listener failed');
    });
    const beta = watchPort(tab.connect({ name: 'beta' }));
    await flush();

    origin.killWorker();
    await flush();

    expect(beta.onDisconnect).toHaveBeenCalledTimes(1);
    expect(error.mock.calls.flat()).toContainEqual(
      expect.objectContaining({ message: 'listener failed' }),
    );
  });

  it('ignores frames from a tab before its handshake and frames that break the protocol', async () => {
    const warn = vi.fn();
    const locks = new FakeLockManager();
    const host = createSharedWorkerHostRuntime({
      locks: locks.forAgent('worker-1'),
      logger: { ...dummyLogger, warn },
    });
    const served = vi.fn();
    host.onConnect.addListener(served);
    host.markReady();
    const [tabSide, workerSide] = createChannel();
    const received: unknown[] = [];
    tabSide.onmessage = ({ data }) => received.push(data);
    tabSide.start();
    host.addClient(workerSide);

    for (const frame of [
      { kind: 'connect', name: 'alpha', portId: 0 },
      'not a frame',
      null,
      { kind: 'hello' },
      { kind: 'connect', name: 1, portId: 0 },
      { kind: 'unknown' },
    ])
      tabSide.postMessage(frame);
    await flush();

    expect(served).not.toHaveBeenCalled();
    expect(received).toEqual([]);
    expect(warn).toHaveBeenCalled();

    void locks
      .forAgent('tab-1')
      .request('tab-1-lock', {}, async () => new Promise(() => undefined));
    await flush();
    tabSide.postMessage({ kind: 'hello', tabLock: 'tab-1-lock' });
    tabSide.postMessage({ kind: 'connect', name: 'alpha', portId: 0 });
    tabSide.postMessage({ kind: 'connect', name: 'alpha', portId: 0 });
    tabSide.postMessage({ kind: 'hello', tabLock: 'tab-1-lock' });
    tabSide.postMessage({ kind: 'ready', runtimeLock: 'not-a-tab-frame' });
    await flush();

    expect(received).toEqual([
      { kind: 'ready', runtimeLock: expect.any(String) as string },
    ]);
    expect(served).toHaveBeenCalledTimes(1);
    expect(() => host.connect({ name: 'alpha' })).toThrow(
      'A SharedWorker host does not open ports: its tabs connect to it',
    );
  });

  it('ignores frames from the worker that break the protocol', async () => {
    const warn = vi.fn();
    const locks = new FakeLockManager();
    const [tabSide, workerSide] = createChannel();
    workerSide.start();
    const tab = createSharedWorkerClientRuntime(
      { connectWorker: () => tabSide },
      { locks: locks.forAgent('tab-1'), logger: { ...dummyLogger, warn } },
    );
    const status = recordStatus(tab);
    const alpha = watchPort(tab.connect({ name: 'alpha' }));
    void locks
      .forAgent('worker-1')
      .request('runtime-lock', {}, async () => new Promise(() => undefined));
    await flush();

    for (const frame of [
      'not a frame',
      { kind: 'message', portId: 'alpha' },
      { kind: 'hello', tabLock: 'tab-1-lock' },
      { kind: 'connect', name: 'alpha', portId: 0 },
      { kind: 'ready' },
    ])
      workerSide.postMessage(frame);
    await flush();
    expect(status.values).toEqual(['starting']);

    workerSide.postMessage({ kind: 'ready', runtimeLock: 'runtime-lock' });
    workerSide.postMessage({ kind: 'ready', runtimeLock: 'another-lock' });
    workerSide.postMessage({ data: 'reply', kind: 'message', portId: 0 });
    await flush();

    expect(status).toEqual({ completed: false, values: ['starting', 'ready'] });
    expect(alpha.messages).toEqual(['reply']);
    expect(warn).toHaveBeenCalled();
  });

  it('logs a lock request the browser refuses, and the tab still ends with SharedWorkerStartupError', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const error = vi.fn();
    const logger = { ...dummyLogger, error };
    const refused: SharedWorkerLocks = {
      request: async () =>
        Promise.reject(new DOMException('No locks here', 'SecurityError')),
    };
    const [tabSide] = createChannel();
    const tab = createSharedWorkerClientRuntime(
      { connectWorker: () => tabSide },
      { locks: refused, logger },
    );
    const status = recordStatus(tab);
    const host = createSharedWorkerHostRuntime({ locks: refused, logger });
    const [rawTabSide, workerSide] = createChannel();
    host.addClient(workerSide);
    rawTabSide.postMessage({ kind: 'hello', tabLock: 'tab-1-lock' });
    await flush();

    expect(error.mock.calls.map(([, message]: unknown[]) => message)).toEqual(
      expect.arrayContaining([
        'Cannot hold the tab lock',
        'Cannot hold the runtime lock',
        'Cannot watch a tab',
      ]),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(status.error).toBeInstanceOf(SharedWorkerStartupError);
  });

  describe('over Messenger and remoteApi', () => {
    const createApiOrigin = () => {
      const counters = new Map<string, BehaviorSubject<number>>();
      const wait = vi.fn(async () => new Promise<void>(() => undefined));
      const origin = createOrigin({
        startWorker: (host, agent) => {
          const counter$ = new BehaviorSubject(0);
          counters.set(agent, counter$);
          exposeTestApi(host, {
            counter$,
            wait,
            whoAmI: async tab => `${tab}, served by ${agent}`,
          });
        },
      });
      return { counters, origin, wait };
    };

    it('serves one API to two tabs: each call answered to its caller, each emission to both', async () => {
      const { counters, origin } = createApiOrigin();
      const api1 = consumeTestApi(origin.openTab('tab-1'));
      const api2 = consumeTestApi(origin.openTab('tab-2'));

      await expect(
        Promise.all([api1.whoAmI('tab-1'), api2.whoAmI('tab-2')]),
      ).resolves.toEqual([
        'tab-1, served by worker-1',
        'tab-2, served by worker-1',
      ]);

      const seven = [api1, api2].map(async api =>
        firstValueFrom(api.counter$.pipe(filter(value => value === 7))),
      );
      counters.get('worker-1')?.next(7);
      await expect(Promise.all(seven)).resolves.toEqual([7, 7]);
      expect(origin.startedWorkers).toBe(1);
    });

    it('rejects a call that is still waiting in every tab with RemoteApiShutdownError when the worker dies', async () => {
      const { origin, wait } = createApiOrigin();
      const outcomes = [
        consumeTestApi(origin.openTab('tab-1')),
        consumeTestApi(origin.openTab('tab-2')),
      ].map(async api =>
        api.wait().then(
          () => 'settled',
          (error: unknown) => error,
        ),
      );
      await vi.waitFor(() => {
        expect(wait).toHaveBeenCalledTimes(2);
      });

      origin.killWorker();

      const [error1, error2] = await Promise.all(outcomes);
      expect(error1).toBeInstanceOf(RemoteApiShutdownError);
      expect(error2).toBeInstanceOf(RemoteApiShutdownError);
    });

    it('fails calls through the stopped runtime and serves them through a new one after a death', async () => {
      const { origin } = createApiOrigin();
      const stopped = consumeTestApi(origin.openTab('tab-1'));
      await expect(stopped.whoAmI('tab-1')).resolves.toBe(
        'tab-1, served by worker-1',
      );

      origin.killWorker();
      await flush();

      await expect(stopped.whoAmI('tab-1')).rejects.toThrow(
        RemoteApiShutdownError,
      );
      const restarted = consumeTestApi(origin.openTab('tab-1'));
      await expect(restarted.whoAmI('tab-1')).resolves.toBe(
        'tab-1, served by worker-2',
      );
    });
  });
});

describe('shared-worker-runtime-import-safety', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('webextension-polyfill');
    vi.resetModules();
    Reflect.deleteProperty(globalThis, 'SharedWorker');
  });

  it('imports the package index where SharedWorker, navigator.locks and window do not exist', async () => {
    const touched: string[] = [];
    const absent = (name: string) => () => {
      touched.push(name);
      throw new ReferenceError(`${name} is not defined`);
    };
    Object.defineProperty(globalThis, 'SharedWorker', {
      configurable: true,
      get: absent('SharedWorker'),
    });
    vi.stubGlobal(
      'navigator',
      Object.defineProperty({}, 'locks', { get: absent('navigator.locks') }),
    );
    expect('window' in globalThis).toBe(false);
    vi.resetModules();

    const messaging = await import('../../src');

    expect(messaging.createSharedWorkerClientRuntime).toBeTypeOf('function');
    expect(messaging.createSharedWorkerHostRuntime).toBeTypeOf('function');
    expect(touched).toEqual([]);
  });

  it('imports the package index without loading webextension-polyfill', async () => {
    vi.doMock('webextension-polyfill', () => {
      throw new Error('webextension-polyfill was loaded at runtime');
    });
    vi.resetModules();

    await expect(import('../../src')).resolves.toHaveProperty(
      'createSharedWorkerClientRuntime',
    );
  });

  it('holds no timer once the handshake is answered, so a reply may take as long as it needs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const origin = createOrigin();
    const tab = origin.openTab('tab-1');
    const status = recordStatus(tab);
    const proving = watchPort(tab.connect({ name: 'proving' }));
    proving.port.postMessage('prove');
    expect(vi.getTimerCount()).toBe(1);
    await flush();

    expect(status.values).toEqual(['starting', 'ready']);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    const [hostProving] = runningWorker(origin).hostPorts;
    hostProving.port.postMessage('proof');
    await flush();

    expect(proving.onDisconnect).not.toHaveBeenCalled();
    expect(proving.messages).toEqual(['proof']);
    expect(status).toEqual({ completed: false, values: ['starting', 'ready'] });
  });
});
