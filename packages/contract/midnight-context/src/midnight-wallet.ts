import { BehaviorSubject, map } from 'rxjs';

import type {
  MidnightEngine,
  MidnightRemoteEngine,
  MidnightWallet,
} from './types';
import type { ModuleInitProps } from '@lace-contract/module';
import type { AccountId } from '@lace-contract/wallet-repo';
import type { Observable } from 'rxjs';

export type MidnightWalletsByAccountId = Record<AccountId, MidnightWallet>;

export type MidnightEnginesByAccountId = Record<AccountId, MidnightEngine>;

const registries = new WeakMap<
  ModuleInitProps['runtime'],
  BehaviorSubject<MidnightEnginesByAccountId>
>();

/**
 * The running engines of one app instance, keyed by account, whether they run
 * in this JavaScript context or in a worker. Every module of an instance
 * receives the same `runtime` object, so its modules share one registry and
 * separate instances never share theirs.
 */
export const midnightWalletsForRuntime = (
  runtime: ModuleInitProps['runtime'],
): BehaviorSubject<MidnightEnginesByAccountId> => {
  let wallets = registries.get(runtime);
  if (!wallets) {
    wallets = new BehaviorSubject<MidnightEnginesByAccountId>({});
    registries.set(runtime, wallets);
  }
  return wallets;
};

/** Whether the engine runs in a worker rather than in this JavaScript context. */
export const isRemoteMidnightEngine = (
  engine: MidnightEngine,
): engine is MidnightRemoteEngine =>
  'remote' in engine && engine.remote === true;

/**
 * The engine as the in-process wallet `consumer` needs.
 *
 * @param engine - A running engine.
 * @param consumer - Who needs the in-process wallet, named in the error.
 * @throws `Error` when the engine runs in a worker.
 */
const inProcessMidnightEngine = (
  engine: MidnightEngine,
  consumer: string,
): MidnightWallet => {
  if (isRemoteMidnightEngine(engine))
    throw new Error(
      `${consumer} needs the Midnight engine of account "${engine.accountId}" in this JavaScript context, but it runs in a worker`,
    );
  return engine;
};

const assertInProcessEngines: (
  engines: MidnightEnginesByAccountId,
  consumer: string,
) => asserts engines is MidnightWalletsByAccountId = (engines, consumer) => {
  for (const engine of Object.values(engines))
    inProcessMidnightEngine(engine, consumer);
};

/**
 * The running engines for a consumer that only runs where engines run in this
 * JavaScript context. Emits the same objects; errors once an engine runs in a
 * worker.
 *
 * @param engines$ - The running engines, such as the app instance's registry.
 * @param consumer - Who needs the in-process wallets, named in the error.
 */
export const inProcessMidnightWallets$ = (
  engines$: Observable<MidnightEnginesByAccountId>,
  consumer: string,
): Observable<MidnightWalletsByAccountId> =>
  engines$.pipe(
    map(engines => {
      assertInProcessEngines(engines, consumer);
      return engines;
    }),
  );
