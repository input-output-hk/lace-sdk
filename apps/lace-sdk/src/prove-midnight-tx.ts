import { defer, finalize, timeout } from 'rxjs';

import { midnightOperationsOf } from './midnight-engine-operations';
import { resolveTimeoutMs } from './midnight-timeouts';
import { withMidnightWallet } from './midnight-wallet';

import type { MidnightTxRecipe } from './build-midnight-transfer';
import type {
  MidnightAccountProps,
  WalletWithMidnight,
} from './midnight-wallet';
import type { AttestationProgressEvent } from '@lace-contract/midnight-context';
import type { Result } from '@lace-lib/util';
import type { OpaqueMidnightFinalizedTx } from '@lace-module/midnight-sync/sdk';

/**
 * A proved transaction, ready for `submitMidnightTx`. It is an opaque value:
 * the serialized ledger transaction, the account and engine instance that
 * proved it, and `activityHash`, the transaction's hash, under which its
 * activity is recorded. It has no ledger methods, survives `structuredClone`
 * and `postMessage`, and is passed back to the SDK unchanged.
 */
export type MidnightFinalizedTx = OpaqueMidnightFinalizedTx;

/** How long every proving helper waits for the proof server unless told otherwise. */
export const DEFAULT_PROVE_TIMEOUT_MS = 10 * 60_000;

/** Applies the default `proveTimeout` and refuses a value no timer can honour. */
export const resolveProveTimeout = (proveTimeout?: number): number =>
  resolveTimeoutMs('proveTimeout', proveTimeout, DEFAULT_PROVE_TIMEOUT_MS);

/** The options of `proveMidnightTx`. */
export interface ProveMidnightTxProps extends MidnightAccountProps {
  /** A signed recipe. */
  recipe: MidnightTxRecipe;
  /**
   * How long the proof server may take, in milliseconds; 10 minutes by default.
   * At most 2^31 - 1 (about 24.8 days); any other value, including `Infinity`, is
   * refused with a `RangeError`. A timeout stops waiting; it does not cancel the
   * proving under way.
   */
  proveTimeout?: number;
  /** Actual attestation/proving phases for this call, until it settles or times out. */
  onProgress?: (event: AttestationProgressEvent) => void;
}

/**
 * Proves the recipe through the proof server the module was configured
 * with. Timeout stops observation; it does not cancel underlying proving.
 * A recipe of another account is refused, and one built before the account's
 * engine restarted or was reset is refused with `MidnightStaleTxError`, both
 * before proving. While a recipe is being proved, even after its caller timed
 * out, proving it again, or a copy of it, is refused before proving.
 */
export const proveMidnightTx = async (
  wallet: WalletWithMidnight,
  { recipe, onProgress, proveTimeout, ...account }: ProveMidnightTxProps,
): Promise<Result<MidnightFinalizedTx, Error>> =>
  withMidnightWallet(wallet, account, engine => {
    const limit = resolveProveTimeout(proveTimeout);
    let observer = onProgress;
    return defer(() =>
      midnightOperationsOf(engine).prove(
        recipe,
        onProgress &&
          (event => {
            observer?.(event);
          }),
      ),
    ).pipe(
      timeout(limit),
      finalize(() => {
        observer = undefined;
      }),
    );
  });
