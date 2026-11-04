import { AuthSecret } from '@lace-contract/authentication-prompt';
import { ByteArray } from '@lace-lib/util';
import { BehaviorSubject, filter, finalize, shareReplay, tap } from 'rxjs';
import { dummyLogger } from 'ts-log';
import { vi } from 'vitest';

import { createMidnightEngineClient } from '../../src/worker/engine-client';

import { PASSWORD, settings } from './engine-host-fakes';
import { createHost } from './engine-host-setup';

import type {
  MidnightEngineConnection,
  MidnightEngineRuntimeStatus,
} from '../../src/worker/engine-client';
import type {
  MidnightEngineHost,
  MidnightSessionStreams,
  MidnightWorkerCaller,
} from '../../src/worker/protocol';
import type { AccessAuthSecret } from '@lace-contract/authentication-prompt';
import type {
  AccountKeyManager,
  MidnightAccountProps,
  StartMidnightAccountWalletParams,
} from '@lace-contract/midnight-context';
import type { InMemoryWalletAccount } from '@lace-contract/wallet-repo';
import type { Observable } from 'rxjs';

type MidnightEngineClientOptions = Parameters<
  typeof createMidnightEngineClient
>[0];
type MidnightEngineRuntimeEndReason = Extract<
  MidnightEngineRuntimeStatus,
  { state: 'ended' }
>['reason'];

type HostMethod = Exclude<keyof MidnightEngineHost, 'streams'>;

const hostMethods: readonly HostMethod[] = [
  'attach',
  'detach',
  'detachClient',
  'build',
  'estimate',
  'sign',
  'prove',
  'discard',
  'preparePendingActivity',
  'submit',
  'signData',
  'buildConnectorTransaction',
  'checkCircuit',
  'proveCircuit',
  'transactionHistoryEntry',
  'signTransaction',
  'resetAccount',
  'resyncAll',
  'deleteWallet',
];

/** One connection as a SharedWorker runtime behaves: calls pending at the end reject after `status$` ends. */
export type FakeConnection = MidnightEngineConnection & {
  readonly clientId: string;
  readonly status: BehaviorSubject<MidnightEngineRuntimeStatus>;
  readonly calls: { method: HostMethod; request: unknown }[];
  isEnded: () => boolean;
  /** The runtime ends: `status$` reports it, then every pending call rejects as Messenger's shutdown error. */
  end: (reason: MidnightEngineRuntimeEndReason) => void;
};

/**
 * Workers the client reaches through `connect`: each worker is a real engine host over fake engines. A worker's death
 * ends its connections; the next `connect` reaches a fresh worker, as a new SharedWorker would be.
 */
export const createFakeWorkers = () => {
  let worker = createHost();
  const workers = [worker];
  const connections: FakeConnection[] = [];
  const control: {
    /** While false, a new connection stays `starting`, and its calls wait, until the test ends or readies it. */
    startReady: boolean;
    /** While set, a new connection has already ended for this reason when `connect` returns it. */
    endAtConnect?: MidnightEngineRuntimeEndReason;
    /** While set, a new connection ends for this reason in the microtask after `connect` returns it. */
    endAfterConnect?: MidnightEngineRuntimeEndReason;
  } = { startReady: true };

  const connectTo = (
    current: ReturnType<typeof createHost>,
    clientId: string,
  ): FakeConnection => {
    const status = new BehaviorSubject<MidnightEngineRuntimeStatus>(
      control.endAtConnect
        ? { state: 'ended', reason: control.endAtConnect }
        : { state: control.startReady ? 'ready' : 'starting' },
    );
    const rejects = new Set<(error: unknown) => void>();
    const calls: FakeConnection['calls'] = [];
    const isEnded = () => status.value.state === 'ended';
    const guard =
      (method: HostMethod) =>
      async (request: unknown): Promise<unknown> => {
        calls.push({ method, request });
        if (isEnded())
          throw new Error('RemoteApiShutdownError: the port disconnected');
        return new Promise((resolve, reject) => {
          rejects.add(reject);
          const forward = () => {
            if (isEnded()) return;
            (current.host[method] as (input: unknown) => Promise<unknown>)(
              request,
            )
              .then(value => {
                if (!isEnded()) resolve(value);
              }, reject)
              .finally(() => rejects.delete(reject));
          };
          if (status.value.state === 'ready') forward();
          else
            status
              .pipe(filter(({ state }) => state === 'ready'))
              .subscribe(forward);
        });
      };
    const host = Object.fromEntries(
      hostMethods.map(method => [method, guard(method)]),
    ) as unknown as MidnightEngineHost;
    // Messenger's remote API keeps each hot stream's last value (`shareReplay(1)`) and replays it to every later
    // subscriber, also after the engine behind the stream was replaced. Its streams do not end with the runtime;
    // they stop emitting.
    const replayed = new Map<string, Observable<unknown>>();
    host.streams = (caller: MidnightWorkerCaller): MidnightSessionStreams => {
      const streams = current.host.streams(caller);
      return Object.fromEntries(
        Object.entries(streams).map(([key, stream]) => {
          const id = `${caller.accountId}/${key}`;
          let shared = replayed.get(id);
          if (!shared) {
            shared = (stream as Observable<unknown>).pipe(
              filter(() => !isEnded()),
              shareReplay(1),
            );
            replayed.set(id, shared);
          }
          return [key, shared];
        }),
      ) as unknown as MidnightSessionStreams;
    };
    const connection: FakeConnection = {
      clientId,
      host,
      status,
      status$: status.asObservable(),
      calls,
      isEnded,
      end: reason => {
        if (isEnded()) return;
        status.next({ state: 'ended', reason });
        queueMicrotask(() => {
          for (const reject of rejects)
            reject(new Error('RemoteApiShutdownError: the port disconnected'));
          rejects.clear();
        });
      },
    };
    return connection;
  };

  const connect = vi.fn((clientId: string): MidnightEngineConnection => {
    const connection = connectTo(worker, clientId);
    connections.push(connection);
    const { endAfterConnect } = control;
    if (endAfterConnect)
      queueMicrotask(() => {
        connection.end(endAfterConnect);
      });
    return connection;
  });

  return {
    connect,
    connections,
    control,
    get worker() {
      return worker;
    },
    workers,
    /** Readies every connection still starting. */
    ready: () => {
      for (const connection of connections)
        if (connection.status.value.state === 'starting')
          connection.status.next({ state: 'ready' });
    },
    /** The worker dies: its connections end, and the next connection reaches a fresh worker. */
    kill: (reason: MidnightEngineRuntimeEndReason = 'stopped') => {
      for (const connection of connections) connection.end(reason);
      worker = createHost();
      workers.push(worker);
    },
  };
};

/** Lends copies of the password as the SDK's password auth does, recording each loan. */
export const passwordAuth = (password: Uint8Array = PASSWORD) => {
  const lent: Uint8Array[] = [];
  const accessAuthSecret: AccessAuthSecret = callback => {
    const clone = AuthSecret(ByteArray.clone(ByteArray(password)));
    lent.push(clone);
    return callback(clone).pipe(
      tap(() => clone.fill(0)),
      finalize(() => clone.fill(0)),
    );
  };
  return { accessAuthSecret, lent };
};

export const createClient = (
  workers: ReturnType<typeof createFakeWorkers>,
  overrides: Partial<MidnightEngineClientOptions> = {},
) => {
  let clientNumber = 0;
  return createMidnightEngineClient({
    connect: workers.connect,
    accessAuthSecret: passwordAuth().accessAuthSecret,
    storage: 'memory',
    attestedProver: false,
    logger: dummyLogger,
    createClientId: () => {
      clientNumber += 1;
      return `client-${clientNumber}`;
    },
    ...overrides,
  });
};

/** What the watcher passes; the client uses the account and the network settings only. */
export const startParams = (
  account: InMemoryWalletAccount<MidnightAccountProps>,
): StartMidnightAccountWalletParams => ({
  account,
  config: settings().config,
  store: {} as StartMidnightAccountWalletParams['store'],
  keyManager: {} as AccountKeyManager,
});

// setImmediate stays real under the tests' clocks, so that `flush` lets every queued promise step run.
export const flush = async () =>
  new Promise<void>(resolve => {
    setImmediate(resolve);
  });

// Bounded by real time, not by turns: a refused password runs PBKDF2 on Node's threadpool, which a loaded runner can
// finish after any fixed number of turns. The clock is taken before any test fakes one, and the bound stays under
// Vitest's 5 s test timeout, so that a condition that never holds fails here.
const now = performance.now.bind(performance);
const UNTIL_BOUND_MS = 4_000;

export const until = async (condition: () => boolean) => {
  const deadline = now() + UNTIL_BOUND_MS;
  while (!condition() && now() < deadline) await flush();
  if (!condition()) throw new Error('condition never held');
};
