import {
  inProcessMidnightWallets$,
  midnightWalletsForRuntime,
} from '@lace-contract/midnight-context';
import { EMPTY, forkJoin, map, of, switchMap, take, throwError } from 'rxjs';

import { teeAttestationProgress$ } from './send-proof-progress';

import type { MidnightSideEffectsDependencies } from '@lace-contract/midnight-context';
import type { ModuleInitProps } from '@lace-contract/module';
import type { AccountId } from '@lace-contract/wallet-repo';

/**
 * The side-effect dependencies that act on the app instance's engine registry alone, for engines of either kind.
 * Every loadout composes these; a loadout that runs engines in this JavaScript context adds the engine start
 * (`createMidnightSideEffectDependencies`).
 */
export const createMidnightRegistryDependencies = (
  runtime: ModuleInitProps['runtime'],
): Omit<MidnightSideEffectsDependencies, 'startMidnightAccountWallet'> => {
  const midnightWallets$ = midnightWalletsForRuntime(runtime);
  return {
    // The transaction executor and the dApp connector read ledger objects; they never load in Worker mode.
    midnightWallets$: inProcessMidnightWallets$(
      midnightWallets$,
      'The Midnight transaction executor',
    ),
    midnightEngines$: midnightWallets$,

    wasmProofActivities$: EMPTY,
    dismissWasmProofActivity: () => undefined,
    teeAttestationProgress$,

    getMidnightWalletByAccountId: (accountId: AccountId) =>
      midnightWallets$.pipe(
        take(1),
        map(wallets => wallets[accountId]),
        switchMap(wallet =>
          wallet
            ? of(wallet)
            : throwError(
                () =>
                  new Error(
                    `Could not load midnight wallet for account ${accountId}`,
                  ),
              ),
        ),
      ),

    stopAllMidnightWallets: () => {
      const walletsArray = Object.values(midnightWallets$.value);
      midnightWallets$.next({});
      if (walletsArray.length === 0) {
        return of(void 0);
      }
      return forkJoin(walletsArray.map(wallet => wallet.stop())).pipe(
        map(() => void 0),
      );
    },

    stopMidnightWallet: (accountId: AccountId) => {
      const wallet = midnightWallets$.value[accountId];
      if (!wallet) {
        return of(void 0);
      }
      const { [accountId]: _, ...remaining } = midnightWallets$.value;
      midnightWallets$.next(remaining);
      return wallet.stop().pipe(map(() => void 0));
    },
  };
};
