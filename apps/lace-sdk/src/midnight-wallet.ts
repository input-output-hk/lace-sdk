import { isInMemoryMidnightAccount } from '@lace-contract/midnight-context';
import { Err, Ok } from '@lace-lib/util';
import {
  concat,
  defer,
  distinctUntilChanged,
  filter,
  firstValueFrom,
  map,
  merge,
  of,
  skipWhile,
  switchMap,
  take,
  throwError,
  timeout,
  timer,
} from 'rxjs';

import {
  MidnightAccountNotFoundError,
  MidnightWalletNotReadyError,
  toMidnightSdkError,
} from './midnight-errors';
import { resolveTimeoutMs } from './midnight-timeouts';

import type { Activity } from '@lace-contract/activities';
import type {
  MidnightAccountId,
  MidnightEngine,
} from '@lace-contract/midnight-context';
import type {
  createModuleLoader,
  StateObservables,
} from '@lace-contract/module';
import type { networkSelectors } from '@lace-contract/network';
import type {
  AccountId,
  AnyAccount,
  walletsSelectors,
} from '@lace-contract/wallet-repo';
import type { Result } from '@lace-lib/util';
import type { Observable } from 'rxjs';

/** Wallet state and instance engine access supplied by `createLaceWallet`. */
export type WalletWithMidnight = {
  /** Present on SDK instances; enables best-effort pending activity tracking. */
  dispatch?: {
    (
      key: 'activities.upsertActivities',
      payload: { accountId: AccountId; activities: Activity[] },
    ): void;
    (
      key: 'activities.removeActivities',
      payload: { accountId: AccountId; activityIds: string[] },
    ): void;
  };
  stateObservables: Pick<
    StateObservables<typeof networkSelectors & typeof walletsSelectors>,
    'network' | 'wallets'
  > & {
    activities?: {
      selectAllMap$: Observable<Record<AccountId, Activity[]>>;
    };
  };
  /** @internal Not for direct SDK consumer use. */
  _loadModules: ReturnType<typeof createModuleLoader>;
};

/** The account a Midnight operation acts on, and how long it waits for the account's wallets. */
export type MidnightAccountProps = {
  /**
   * Midnight account to act on. Required when more than one in-memory
   * Midnight account is present on the active network.
   */
  accountId?: AccountId;
  /**
   * How long, in milliseconds, to wait for the engine to start the account's wallets; 120 s by default. A
   * value that is not a finite positive number up to 2^31 - 1 (the longest delay a timer honours) is refused
   * with a `RangeError`. In Worker mode the worker stops an engine start at 120 s, which a longer value cannot
   * extend: such a start fails with `MidnightWalletNotReadyError` naming 120 s.
   */
  startTimeout?: number;
};

const DEFAULT_START_TIMEOUT_MS = 120_000;

export const resolveMidnightAccountId = async (
  { stateObservables }: WalletWithMidnight,
  requestedAccountId?: AccountId,
): Promise<MidnightAccountId> => {
  const wallets = await firstValueFrom(stateObservables.wallets.selectAll$);
  const activeNetworkIds = await firstValueFrom(
    stateObservables.network.selectAllActiveNetworkIds$,
  );
  const accounts = wallets
    .flatMap((wallet): AnyAccount[] => wallet.accounts)
    .filter(isInMemoryMidnightAccount)
    .filter(account => activeNetworkIds.includes(account.blockchainNetworkId));

  if (requestedAccountId) {
    const found = accounts.find(
      account => account.accountId === requestedAccountId,
    );
    if (!found)
      throw new MidnightAccountNotFoundError(
        `Midnight account "${requestedAccountId}" not found on the active network`,
      );
    return found.accountId as MidnightAccountId;
  }
  if (accounts.length === 0)
    throw new MidnightAccountNotFoundError(
      'No Midnight accounts found on the active network',
    );
  if (accounts.length > 1)
    throw new MidnightAccountNotFoundError(
      `Multiple Midnight accounts found (${accounts.length}) — specify accountId to disambiguate`,
    );
  return accounts[0].accountId as MidnightAccountId;
};

/**
 * The engine of the account, emitted once the engine starts it and again
 * whenever the engine replaces it (a sync reset or a restart). Emits
 * `undefined` while the engine has stopped the account's wallet and not yet
 * replaced it. Resolves the account on subscription and errors with
 * `MidnightAccountNotFoundError`, or with `MidnightWalletNotReadyError` when
 * no wallet arrives within `startTimeout`, at first or after a stop, so a
 * subscriber that was already watching fails the same way a new one would.
 *
 * In Worker mode it also errors, at once, with the failure the engine module
 * recorded for the account: a start the worker refused or stopped at its
 * bound, a worker that could not start, or the end of the worker. Each
 * subscription first lets an engine held back by such a failure start again,
 * once.
 */
export const observeMidnightEngine = (
  wallet: WalletWithMidnight,
  { accountId, startTimeout: requestedStartTimeout }: MidnightAccountProps,
): Observable<MidnightEngine | undefined> =>
  defer(async () => {
    const startTimeout = resolveTimeoutMs(
      'startTimeout',
      requestedStartTimeout,
      DEFAULT_START_TIMEOUT_MS,
    );
    const resolvedAccountId = await resolveMidnightAccountId(wallet, accountId);
    const [access] = await wallet._loadModules('addons.loadMidnightEngine');
    if (!access)
      throw new MidnightWalletNotReadyError(resolvedAccountId, startTimeout);
    return { resolvedAccountId, access, startTimeout };
  }).pipe(
    switchMap(({ resolvedAccountId, access, startTimeout }) => {
      // Before watching for failures, so that this call never sees the one it clears.
      access.requestEngine(resolvedAccountId);
      const failed$ = access.startFailures$.pipe(
        map(failures => failures[resolvedAccountId]),
        filter((failure): failure is Error => !!failure),
        take(1),
        switchMap(failure =>
          throwError(() =>
            toMidnightSdkError(failure, { accountId: resolvedAccountId }),
          ),
        ),
      );
      const notReady = () =>
        throwError(
          () =>
            new MidnightWalletNotReadyError(resolvedAccountId, startTimeout),
        );
      const engine$ = access.engines$.pipe(
        map(wallets => wallets[resolvedAccountId]),
        distinctUntilChanged(),
        skipWhile(candidate => !candidate),
        timeout({ first: startTimeout, with: notReady }),
        switchMap(candidate =>
          candidate
            ? of(candidate)
            : concat(
                of(undefined),
                timer(startTimeout).pipe(switchMap(notReady)),
              ),
        ),
      );
      return merge(failed$, engine$);
    }),
  );

/** The account's engine, once the engine module has started it: on this page, or in the worker. */
export const midnightWalletFor = async (
  wallet: WalletWithMidnight,
  props: MidnightAccountProps,
): Promise<MidnightEngine> =>
  firstValueFrom(
    observeMidnightEngine(wallet, props).pipe(
      filter((candidate): candidate is MidnightEngine => !!candidate),
    ),
  );

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

/**
 * Runs one engine operation for the account and settles it as a `Result`. The engine pipelines' refusals become the
 * SDK's named errors (`toMidnightSdkError`).
 */
export const withMidnightWallet = async <T>(
  wallet: WalletWithMidnight,
  props: MidnightAccountProps,
  operation: (engine: MidnightEngine) => Observable<T>,
): Promise<Result<T, Error>> => {
  let engine: MidnightEngine;
  try {
    engine = await midnightWalletFor(wallet, props);
  } catch (error) {
    return Err(toError(error));
  }
  try {
    return Ok(await firstValueFrom(operation(engine)));
  } catch (error) {
    return Err(toMidnightSdkError(error, { accountId: engine.accountId }));
  }
};
