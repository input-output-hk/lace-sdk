import {
  isRemoteMidnightEngine,
  NIGHT_TOKEN_ID,
} from '@lace-contract/midnight-context';
import {
  acrossMidnightEngineResets,
  dustBalancesOf,
  midnightStateOf$,
  MidnightEngineClientError,
  strictCompletionOf,
} from '@lace-module/midnight-sync/sdk';
import {
  catchError,
  combineLatest,
  distinctUntilChanged,
  filter,
  map,
  of,
  scan,
  switchMap,
  throwError,
} from 'rxjs';

import { observeMidnightEngine } from './midnight-wallet';

import type {
  MidnightAccountProps,
  WalletWithMidnight,
} from './midnight-wallet';
import type {
  MidnightAccountId,
  MidnightEngine,
  MidnightWalletAddress,
} from '@lace-contract/midnight-context';
import type { Observable } from 'rxjs';

/** The balances and sync state of one Midnight account, as `observeMidnightBalances` emits them. */
export type MidnightBalances = {
  accountId: MidnightAccountId;
  address: MidnightWalletAddress;
  /** Unshielded NIGHT, in its smallest unit. */
  night: { available: bigint; pending: bigint };
  /** Generated DUST; `available` excludes the coin a pending transaction pays with. */
  dust: { balance: bigint; available: bigint };
  /** Whether each sub-wallet has strictly caught up with the chain. */
  synced: { unshielded: boolean; shielded: boolean; dust: boolean };
};

const sumNight = (
  coins: readonly { utxo: { type: string; value: bigint } }[],
) =>
  coins
    .filter(({ utxo }) => utxo.type === NIGHT_TOKEN_ID)
    .reduce((sum, { utxo }) => sum + utxo.value, 0n);

const sameBalances = (a: MidnightBalances, b: MidnightBalances) =>
  a.address.unshielded === b.address.unshielded &&
  a.night.available === b.night.available &&
  a.night.pending === b.night.pending &&
  a.dust.balance === b.dust.balance &&
  a.dust.available === b.dust.available &&
  a.synced.unshielded === b.synced.unshielded &&
  a.synced.shielded === b.synced.shielded &&
  a.synced.dust === b.synced.dust;

const NOT_SYNCED = { unshielded: false, shielded: false, dust: false };

// NIGHT and the synced flags come from the engine state itself, not from the store's coinsByTokenType$ or the
// engine's syncProgress$: those are second streams of the same state, and combining them can emit inconsistent
// snapshots, such as synced flags newer than the balances they come with.
const balancesOf = (engine: MidnightEngine) =>
  combineLatest([midnightStateOf$(engine), engine.address$]).pipe(
    map(
      ([state, address]): MidnightBalances => ({
        accountId: engine.accountId,
        address,
        night: {
          available: sumNight(state.unshielded.availableCoins),
          pending: sumNight(state.unshielded.pendingCoins),
        },
        dust: dustBalancesOf(state),
        synced: strictCompletionOf(state),
      }),
    ),
  );

/**
 * The account's NIGHT and DUST, straight from the engine, from the moment
 * it starts the account's wallets. Balances are complete once `synced`
 * reports the sub-wallet caught up; a transfer needs unshielded and dust.
 * NIGHT is summed from the engine's state, not from the store's token
 * balances; DUST is summed as the store sums it.
 *
 * Follows the engine across a sync reset or restart. While the engine has
 * stopped the account's wallets and not yet replaced them, it repeats the
 * last balances with every `synced` flag false; once the new wallets start,
 * it emits theirs.
 *
 * Cold: the account is resolved on subscription. Errors the subscriber with
 * `MidnightAccountNotFoundError`, or with `MidnightWalletNotReadyError` when
 * no wallets run for `startTimeout`, at first or after a stop.
 */
export const observeMidnightBalances = (
  wallet: WalletWithMidnight,
  props: MidnightAccountProps = {},
): Observable<MidnightBalances> =>
  observeMidnightEngine(wallet, props).pipe(
    // A worker engine survives its reset, so the reset restarts its balances and marks them not synced, as a
    // page engine's stop does. Its failure, which the account watcher retries, marks them not synced too; any
    // other error, which nothing retries, reaches the subscriber as in page mode.
    switchMap(engine =>
      engine
        ? acrossMidnightEngineResets<MidnightBalances | undefined>(
            engine,
            () => [undefined],
            () => balancesOf(engine),
          ).pipe(
            catchError((error: unknown) =>
              isRemoteMidnightEngine(engine) &&
              error instanceof MidnightEngineClientError &&
              error.reason === 'engine-failed'
                ? of(undefined)
                : throwError(() => error),
            ),
          )
        : of(undefined),
    ),
    scan<MidnightBalances | undefined, MidnightBalances | undefined>(
      (last, next) => next ?? (last && { ...last, synced: NOT_SYNCED }),
      undefined,
    ),
    filter((balances): balances is MidnightBalances => !!balances),
    distinctUntilChanged(sameBalances),
  );
