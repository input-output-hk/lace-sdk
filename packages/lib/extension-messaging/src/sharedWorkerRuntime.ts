import { contextLogger } from '@lace-lib/cardano-util';
import { BehaviorSubject } from 'rxjs';
import { CustomError } from 'ts-custom-error';
import { v4 as uuidv4 } from 'uuid';

import type { MessengerPort, MinimalRuntime } from './types';
import type { Shutdown } from '@lace-lib/util';
import type { Observable } from 'rxjs';
import type { Logger } from 'ts-log';

/**
 * The part of a `MessagePort` the runtimes use: a SharedWorker's `port`, or the
 * port of its `connect` event.
 */
export interface SharedWorkerPort {
  close(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
  start(): void;
}

/** The part of the Web Locks API the runtimes use: `navigator.locks` of the calling context. */
export interface SharedWorkerLocks {
  request(
    name: string,
    options: LockOptions,
    callback: (lock: Lock | null) => unknown,
  ): Promise<unknown>;
}

interface SharedWorkerRuntimeDependencies {
  locks: SharedWorkerLocks;
  logger: Logger;
}

interface SharedWorkerHostRuntimeDependencies
  extends SharedWorkerRuntimeDependencies {
  /**
   * Called once when the worker cannot take its runtime lock, or loses it once
   * held, as when another context steals it, with the browser's error. Tabs
   * learn that the worker has gone only through that lock, so from then on the
   * runtime answers no handshake: the worker should tell its tabs and close.
   */
  onRuntimeLockLost?: (error: unknown) => void;
}

interface SharedWorkerClientRuntimeOptions {
  /**
   * Starts the SharedWorker, or attaches to the running one, and returns its port,
   * for example `() => new SharedWorker(url, { name, type: 'module' }).port`.
   * Called once, when the runtime is created; whatever it throws, the creation throws.
   */
  connectWorker: () => SharedWorkerPort;
  /** How long the worker has to answer the handshake, in milliseconds; 30 000 by default. */
  handshakeTimeoutMs?: number;
}

/** `'starting'` until the worker answers the handshake, then `'ready'`. */
type SharedWorkerRuntimeStatus = 'ready' | 'starting';

/**
 * The runtime did not start: the SharedWorker did not answer the handshake in time
 * (its script failed, its startup failed, or it is still loading), or the browser
 * refused or cancelled this tab's lock first, which `cause` then carries.
 */
export class SharedWorkerStartupError extends CustomError {
  constructor(reason: string, options?: ErrorOptions) {
    super(`The SharedWorker runtime did not start: ${reason}`, options);
  }
}

/**
 * The runtime stopped after the handshake: the SharedWorker died, or the browser
 * cancelled one of this tab's locks while the tab lived on, as WebKit does when it
 * suspends a page or keeps it in the back/forward cache; `cause` then carries the
 * browser's error.
 */
class SharedWorkerRuntimeStoppedError extends CustomError {
  constructor(reason: string, options?: ErrorOptions) {
    super(`The SharedWorker runtime stopped: ${reason}`, options);
  }
}

/**
 * A tab's connection to one SharedWorker instance, carrying any number of named
 * Messenger ports. Its end is terminal: every open port then fires `onDisconnect`
 * once, a port connected later fires it at once, and reconnecting takes a new runtime.
 * `shutdown()` detaches this tab; it never stops the worker.
 */
interface SharedWorkerClientRuntime extends MinimalRuntime, Shutdown {
  /**
   * Replays the current status. Errors with {@link SharedWorkerStartupError} when the
   * runtime does not start, and with {@link SharedWorkerRuntimeStoppedError} when it
   * stops after the handshake; completes on `shutdown()`. No call is timed out once
   * the runtime is ready.
   */
  status$: Observable<SharedWorkerRuntimeStatus>;
}

/**
 * The worker side: each tab's named ports reach `onConnect`, as `BackgroundMessenger`
 * expects, and are released when that tab closes or shuts its runtime down.
 * A tab's ports are taken only once its handshake is answered, so none reaches
 * `onConnect` before the worker serves. These ports carry no `sender`, so a
 * `BackgroundMessenger` over them must not check the sender in
 * `isConnectionAuthorized`: such a check would disconnect every tab.
 */
interface SharedWorkerHostRuntime extends MinimalRuntime {
  /** Serves the tab behind the port of a `connect` event. */
  addClient(port: SharedWorkerPort): void;
  /**
   * Answers every tab's handshake, waiting and later ones, while the worker holds
   * its runtime lock. Call it once the worker can serve, after its API is exposed
   * through this runtime: a tab whose handshake is never answered fails with
   * {@link SharedWorkerStartupError}.
   */
  markReady(): void;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 30_000;

const LOCK_PREFIX = 'lace-shared-worker-runtime';

// Chrome's wording, which BackgroundMessenger matches to release a dead port.
const DISCONNECTED_PORT_MESSAGE =
  'Attempting to use a disconnected port object';

const noOp = () => void 0;

/**
 * What crosses a tab's MessagePort. The tab opens with `hello`, naming the lock it
 * holds while it lives; the worker answers `ready`, naming the lock it holds while
 * it lives. The other frames carry the named ports multiplexed on that MessagePort.
 */
type Frame =
  | { data: unknown; kind: 'message'; portId: number }
  | { kind: 'connect'; name: string; portId: number }
  | { kind: 'disconnect'; portId: number }
  | { kind: 'hello'; tabLock: string }
  | { kind: 'ready'; runtimeLock: string };

const isFrame = (data: unknown): data is Frame => {
  if (typeof data !== 'object' || data === null) return false;
  const frame = data as Record<string, unknown>;
  switch (frame.kind) {
    case 'connect':
      return typeof frame.portId === 'number' && typeof frame.name === 'string';
    case 'disconnect':
    case 'message':
      return typeof frame.portId === 'number';
    case 'hello':
      return typeof frame.tabLock === 'string';
    case 'ready':
      return typeof frame.runtimeLock === 'string';
    default:
      return false;
  }
};

// A throwing listener must not keep the next one from learning that its port
// closed: no call is timed out, so a missed onDisconnect would wait forever.
const notifyAll = <Listener>(
  listeners: ReadonlySet<Listener>,
  notify: (listener: Listener) => void,
  logger: Logger,
) => {
  for (const listener of [...listeners]) {
    try {
      notify(listener);
    } catch (error) {
      logger.error('A port listener threw', error);
    }
  }
};

interface MultiplexedPort {
  deliver(data: unknown): void;
  port: MessengerPort;
  /** The other side closed the port: fires `onDisconnect` once, as `chrome.runtime` ports do. */
  remoteDisconnect(): void;
}

const createMultiplexedPort = (
  { name, portId }: { name: string; portId: number },
  {
    logger,
    onLocalDisconnect,
    post,
  }: {
    logger: Logger;
    onLocalDisconnect: () => void;
    post: (frame: Frame) => void;
  },
): MultiplexedPort => {
  const messageListeners = new Set<
    (data: unknown, port: MessengerPort) => void
  >();
  const disconnectListeners = new Set<(port: MessengerPort) => void>();
  let isOpen = true;
  const port: MessengerPort = {
    disconnect: () => {
      if (!isOpen) return;
      isOpen = false;
      post({ kind: 'disconnect', portId });
      onLocalDisconnect();
    },
    name,
    onDisconnect: {
      addListener: listener => disconnectListeners.add(listener),
      removeListener: listener => disconnectListeners.delete(listener),
    },
    onMessage: {
      addListener: listener => messageListeners.add(listener),
      removeListener: listener => messageListeners.delete(listener),
    },
    postMessage: data => {
      if (!isOpen) throw new Error(DISCONNECTED_PORT_MESSAGE);
      post({ data, kind: 'message', portId });
    },
  };
  return {
    deliver: data => {
      if (!isOpen) return;
      notifyAll(
        messageListeners,
        listener => {
          listener(data, port);
        },
        logger,
      );
    },
    port,
    remoteDisconnect: () => {
      if (!isOpen) return;
      isOpen = false;
      notifyAll(
        disconnectListeners,
        listener => {
          listener(port);
        },
        logger,
      );
    },
  };
};

/** Routes a frame addressed to one of `ports`; returns false for any other frame. */
const routeToPort = (ports: Map<number, MultiplexedPort>, frame: Frame) => {
  switch (frame.kind) {
    case 'message': {
      ports.get(frame.portId)?.deliver(frame.data);
      return true;
    }
    case 'disconnect': {
      const port = ports.get(frame.portId);
      ports.delete(frame.portId);
      port?.remoteDisconnect();
      return true;
    }
    case 'connect':
    case 'hello':
    case 'ready':
      return false;
  }
};

const disconnectAll = (ports: Map<number, MultiplexedPort>) => {
  const openPorts = [...ports.values()];
  ports.clear();
  for (const port of openPorts) port.remoteDisconnect();
  return openPorts.length;
};

/**
 * Creates a tab's runtime for Messenger over the SharedWorker that `connectWorker` reaches.
 */
export const createSharedWorkerClientRuntime = (
  {
    connectWorker,
    handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
  }: SharedWorkerClientRuntimeOptions,
  { locks, logger: baseLogger }: SharedWorkerRuntimeDependencies,
): SharedWorkerClientRuntime => {
  const logger = contextLogger(baseLogger, 'SharedWorkerClientRuntime');
  const workerPort = connectWorker();
  const tabLock = `${LOCK_PREFIX}:tab:${uuidv4()}`;
  const status$ = new BehaviorSubject<SharedWorkerRuntimeStatus>('starting');
  const ports = new Map<number, MultiplexedPort>();
  // The worker answers the handshake only once it serves, so a frame sent before
  // then could reach no listener; it waits here, cloned as postMessage would.
  const outbox: Frame[] = [];
  const runtimeLockRequest = new AbortController();
  let isReady = false;
  let isStopped = false;
  let nextPortId = 0;
  let releaseTabLock: () => void = noOp;
  const tabLockReleased = new Promise<void>(resolve => {
    releaseTabLock = resolve;
  });

  const post = (frame: Frame) => {
    if (isStopped) return;
    if (isReady) workerPort.postMessage(frame);
    else outbox.push(structuredClone(frame));
  };

  const stop = (
    reason?: SharedWorkerRuntimeStoppedError | SharedWorkerStartupError,
  ) => {
    if (isStopped) return;
    isStopped = true;
    clearTimeout(handshakeTimeout);
    runtimeLockRequest.abort();
    releaseTabLock();
    workerPort.onmessage = null;
    workerPort.close();
    outbox.length = 0;
    if (reason) status$.error(reason);
    else status$.complete();
    disconnectAll(ports);
  };

  // The worker takes a tab whose lock is gone for closed and releases its ports, so
  // a lock the browser cancels ends this runtime. The abort that `stop()` causes
  // finds the runtime already stopped.
  const onLockCancelled = (message: string) => (error: unknown) => {
    if (isStopped) return;
    logger.error(message, error);
    const reason = 'the browser refused or cancelled a lock of this tab';
    stop(
      isReady
        ? new SharedWorkerRuntimeStoppedError(reason, { cause: error })
        : new SharedWorkerStartupError(reason, { cause: error }),
    );
  };

  const onReady = (runtimeLock: string) => {
    if (isReady || isStopped) return;
    isReady = true;
    clearTimeout(handshakeTimeout);
    // The worker holds this lock for its whole life: the grant means it has gone.
    // Shared, so that a tab that runs no callback, frozen or paused, cannot keep
    // the other tabs from learning it.
    locks
      .request(
        runtimeLock,
        { mode: 'shared', signal: runtimeLockRequest.signal },
        () => {
          stop(new SharedWorkerRuntimeStoppedError('the worker has gone'));
        },
      )
      .catch(onLockCancelled('Cannot watch the SharedWorker'));
    for (const frame of outbox.splice(0)) workerPort.postMessage(frame);
    status$.next('ready');
  };

  // Armed before the port is wired: an injected port may deliver `ready` from
  // `start()`, and `onReady` must then find a timer to clear.
  const handshakeTimeout = setTimeout(() => {
    stop(
      new SharedWorkerStartupError(
        `the worker did not answer the handshake within ${handshakeTimeoutMs} ms`,
      ),
    );
  }, handshakeTimeoutMs);

  workerPort.onmessage = ({ data }: MessageEvent) => {
    if (!isFrame(data)) {
      logger.warn('Ignoring a message that is not a runtime frame');
      return;
    }
    if (data.kind === 'ready') onReady(data.runtimeLock);
    else if (!routeToPort(ports, data))
      logger.warn(`Ignoring a '${data.kind}' frame from the worker`);
  };
  workerPort.start();

  // Hello waits for the grant so that the worker's request for this lock queues
  // behind the tab's hold; granted earlier, it would release a live tab's ports.
  locks
    .request(tabLock, {}, async () => {
      if (!isStopped)
        workerPort.postMessage({ kind: 'hello', tabLock } satisfies Frame);
      return tabLockReleased;
    })
    .catch(onLockCancelled('Cannot hold the tab lock'));

  return {
    connect: ({ name = '' }) => {
      const portId = nextPortId++;
      const port = createMultiplexedPort(
        { name, portId },
        { logger, onLocalDisconnect: () => ports.delete(portId), post },
      );
      if (isStopped) {
        // Fired later, once the caller has attached its listener.
        queueMicrotask(() => {
          port.remoteDisconnect();
        });
      } else {
        ports.set(portId, port);
        post({ kind: 'connect', name, portId });
      }
      return port.port;
    },
    onConnect: { addListener: noOp, removeListener: noOp },
    shutdown: () => {
      stop();
    },
    status$: status$.asObservable(),
  };
};

/**
 * Creates the SharedWorker's runtime for Messenger. Create it when the worker starts,
 * before anything asynchronous, so no `connect` event is missed.
 */
export const createSharedWorkerHostRuntime = ({
  locks,
  logger: baseLogger,
  onRuntimeLockLost,
}: SharedWorkerHostRuntimeDependencies): SharedWorkerHostRuntime => {
  const logger = contextLogger(baseLogger, 'SharedWorkerHostRuntime');
  const runtimeLock = `${LOCK_PREFIX}:runtime:${uuidv4()}`;
  const connectListeners = new Set<(port: MessengerPort) => void>();
  const awaitingReady = new Set<SharedWorkerPort>();
  const answered = new WeakSet<SharedWorkerPort>();
  let isMarkedReady = false;
  let holdsRuntimeLock = false;

  const answerHandshakes = () => {
    if (!isMarkedReady || !holdsRuntimeLock) return;
    for (const tabPort of awaitingReady) {
      tabPort.postMessage({ kind: 'ready', runtimeLock } satisfies Frame);
      answered.add(tabPort);
    }
    awaitingReady.clear();
  };

  // Held exclusively for the worker's whole life: each tab's shared request waits
  // behind it to learn that the worker has gone, so the handshake is answered only
  // while it is held. The request rejects when the browser refuses it, and when
  // another context steals the lock once held.
  locks
    .request(runtimeLock, { mode: 'exclusive' }, async () => {
      holdsRuntimeLock = true;
      answerHandshakes();
      return new Promise<never>(noOp);
    })
    .catch((error: unknown) => {
      holdsRuntimeLock = false;
      logger.error('Cannot hold the runtime lock', error);
      onRuntimeLockLost?.(error);
    });

  const addClient = (tabPort: SharedWorkerPort) => {
    const ports = new Map<number, MultiplexedPort>();
    let hasGreeted = false;

    const release = () => {
      awaitingReady.delete(tabPort);
      tabPort.onmessage = null;
      tabPort.close();
      logger.debug(`A tab left; released ${disconnectAll(ports)} port(s)`);
    };

    const greet = (tabLock: string) => {
      hasGreeted = true;
      // The tab holds this lock while it lives, so the grant means it has gone.
      locks.request(tabLock, {}, release).catch((error: unknown) => {
        logger.error('Cannot watch a tab', error);
      });
      awaitingReady.add(tabPort);
      answerHandshakes();
    };

    const serve = (portId: number, name: string) => {
      if (ports.has(portId)) {
        logger.warn(`Ignoring a second port ${portId} from one tab`);
        return;
      }
      const port = createMultiplexedPort(
        { name, portId },
        {
          logger,
          onLocalDisconnect: () => ports.delete(portId),
          post: frame => {
            tabPort.postMessage(frame);
          },
        },
      );
      ports.set(portId, port);
      notifyAll(
        connectListeners,
        listener => {
          listener(port.port);
        },
        logger,
      );
    };

    tabPort.onmessage = ({ data }: MessageEvent) => {
      if (!isFrame(data)) {
        logger.warn('Ignoring a message that is not a runtime frame');
      } else if (!hasGreeted) {
        if (data.kind === 'hello') greet(data.tabLock);
        else
          logger.warn(`Ignoring a '${data.kind}' frame before the handshake`);
      } else if (data.kind === 'connect') {
        // A tab's runtime holds every frame until `ready`, so an earlier port is not a
        // tab's: it would reach `onConnect` before the worker serves and checks it.
        if (answered.has(tabPort)) serve(data.portId, data.name);
        else logger.warn("Ignoring a 'connect' frame before the handshake");
      } else if (!routeToPort(ports, data)) {
        logger.warn(`Ignoring a '${data.kind}' frame from a tab`);
      }
    };
    tabPort.start();
  };

  return {
    addClient,
    connect: () => {
      throw new Error(
        'A SharedWorker host does not open ports: its tabs connect to it',
      );
    },
    markReady: () => {
      isMarkedReady = true;
      answerHandshakes();
    },
    onConnect: {
      addListener: listener => connectListeners.add(listener),
      removeListener: listener => connectListeners.delete(listener),
    },
  };
};
