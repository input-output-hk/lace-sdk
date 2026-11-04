import {
  consumeMessengerRemoteApi,
  createNonBackgroundMessenger,
  createSharedWorkerClientRuntime,
  FinalizationRegistryDestructor,
  SharedWorkerStartupError,
} from '@lace-lib/extension-messaging';
import { catchError, concat, defer, EMPTY, map, of, throwError } from 'rxjs';
import { dummyLogger } from 'ts-log';

import {
  engineChannelOf,
  MIDNIGHT_ENGINE_ERROR_TYPES,
  MIDNIGHT_ENGINE_HOST_PROPERTIES,
  MIDNIGHT_WORKER_FAILED,
} from './engine-host-api';

import type {
  SharedWorkerLocks,
  SharedWorkerPort,
} from '@lace-lib/extension-messaging';
import type {
  ConnectMidnightEngine,
  MidnightEngineConnection,
  MidnightEngineHost,
  MidnightEngineRuntimeStatus,
} from '@lace-module/midnight-sync/sdk';
import type { Logger } from 'ts-log';

/**
 * Starts the SDK's engine worker, or attaches to the one the app's other pages run (they share it by its name), and
 * returns its port. Bundlers find the worker entry by this exact expression,
 * `new SharedWorker(new URL(…, import.meta.url), …)`, and read its options statically, so both stay literal.
 */
export const startMidnightEngineWorker = (): SharedWorkerPort =>
  new SharedWorker(new URL('./midnight-worker.js', import.meta.url), {
    type: 'module',
    name: 'lace-midnight-engine',
  }).port;

/**
 * Whether this environment runs module SharedWorkers and has the Web Locks API, through which the runtime learns that
 * a tab closed or the worker died. A SharedWorker constructor reads its options before it loads the script: it reads
 * `type` only where module workers are supported, and the opaque `blob://` URL then makes it throw (or, in Firefox,
 * fail to load) before any worker runs.
 */
export const supportsModuleSharedWorker = (): boolean => {
  if (
    typeof SharedWorker !== 'function' ||
    typeof navigator === 'undefined' ||
    !(navigator as Partial<Navigator>).locks
  )
    return false;
  let isTypeRead = false;
  const probe = {
    get type(): WorkerType {
      isTypeRead = true;
      return 'module';
    },
  };
  try {
    new SharedWorker('blob://', probe);
  } catch {
    // The expected refusal of the URL.
  }
  return isTypeRead;
};

/** What the Messenger adapter uses of the browser; the defaults are the browser's own. */
export type MidnightEngineWorkerDependencies = {
  readonly startWorker?: () => SharedWorkerPort;
  readonly locks?: () => SharedWorkerLocks;
  readonly isSupported?: () => boolean;
  readonly logger?: Logger;
};

// The most of the worker's failure message that the page keeps in the error it reports, which apps log.
const MAX_FAILURE_MESSAGE_LENGTH = 500;

// The message of the worker's notice that it failed; `undefined` for any other data on the port.
const failureMessageOf = (data: unknown): string | undefined => {
  if (typeof data !== 'object' || data === null) return undefined;
  const { type, message } = data as { type?: unknown; message?: unknown };
  return type === MIDNIGHT_WORKER_FAILED && typeof message === 'string'
    ? message.slice(0, MAX_FAILURE_MESSAGE_LENGTH)
    : undefined;
};

// The runtime reads the port, so the worker's notice that it failed, which is not a runtime frame, is taken out before
// the runtime sees it. Any other message, a malformed notice included, reaches the runtime as it came.
const withFailureNotice = (
  port: SharedWorkerPort,
  onFailure: (message: string) => void,
): SharedWorkerPort => {
  let listener: SharedWorkerPort['onmessage'] = null;
  return {
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
      return listener;
    },
    set onmessage(next) {
      listener = next;
      port.onmessage =
        next &&
        ((event: MessageEvent) => {
          const message = failureMessageOf(event.data);
          if (message === undefined) next(event);
          else onFailure(message);
        });
    },
  };
};

// Every call on a connection that never started fails; the engine client then reports the connection's end.
const hostThatRefuses = (cause: unknown): MidnightEngineHost =>
  Object.fromEntries(
    Object.keys(MIDNIGHT_ENGINE_HOST_PROPERTIES).map(name => [
      name,
      async () => {
        throw cause;
      },
    ]),
  ) as unknown as MidnightEngineHost;

const ended = (
  reason: 'not-supported' | 'startup-failed',
  cause?: unknown,
): MidnightEngineConnection => ({
  host: hostThatRefuses(
    cause ?? new Error('The Midnight worker is not running'),
  ),
  status$: of<MidnightEngineRuntimeStatus>({ state: 'ended', reason, cause }),
});

/**
 * Worker mode's `ConnectMidnightEngine` over the SharedWorker runtime and Messenger: each call opens a runtime of its
 * own, with the client's own channel. Where no module SharedWorker can run, the connection reports `not-supported`
 * and starts nothing; a worker that cannot be constructed, or that reports that it failed before it answered the
 * handshake, reports `startup-failed`. A worker that reports that it failed once it served reports `stopped`, as one
 * that dies. For a reported failure, the error the end carries has the worker's message as its `cause`.
 *
 * @param dependencies - Replaces the browser's SharedWorker, locks and feature check.
 */
export const connectMidnightEngineWorker =
  ({
    startWorker = startMidnightEngineWorker,
    locks = () => navigator.locks,
    isSupported = supportsModuleSharedWorker,
    logger = dummyLogger,
  }: MidnightEngineWorkerDependencies = {}): ConnectMidnightEngine =>
  clientId => {
    if (!isSupported()) return ended('not-supported');
    let runtime: ReturnType<typeof createSharedWorkerClientRuntime>;
    let isReady = false;
    let failure: Error | undefined;
    // Shutting the runtime down completes its status before it fails the pending calls, so the connection reports
    // its end first, as the engine client expects.
    const onFailure = (message: string) => {
      failure = isReady
        ? new Error('The Midnight worker failed and closed', { cause: message })
        : new SharedWorkerStartupError(
            'the worker failed and closed before it served',
            { cause: message },
          );
      runtime.shutdown();
    };
    try {
      runtime = createSharedWorkerClientRuntime(
        {
          connectWorker: () => withFailureNotice(startWorker(), onFailure),
        },
        { locks: locks(), logger },
      );
    } catch (error) {
      return ended('startup-failed', error);
    }
    runtime.status$.subscribe({
      next: state => {
        isReady = state === 'ready';
      },
      error: () => undefined,
    });
    const host = consumeMessengerRemoteApi<MidnightEngineHost>(
      {
        properties: MIDNIGHT_ENGINE_HOST_PROPERTIES,
        errorTypes: MIDNIGHT_ENGINE_ERROR_TYPES,
      },
      {
        logger,
        messenger: createNonBackgroundMessenger(
          { baseChannel: engineChannelOf(clientId) },
          { logger, runtime },
        ),
        destructor: new FinalizationRegistryDestructor(logger),
      },
    );
    return {
      host,
      status$: concat(
        runtime.status$.pipe(
          map((state): MidnightEngineRuntimeStatus => ({ state })),
        ),
        defer(() => (failure ? throwError(() => failure) : EMPTY)),
      ).pipe(
        catchError((cause: unknown) =>
          of<MidnightEngineRuntimeStatus>({
            state: 'ended',
            reason:
              cause instanceof SharedWorkerStartupError
                ? 'startup-failed'
                : 'stopped',
            cause,
          }),
        ),
      ),
    };
  };
