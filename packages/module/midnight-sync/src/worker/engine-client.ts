import { isRemoteMidnightEngine } from '@lace-contract/midnight-context';
import {
  BehaviorSubject,
  combineLatest,
  concat,
  defer,
  EMPTY,
  filter,
  finalize,
  firstValueFrom,
  from,
  map,
  merge,
  Observable,
  of,
  repeat,
  ReplaySubject,
  startWith,
  Subject,
  Subscription,
  switchMap,
  take,
  takeUntil,
  throwError,
  timeout,
} from 'rxjs';

import type { OpaqueMidnightFinalizedTx, OpaqueMidnightRecipe } from './codec';
import type {
  MidnightAttachResult,
  MidnightCircuitRequest,
  MidnightConnectorRequest,
  MidnightEngineHost,
  MidnightEngineValue,
  MidnightStorageAuthority,
  MidnightWorkerErrorReason,
  MidnightWorkerStorageKind,
  MidnightWorkerTxRequest,
} from './protocol';
import type { MidnightStateView } from './state-view';
import type { MidnightSyncBatchUpdates } from '../store/dependencies';
import type { Activity } from '@lace-contract/activities';
import type { AccessAuthSecret } from '@lace-contract/authentication-prompt';
import type {
  AttestationProgressEvent,
  MidnightAccountProps,
  MidnightEngine,
  MidnightNetworkConfig,
  MidnightRemoteEngine,
  StartMidnightAccountWalletParams,
} from '@lace-contract/midnight-context';
import type { ModuleInitProps } from '@lace-contract/module';
import type {
  AccountId,
  InMemoryWalletAccount,
  WalletId,
} from '@lace-contract/wallet-repo';
import type { WithLogger } from '@lace-lib/util';

/** Why a connection to the engine host ended. */
type MidnightEngineRuntimeEndReason =
  | 'not-supported'
  | 'startup-failed'
  | 'stopped';

/** A connection's lifecycle; `ended` is final. */
export type MidnightEngineRuntimeStatus =
  | {
      readonly state: 'ended';
      readonly reason: MidnightEngineRuntimeEndReason;
      readonly cause?: unknown;
    }
  | { readonly state: 'ready' | 'starting' };

/**
 * One connection to the engine host, such as one SharedWorker runtime. A call still pending when the connection
 * ends rejects, after `status$` has reported the end.
 */
export type MidnightEngineConnection = {
  readonly host: MidnightEngineHost;
  /** Replays the current status to a late subscriber. */
  readonly status$: Observable<MidnightEngineRuntimeStatus>;
};

/**
 * Opens a new connection to the engine host for a client id. The client calls it again only once the previous
 * connection has ended, and with a new id each time. A runtime that cannot run here reports `not-supported` through
 * `status$` instead of throwing.
 */
export type ConnectMidnightEngine = (
  clientId: string,
) => MidnightEngineConnection;

/**
 * Why the engine client refused or ended a call: a host refusal, or the end of the connection. `engine-failed` ends
 * the streams of an engine that the worker reports failed, which the account watcher retries.
 */
type MidnightEngineClientErrorReason =
  | MidnightWorkerErrorReason
  | 'engine-failed'
  | 'not-supported'
  | 'runtime-stopped'
  | 'startup-failed'
  | 'submit-interrupted';

/** A failure the SDK maps to its named Worker-mode errors. */
export class MidnightEngineClientError extends Error {
  public readonly reason: MidnightEngineClientErrorReason;
  public readonly accountId: AccountId;

  public constructor({
    reason,
    accountId,
    message,
    cause,
  }: {
    reason: MidnightEngineClientErrorReason;
    accountId: AccountId;
    message: string;
    cause?: unknown;
  }) {
    super(message, { cause });
    this.name = 'MidnightEngineClientError';
    this.reason = reason;
    this.accountId = accountId;
  }
}

/** Records and removes the Pending activity of a submission, as the SDK's activity tracking does. */
export type MidnightPendingRow = {
  readonly record: (activity: Activity) => void;
  readonly remove: (activity: Activity) => void;
};

/**
 * A worker engine as this module's client serves it: the contract's remote engine plus one operation per SDK
 * helper. Each operation runs in the worker and exchanges plain data and opaque values.
 */
export type MidnightRemoteEngineClient = MidnightRemoteEngine & {
  /**
   * The generation of the engine now serving this page; a reset or a replacement changes it. Absent after a reset
   * whose replacement engine did not start: no engine serves the page then, and the streams pass no value.
   */
  readonly engineGeneration: string | undefined;
  readonly stateView$: Observable<MidnightStateView>;
  /**
   * Emits each time the worker has reset the engine in place, before the streams pass any value of the fresh engine
   * and before `resets$`: a reader of the old state ends here, so that no fresh value reaches it before it clears
   * that state.
   */
  readonly resetting$: Observable<void>;
  /**
   * Emits each time the worker has reset the engine in place. Its streams carry on with the fresh engine's values,
   * so a reader clears what it derived from the old state and then subscribes again.
   */
  readonly resets$: Observable<void>;
  readonly build: (
    tx: MidnightWorkerTxRequest,
  ) => Observable<OpaqueMidnightRecipe>;
  readonly estimate: (
    tx: MidnightWorkerTxRequest,
  ) => Observable<{ dustFee: bigint; availableDust: bigint }>;
  readonly sign: (
    recipe: OpaqueMidnightRecipe,
  ) => Observable<OpaqueMidnightRecipe>;
  readonly prove: (
    recipe: OpaqueMidnightRecipe,
    onProgress?: (event: AttestationProgressEvent) => void,
  ) => Observable<OpaqueMidnightFinalizedTx>;
  readonly discard: (recipe: OpaqueMidnightRecipe) => Observable<void>;
  /**
   * Submits in two steps. With `pendingRow`, the worker first derives the Pending activity, which the row records; a
   * derivation still running after `pendingRowTimeout` milliseconds is given up, and the transaction goes without a
   * row. Then the request is posted, and the observable emits the submission's outcome, as an observable, once it has
   * posted, so that a caller can time the wait for finality from the post. A failure before the post removes the row
   * and is not a submission. When no engine in the worker takes the transaction (none runs, or the one that runs has
   * failed), the row is removed too and the call fails with `stale-value`: nothing was broadcast, and the next engine
   * refuses the value. Once posted, any other failure of the live worker removes the row, while the end of the
   * worker, or of the engine, keeps it and fails the outcome with `submit-interrupted`: the transaction may still
   * reach the chain, and it is never posted again.
   */
  readonly submit: (
    transaction: OpaqueMidnightFinalizedTx,
    options: {
      readonly pendingRow?: MidnightPendingRow;
      readonly pendingRowTimeout: number;
    },
  ) => Observable<Observable<{ txId: string }>>;
  readonly buildConnectorTransaction: (
    transaction: MidnightConnectorRequest,
  ) => Observable<OpaqueMidnightFinalizedTx>;
  readonly checkCircuit: (
    request: MidnightCircuitRequest,
  ) => Observable<(bigint | undefined)[]>;
  readonly proveCircuit: (
    request: MidnightCircuitRequest & {
      readonly overwriteBindingInput?: bigint;
    },
  ) => Observable<Uint8Array>;
};

/**
 * What the page shows of the worker engine's lifecycle; each kind maps to the existing Redux actions. `reset` means
 * the account's checkpoint was reset after this page filled its caches of the account, so the page clears them. It
 * comes before any value of the replacement engine reaches this page's readers, for each reset this page learns of
 * on its connection to the worker: from the account's engine it has attached, from its next attach, or from its own
 * request, as that settles while no engine of the account is attached here. What the page learned lasts one
 * connection: the first engine of an account on a new connection brings no notice. Nor does another tab's wipe of an
 * account that no tab has attached, when the worker counts no reset for it. Around a reset that waits for a settling
 * submission, the notice can come twice: before the reset and after.
 */
type MidnightEngineNotice = {
  readonly accountId: AccountId;
  readonly kind: 'reset-failed' | 'reset-pending' | 'reset';
};

type Account = InMemoryWalletAccount<MidnightAccountProps>;

type MidnightEngineClientOptions = WithLogger & {
  readonly connect: ConnectMidnightEngine;
  /** Lends the module's password; each attach and storage operation sends the host a copy it owns. */
  readonly accessAuthSecret: AccessAuthSecret;
  readonly storage: MidnightWorkerStorageKind;
  /** Attach with the running engine's settings when they differ from this page's. */
  readonly adopt?: boolean;
  /** Whether the module was given an attested prover, which Worker mode refuses. */
  readonly attestedProver: boolean;
  readonly batchUpdates?: MidnightSyncBatchUpdates;
  /**
   * Mints the unguessable id each connection presents to the host; a random UUID by default. When it throws, as the
   * default does outside a secure context, the connection ends `not-supported` before anything connects.
   */
  readonly createClientId?: () => string;
};

/** The page side of Worker mode for one app instance. */
export type MidnightEngineClient = {
  /**
   * Worker mode's `startMidnightAccountWallet`. Emits the account's remote engine once attached, and again after
   * each re-attach. When the worker ends, the engine's streams complete and the next attach waits until a public
   * operation calls {@link MidnightEngineClient.requestEngine}; a refused start waits the same way. Errors only with
   * a transient failure, which the watcher retries.
   */
  readonly startAccountEngine: (
    params: StartMidnightAccountWalletParams,
  ) => Observable<MidnightRemoteEngineClient>;
  /** See `MidnightEngineAccess.startFailures$`. */
  readonly startFailures$: Observable<
    Readonly<Partial<Record<AccountId, Error>>>
  >;
  /** See `MidnightEngineAccess.requestEngine`. */
  readonly requestEngine: (accountId: AccountId) => void;
  readonly notices$: Observable<MidnightEngineNotice>;
  /**
   * Resets the account in the worker. Resolves once the reset is scheduled. Its `reset` notice comes from the
   * account's engine attached here once the reset ran, or, with none attached, as this resolves. A held reset whose
   * wipe then fails reaches only tabs with the account's engine attached as it settles; a tab without one is not told.
   * Once the worker took the reset, it counts as a public call for the account
   * ({@link MidnightEngineClient.requestEngine}), so its engine starts again after the end of a worker.
   */
  readonly resetAccount: (account: Account) => Observable<void>;
  /**
   * Resyncs every account of the worker; `accounts` are this page's, presented as authority. Resolves once the
   * worker's engines restarted; each of `accounts` gets its `reset` notice, and then counts a public call, as for
   * {@link MidnightEngineClient.resetAccount}. Fails when the worker could not clear a storage kind, once its engines
   * restarted.
   */
  readonly resyncAll: (accounts: readonly Account[]) => Observable<void>;
  /** Deletes the wallet in the worker; `accounts` are the wallet's Midnight accounts, presented as authority. */
  readonly deleteWallet: (
    walletId: WalletId,
    accounts: readonly Account[],
  ) => Observable<void>;
};

// Refusals of an attach that a retry cannot change: each waits for a public operation instead of the watcher's retry.
const SURFACED_START_REFUSALS: ReadonlySet<MidnightEngineClientErrorReason> =
  new Set([
    'attested-prover',
    'settings-conflict',
    'start-timeout',
    'wrong-password',
  ]);

const WORKER_ERROR_REASONS: ReadonlySet<string> =
  new Set<MidnightWorkerErrorReason>([
    'attested-prover',
    'engine-replaced',
    'not-attached',
    'not-running',
    'nothing-to-register',
    'prove-timeout',
    'reset-pending',
    'settings-conflict',
    'stale-value',
    'start-timeout',
    'wrong-password',
  ]);

// A refusal crosses the worker boundary as a serialized `MidnightWorkerError`, whose `reason` is an own property.
const workerReasonOf = (
  error: unknown,
): MidnightWorkerErrorReason | undefined => {
  const reason = (error as { reason?: unknown } | null)?.reason;
  return typeof reason === 'string' && WORKER_ERROR_REASONS.has(reason)
    ? (reason as MidnightWorkerErrorReason)
    : undefined;
};

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

// The host of a connection that did not open: every call fails, and the client reports the connection's end instead.
const hostThatRefuses = (cause: unknown): MidnightEngineHost =>
  new Proxy({} as MidnightEngineHost, {
    get: () => async () => {
      throw cause;
    },
  });

type ConnectionEnd = {
  readonly reason: MidnightEngineRuntimeEndReason;
  readonly cause?: unknown;
};

const endedError = (
  { reason, cause }: ConnectionEnd,
  accountId: AccountId,
): MidnightEngineClientError => {
  switch (reason) {
    case 'not-supported':
      return new MidnightEngineClientError({
        reason: 'not-supported',
        accountId,
        message:
          'Midnight Worker mode needs a module SharedWorker, the Web Locks API and a secure context (HTTPS or localhost); this environment lacks one of them',
        cause,
      });
    case 'startup-failed':
      return new MidnightEngineClientError({
        reason: 'startup-failed',
        accountId,
        message: `The Midnight worker did not start, so the engine of account "${accountId}" is not running`,
        cause,
      });
    case 'stopped':
      return new MidnightEngineClientError({
        reason: 'runtime-stopped',
        accountId,
        message: `The Midnight worker stopped; the engine of account "${accountId}" starts again with the next Midnight operation`,
        cause,
      });
  }
};

/**
 * Whether a reset in one worker wiped the checkpoint that this page's caches of an account were filled from. It is
 * kept per connection, so the first engine of an account on a new connection sets the count without a clear.
 */
type AccountCaches = {
  /** The account's `resets` that the engines this page accepted last reported; unset until the next accepted one. */
  readonly resets?: number;
  /** The posts of this page's reset and resync requests whose wipe no clear of the caches has covered yet. */
  readonly requests: readonly number[];
};

type Connection = {
  readonly clientId: string;
  readonly host: MidnightEngineHost;
  readonly attachments: Set<Attachment>;
  /** Per account, settles once an attach cancelled before it answered has answered and been detached. */
  readonly cancelledAttaches: Map<AccountId, Promise<void>>;
  readonly caches: Map<AccountId, AccountCaches>;
  /** Numbers this page's attach and reset requests in the order they are posted. */
  posts: number;
  readonly subscription: Subscription;
  end?: ConnectionEnd;
};

type Attachment = {
  readonly accountId: AccountId;
  /** The engine once attached. */
  engine?: MidnightRemoteEngineClient;
  /** The connection ended: the engine streams complete and the start waits for the next public operation. */
  readonly end: () => void;
};

// Only engines this module's clients made carry the worker operations beyond the contract's remote engine.
const remoteEngineClients = new WeakMap<
  MidnightRemoteEngine,
  MidnightRemoteEngineClient
>();

/**
 * The worker operations of a remote engine that this module's engine client made.
 *
 * @param engine - A remote engine from the app instance's registry.
 * @throws `Error` for a remote engine that another module made.
 */
export const remoteEngineClientOf = (
  engine: MidnightRemoteEngine,
): MidnightRemoteEngineClient => {
  const client = remoteEngineClients.get(engine);
  if (!client)
    throw new Error(
      `The remote Midnight engine of account "${engine.accountId}" was not made by this module's engine client`,
    );
  return client;
};

/**
 * Reads the engine through `subscribe`; for a worker engine, again after each reset the worker ran in place, first
 * emitting `cleared`. The reader of the old state ends before the account's `reset` notice and before any value of
 * the fresh engine passes, so the fresh engine's values land only after the page cleared its caches, and pass the
 * reader's change filters, which a new subscription starts afresh. When a worker engine ends, its reader ends at once
 * and drops any value it still holds, such as a throttle's trailing one, which would otherwise land over the Failed
 * sync operation that a worker's death publishes.
 *
 * @param engine - A running engine.
 * @param cleared - What resets the reader's own view of the old state; the `reset` notice clears the page's caches.
 * @param subscribe - The reader.
 */
export const acrossMidnightEngineResets = <T>(
  engine: MidnightEngine,
  cleared: () => readonly T[],
  subscribe: () => Observable<T>,
): Observable<T> => {
  if (!isRemoteMidnightEngine(engine)) return subscribe();
  const { resetting$, resets$ } = remoteEngineClientOf(engine);
  // Both complete when the engine ends, and error when it failed.
  return concat(
    merge(
      resetting$.pipe(map(() => 'ending' as const)),
      resets$.pipe(map(() => 'restarted' as const)),
    ),
    of('ending' as const),
  ).pipe(
    startWith('started' as const),
    switchMap(phase =>
      phase === 'ending'
        ? EMPTY
        : concat(
            phase === 'restarted' ? from(cleared()) : EMPTY,
            defer(subscribe),
          ),
    ),
  );
};

const clientsByRuntime = new WeakMap<
  ModuleInitProps['runtime'],
  MidnightEngineClient
>();

/** Makes the client the one the engine addon of this app instance reports failures from. */
export const registerMidnightEngineClient = (
  runtime: ModuleInitProps['runtime'],
  client: MidnightEngineClient,
): void => {
  clientsByRuntime.set(runtime, client);
};

/** The app instance's engine client; absent while engines run in this JavaScript context. */
export const midnightEngineClientFor = (
  runtime: ModuleInitProps['runtime'],
): MidnightEngineClient | undefined => clientsByRuntime.get(runtime);

/**
 * Creates the page side of Worker mode. It attaches each account the watcher starts to that account's engine in
 * the worker, reconnecting through a new connection after the previous one ended, but only once a public operation
 * asks for an engine: a worker that cannot start is never restarted in a loop.
 *
 * @param options - The connection, the password, and the settings every attach presents.
 */
export const createMidnightEngineClient = ({
  connect,
  accessAuthSecret,
  storage,
  adopt,
  attestedProver,
  batchUpdates,
  logger,
  createClientId = () => crypto.randomUUID(),
}: MidnightEngineClientOptions): MidnightEngineClient => {
  // Closed by the end of a connection; any public operation opens it.
  const gateOpen$ = new BehaviorSubject(true);
  const failures$ = new BehaviorSubject<
    Readonly<Partial<Record<AccountId, Error>>>
  >({});
  const notices$ = new Subject<MidnightEngineNotice>();
  let current: Connection | undefined;

  const recordFailures = (errors: readonly MidnightEngineClientError[]) => {
    if (errors.length === 0) return;
    failures$.next({
      ...failures$.value,
      ...Object.fromEntries(errors.map(error => [error.accountId, error])),
    });
  };

  // Failures are recorded before the engine streams complete, so that a public subscriber errors with the failure
  // instead of seeing its engine go first.
  const endConnection = (connection: Connection, end: ConnectionEnd) => {
    if (connection.end) return;
    connection.end = end;
    if (current === connection) current = undefined;
    gateOpen$.next(false);
    const ended = [...connection.attachments];
    connection.attachments.clear();
    recordFailures(ended.map(({ accountId }) => endedError(end, accountId)));
    for (const attachment of ended) attachment.end();
    connection.subscription.unsubscribe();
  };

  // Without an id this page has nothing that proves its calls are its own, so it ends `not-supported` as a `connect`
  // that cannot run here does: the failure is recorded before any caller waits, and no worker starts.
  const open = (): MidnightEngineConnection & { readonly clientId: string } => {
    let clientId: string;
    try {
      clientId = createClientId();
    } catch (cause) {
      return {
        clientId: '',
        host: hostThatRefuses(cause),
        status$: of<MidnightEngineRuntimeStatus>({
          state: 'ended',
          reason: 'not-supported',
          cause,
        }),
      };
    }
    return { clientId, ...connect(clientId) };
  };

  const connectionFor = (): Connection => {
    if (current && !current.end) return current;
    const { clientId, host, status$ } = open();
    const connection: Connection = {
      clientId,
      host,
      attachments: new Set(),
      cancelledAttaches: new Map(),
      caches: new Map(),
      posts: 0,
      subscription: new Subscription(),
    };
    current = connection;
    connection.subscription.add(
      status$.subscribe({
        next: status => {
          if (status.state === 'ended') endConnection(connection, status);
        },
        error: (cause: unknown) => {
          endConnection(connection, { reason: 'stopped', cause });
        },
      }),
    );
    return connection;
  };

  const clientErrorOf = (
    connection: Connection,
    accountId: AccountId,
    error: unknown,
  ): unknown => {
    if (connection.end) return endedError(connection.end, accountId);
    const reason = workerReasonOf(error);
    return reason
      ? new MidnightEngineClientError({
          reason,
          accountId,
          message: messageOf(error),
          cause: error,
        })
      : error;
  };

  const cachesOf = (connection: Connection, accountId: AccountId) =>
    connection.caches.get(accountId) ?? { requests: [] };

  const hasEngine = (connection: Connection, accountId: AccountId) =>
    [...connection.attachments].some(
      attachment =>
        attachment.accountId === accountId && attachment.engine !== undefined,
    );

  // An attach is served after the requests this page posted before it, so its engine starts from their wipes, and a
  // higher count reports the resets since the engine accepted last; another tab's uncounted wipe goes unseen.
  // Requests posted after the attach stay open.
  const acceptAttach = (
    connection: Connection,
    accountId: AccountId,
    { resets, post }: { resets: number; post: number },
  ) => {
    const caches = cachesOf(connection, accountId);
    const requests = caches.requests.filter(request => request > post);
    const isStale =
      (caches.resets !== undefined && resets > caches.resets) ||
      requests.length < caches.requests.length;
    connection.caches.set(accountId, {
      resets: Math.max(resets, caches.resets ?? resets),
      requests,
    });
    if (isStale) notices$.next({ accountId, kind: 'reset' });
  };

  // While an engine of the account is attached here, the host counts each wipe of it, so a reported reset covers
  // every open request.
  const acceptReset = (
    connection: Connection,
    accountId: AccountId,
    resets: number,
  ) => {
    const caches = cachesOf(connection, accountId);
    connection.caches.set(accountId, {
      resets: Math.max(resets, caches.resets ?? resets),
      requests: [],
    });
    if (caches.resets !== undefined && resets > caches.resets)
      notices$.next({ accountId, kind: 'reset' });
  };

  // Marks the accounts a reset or resync request may wipe, as it is posted: the host can wipe a checkpoint without
  // counting a reset when no tab has the account attached. A failed or refused request counts as one that wiped
  // nothing, so a reset whose replacement engine failed to start after the wipe clears only through the count.
  const requestWipe = async (
    connection: Connection,
    accounts: readonly Account[],
    send: () => Promise<void>,
  ) => {
    connection.posts += 1;
    const post = connection.posts;
    for (const { accountId } of accounts) {
      const caches = cachesOf(connection, accountId);
      connection.caches.set(accountId, {
        ...caches,
        requests: [...caches.requests, post],
      });
    }
    try {
      await send();
    } catch (error) {
      for (const { accountId } of accounts) {
        const caches = cachesOf(connection, accountId);
        connection.caches.set(accountId, {
          ...caches,
          requests: caches.requests.filter(request => request !== post),
        });
      }
      throw error;
    }
    // Nothing refills the caches of an account with no engine attached here before the next accepted one, which
    // starts from the wipe and sets the count. A held reset runs later, so a clear here, or at an attach served
    // before it ran, is followed by the one its count brings.
    for (const { accountId } of accounts) {
      const { requests } = cachesOf(connection, accountId);
      if (!requests.includes(post) || hasEngine(connection, accountId))
        continue;
      connection.caches.set(accountId, {
        requests: requests.filter(request => request > post),
      });
      notices$.next({ accountId, kind: 'reset' });
    }
  };

  // This page zeroes the copy it sends once the call settles, and the host the typed array it receives; a transport
  // that serializes the request, as Messenger does, leaves the serialized form to garbage collection.
  const withPassword = async <T>(
    use: (password: Uint8Array) => Promise<T>,
  ): Promise<T> =>
    firstValueFrom(
      accessAuthSecret(secret =>
        defer(async () => {
          const copy = secret.slice();
          try {
            return await use(copy);
          } finally {
            copy.fill(0);
          }
        }),
      ),
    );

  const createRemoteEngine = (
    connection: Connection,
    result: MidnightAttachResult,
    attachment: Attachment,
  ): { engine: MidnightRemoteEngineClient; terminate: () => void } => {
    const { host, clientId } = connection;
    const { accountId } = result;
    const caller = { clientId, accountId };
    const streams = host.streams(caller);
    const terminated$ = new ReplaySubject<Error | undefined>(1);
    let isTerminated = false;
    let isDetached = false;
    const generation$ = new BehaviorSubject<string | undefined>(
      result.engineGeneration,
    );
    let resets = result.resets;
    let isResetPending = false;
    const resetting$ = new Subject<void>();
    const resetsRun$ = new Subject<void>();

    // The host's streams outlive the connection, so the engine's streams end with this engine instead: they
    // complete when it stops or its worker ends, and error when the worker reports it failed, which the watcher
    // retries by attaching again.
    const statusSubscription = new Subscription();
    const terminate = (error?: Error) => {
      if (isTerminated) return;
      isTerminated = true;
      statusSubscription.unsubscribe();
      terminated$.next(error);
      terminated$.complete();
      resetting$.complete();
      resetsRun$.complete();
    };
    const ending$ = terminated$.pipe(
      switchMap(error => (error ? throwError(() => error) : of(undefined))),
    );
    const follow = <T>(source$: Observable<T>): Observable<T> =>
      source$.pipe(takeUntil(ending$));
    // A replaying transport can deliver a value of the engine a reset replaced after the reset, which would restore
    // what the reset cleared: only values of the current engine pass. One that arrives before the status naming its
    // engine passes when that status does.
    const ofCurrentEngine = <T>(
      source$: Observable<MidnightEngineValue<T>>,
    ): Observable<T> =>
      follow(
        combineLatest([source$, generation$]).pipe(
          filter(
            ([{ engineGeneration }, current]) => engineGeneration === current,
          ),
          map(([{ value }]) => value),
        ),
      );

    const run = <T>(invoke: () => Promise<T>): Observable<T> =>
      defer(async () => {
        if (connection.end) throw endedError(connection.end, accountId);
        try {
          return await invoke();
        } catch (error) {
          throw clientErrorOf(connection, accountId, error);
        }
      });

    const withProgress = <T>(
      onProgress: ((event: AttestationProgressEvent) => void) | undefined,
      invoke: (operationId?: string) => Observable<T>,
    ): Observable<T> =>
      onProgress
        ? defer(() => {
            // Random, and unrelated to the client id, which proves this page's calls on the worker's channels.
            const operationId = crypto.randomUUID();
            const progress = streams.progress$
              .pipe(filter(update => update.operationId === operationId))
              .subscribe(({ event }) => {
                onProgress(event);
              });
            return invoke(operationId).pipe(
              finalize(() => {
                progress.unsubscribe();
              }),
            );
          })
        : invoke();

    const detach = async () => {
      terminate();
      connection.attachments.delete(attachment);
      if (isDetached || connection.end) return;
      isDetached = true;
      await host.detach(caller);
    };

    // The next engine of the account has a new generation, so a transaction that no engine took is stale there.
    const notBroadcast = (
      transaction: OpaqueMidnightFinalizedTx,
      error: unknown,
    ): unknown =>
      workerReasonOf(error) === 'not-running'
        ? new MidnightEngineClientError({
            reason: 'stale-value',
            accountId,
            message: `No running Midnight engine of account "${accountId}" took transaction ${transaction.activityHash}, so nothing was broadcast: build the transaction again`,
            cause: error,
          })
        : error;

    const submit = async (
      transaction: OpaqueMidnightFinalizedTx,
      pendingRow: MidnightPendingRow | undefined,
      pendingRowTimeout: number,
    ): Promise<Observable<{ txId: string }>> => {
      const activity = pendingRow
        ? await firstValueFrom(
            run(async () =>
              host.preparePendingActivity({ ...caller, transaction }),
            ).pipe(
              timeout({ first: pendingRowTimeout, with: () => of(undefined) }),
            ),
          ).catch((error: unknown) => {
            throw notBroadcast(transaction, error);
          })
        : undefined;
      if (activity) pendingRow?.record(activity);
      if (connection.end) {
        if (activity) pendingRow?.remove(activity);
        throw endedError(connection.end, accountId);
      }
      // Replayed, so that the outcome reaches a caller that subscribes after it settled, and a failure that nobody
      // waits for any more still removes the row.
      const outcome$ = new ReplaySubject<{ txId: string }>(1);
      void host.submit({ ...caller, transaction }).then(
        result => {
          outcome$.next(result);
          outcome$.complete();
        },
        (error: unknown) => {
          // The transport does not say whether it sent the request (Messenger posts after a short delay), so a death
          // once the call is made counts as interrupted: the outcome is unknown and the row stays, never resubmitted.
          if (connection.end || workerReasonOf(error) === 'engine-replaced') {
            outcome$.error(
              new MidnightEngineClientError({
                reason: 'submit-interrupted',
                accountId,
                message: `The Midnight worker ended before it reported the outcome of transaction ${transaction.activityHash}. It may still reach the chain: look for it in the account's activities before submitting it again`,
                cause: error,
              }),
            );
            return;
          }
          if (activity) pendingRow?.remove(activity);
          outcome$.error(
            notBroadcast(
              transaction,
              clientErrorOf(connection, accountId, error),
            ),
          );
        },
      );
      return outcome$.asObservable();
    };

    const engine: MidnightRemoteEngineClient = {
      remote: true,
      accountId,
      walletId: result.walletId,
      networkId: result.networkId,
      nightVerifyingKey: result.nightVerifyingKey,
      get engineGeneration() {
        return generation$.value;
      },
      address$: ofCurrentEngine(streams.address$),
      areKeysAvailable$: ofCurrentEngine(streams.areKeysAvailable$),
      coinsByTokenType$: ofCurrentEngine(streams.coinsByTokenType$),
      syncProgress$: ofCurrentEngine(streams.syncProgress$),
      transactionHistory$: ofCurrentEngine(streams.transactionHistory$),
      stateView$: ofCurrentEngine(streams.stateView$),
      resetting$: follow(resetting$),
      resets$: follow(resetsRun$),
      stop: () => defer(detach),
      getTransactionHistoryEntryByHash: hash =>
        run(async () => host.transactionHistoryEntry({ ...caller, hash })),
      signData: data => run(async () => host.signData({ ...caller, data })),
      signTransaction: (request, onProgress) =>
        withProgress(onProgress, operationId =>
          run(async () =>
            host.signTransaction({ ...caller, request, operationId }),
          ),
        ),
      build: tx => run(async () => host.build({ ...caller, tx })),
      estimate: tx => run(async () => host.estimate({ ...caller, tx })),
      sign: recipe => run(async () => host.sign({ ...caller, recipe })),
      prove: (recipe, onProgress) =>
        withProgress(onProgress, operationId =>
          run(async () => host.prove({ ...caller, recipe, operationId })),
        ),
      discard: recipe => run(async () => host.discard({ ...caller, recipe })),
      submit: (transaction, { pendingRow, pendingRowTimeout }) =>
        defer(async () => submit(transaction, pendingRow, pendingRowTimeout)),
      buildConnectorTransaction: transaction =>
        run(async () =>
          host.buildConnectorTransaction({ ...caller, transaction }),
        ),
      checkCircuit: request =>
        run(async () => host.checkCircuit({ ...request, ...caller })),
      proveCircuit: request =>
        run(async () => host.proveCircuit({ ...request, ...caller })),
    };

    // `resets` rising means a reset ran; `resetPending` going without it, but with `failure`, means its wipe failed.
    statusSubscription.add(
      streams.status$.subscribe(status => {
        const didResetRun = status.resets > resets;
        // The readers a reset restarts end before the caches are cleared and the generation moves on, and restart
        // after it, so that they get no value of the replaced engine, and none of the fresh one before the clear.
        if (didResetRun) {
          resets = status.resets;
          resetting$.next();
          acceptReset(connection, accountId, status.resets);
        }
        // A reset retires the replaced engine's generation even when no replacement started, as after a failed start.
        const generation = didResetRun
          ? status.engineGeneration
          : status.engineGeneration ?? generation$.value;
        if (generation !== generation$.value) generation$.next(generation);
        const isNowResetPending = status.resetPending === true;
        const didResetSettle = isResetPending && !isNowResetPending;
        if (isNowResetPending && !isResetPending)
          notices$.next({ accountId, kind: 'reset-pending' });
        isResetPending = isNowResetPending;
        if (didResetRun) resetsRun$.next();
        else if (didResetSettle && status.failure !== undefined) {
          // The held reset wiped nothing, so no later attach clears for the requests it served.
          connection.caches.set(accountId, {
            ...cachesOf(connection, accountId),
            requests: [],
          });
          notices$.next({ accountId, kind: 'reset-failed' });
        }
        // A failed engine that waits for its submissions keeps serving until the worker replaces it in place, so the
        // page waits for the new generation instead of attaching again.
        if (status.failure !== undefined && !status.replacePending)
          terminate(
            new MidnightEngineClientError({
              reason: 'engine-failed',
              accountId,
              message:
                status.failure === ''
                  ? `The Midnight engine of account "${accountId}" failed without an error message`
                  : status.failure,
            }),
          );
      }),
    );
    remoteEngineClients.set(engine, engine);
    return {
      engine,
      terminate: () => {
        terminate();
      },
    };
  };

  const attach$ = (
    account: Account,
    config: MidnightNetworkConfig,
  ): Observable<MidnightRemoteEngineClient> =>
    new Observable<MidnightRemoteEngineClient>(subscriber => {
      const { accountId } = account;
      let isClosed = false;
      let endEngine = () => undefined as void;
      const attachment: Attachment = {
        accountId,
        end: () => {
          endEngine();
          subscriber.complete();
        },
      };
      const connection = connectionFor();
      connection.attachments.add(attachment);
      if (connection.end) {
        connection.attachments.delete(attachment);
        recordFailures([endedError(connection.end, accountId)]);
        subscriber.complete();
        return;
      }
      const { host, clientId } = connection;
      // The host keeps one membership per client and account, which a detach ends. So an attach waits until a
      // cancelled attach of the account has answered and been detached, or that late detach would end this one's.
      const previous = connection.cancelledAttaches.get(accountId);
      let post = 0;
      const sendAttach = async () =>
        withPassword(async password => {
          connection.posts += 1;
          post = connection.posts;
          return host.attach({
            clientId,
            account,
            password,
            settings: { config, attestedProver, storage },
            adopt,
            batchUpdates,
          });
        });
      const attached: Promise<MidnightAttachResult | undefined> = previous
        ? previous.then(async () =>
            isClosed || connection.end ? undefined : sendAttach(),
          )
        : sendAttach();
      let isSettled = false;
      const settled = attached.then(
        async result => {
          isSettled = true;
          if (!result || connection.end) return;
          if (isClosed) {
            await host
              .detach({ clientId, accountId })
              .catch((error: unknown) => {
                logger.error('Detaching a cancelled Midnight attach', error);
              });
            return;
          }
          acceptAttach(connection, accountId, {
            resets: result.resets,
            post,
          });
          const { engine, terminate } = createRemoteEngine(
            connection,
            result,
            attachment,
          );
          attachment.engine = engine;
          endEngine = terminate;
          subscriber.next(engine);
        },
        (error: unknown) => {
          isSettled = true;
          if (connection.end || isClosed) return;
          connection.attachments.delete(attachment);
          const failure = clientErrorOf(connection, accountId, error);
          if (
            failure instanceof MidnightEngineClientError &&
            SURFACED_START_REFUSALS.has(failure.reason)
          ) {
            logger.error(
              `The Midnight engine of ${accountId} did not start`,
              error,
            );
            recordFailures([failure]);
            subscriber.complete();
            return;
          }
          subscriber.error(failure);
        },
      );
      return () => {
        isClosed = true;
        if (attachment.engine) {
          void firstValueFrom(attachment.engine.stop(), {
            defaultValue: undefined,
          }).catch((error: unknown) => {
            logger.error('Detaching a Midnight engine', error);
          });
          return;
        }
        // A cancelled attach no longer belongs to this page: the end of the connection must not record it.
        connection.attachments.delete(attachment);
        if (isSettled) return;
        const detached: Promise<void> = settled
          .catch(() => undefined)
          .then(() => {
            if (connection.cancelledAttaches.get(accountId) === detached)
              connection.cancelledAttaches.delete(accountId);
          });
        connection.cancelledAttaches.set(accountId, detached);
      };
    });

  const startAccountEngine = ({
    account,
    config,
  }: StartMidnightAccountWalletParams): Observable<MidnightRemoteEngineClient> =>
    combineLatest([gateOpen$, failures$]).pipe(
      filter(([isOpen, failures]) => isOpen && !failures[account.accountId]),
      take(1),
      switchMap(() => attach$(account, config)),
      repeat(),
    );

  const requestEngine = (accountId: AccountId) => {
    if (failures$.value[accountId]) {
      const { [accountId]: _, ...others } = failures$.value;
      failures$.next(others);
    }
    if (!gateOpen$.value) gateOpen$.next(true);
  };

  // After the end of a connection, a reset or resync through the next one would otherwise leave its accounts Pending
  // with no engine, as the gate stays closed. Their engines are requested once the wipe ran, so none restores the
  // wiped checkpoint. A deletion requests none: its accounts are gone.
  const requestEnginesAfterWipe = (accounts: readonly Account[]) => {
    for (const { accountId } of accounts) requestEngine(accountId);
  };

  // The host skips the authority check for a client attached to an affected engine; otherwise it needs one of the
  // running accounts, which this page cannot know, so each of its accounts is presented in turn.
  const withAuthority = async (
    connection: Connection,
    accounts: readonly Account[],
    invoke: (authority?: MidnightStorageAuthority) => Promise<void>,
  ): Promise<void> => {
    const [first] = accounts;
    if (!first) {
      await invoke();
      return;
    }
    let refusal: unknown;
    for (const account of accounts)
      try {
        await withPassword(async password => invoke({ account, password }));
        return;
      } catch (error) {
        if (connection.end || workerReasonOf(error) !== 'not-attached')
          throw clientErrorOf(connection, account.accountId, error);
        refusal = error;
      }
    throw clientErrorOf(connection, first.accountId, refusal);
  };

  return {
    startAccountEngine,
    startFailures$: failures$.asObservable(),
    requestEngine,
    notices$: notices$.asObservable(),
    resetAccount: account =>
      defer(async () => {
        const connection = connectionFor();
        try {
          await withPassword(async password =>
            requestWipe(connection, [account], async () =>
              connection.host.resetAccount({
                clientId: connection.clientId,
                accountId: account.accountId,
                storage,
                authority: { account, password },
              }),
            ),
          );
        } catch (error) {
          throw clientErrorOf(connection, account.accountId, error);
        }
        requestEnginesAfterWipe([account]);
      }),
    resyncAll: accounts =>
      defer(async () => {
        const connection = connectionFor();
        await withAuthority(connection, accounts, async authority =>
          requestWipe(connection, accounts, async () =>
            connection.host.resyncAll({
              clientId: connection.clientId,
              storage,
              authority,
            }),
          ),
        );
        requestEnginesAfterWipe(accounts);
      }),
    deleteWallet: (walletId, accounts) =>
      defer(async () => {
        const connection = connectionFor();
        await withAuthority(connection, accounts, async authority =>
          connection.host.deleteWallet({
            clientId: connection.clientId,
            walletId,
            storage,
            authority,
          }),
        );
      }),
  };
};
