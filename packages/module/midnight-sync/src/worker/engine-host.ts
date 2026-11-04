import { AuthSecret } from '@lace-contract/authentication-prompt';
import { ByteArray } from '@lace-lib/util';
import { isSameProofServerMode } from '@lace-lib/vendor/midnight-proof-servers';
import {
  BehaviorSubject,
  catchError,
  defaultIfEmpty,
  defer,
  distinctUntilChanged,
  EMPTY,
  filter,
  finalize,
  firstValueFrom,
  from,
  map,
  noop,
  race,
  ReplaySubject,
  shareReplay,
  Subject,
  switchMap,
  take,
  throttleTime,
  throwError,
  throwIfEmpty,
  timeout,
  TimeoutError,
} from 'rxjs';

import { signWithWallet } from '../signing/midnight-in-memory-transaction-signer';
import { createStartMidnightAccountWallet } from '../store/dependencies';
import { createAccountKeyManager } from '../store/side-effects/account-key-manager';
import { buildAccountKeys, decryptKey } from '../store/side-effects/watch';

import { midnightEngineGeneration } from './codec';
import {
  buildConnectorTransaction,
  buildTransaction,
  discardRecipe,
  estimateFee,
  preparePendingActivity,
  proveRecipe,
  signRecipe,
  submitTransaction,
} from './engine-operations';
import { MidnightWorkerError } from './protocol';
import {
  assertWorkerProofServer,
  checkCircuitThroughPort,
  proveCircuitThroughPort,
} from './prover-port';
import { toMidnightStateView } from './state-view';

import type { DerivePendingMidnightActivity } from './engine-operations';
import type {
  MidnightAttachRequest,
  MidnightAttachResult,
  MidnightEngineHost,
  MidnightEngineSettings,
  MidnightEngineValue,
  MidnightProvingProgress,
  MidnightSessionStatus,
  MidnightStorageAuthority,
  MidnightWorkerCaller,
  MidnightWorkerStorageKind,
} from './protocol';
import type { MidnightStateView } from './state-view';
import type { MidnightSyncBatchUpdates } from '../store/dependencies';
import type {
  AccountKeyManager,
  AttestationProgressEvent,
  MidnightAccountProps,
  MidnightWallet,
  SerializedMidnightWallet,
} from '@lace-contract/midnight-context';
import type { CollectionStorage } from '@lace-contract/storage';
import type {
  AccountId,
  InMemoryWalletAccount,
  WalletId,
} from '@lace-contract/wallet-repo';
import type { WithLogger } from '@lace-lib/util';
import type { Observable, Subscription } from 'rxjs';

/** What the SharedWorker entry composes the engine host with. */
type MidnightEngineHostDependencies = {
  /** The checkpoint collection of a storage kind; called at most once per kind. */
  createStore: (
    kind: MidnightWorkerStorageKind,
  ) => CollectionStorage<SerializedMidnightWallet>;
  /** The Pending activity derivation of the dApp connector module, which this module cannot import (ADR 14). */
  derivePendingActivity: DerivePendingMidnightActivity;
  logger: WithLogger['logger'];
};

type RunningEngine = {
  readonly engine: MidnightWallet;
  readonly subscription: Subscription;
  /**
   * Why the engine failed. A failed engine takes no new submission and is replaced on the next attach, or, while a
   * submission of it is unsettled, once the last one settles, as a held reset waits.
   */
  failure?: string;
};

// One per account whose engine runs here. It outlives each engine: a reset or a failure replaces the engine and
// keeps the clients, the password copy and the key manager.
type Session = {
  readonly account: InMemoryWalletAccount<MidnightAccountProps>;
  readonly settings: MidnightEngineSettings;
  readonly batchUpdates: MidnightSyncBatchUpdates | undefined;
  readonly password: ByteArray;
  readonly keyManager: AccountKeyManager;
  readonly clients: Set<string>;
  unsettled: number;
  running?: RunningEngine;
  /** Why the last engine start failed, until an engine starts. */
  startFailure?: string;
  /**
   * Set when a reset or bulk resync found a submission still settling: the reset runs once the last one settles,
   * and new submissions are refused meanwhile, so the wait always ends.
   */
  resetWhenSettled?: boolean;
};

// What clients observe of an account; it outlives sessions, so streams follow the account across them. It goes once
// no session and no subscription uses it, and the next one starts from the account's state as it is then.
type AccountChannel = {
  readonly engine$: BehaviorSubject<MidnightWallet | undefined>;
  readonly clients$: BehaviorSubject<ReadonlySet<string>>;
  readonly status$: BehaviorSubject<MidnightSessionStatus>;
  /** Each event with the client whose operation it belongs to, which `streams` keeps to itself. */
  readonly progress$: Subject<
    MidnightProvingProgress & { readonly clientId: string }
  >;
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const errorOf = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
};

// Lifecycle steps of one account run one at a time, in call order; different accounts do not wait for each other.
const createLanes = () => {
  const tails = new Map<string, Promise<unknown>>();
  return async <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const run = (tails.get(key) ?? Promise.resolve()).then(task);
    const tail = run.catch(() => undefined);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };
};

// A spanning step runs alone: it waits for every step that came to the gate before it, and later steps wait for it.
// Other steps pass at once only while no spanning step is queued and no step waits, keeping their call order in the
// lanes. Waiting here and never inside a lane keeps a spanning step from waiting on a step that waits for it.
const createGate = () => {
  let spanning = 0;
  let waiting = 0;
  let afterSpanning: Promise<void> = Promise.resolve();
  let afterAll: Promise<void> = Promise.resolve();
  const settled = async (step: Promise<unknown>) => step.then(noop, noop);
  return {
    pass: async <T>(task: () => Promise<T>): Promise<T> => {
      let run: Promise<T>;
      if (spanning === 0 && waiting === 0) run = task();
      else {
        waiting += 1;
        run = afterSpanning.then(async () => {
          waiting -= 1;
          return task();
        });
      }
      afterAll = Promise.all([afterAll, settled(run)]).then(noop);
      return run;
    },
    passAlone: async <T>(task: () => Promise<T>): Promise<T> => {
      spanning += 1;
      const run = afterAll.then(task).finally(() => {
        spanning -= 1;
      });
      afterSpanning = settled(run);
      afterAll = afterSpanning;
      return run;
    },
  };
};

// Bounded, unlike call replies (ADR 47: proving may run for minutes), because this is teardown. Carrying on without
// the acknowledgement is safe: stop() halts persistence as it is called, so no write can land after the wipe.
const ENGINE_STOP_BOUND_MS = 30_000;

// Bounded so that a start that never arrives cannot hold its lane and the gate. 120 s, as page mode waits for a start
// (the SDK's `DEFAULT_START_TIMEOUT_MS`), leaves room for restoring a large checkpoint on a slow device.
export const MIDNIGHT_ENGINE_START_BOUND_MS = 120_000;

// During a DUST replay the engine state changes with every block. The page's DUST readers throttle the same way
// (`updateDustBalance`), and the trailing value still delivers the last state.
const STATE_VIEW_THROTTLE_MS = 500;

const sameSettings = (
  running: MidnightEngineSettings,
  requested: MidnightEngineSettings,
): boolean =>
  running.config.indexerAddress === requested.config.indexerAddress &&
  running.config.nodeAddress === requested.config.nodeAddress &&
  isSameProofServerMode(
    running.config.proofServer,
    requested.config.proofServer,
  ) &&
  running.attestedProver === requested.attestedProver &&
  running.storage === requested.storage;

const assertClientId = (clientId: unknown): void => {
  if (typeof clientId !== 'string' || clientId.length === 0)
    throw new TypeError('Expected a Midnight worker client identifier');
};

const notAttached = (accountId: AccountId) =>
  new MidnightWorkerError(
    'not-attached',
    `This client is not attached to the Midnight engine of account "${accountId}"`,
  );

const wrongPassword = (accountId: AccountId) =>
  new MidnightWorkerError(
    'wrong-password',
    `The password does not open the keys of Midnight account "${accountId}"`,
  );

const resetPending = (accountId: AccountId) =>
  new MidnightWorkerError(
    'reset-pending',
    `A reset of Midnight account "${accountId}" waits for its submissions to settle: build and prove the transaction again once the reset has run`,
  );

const noAuthority = () =>
  new MidnightWorkerError(
    'not-attached',
    'This client is attached to none of the Midnight engines the storage operation affects and presented no password for one',
  );

const engineReplaced = (accountId: AccountId) =>
  new MidnightWorkerError(
    'engine-replaced',
    `The Midnight engine of account "${accountId}" was stopped or replaced while the call ran`,
  );

const notRunning = (accountId: AccountId) =>
  new MidnightWorkerError(
    'not-running',
    `No Midnight engine of account "${accountId}" runs to take the call, so no engine saw it`,
  );

const failedEngine = (accountId: AccountId) =>
  new MidnightWorkerError(
    'not-running',
    `The Midnight engine of account "${accountId}" failed and takes no new submission, so nothing was broadcast; it is replaced once its unsettled submissions settle`,
  );

// Each use lends the decryption its own copy of the password, zeroed after use, as the page module does.
const withPassword = <T>(
  password: Uint8Array,
  use: (secret: AuthSecret) => Observable<T>,
): Observable<T> =>
  defer(() => {
    const secret = AuthSecret(ByteArray.clone(ByteArray(password)));
    return use(secret).pipe(finalize(() => secret.fill(0)));
  });

// Decrypting a key of the account data the engine runs with is the check, so a client cannot attach by presenting
// other account data, sealed under its own password, under this account's id.
const opensKeys = async (
  account: InMemoryWalletAccount<MidnightAccountProps>,
  password: Uint8Array,
): Promise<boolean> =>
  firstValueFrom(
    withPassword(password, secret =>
      from(
        decryptKey(
          account.blockchainSpecific.nightExternalKey.encryptedKey,
          secret,
        ),
      ),
    ).pipe(
      map(key => {
        key.fill(0);
        return true;
      }),
      catchError(() => [false]),
    ),
  );

const keyManagerFor = (
  account: InMemoryWalletAccount<MidnightAccountProps>,
  password: ByteArray,
): AccountKeyManager => {
  const { nightExternalKey, dustKey, zswapKey, networkId } =
    account.blockchainSpecific;
  return createAccountKeyManager({
    requestKeys: () =>
      withPassword(password, secret =>
        from(
          Promise.all([
            decryptKey(nightExternalKey.encryptedKey, secret),
            decryptKey(dustKey.encryptedKey, secret),
            decryptKey(zswapKey.encryptedKey, secret),
          ]),
        ),
      ).pipe(map(keys => buildAccountKeys(keys, networkId))),
  });
};

// While an affected engine runs, only its own account data can vouch for a password, so made-up account data cannot
// reach it. While none runs, only checkpoints are at stake, and the presented account is checked as at a first attach.
const assertAuthority = async ({
  clientId,
  affected,
  authority,
  isInScope,
}: {
  clientId: string;
  affected: readonly Session[];
  authority: MidnightStorageAuthority | undefined;
  isInScope: (account: InMemoryWalletAccount<MidnightAccountProps>) => boolean;
}): Promise<void> => {
  if (affected.some(session => session.clients.has(clientId))) return;
  const presented = authority?.account;
  const vouching =
    affected.length > 0
      ? affected.find(
          ({ account }) => account.accountId === presented?.accountId,
        )?.account
      : presented && isInScope(presented)
      ? presented
      : undefined;
  if (!authority || !vouching) throw noAuthority();
  if (!(await opensKeys(vouching, authority.password)))
    throw wrongPassword(vouching.accountId);
};

/**
 * The worker side of Midnight Worker mode: runs at most one engine per account for every client of the
 * SharedWorker, and every operation the page-side SDK dispatches to it. Checkpoint storage and the Pending activity
 * derivation are injected.
 *
 * A client attaches with the account's password, which must open the account's keys, and with the settings the
 * engine runs with; it then shares the running engine. An engine stops once its last client detaches and no
 * submission of it is unsettled.
 *
 * @param dependencies - The storage, derivation and logger the worker entry composes the host with.
 */
export const createMidnightEngineHost = ({
  createStore,
  derivePendingActivity,
  logger,
}: MidnightEngineHostDependencies): MidnightEngineHost => {
  const sessions = new Map<AccountId, Session>();
  const channels = new Map<AccountId, AccountChannel>();
  const stores = new Map<
    MidnightWorkerStorageKind,
    CollectionStorage<SerializedMidnightWallet>
  >();
  // A client whose tab closed never attaches again, even when its attach was still running. Its entry goes once every
  // attach it made has settled: each checks this set before it adds the client to a session.
  const closedClients = new Set<string>();
  // The attaches of each client that have not settled yet.
  const attachesOf = new Map<string, Set<Promise<unknown>>>();
  // Kept apart from the channels and never dropped: a client compares each count with the one it saw last, so a count
  // must not fall when a channel goes. One number per account the worker reset.
  const resetCounts = new Map<AccountId, number>();
  // One view per engine, shared by its clients; see `stateViewOf`.
  const stateViews = new WeakMap<
    MidnightWallet,
    Observable<MidnightEngineValue<MidnightStateView>>
  >();
  // Wallets deleted while an engine of theirs drained a submission, with the store kinds to wipe the draining accounts
  // from once the last such submission settles. Kept in memory only: a worker that ends first leaves those
  // checkpoints. A client attaching to one of their accounts keeps them.
  const deletedWallets = new Map<WalletId, Set<MidnightWorkerStorageKind>>();
  const inLane = createLanes();
  // Bulk resync and wallet deletion span accounts. They wait for the attaches and detaches called before them, so
  // they see every session those make or end, and the attaches and detaches called after them wait until they end.
  const gate = createGate();

  const storeFor = (kind: MidnightWorkerStorageKind) => {
    let store = stores.get(kind);
    if (!store) {
      store = createStore(kind);
      stores.set(kind, store);
    }
    return store;
  };

  const accountIdOf = (session: Session) => session.account.accountId;

  const resetsOf = (accountId: AccountId) => resetCounts.get(accountId) ?? 0;

  const countReset = (accountId: AccountId) => {
    resetCounts.set(accountId, resetsOf(accountId) + 1);
  };

  const statusOf = (accountId: AccountId): MidnightSessionStatus => {
    const session = sessions.get(accountId);
    const running = session?.running;
    const failure = running ? running.failure : session?.startFailure;
    return {
      resets: resetsOf(accountId),
      ...(running && {
        engineGeneration: midnightEngineGeneration(running.engine),
      }),
      ...(failure !== undefined && { failure }),
      ...(session?.resetWhenSettled && { resetPending: true as const }),
      ...(session?.running?.failure !== undefined &&
        session.unsettled > 0 && { replacePending: true as const }),
    };
  };

  const channelOf = (accountId: AccountId): AccountChannel => {
    let channel = channels.get(accountId);
    if (!channel) {
      const session = sessions.get(accountId);
      channel = {
        engine$: new BehaviorSubject(session?.running?.engine),
        clients$: new BehaviorSubject<ReadonlySet<string>>(
          new Set(session?.clients),
        ),
        status$: new BehaviorSubject(statusOf(accountId)),
        progress$: new Subject<
          MidnightProvingProgress & { readonly clientId: string }
        >(),
      };
      channels.set(accountId, channel);
    }
    return channel;
  };

  const releaseChannel = (accountId: AccountId) => {
    const channel = channels.get(accountId);
    if (
      !channel ||
      sessions.has(accountId) ||
      channel.engine$.observed ||
      channel.clients$.observed ||
      channel.status$.observed ||
      channel.progress$.observed
    )
      return;
    channels.delete(accountId);
  };

  // An account without a channel has no subscriber to tell; its next channel starts from the state.
  const publishStatus = (accountId: AccountId) => {
    channels.get(accountId)?.status$.next(statusOf(accountId));
  };

  const publishClients = (session: Session) => {
    channels.get(accountIdOf(session))?.clients$.next(new Set(session.clients));
  };

  const publishEngine = (
    accountId: AccountId,
    engine: MidnightWallet | undefined,
  ) => {
    channels.get(accountId)?.engine$.next(engine);
  };

  const markFailed = (
    accountId: AccountId,
    engine: MidnightWallet,
    error: unknown,
  ) => {
    const running = sessions.get(accountId)?.running;
    if (running?.engine !== engine || running.failure !== undefined) return;
    running.failure = messageOf(error);
    logger.error(`Midnight engine of account ${accountId} failed`, error);
    publishStatus(accountId);
  };

  const startEngine = async (session: Session): Promise<MidnightWallet> => {
    const accountId = accountIdOf(session);
    const started = new ReplaySubject<MidnightWallet>(1);
    let first: MidnightWallet | undefined;
    const subscription = createStartMidnightAccountWallet(
      { logger },
      { batchUpdates: session.batchUpdates },
    )({
      account: session.account,
      config: session.settings.config,
      store: storeFor(session.settings.storage),
      keyManager: session.keyManager,
    }).subscribe({
      next: engine => {
        if (first) return;
        first = engine;
        started.next(engine);
        started.complete();
      },
      error: (error: unknown) => {
        if (first) markFailed(accountId, first, error);
        else started.error(error);
      },
    });
    let engine: MidnightWallet;
    try {
      engine = await firstValueFrom(
        started.pipe(
          timeout({
            first: MIDNIGHT_ENGINE_START_BOUND_MS,
            with: () =>
              throwError(
                () =>
                  new MidnightWorkerError(
                    'start-timeout',
                    `The Midnight engine of ${accountId} did not start within ${MIDNIGHT_ENGINE_START_BOUND_MS} ms`,
                  ),
              ),
          }),
        ),
      );
    } catch (error) {
      subscription.unsubscribe();
      logger.error(`Starting the Midnight engine of ${accountId}`, error);
      // Clients left without an engine, as after a failed restart, learn it and attach again.
      session.startFailure = messageOf(error);
      publishStatus(accountId);
      throw error;
    }
    session.startFailure = undefined;
    session.running = { engine, subscription };
    publishEngine(accountId, engine);
    publishStatus(accountId);
    return engine;
  };

  // `awaitStop` when a wipe follows: stop() halts persistence at once, and its acknowledgement means the facade
  // stopped too, as the page-side reset waits for. Unsubscribing alone tears the engine down without waiting.
  // stop() is called before this first yields.
  const stopEngine = async (session: Session, awaitStop: boolean) => {
    const { running } = session;
    if (!running) return;
    const accountId = accountIdOf(session);
    session.running = undefined;
    publishEngine(accountId, undefined);
    publishStatus(accountId);
    if (awaitStop)
      await firstValueFrom(
        running.engine
          .stop()
          .pipe(
            defaultIfEmpty(undefined),
            timeout({ first: ENGINE_STOP_BOUND_MS }),
          ),
      ).catch((error: unknown) => {
        logger.error(
          error instanceof TimeoutError
            ? `The Midnight engine of ${accountId} did not acknowledge its stop within ${ENGINE_STOP_BOUND_MS} ms; carrying on as stopped`
            : `Stopping the Midnight engine of ${accountId}`,
          error,
        );
      });
    running.subscription.unsubscribe();
  };

  // The password copy and the key manager go before any wait for the stop acknowledgement, which a stuck engine delays.
  const endSession = async (session: Session, awaitStop = false) => {
    const accountId = accountIdOf(session);
    const stopped = stopEngine(session, awaitStop);
    session.keyManager.destroy();
    session.password.fill(0);
    session.clients.clear();
    sessions.delete(accountId);
    publishClients(session);
    publishStatus(accountId);
    releaseChannel(accountId);
    await stopped;
  };

  // A held reset keeps an idle session for its queued afterSettle, which wipes the checkpoint and ends the session.
  const endIfIdle = async (session: Session) => {
    if (
      sessions.get(accountIdOf(session)) === session &&
      session.clients.size === 0 &&
      session.unsettled === 0 &&
      !session.resetWhenSettled
    )
      await endSession(session);
  };

  const addClient = async (session: Session, clientId: string) => {
    if (closedClients.has(clientId)) {
      await endIfIdle(session);
      throw notAttached(accountIdOf(session));
    }
    session.clients.add(clientId);
    publishClients(session);
  };

  const attachResultOf = (session: Session): MidnightAttachResult => {
    const { engine } = session.running!;
    return {
      accountId: engine.accountId,
      walletId: engine.walletId,
      networkId: engine.networkId,
      nightVerifyingKey: engine.nightVerifyingKey,
      engineGeneration: midnightEngineGeneration(engine),
      resets: resetsOf(accountIdOf(session)),
      settings: session.settings,
    };
  };

  // An attach is its client's until it settles, so that the client's entry in closedClients outlives it.
  const trackAttach = async <T>(
    clientId: string,
    attaching: Promise<T>,
  ): Promise<T> => {
    const pending = attachesOf.get(clientId) ?? new Set<Promise<unknown>>();
    pending.add(attaching);
    attachesOf.set(clientId, pending);
    try {
      return await attaching;
    } finally {
      pending.delete(attaching);
      if (pending.size === 0 && attachesOf.get(clientId) === pending)
        attachesOf.delete(clientId);
    }
  };

  // The host owns the request's password buffer and zeroes it once the attach settles, refused or not.
  const attach = async ({
    clientId,
    account,
    password,
    settings,
    adopt,
    batchUpdates,
  }: MidnightAttachRequest): Promise<MidnightAttachResult> => {
    try {
      assertClientId(clientId);
      const { accountId } = account;
      if (closedClients.has(clientId)) throw notAttached(accountId);
      const attaching = gate.pass(async () =>
        inLane(accountId, async () => {
          if (closedClients.has(clientId)) throw notAttached(accountId);
          assertWorkerProofServer(settings);
          const existing = sessions.get(accountId);
          if (existing) {
            if (!(await opensKeys(existing.account, password)))
              throw wrongPassword(accountId);
            if (!adopt && !sameSettings(existing.settings, settings))
              throw new MidnightWorkerError(
                'settings-conflict',
                `The Midnight engine of account "${accountId}" runs with other settings: attach with adopt to use them`,
              );
            // A failed engine is replaced on the next attach, as the page-side watcher restarts one after a failure,
            // but not while a submission of it is unsettled: `afterSettle` replaces it then.
            if (
              existing.running?.failure !== undefined &&
              existing.unsettled === 0
            )
              await stopEngine(existing, false);
            if (!existing.running) await startEngine(existing);
            await addClient(existing, clientId);
            deletedWallets.delete(existing.account.walletId);
            return attachResultOf(existing);
          }
          if (!(await opensKeys(account, password)))
            throw wrongPassword(accountId);
          const owned = ByteArray.clone(ByteArray(password));
          const session: Session = {
            account,
            settings,
            batchUpdates,
            password: owned,
            keyManager: keyManagerFor(account, owned),
            clients: new Set(),
            unsettled: 0,
          };
          sessions.set(accountId, session);
          try {
            await startEngine(session);
          } catch (error) {
            await endSession(session);
            throw error;
          }
          await addClient(session, clientId);
          deletedWallets.delete(account.walletId);
          return attachResultOf(session);
        }),
      );
      return await trackAttach(clientId, attaching);
    } finally {
      password.fill(0);
    }
  };

  const detach = async ({ clientId, accountId }: MidnightWorkerCaller) =>
    gate.pass(async () =>
      inLane(accountId, async () => {
        const session = sessions.get(accountId);
        if (!session?.clients.delete(clientId)) return;
        publishClients(session);
        await endIfIdle(session);
      }),
    );

  const detachClient = async (clientId: string) => {
    closedClients.add(clientId);
    // Each attach the client made before it closed refuses it in its lane, so once they have all settled the entry has
    // no reader left. The closed client's channel takes no new call, and the entry refuses a later attach until then.
    void Promise.allSettled([...(attachesOf.get(clientId) ?? [])]).then(() => {
      closedClients.delete(clientId);
    });
    await Promise.all(
      [...sessions.values()]
        .filter(session => session.clients.has(clientId))
        .map(async session =>
          detach({ clientId, accountId: accountIdOf(session) }),
        ),
    );
  };

  const tagged = <T>(
    accountId: AccountId,
    engine: MidnightWallet,
    source$: Observable<T>,
  ): Observable<MidnightEngineValue<T>> => {
    const engineGeneration = midnightEngineGeneration(engine);
    return source$.pipe(
      map(value => ({ engineGeneration, value })),
      catchError((error: unknown) => {
        markFailed(accountId, engine, error);
        return EMPTY;
      }),
    );
  };

  // Converted once per engine for all its clients, and only for the states the throttle passes. The view ends with the
  // last client that reads it, which lets the engine's state go when the engine is replaced or stops; a client that
  // comes later gets the last view at once.
  const stateViewOf = (accountId: AccountId, engine: MidnightWallet) => {
    let view$ = stateViews.get(engine);
    if (!view$) {
      view$ = tagged(
        accountId,
        engine,
        defer(() => engine.state()).pipe(
          throttleTime(STATE_VIEW_THROTTLE_MS, undefined, {
            leading: true,
            trailing: true,
          }),
          map(toMidnightStateView),
        ),
      ).pipe(shareReplay({ bufferSize: 1, refCount: true }));
      stateViews.set(engine, view$);
    }
    return view$;
  };

  const streams = ({ clientId, accountId }: MidnightWorkerCaller) => {
    // Each stream takes the account's channel as it is subscribed, not as streams() is called, so it never follows a
    // channel that went in between, and it lets the channel go once nothing else uses it.
    const onChannel = <T>(
      select: (channel: AccountChannel) => Observable<T>,
    ): Observable<T> =>
      defer(() => {
        const channel = channelOf(accountId);
        return channel.clients$.pipe(
          map(clients => clients.has(clientId)),
          distinctUntilChanged(),
          switchMap(attached => (attached ? select(channel) : EMPTY)),
        );
      }).pipe(
        finalize(() => {
          releaseChannel(accountId);
        }),
      );
    const ofEngine = <T>(
      select: (engine: MidnightWallet) => Observable<T>,
    ): Observable<T> =>
      onChannel(channel =>
        channel.engine$.pipe(
          switchMap(engine => (engine ? select(engine) : EMPTY)),
        ),
      );
    const fromEngine = <T>(
      select: (engine: MidnightWallet) => Observable<T>,
    ): Observable<MidnightEngineValue<T>> =>
      ofEngine(engine => tagged(accountId, engine, select(engine)));
    return {
      address$: fromEngine(engine => engine.address$),
      areKeysAvailable$: fromEngine(engine => engine.areKeysAvailable$),
      coinsByTokenType$: fromEngine(engine => engine.coinsByTokenType$),
      syncProgress$: fromEngine(engine => engine.syncProgress$),
      transactionHistory$: fromEngine(engine => engine.transactionHistory$),
      stateView$: ofEngine(engine => stateViewOf(accountId, engine)),
      // A client's id proves its calls are its own, so a client gets the progress of its own operations alone, and
      // no event names the client.
      progress$: onChannel(channel =>
        channel.progress$.pipe(
          filter(progress => progress.clientId === clientId),
          map(({ operationId, event }) => ({ operationId, event })),
        ),
      ),
      status$: onChannel(channel => channel.status$),
    };
  };

  // An operation runs on the engine current when it is called; replacing that engine fails it, so a result built by
  // an engine that is gone never reaches the caller.
  const runOn = async <T>(
    { clientId, accountId }: MidnightWorkerCaller,
    operation: (engine: MidnightWallet, session: Session) => Observable<T>,
  ): Promise<T> => {
    const session = sessions.get(accountId);
    if (!session?.clients.has(clientId)) throw notAttached(accountId);
    const engine = session.running?.engine;
    // Between a stop and the next start, as during a reset or a replacement, or after a start that failed.
    if (!engine) throw notRunning(accountId);
    // The replacement arm cannot end the race by completing: engine$ never completes, and the arm errors as soon as
    // a value passes its filter.
    return firstValueFrom(
      race(
        defer(() => operation(engine, session)),
        channelOf(accountId).engine$.pipe(
          filter(current => current !== engine),
          take(1),
          switchMap(() => throwError(() => engineReplaced(accountId))),
        ),
      ).pipe(
        finalize(() => {
          releaseChannel(accountId);
        }),
      ),
    );
  };

  const progressTo = (
    { clientId, accountId }: MidnightWorkerCaller,
    operationId: string | undefined,
  ) =>
    operationId === undefined
      ? undefined
      : (event: AttestationProgressEvent) => {
          channels
            .get(accountId)
            ?.progress$.next({ clientId, operationId, event });
        };

  const wipeAccount = async (
    store: CollectionStorage<SerializedMidnightWallet>,
    accountId: AccountId,
  ) =>
    firstValueFrom(
      store
        .removeWhere(document => document?.accountId === accountId)
        .pipe(
          throwIfEmpty(
            () =>
              new Error(
                'Midnight account storage wipe did not acknowledge completion',
              ),
          ),
        ),
    );

  // Kept only for an unsettled submission, so a deletion leaves it running.
  const isDraining = (session: Session) =>
    session.clients.size === 0 && session.unsettled > 0;

  // A reset or resync never cuts off a submission that is still settling: it waits for it. One that runs
  // after the last submission settled but before its queued afterSettle joins the held reset, so the reset runs once.
  const holdsReset = (session: Session) => {
    if (session.unsettled === 0 && !session.resetWhenSettled) return false;
    session.resetWhenSettled = true;
    publishStatus(accountIdOf(session));
    return true;
  };

  // Stop before the wipe, or an in-flight throttled persist write could revive the cleared state. An engine with
  // clients restarts even after a failed wipe, so that they are not left without one; one without clients ends.
  const resetEngine = async (session: Session) => {
    const accountId = accountIdOf(session);
    const hasClients = session.clients.size > 0;
    await (hasClients ? stopEngine(session, true) : endSession(session, true));
    let wipeError: Error | undefined;
    try {
      await wipeAccount(storeFor(session.settings.storage), accountId);
      countReset(accountId);
    } catch (error) {
      wipeError = errorOf(error);
      logger.error(`Wiping the Midnight checkpoint of ${accountId}`, error);
    }
    if (hasClients) await startEngine(session);
    else publishStatus(accountId);
    if (wipeError) throw wipeError;
  };

  const resetAccount: MidnightEngineHost['resetAccount'] = async ({
    clientId,
    accountId,
    storage,
    authority,
  }) => {
    try {
      await inLane(accountId, async () => {
        const session = sessions.get(accountId);
        await assertAuthority({
          clientId,
          affected: session ? [session] : [],
          authority,
          isInScope: account => account.accountId === accountId,
        });
        if (!session) {
          await wipeAccount(storeFor(storage), accountId);
          return;
        }
        if (holdsReset(session)) return;
        await resetEngine(session);
      });
    } finally {
      authority?.password.fill(0);
    }
  };

  // Clears every kind in use and returns the error of each kind that failed. A failed clear leaves that kind's
  // checkpoints in place, so the engines of its accounts restart from them, as after a failed reset wipe.
  const clearStores = async (storage: MidnightWorkerStorageKind) => {
    const failures = new Map<MidnightWorkerStorageKind, Error>();
    for (const kind of new Set([...stores.keys(), storage])) {
      try {
        await firstValueFrom(
          storeFor(kind).clear().pipe(defaultIfEmpty(undefined)),
        );
      } catch (error) {
        logger.error(`Clearing the Midnight ${kind} checkpoints`, error);
        failures.set(kind, errorOf(error));
      }
    }
    return failures;
  };

  const resyncAll: MidnightEngineHost['resyncAll'] = async ({
    clientId,
    storage,
    authority,
  }) => {
    try {
      await gate.passAlone(async () => {
        const affected = [...sessions.values()];
        await assertAuthority({
          clientId,
          affected,
          authority,
          isInScope: () => true,
        });
        // Each account's lane is held from its stop to its restart, so that no attach restores a checkpoint between
        // the stop and the clear. `undefined` means the clear's outcome is unknown, so no reset counts.
        const cleared = deferred<
          ReadonlyMap<MidnightWorkerStorageKind, Error> | undefined
        >();
        const stopped = affected.map(() => deferred<void>());
        const restarts = affected.map(async (session, index) =>
          inLane(accountIdOf(session), async () => {
            try {
              if (sessions.get(accountIdOf(session)) !== session) return;
              if (holdsReset(session)) return;
              await stopEngine(session, true);
            } finally {
              stopped[index].resolve();
            }
            const failedClears = await cleared.promise;
            if (sessions.get(accountIdOf(session)) !== session) return;
            if (session.clients.size === 0) {
              await endSession(session);
              return;
            }
            // As for a reset, only a wipe that ran counts.
            if (failedClears && !failedClears.has(session.settings.storage))
              countReset(accountIdOf(session));
            await startEngine(session);
          }),
        );
        await Promise.all(stopped.map(async ({ promise }) => promise));
        let failedClears:
          | ReadonlyMap<MidnightWorkerStorageKind, Error>
          | undefined;
        // Resolved whatever happens, or every lane would wait with its engine stopped.
        try {
          failedClears = await clearStores(storage);
        } finally {
          cleared.resolve(failedClears);
        }
        // Every engine restarts before the failure is reported, as a reset reports a failed wipe.
        const failedRestart = (await Promise.allSettled(restarts)).find(
          (result): result is PromiseRejectedResult =>
            result.status === 'rejected',
        );
        if (failedRestart) throw errorOf(failedRestart.reason);
        const [failedClear] = failedClears.values();
        if (failedClear) throw failedClear;
      });
    } finally {
      authority?.password.fill(0);
    }
  };

  const wipeWallet = async (
    walletId: WalletId,
    kinds: ReadonlySet<MidnightWorkerStorageKind>,
    keep: ReadonlySet<AccountId> = new Set(),
  ) => {
    for (const kind of kinds)
      await firstValueFrom(
        storeFor(kind)
          .removeWhere(
            document =>
              document?.walletId === walletId && !keep.has(document.accountId),
          )
          .pipe(defaultIfEmpty(undefined)),
      ).catch((error: unknown) => {
        logger.error(`Wiping the Midnight checkpoints of ${walletId}`, error);
      });
  };

  // Runs once the wallet's last engine draining a submission has ended, unless a client attached to it meanwhile.
  const wipeDeletedWallet = async (walletId: WalletId) => {
    const kinds = deletedWallets.get(walletId);
    if (
      !kinds ||
      [...sessions.values()].some(
        ({ account }) => account.walletId === walletId,
      )
    )
      return;
    deletedWallets.delete(walletId);
    await wipeWallet(walletId, kinds);
  };

  const deleteWallet: MidnightEngineHost['deleteWallet'] = async ({
    clientId,
    walletId,
    storage,
    authority,
  }) => {
    try {
      await gate.passAlone(async () => {
        const affected = [...sessions.values()].filter(
          session => session.account.walletId === walletId,
        );
        await assertAuthority({
          clientId,
          affected,
          authority,
          isInScope: account => account.walletId === walletId,
        });
        // Every store in use, not only the affected engines' ones: an engine of the wallet that already ended may have
        // left its checkpoint in another store. A deletion still waiting for a draining engine keeps the stores it
        // named, so its deferred wipe covers them.
        const kinds = new Set([
          storage,
          ...stores.keys(),
          ...(deletedWallets.get(walletId) ?? []),
        ]);
        // The decision needs every engine of the wallet detached first, and no attach may slip in before it applies.
        const detached = affected.map(() => deferred<void>());
        const shouldWipe = deferred<boolean>();
        const steps = affected.map(async (session, index) =>
          inLane(accountIdOf(session), async () => {
            try {
              if (session.clients.delete(clientId)) publishClients(session);
            } finally {
              detached[index].resolve();
            }
            const isWiping = await shouldWipe.promise;
            if (sessions.get(accountIdOf(session)) !== session) return;
            if (!isWiping) await endIfIdle(session);
            else if (isDraining(session)) deletedWallets.set(walletId, kinds);
            else await endSession(session, true);
          }),
        );
        await Promise.all(detached.map(async ({ promise }) => promise));
        const isLastClient = affected.every(
          session => session.clients.size === 0,
        );
        shouldWipe.resolve(isLastClient);
        await Promise.all(steps);
        if (!isLastClient) return;
        // Engines still draining a submission keep only their own checkpoints until it settles.
        const draining = new Set(
          [...sessions.values()]
            .filter(({ account }) => account.walletId === walletId)
            .map(accountIdOf),
        );
        await wipeWallet(walletId, kinds, draining);
      });
    } finally {
      authority?.password.fill(0);
    }
  };

  // Runs the work held back for submissions once the last one settles: storage work and the replacement of a failed
  // engine. Then it ends the session if it is idle.
  const afterSettle = async (session: Session) => {
    if (sessions.get(accountIdOf(session)) !== session || session.unsettled > 0)
      return;
    const { walletId } = session.account;
    if (session.clients.size === 0 && deletedWallets.has(walletId)) {
      await endSession(session, true);
      // Not awaited: a lane step never waits on the gate.
      void gate.passAlone(async () => wipeDeletedWallet(walletId));
      return;
    }
    if (session.resetWhenSettled) {
      const accountId = accountIdOf(session);
      // No caller waits for a held reset, so its outcome reaches the clients through the status, which drops
      // `resetPending` only with it. An engine runs after a rejected reset only when the wipe failed; marking it
      // failed tells them, and their next attach replaces it.
      await resetEngine(session)
        .catch((error: unknown) => {
          const reason = messageOf(error);
          if (session.running && session.running.failure === undefined)
            session.running.failure = `The reset of Midnight account "${accountId}" did not wipe its checkpoint: ${reason}`;
        })
        .finally(() => {
          session.resetWhenSettled = false;
          publishStatus(accountId);
        });
      return;
    }
    // A failed engine waited for its submissions; with clients left it is replaced now, as their next attach would.
    if (session.running?.failure !== undefined && session.clients.size > 0) {
      await stopEngine(session, false);
      // A start that fails reaches the clients through the status, and they attach again, as after any failed restart.
      await startEngine(session).catch(noop);
      return;
    }
    await endIfIdle(session);
  };

  return {
    attach,
    detach,
    detachClient,
    streams,
    build: async ({ tx, ...caller }) =>
      runOn(caller, engine => buildTransaction(engine, tx)),
    estimate: async ({ tx, ...caller }) =>
      runOn(caller, engine => estimateFee(engine, tx)),
    sign: async ({ recipe, ...caller }) =>
      runOn(caller, engine => signRecipe(engine, recipe)),
    prove: async ({ recipe, operationId, ...caller }) =>
      runOn(caller, engine =>
        proveRecipe(engine, recipe, progressTo(caller, operationId)),
      ),
    discard: async ({ recipe, ...caller }) =>
      runOn(caller, engine => discardRecipe(engine, recipe)),
    preparePendingActivity: async ({ transaction, ...caller }) =>
      runOn(caller, engine =>
        preparePendingActivity(engine, transaction, derivePendingActivity),
      ),
    submit: async ({ transaction, ...caller }) =>
      runOn(caller, (engine, session) =>
        defer(() => {
          if (session.resetWhenSettled)
            return throwError(() => resetPending(caller.accountId));
          // A failed engine is on its way out, and a submission would hold it longer: any value it built is stale to
          // the next engine. Refusing it here, as a held reset does, bounds the wait for the replacement.
          if (session.running?.failure !== undefined)
            return throwError(() => failedEngine(caller.accountId));
          session.unsettled += 1;
          return submitTransaction(engine, transaction).pipe(
            finalize(() => {
              session.unsettled -= 1;
              void inLane(caller.accountId, async () => afterSettle(session));
            }),
          );
        }),
      ),
    signData: async ({ data, ...caller }) =>
      runOn(caller, engine => engine.signData(data).pipe(take(1))),
    buildConnectorTransaction: async ({ transaction, ...caller }) =>
      runOn(caller, engine => buildConnectorTransaction(engine, transaction)),
    checkCircuit: async ({ clientId, accountId, ...circuit }) =>
      runOn({ clientId, accountId }, engine =>
        from(checkCircuitThroughPort(engine.proofCircuitProvider, circuit)),
      ),
    proveCircuit: async ({ clientId, accountId, ...circuit }) =>
      runOn({ clientId, accountId }, engine =>
        from(proveCircuitThroughPort(engine.proofCircuitProvider, circuit)),
      ),
    transactionHistoryEntry: async ({ hash, ...caller }) =>
      runOn(caller, engine =>
        engine
          .getTransactionHistoryEntryByHash(hash)
          .pipe(take(1), defaultIfEmpty(undefined)),
      ),
    signTransaction: async ({ request, operationId, ...caller }) =>
      runOn(caller, engine =>
        signWithWallet(engine, request, {
          accountId: caller.accountId,
          onProgress: progressTo(caller, operationId) ?? (() => undefined),
        }).pipe(take(1)),
      ),
    resetAccount,
    resyncAll,
    deleteWallet,
  };
};
