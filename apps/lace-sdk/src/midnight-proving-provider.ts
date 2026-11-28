import { Err, Ok } from '@lace-lib/util';
import { createProvingProviderFromCircuits } from '@lace-module/midnight-sync/sdk';
import { firstValueFrom, from, timeout } from 'rxjs';

import { midnightOperationsOf } from './midnight-engine-operations';
import { toMidnightSdkError } from './midnight-errors';
import { midnightWalletFor, resolveMidnightAccountId } from './midnight-wallet';
import { resolveProveTimeout } from './prove-midnight-tx';

import type { MidnightEngineOperations } from './midnight-engine-operations';
import type {
  MidnightAccountProps,
  WalletWithMidnight,
} from './midnight-wallet';
import type { Result } from '@lace-lib/util';
import type { KeyMaterialProvider } from '@midnight-ntwrk/dapp-connector-api';
import type { ProvingProvider } from '@midnightntwrk/ledger-v9';
import type { Observable } from 'rxjs';

/** Options for an account-bound circuit provider. */
export type GetMidnightProvingProviderProps = MidnightAccountProps & {
  /**
   * Circuit proving/verifying keys and ZKIR. A failed lookup for one of the
   * ledger's built-in circuits proves with the material the proof server
   * holds; any other failed lookup rejects the call with the lookup's error.
   */
  keyMaterialProvider: KeyMaterialProvider;
  /**
   * How long each `lookupKey`, `check` or `prove` call may take, in milliseconds, including
   * the `keyMaterialProvider` lookup; 10 minutes by default.
   * At most 2^31 - 1 (about 24.8 days); any other value, including `Infinity`, is
   * refused with a `RangeError`. A timeout stops waiting; it does not cancel the
   * proving under way.
   */
  proveTimeout?: number;
};

const withinTimeout = async <T>(
  operation: Promise<T>,
  milliseconds: number,
): Promise<T> => firstValueFrom(from(operation).pipe(timeout(milliseconds)));

/**
 * Captures one account identity and resolves its current engine on every use.
 * `lookupKey` resolves circuit material locally without contacting the engine or prover.
 * No proof-server URL or wallet keys are exposed. Factory failures are `Err`;
 * `check`/`prove` reject on transport or attestation failure without fallback,
 * and on timeout.
 * The consumer must authorize disclosure of the circuit preimage to the configured prover.
 * In Worker mode the circuit's key material is looked up on the page and the
 * proof server is called from the worker.
 */
export const getMidnightProvingProvider = async (
  wallet: WalletWithMidnight,
  {
    keyMaterialProvider,
    proveTimeout: requestedProveTimeout,
    ...selection
  }: GetMidnightProvingProviderProps,
): Promise<Result<ProvingProvider, Error>> => {
  try {
    const proveTimeout = resolveProveTimeout(requestedProveTimeout);
    const accountId = await resolveMidnightAccountId(
      wallet,
      selection.accountId,
    );
    const account = { ...selection, accountId };
    await midnightWalletFor(wallet, account);
    const run = async <T>(
      operation: (operations: MidnightEngineOperations) => Observable<T>,
    ): Promise<T> => {
      const engine = await midnightWalletFor(wallet, account);
      try {
        return await firstValueFrom(operation(midnightOperationsOf(engine)));
      } catch (error) {
        throw toMidnightSdkError(error, { accountId });
      }
    };
    // The provider looks the key material up on this page before it calls `run`, so that a failed lookup rejects
    // before any engine is asked.
    const provider = createProvingProviderFromCircuits(
      {
        check: async request =>
          run(operations => operations.checkCircuit(request)),
        prove: async request =>
          run(operations => operations.proveCircuit(request)),
      },
      keyMaterialProvider,
      { onKeyMaterialError: 'propagate' },
    );
    return Ok({
      lookupKey: async keyLocation =>
        withinTimeout(provider.lookupKey(keyLocation), proveTimeout),
      check: async (serializedPreimage, keyLocation) =>
        withinTimeout(
          provider.check(serializedPreimage, keyLocation),
          proveTimeout,
        ),
      prove: async (serializedPreimage, keyLocation, overwriteBindingInput) =>
        withinTimeout(
          provider.prove(
            serializedPreimage,
            keyLocation,
            overwriteBindingInput,
          ),
          proveTimeout,
        ),
    });
  } catch (error) {
    return Err(error instanceof Error ? error : new Error(String(error)));
  }
};
