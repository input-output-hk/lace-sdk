import { HexBytes } from '@lace-lib/util';
import { defer, finalize, shareReplay, take, throwError } from 'rxjs';

import type { OpaqueMidnightRecipe } from './codec';
import type { BalancingRecipe } from '@midnightntwrk/wallet-sdk/facade';
import type { Observable } from 'rxjs';

// A failed proof makes the engine release its transaction's coins, so a second proof of one recipe could free coins
// the first still spends. The proof server access refuses it by object identity, which a decoded recipe never shares.
const finalizing = new WeakMap<object, Set<string>>();

// The transaction a finalization proves, the one the proof server access keys on; without it, nothing is proved.
const provedTransactionOf = (
  value: OpaqueMidnightRecipe,
): Uint8Array | undefined =>
  value.type === 'UNPROVEN_TRANSACTION'
    ? value.transaction
    : value.balancingTransaction;

const finalizeExclusively = <T>(
  engine: object,
  proved: Uint8Array | undefined,
  finalizeRecipe: () => Observable<T>,
): Observable<T> => {
  if (!proved) return finalizeRecipe();
  const key = HexBytes.fromByteArray(proved);
  const held = finalizing.get(engine) ?? new Set<string>();
  if (held.has(key))
    return throwError(
      () => new Error('This transaction is already being finalized'),
    );
  held.add(key);
  finalizing.set(engine, held);
  // refCount false keeps the finalization subscribed after its caller unsubscribes (a timeout), so the recipe is
  // released when the engine settles it, not when the caller stops waiting.
  return defer(finalizeRecipe).pipe(
    take(1),
    finalize(() => held.delete(key)),
    shareReplay({ bufferSize: 1, refCount: false }),
  );
};

/**
 * Runs an engine's finalization of a recipe unless that engine is already finalizing the same recipe, in which case
 * it errors with "This transaction is already being finalized" and starts nothing. A recipe is the bytes of the
 * transaction its finalization proves, so a copy of its value, such as one made by `structuredClone` or
 * `postMessage`, is the same recipe. The recipe stays held until the finalization settles, even when its caller has
 * stopped waiting.
 *
 * @param engine - The account-engine instance that finalizes the recipe.
 * @param value - The recipe's opaque value.
 * @param finalizeRecipe - Starts the engine's finalization of the recipe `value` holds.
 */
export const finalizeMidnightRecipeExclusively = <T>(
  engine: object,
  value: OpaqueMidnightRecipe,
  finalizeRecipe: () => Observable<T>,
): Observable<T> =>
  defer(() =>
    finalizeExclusively(engine, provedTransactionOf(value), finalizeRecipe),
  );

/**
 * {@link finalizeMidnightRecipeExclusively} for a recipe the engine holds decoded, such as one a connector build has
 * just signed: the same guard, keyed on the same bytes, serialized from the transaction its finalization proves only.
 *
 * @param engine - The account-engine instance that finalizes the recipe.
 * @param recipe - The engine's recipe.
 * @param finalizeRecipe - Starts the engine's finalization of `recipe`.
 */
export const finalizeEngineRecipeExclusively = <T>(
  engine: object,
  recipe: BalancingRecipe,
  finalizeRecipe: () => Observable<T>,
): Observable<T> =>
  defer(() => {
    const proved =
      recipe.type === 'UNPROVEN_TRANSACTION'
        ? recipe.transaction
        : recipe.balancingTransaction;
    return finalizeExclusively(engine, proved?.serialize(), finalizeRecipe);
  });
