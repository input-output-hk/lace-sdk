import {
  defaultTxTtlLength,
  NIGHT_TOKEN_ID,
} from '@lace-contract/midnight-context';
import {
  deserializeMidnightSealedTransaction,
  deserializeMidnightUnsealedTransaction,
  groupMidnightConnectorInputs,
  groupMidnightConnectorOutputs,
} from '@lace-lib/vendor/midnight-connector-transaction';
import { addressFromKey } from '@midnight-ntwrk/ledger-v8';
import {
  DustAddress,
  MidnightBech32m,
  ShieldedAddress,
  UnshieldedAddress,
} from '@midnightntwrk/wallet-sdk-address-format';
import {
  catchError,
  combineLatest,
  concat,
  defaultIfEmpty,
  defer,
  endWith,
  from,
  ignoreElements,
  map,
  of,
  switchMap,
  take,
  throwError,
  timeout,
} from 'rxjs';

import {
  constructDustDesignationTransaction,
  constructShieldedTransaction,
  constructUnshieldedTransaction,
  estimatePreparedMidnightFee,
  normalizeMidnightTransfers,
} from '../store/prepare-midnight-tx';

import {
  decodeMidnightFinalizedTx,
  decodeMidnightRecipe,
  encodeMidnightFinalizedTx,
  encodeMidnightRecipe,
  midnightEngineGeneration,
  midnightValueOriginOf,
} from './codec';
import {
  finalizeEngineRecipeExclusively,
  finalizeMidnightRecipeExclusively,
} from './finalization';
import { MidnightWorkerError } from './protocol';
import { isDesignatedForDust } from './state-view';

import type {
  MidnightValueOrigin,
  OpaqueMidnightFinalizedTx,
  OpaqueMidnightRecipe,
} from './codec';
import type {
  MidnightConnectorRequest,
  MidnightWorkerTransfer,
  MidnightWorkerTxRequest,
} from './protocol';
import type { Activity } from '@lace-contract/activities';
import type {
  AttestationProgressEvent,
  MidnightSDKNetworkId,
  MidnightWallet,
} from '@lace-contract/midnight-context';
import type { AccountId } from '@lace-contract/wallet-repo';
import type { FinalizedTransaction } from '@midnight-ntwrk/ledger-v8';
import type {
  BalancingRecipe,
  CombinedTokenTransfer,
  UtxoWithMeta,
} from '@midnightntwrk/wallet-sdk/facade';
import type { Observable } from 'rxjs';

// The engine side of the SDK's Midnight helpers (each named in its doc comment): the engine host runs them on the
// account's engine in the SharedWorker, and the helpers run them on the page's engine in page mode, so both modes
// share one pipeline. Input checks, timeouts and the mapping to the SDK's errors stay in the helpers.

/** Derives the Pending activity of a submission; injected because it belongs to another module (ADR 14). */
export type DerivePendingMidnightActivity = (params: {
  deserializedTx: FinalizedTransaction;
  accountId: AccountId;
  ownUserAddressHex: string;
  nightUtxos: readonly UtxoWithMeta[];
  networkId: MidnightSDKNetworkId;
}) => Activity | undefined;

type UnprovenRecipe = Extract<
  BalancingRecipe,
  { type: 'UNPROVEN_TRANSACTION' }
>;

const originOf = (engine: MidnightWallet): MidnightValueOrigin => ({
  accountId: engine.accountId,
  engineGeneration: midnightEngineGeneration(engine),
});

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// The account is checked first: generations belong to engine objects, so a value of another account would otherwise
// be reported as stale.
const assertBuiltBy = (
  engine: MidnightWallet,
  { accountId, engineGeneration }: MidnightValueOrigin,
): void => {
  if (accountId !== engine.accountId)
    throw new Error(
      `This Midnight transaction belongs to account "${accountId}", not "${engine.accountId}": pass the accountId it was built with`,
    );
  if (engineGeneration !== midnightEngineGeneration(engine))
    throw new MidnightWorkerError(
      'stale-value',
      `This Midnight transaction was built by an earlier engine of account "${engine.accountId}": build it again`,
    );
};

// The origin is checked before the bytes reach the ledger's WebAssembly, so a value of an earlier engine is stale
// whatever its bytes hold, such as bytes kept across an SDK upgrade that the bundled ledger no longer reads.
const recipeFor = (
  engine: MidnightWallet,
  value: OpaqueMidnightRecipe,
): BalancingRecipe => {
  assertBuiltBy(engine, midnightValueOriginOf(value));
  return decodeMidnightRecipe(value);
};

const finalizedFor = (
  engine: MidnightWallet,
  value: OpaqueMidnightFinalizedTx,
): FinalizedTransaction => {
  assertBuiltBy(engine, midnightValueOriginOf(value));
  return decodeMidnightFinalizedTx(value);
};

const encodeRecipe = (engine: MidnightWallet) => (recipe: BalancingRecipe) =>
  encodeMidnightRecipe(recipe, originOf(engine));

const encodeFinalized =
  (engine: MidnightWallet) => (transaction: FinalizedTransaction) =>
    encodeMidnightFinalizedTx(transaction, originOf(engine));

const defaultTtl = () => new Date(Date.now() + defaultTxTtlLength);

// The caller never receives a recipe that failed after the engine reserved its inputs, so nothing else could release
// them. When the release fails too, the error is an `AggregateError` of both failures.
const releaseThenThrow = (
  engine: MidnightWallet,
  recipe: BalancingRecipe,
  error: unknown,
): Observable<never> =>
  concat(
    engine.revert(recipe).pipe(
      ignoreElements(),
      catchError((releaseError: unknown) =>
        throwError(
          () =>
            new AggregateError(
              [error, releaseError],
              `${messageOf(
                error,
              )}; the coins it reserved could not be released: ${messageOf(
                releaseError,
              )}`,
            ),
        ),
      ),
    ),
    throwError(() => error),
  );

// Pays a built recipe's fee with DUST, releasing the recipe's inputs when that fails.
const balanceRecipe = (
  engine: MidnightWallet,
  recipe: UnprovenRecipe,
  ttl: Date,
): Observable<BalancingRecipe> =>
  engine
    .balanceUnprovenTransaction(recipe.transaction, {
      ttl,
      tokenKindsToBalance: ['dust'],
    })
    .pipe(
      catchError((balancingError: unknown) =>
        releaseThenThrow(engine, recipe, balancingError),
      ),
    );

const desiredOutputsOf = (
  networkId: MidnightSDKNetworkId,
  { kind, outputs }: MidnightWorkerTransfer,
): CombinedTokenTransfer => {
  const transfers = normalizeMidnightTransfers(networkId, kind, outputs);
  return kind === 'shielded'
    ? {
        type: 'shielded',
        outputs: transfers.map(({ address, tokenId, amount }) => ({
          type: tokenId,
          amount,
          receiverAddress: ShieldedAddress.codec.decode(
            networkId,
            MidnightBech32m.parse(address),
          ),
        })),
      }
    : {
        type: 'unshielded',
        outputs: transfers.map(({ address, tokenId, amount }) => ({
          type: tokenId,
          amount,
          receiverAddress: UnshieldedAddress.codec.decode(
            networkId,
            MidnightBech32m.parse(address),
          ),
        })),
      };
};

// The unsigned selection a DUST registration and its fee estimate share.
const prepareDustRegistration = (
  engine: MidnightWallet,
  destination: string | undefined,
) =>
  combineLatest([
    engine.state().pipe(take(1)),
    engine.address$.pipe(take(1)),
  ]).pipe(
    map(([state, address]) => {
      const nightCoins = state.unshielded.availableCoins.filter(
        ({ utxo }) => utxo.type === NIGHT_TOKEN_ID,
      );
      if (
        nightCoins.length === 0 ||
        nightCoins.every(({ utxo }) => utxo.value <= 0n)
      )
        throw new MidnightWorkerError(
          'nothing-to-register',
          `Midnight account "${engine.accountId}" has no NIGHT to register for DUST generation`,
        );
      const dustAddress = DustAddress.codec.decode(
        engine.networkId,
        MidnightBech32m.parse(destination ?? address.dust),
      );
      if (destination !== undefined && isDesignatedForDust(state, nightCoins))
        throw new Error(
          'DUST destination cannot be changed while the account is designated for DUST generation',
        );
      return {
        state,
        nightCoins,
        dustAddress,
        destination: destination ?? address.dust,
        isRepeatRegistration: nightCoins.some(
          coin => coin.meta.registeredForDustGeneration,
        ),
      };
    }),
  );

/**
 * Builds a recipe that reserves its inputs: `buildMidnightTransfers` (also `buildMidnightTransfer`) or
 * `registerMidnightDust`. When its fee cannot be paid, the inputs it reserved are released before the error.
 *
 * @param engine - The account's engine.
 * @param request - What to build.
 */
export const buildTransaction = (
  engine: MidnightWallet,
  request: MidnightWorkerTxRequest,
): Observable<OpaqueMidnightRecipe> =>
  defer(() => {
    if (request.kind === 'transfer') {
      const desiredOutputs = desiredOutputsOf(
        engine.networkId,
        request.transfer,
      );
      const ttl = request.transfer.ttl ?? defaultTtl();
      // Built without its fee, then balanced, so that a release that fails beside a fee failure is reported.
      return engine
        .transferTransaction([desiredOutputs], { ttl, payFees: false })
        .pipe(switchMap(recipe => balanceRecipe(engine, recipe, ttl)));
    }
    return prepareDustRegistration(engine, request.dustAddress).pipe(
      switchMap(({ nightCoins, dustAddress, isRepeatRegistration }) => {
        const registration$ = engine.registerNightUtxosForDustGeneration(
          nightCoins,
          dustAddress,
        );
        return isRepeatRegistration
          ? registration$.pipe(
              switchMap(registration =>
                balanceRecipe(engine, registration, defaultTtl()),
              ),
            )
          : registration$;
      }),
    );
  }).pipe(map(encodeRecipe(engine)));

/**
 * Estimates the DUST fee from unsigned preparation, reserving nothing: `estimateMidnightFee`.
 *
 * @param engine - The account's engine.
 * @param request - What to estimate.
 */
export const estimateFee = (
  engine: MidnightWallet,
  request: MidnightWorkerTxRequest,
): Observable<{ dustFee: bigint; availableDust: bigint }> =>
  defer(() => {
    const prepared$ =
      request.kind === 'transfer'
        ? engine.state().pipe(
            take(1),
            map(state => {
              const { kind, outputs, ttl } = request.transfer;
              const transfers = normalizeMidnightTransfers(
                engine.networkId,
                kind,
                outputs,
              );
              const construct =
                kind === 'shielded'
                  ? constructShieldedTransaction
                  : constructUnshieldedTransaction;
              return {
                state,
                tx: construct({ networkId: engine.networkId, transfers, ttl }),
                isFirstDesignation: false,
              };
            }),
          )
        : prepareDustRegistration(engine, request.dustAddress).pipe(
            map(({ state, nightCoins, destination, isRepeatRegistration }) => ({
              state,
              tx: constructDustDesignationTransaction({
                networkId: engine.networkId,
                address: destination,
                nightUtxos: nightCoins,
                nightVerifyingKey: engine.nightVerifyingKey,
                // The engine registers already registered NIGHT with no fee allowance and balances it with DUST,
                // so zero prices that fee instead of hiding it behind the default allowance.
                allowFeePayment: isRepeatRegistration ? 0n : undefined,
              }),
              isFirstDesignation: !isRepeatRegistration,
            })),
          );
    return combineLatest([
      prepared$,
      engine.areKeysAvailable$.pipe(take(1)),
    ]).pipe(
      switchMap(([{ state, tx, isFirstDesignation }, areKeysAvailable]) => {
        const availableDust = state.dust.balance(new Date());
        return estimatePreparedMidnightFee(engine, tx, {
          isDustDesignation: isFirstDesignation,
          dustBalance: availableDust,
          areKeysAvailable,
        }).pipe(
          map(dustFee => {
            if (dustFee > availableDust)
              throw new Error('Insufficient spendable DUST');
            return { dustFee, availableDust };
          }),
        );
      }),
    );
  });

/**
 * Signs a recipe this engine built: `signMidnightTx`.
 *
 * @param engine - The account's engine.
 * @param value - The recipe.
 */
export const signRecipe = (
  engine: MidnightWallet,
  value: OpaqueMidnightRecipe,
): Observable<OpaqueMidnightRecipe> =>
  defer(() => engine.signRecipe(recipeFor(engine, value))).pipe(
    map(encodeRecipe(engine)),
  );

/**
 * Proves a recipe this engine built, refusing one that is already being proved: `proveMidnightTx`.
 *
 * @param engine - The account's engine.
 * @param value - The recipe.
 * @param onProgress - Receives the proving phases.
 */
export const proveRecipe = (
  engine: MidnightWallet,
  value: OpaqueMidnightRecipe,
  onProgress?: (event: AttestationProgressEvent) => void,
): Observable<OpaqueMidnightFinalizedTx> =>
  defer(() => {
    const recipe = recipeFor(engine, value);
    return finalizeMidnightRecipeExclusively(engine, value, () =>
      onProgress
        ? engine.finalizeRecipe(recipe, onProgress)
        : engine.finalizeRecipe(recipe),
    );
  }).pipe(map(encodeFinalized(engine)));

/**
 * Releases the coins a recipe of this engine reserved: `discardMidnightTx`.
 *
 * @param engine - The account's engine.
 * @param value - The recipe.
 */
export const discardRecipe = (
  engine: MidnightWallet,
  value: OpaqueMidnightRecipe,
): Observable<void> =>
  defer(() => engine.revert(recipeFor(engine, value))).pipe(
    ignoreElements(),
    endWith(undefined),
  );

/**
 * The Pending activity a submission records, derived before submitting: submission can remove consumed coins at
 * once, and the engine moves a transaction's own inputs to the pending coins when it builds it. Best effort, like
 * the row it feeds: a derivation that fails gives none. `submitMidnightTx`.
 *
 * @param engine - The account's engine.
 * @param value - The proved transaction.
 * @param derive - The injected derivation.
 */
export const preparePendingActivity = (
  engine: MidnightWallet,
  value: OpaqueMidnightFinalizedTx,
  derive: DerivePendingMidnightActivity,
): Observable<Activity | undefined> =>
  defer(() => {
    const deserializedTx = finalizedFor(engine, value);
    return defer(() => engine.state()).pipe(
      take(1),
      map(({ unshielded }) =>
        derive({
          deserializedTx,
          accountId: engine.accountId,
          ownUserAddressHex: addressFromKey(engine.nightVerifyingKey),
          nightUtxos: [
            ...unshielded.availableCoins,
            ...unshielded.pendingCoins,
          ],
          networkId: engine.networkId,
        }),
      ),
      catchError(() => of(undefined)),
      defaultIfEmpty(undefined),
    );
  });

/**
 * Submits a proved transaction of this engine and emits its identifier at finality: `submitMidnightTx`.
 *
 * @param engine - The account's engine.
 * @param value - The proved transaction.
 */
export const submitTransaction = (
  engine: MidnightWallet,
  value: OpaqueMidnightFinalizedTx,
): Observable<{ txId: string }> =>
  defer(() => engine.submitTransaction(finalizedFor(engine, value))).pipe(
    take(1),
    map(txId => ({ txId })),
  );

// What a connector build reserved, which a signing failure releases: the whole recipe when the wallet built it,
// otherwise its balancing transaction. The dApp's own transaction may spend coins an earlier build reserved, and the
// wallet does not reserve the unshielded inputs it adds to an unbound one.
const reservedBy = (recipe: BalancingRecipe): BalancingRecipe | undefined =>
  recipe.type === 'UNPROVEN_TRANSACTION'
    ? recipe
    : recipe.balancingTransaction && {
        type: 'UNPROVEN_TRANSACTION',
        transaction: recipe.balancingTransaction,
      };

// The longest delay a timer honours; a longer one, or `Infinity`, fires at once.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

// The page checks `proveTimeout` before it sends a build, and the worker checks it again rather than trust the page.
const assertProveTimeout = (proveTimeout: unknown): void => {
  if (
    proveTimeout !== undefined &&
    (typeof proveTimeout !== 'number' ||
      !Number.isFinite(proveTimeout) ||
      proveTimeout <= 0 ||
      proveTimeout > MAX_TIMEOUT_MS)
  )
    throw new RangeError(
      `proveTimeout must be a positive number of milliseconds up to ${MAX_TIMEOUT_MS}; got ${
        typeof proveTimeout === 'number' ? proveTimeout : typeof proveTimeout
      }`,
    );
};

// `proveTimeout` bounds proving only: its timer starts with proving, and a timeout stops the wait without cancelling
// the proving under way, as `proveMidnightTx` does.
const signAndProve = (
  engine: MidnightWallet,
  recipe: BalancingRecipe,
  { sign, proveTimeout }: { sign: boolean; proveTimeout?: number },
): Observable<OpaqueMidnightFinalizedTx> => {
  const reserved = reservedBy(recipe);
  const prepared$ = sign
    ? engine
        .signRecipe(recipe)
        .pipe(
          catchError((signingError: unknown) =>
            reserved
              ? releaseThenThrow(engine, reserved, signingError)
              : throwError(() => signingError),
          ),
        )
    : of(recipe);
  return prepared$.pipe(
    switchMap(prepared => {
      const proved$ = finalizeEngineRecipeExclusively(engine, prepared, () =>
        engine.finalizeRecipe(prepared),
      );
      return proveTimeout === undefined
        ? proved$
        : proved$.pipe(
            timeout({
              first: proveTimeout,
              with: () =>
                throwError(
                  () =>
                    new MidnightWorkerError(
                      'prove-timeout',
                      `The Midnight transaction was not proved within proveTimeout (${proveTimeout} ms); proving goes on`,
                    ),
                ),
            }),
          );
    }),
    map(encodeFinalized(engine)),
  );
};

const assertOutputKindsHaveInputs = (
  inputs: ReturnType<typeof groupMidnightConnectorInputs>,
  outputs: CombinedTokenTransfer[],
) => {
  const missing = outputs
    .map(output => output.type)
    .filter(kind => inputs[kind] === undefined);
  if (missing.length > 0)
    throw new Error(
      `Midnight intent requests ${missing.join(
        ' and ',
      )} outputs without inputs of that kind, which the wallet library would drop`,
    );
};

const tokenKindsToBalance = (
  payFees: boolean | undefined,
): ('shielded' | 'unshielded')[] | undefined =>
  payFees === false ? ['shielded', 'unshielded'] : undefined;

/**
 * Balances, signs where needed and proves a dApp connector transaction, never submitting it:
 * `balanceMidnightSealedTransaction`, `balanceMidnightUnsealedTransaction`, `makeMidnightTransfer` and
 * `makeMidnightIntent`. A `proveTimeout` that no timer can honour is refused with a `RangeError` before anything is
 * reserved.
 *
 * @param engine - The account's engine.
 * @param request - The connector build.
 */
export const buildConnectorTransaction = (
  engine: MidnightWallet,
  request: MidnightConnectorRequest,
): Observable<OpaqueMidnightFinalizedTx> =>
  defer(() => {
    const { proveTimeout } = request;
    assertProveTimeout(proveTimeout);
    const ttl = defaultTtl();
    switch (request.kind) {
      case 'balance-sealed':
        return from(deserializeMidnightSealedTransaction(request.tx)).pipe(
          switchMap(transaction =>
            engine.balanceFinalizedTransaction(transaction, {
              ttl,
              tokenKindsToBalance: tokenKindsToBalance(request.payFees),
            }),
          ),
          switchMap(recipe =>
            signAndProve(engine, recipe, { sign: true, proveTimeout }),
          ),
        );
      case 'balance-unsealed':
        return from(deserializeMidnightUnsealedTransaction(request.tx)).pipe(
          switchMap(transaction =>
            engine.balanceUnboundTransaction(transaction, {
              ttl,
              tokenKindsToBalance: tokenKindsToBalance(request.payFees),
            }),
          ),
          switchMap(recipe =>
            signAndProve(engine, recipe, { sign: true, proveTimeout }),
          ),
        );
      case 'transfer': {
        const outputs = groupMidnightConnectorOutputs(
          request.desiredOutputs,
          engine.networkId,
        );
        return engine
          .transferTransaction(outputs, { ttl, payFees: false })
          .pipe(
            switchMap(built =>
              request.payFees ?? true
                ? balanceRecipe(engine, built, ttl)
                : of(built),
            ),
            switchMap(recipe =>
              signAndProve(engine, recipe, {
                sign: outputs.some(output => output.type === 'unshielded'),
                proveTimeout,
              }),
            ),
          );
      }
      case 'intent': {
        const inputs = groupMidnightConnectorInputs(request.desiredInputs);
        const outputs = groupMidnightConnectorOutputs(
          request.desiredOutputs,
          engine.networkId,
        );
        assertOutputKindsHaveInputs(inputs, outputs);
        return engine.initSwap(inputs, outputs, { ttl, payFees: false }).pipe(
          switchMap(built =>
            request.payFees ? balanceRecipe(engine, built, ttl) : of(built),
          ),
          switchMap(recipe =>
            signAndProve(engine, recipe, {
              sign:
                !!inputs.unshielded ||
                outputs.some(output => output.type === 'unshielded'),
              proveTimeout,
            }),
          ),
        );
      }
    }
  });
