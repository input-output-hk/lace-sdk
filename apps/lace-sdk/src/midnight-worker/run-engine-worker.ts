import {
  createBackgroundMessenger,
  createSharedWorkerHostRuntime,
} from '@lace-lib/extension-messaging';

import { MIDNIGHT_WORKER_FAILED } from './engine-host-api';
import {
  createMidnightClientChannels,
  serveMidnightEngineHost,
} from './serve-engine-host';

import type {
  SharedWorkerLocks,
  SharedWorkerPort,
} from '@lace-lib/extension-messaging';
import type { MidnightEngineHost } from '@lace-module/midnight-sync/sdk';
import type { Logger } from 'ts-log';

/** The parts of a SharedWorker's global scope the engine worker uses. */
export type MidnightEngineWorkerScope = {
  addEventListener: (
    type: 'connect',
    listener: (event: { readonly ports: readonly SharedWorkerPort[] }) => void,
  ) => void;
  /** Ends the worker, as the global `close()` of a SharedWorker does. */
  close: () => void;
  Buffer?: unknown;
};

/** What `runMidnightEngineWorker` runs with: the worker's globals and the engine host it serves once loaded. */
export type RunMidnightEngineWorkerProps = {
  readonly scope: MidnightEngineWorkerScope;
  readonly locks: SharedWorkerLocks;
  /** The `Buffer` the engine expects as a global, which no application code can set inside the worker. */
  readonly buffer: unknown;
  /** Imports the engine and creates the host; called once the worker listens. */
  readonly loadHost: () => Promise<MidnightEngineHost>;
  readonly logger: Logger;
};

// A page gives up its handshake after 30 s, but fetching and compiling the ledger's WebAssembly (about 10 MB) over a
// slow link can take longer, and a page that calls again meanwhile attaches to this worker with a new 30 s handshake,
// so a load that ends within 60 s still serves. A longer load counts as hung: the worker closes, and the next page
// starts a new worker instead of attaching to one that never serves.
const MIDNIGHT_ENGINE_LOAD_BOUND_MS = 60_000;

// The runtime closes a page's port once the page has gone, which ends what the worker keeps of the page.
const forgottenOnClose = (
  port: SharedWorkerPort,
  pages: Set<SharedWorkerPort>,
): SharedWorkerPort => ({
  close: () => {
    pages.delete(port);
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
    port.onmessage = listener;
  },
});

/**
 * Runs the SDK's engine worker. Pages connect as soon as the worker exists, and the engine's WebAssembly takes a
 * moment to load, so the worker takes every connection first, holds the pages' handshakes, and answers them once the
 * host serves. The worker fails when the host fails to load or does not load within 60 s, and when it cannot hold its
 * runtime lock or loses it, through which pages learn that it has gone. It then sends the error's message to each page
 * it holds, whose runtime reports that the worker did not start, or stopped, and closes. The browser never gives a
 * closing SharedWorker to a new page, so the next page that constructs it starts a new worker, which loads the engine
 * again.
 *
 * @returns Settles once the host serves, or once the worker failed and closed.
 */
export const runMidnightEngineWorker = async ({
  scope,
  locks,
  buffer,
  loadHost,
  logger,
}: RunMidnightEngineWorkerProps): Promise<void> => {
  // The pages to tell when the worker fails, until the runtime releases them.
  const pages = new Set<SharedWorkerPort>();
  let hasFailed = false;
  const fail = (reason: string, error: unknown) => {
    if (hasFailed) return;
    hasFailed = true;
    logger.error(reason, error);
    // Only the message: the error itself may not be cloneable, and then `postMessage` would throw before the close.
    const notice = {
      type: MIDNIGHT_WORKER_FAILED,
      message: error instanceof Error ? error.message : String(error),
    };
    for (const page of pages) page.postMessage(notice);
    scope.close();
  };
  const runtime = createSharedWorkerHostRuntime({
    locks,
    logger,
    onRuntimeLockLost: error => {
      fail('The Midnight engine worker cannot hold its runtime lock', error);
    },
  });
  scope.addEventListener('connect', ({ ports: [port] }) => {
    pages.add(port);
    runtime.addClient(forgottenOnClose(port, pages));
  });
  const channels = createMidnightClientChannels();
  const messenger = createBackgroundMessenger({
    logger,
    runtime,
    isConnectionAuthorized: channels.isAdmitted,
  });
  scope.Buffer ??= buffer;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const host = await new Promise<MidnightEngineHost>((resolve, reject) => {
      deadline = setTimeout(() => {
        reject(
          new Error(
            `The Midnight engine did not load within ${MIDNIGHT_ENGINE_LOAD_BOUND_MS} ms`,
          ),
        );
      }, MIDNIGHT_ENGINE_LOAD_BOUND_MS);
      loadHost().then(resolve, reject);
    });
    if (hasFailed) return;
    serveMidnightEngineHost({ host, runtime, messenger, channels, logger });
    runtime.markReady();
  } catch (error) {
    fail('The Midnight engine worker could not load the engine', error);
  } finally {
    clearTimeout(deadline);
  }
};
