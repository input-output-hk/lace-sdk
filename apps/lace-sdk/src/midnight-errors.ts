import {
  MIDNIGHT_ENGINE_START_BOUND_MS,
  MidnightEngineClientError,
  MidnightWorkerError,
} from '@lace-module/midnight-sync/sdk';
import { TimeoutError } from 'rxjs';

import type { MidnightSDKNetworkId } from '@lace-contract/midnight-context';
import type { AccountId } from '@lace-contract/wallet-repo';

/** The `code` of each Midnight error the SDK throws or returns. */
export type MidnightErrorCode =
  | 'midnight-account-not-found'
  | 'midnight-attested-prover-unsupported'
  | 'midnight-engine-reset'
  | 'midnight-network-not-configured'
  | 'midnight-nothing-to-register'
  | 'midnight-settings-conflict'
  | 'midnight-stale-tx'
  | 'midnight-submit-interrupted'
  | 'midnight-submit-timeout'
  | 'midnight-wallet-not-ready'
  | 'midnight-worker-startup-failed'
  | 'midnight-worker-stopped'
  | 'midnight-worker-unsupported';

/** The loadout has no endpoints for the network: none public, none from `networks`. */
export class MidnightNetworkNotConfiguredError extends Error {
  public readonly code: MidnightErrorCode = 'midnight-network-not-configured';

  public constructor(networkId: MidnightSDKNetworkId) {
    super(
      `Midnight network "${networkId}" has no endpoints in this loadout: pass networks.${networkId} with nodeAddress and indexerAddress to createMidnightModule`,
    );
    this.name = 'MidnightNetworkNotConfiguredError';
  }
}

/** No single in-memory Midnight account on the active network answers the request. */
export class MidnightAccountNotFoundError extends Error {
  public readonly code: MidnightErrorCode = 'midnight-account-not-found';

  public constructor(message: string) {
    super(message);
    this.name = 'MidnightAccountNotFoundError';
  }
}

/** The engine did not start the account's wallets within the wait. */
export class MidnightWalletNotReadyError extends Error {
  public readonly code: MidnightErrorCode = 'midnight-wallet-not-ready';

  public constructor(accountId: AccountId, timeoutMs: number) {
    super(
      `Midnight wallet for account "${accountId}" did not start within ${timeoutMs}ms`,
    );
    this.name = 'MidnightWalletNotReadyError';
  }
}

/** The account holds no available NIGHT to register for DUST generation. */
export class MidnightNothingToRegisterError extends Error {
  public readonly code: MidnightErrorCode = 'midnight-nothing-to-register';

  public constructor(accountId: AccountId) {
    super(`Account "${accountId}" has no available NIGHT to register`);
    this.name = 'MidnightNothingToRegisterError';
  }
}

/**
 * A recipe or proved transaction was built by an earlier engine of its account, which a sync reset or a restart
 * has since replaced. Signing, proving, discarding and submitting it are refused: its reservation may be gone (a
 * sync reset clears it, a restart can lose it), so a later build can hold the same coins, and releasing this one
 * could free them. Build the transaction again. What a restart kept of the reservation stays until a sync reset.
 * In Worker mode, `submitMidnightTx` also returns it when no running engine took the transaction: the engine that
 * built it had stopped or failed, and the one that replaces it refuses the value. Nothing was broadcast.
 */
export class MidnightStaleTxError extends Error {
  public readonly code: MidnightErrorCode = 'midnight-stale-tx';

  public constructor(accountId: AccountId) {
    super(
      `This Midnight transaction was built before the engine of account "${accountId}" restarted or was reset: build it again`,
    );
    this.name = 'MidnightStaleTxError';
  }
}

/**
 * `submitMidnightTx` stopped waiting for the node to report the transaction final. The engine had already been
 * given the transaction, so it may be on chain or reach it later: look for `activityHash` in the account's
 * activities before submitting again.
 */
export class MidnightSubmitTimeoutError extends Error {
  public readonly code: MidnightErrorCode = 'midnight-submit-timeout';
  /** The transaction's hash, which is the `activityId` of its activity. */
  public readonly activityHash: string;

  public constructor(activityHash: string, timeoutMs: number) {
    super(
      `Midnight transaction ${activityHash} was not reported final within ${timeoutMs}ms and may still reach the chain`,
    );
    this.name = 'MidnightSubmitTimeoutError';
    this.activityHash = activityHash;
  }
}

/**
 * `worker` was set where no module SharedWorker can run, such as an older mobile browser, a browser without the
 * Web Locks API, a page outside a secure context (served over plain HTTP, not HTTPS or localhost), Node.js or React
 * Native. Worker mode has no fallback: every call that needs the engine returns this error. Create the module without
 * `worker` to run the engine on the page.
 */
export class MidnightWorkerUnsupportedError extends Error {
  public readonly code: MidnightErrorCode = 'midnight-worker-unsupported';

  public constructor(options?: ErrorOptions) {
    super(
      'Midnight Worker mode needs a module SharedWorker, the Web Locks API and a secure context (HTTPS or localhost); this environment lacks one of them',
      options,
    );
    this.name = 'MidnightWorkerUnsupportedError';
  }
}

/**
 * The Midnight worker did not start: its script or WebAssembly failed to load, or it did not answer within 30
 * seconds. No engine work ran. The next call that needs the engine tries once more. When the worker could not load
 * the engine, the error's `cause` chain ends with the load error's message, a string.
 */
export class MidnightWorkerStartupError extends Error {
  public readonly code: MidnightErrorCode = 'midnight-worker-startup-failed';

  public constructor(accountId: AccountId, options?: ErrorOptions) {
    super(
      `The Midnight worker did not start, so the engine of account "${accountId}" is not running`,
      options,
    );
    this.name = 'MidnightWorkerStartupError';
  }
}

/**
 * The Midnight worker ended while this page used it: the browser stopped it or it crashed. Calls in flight fail
 * with this error and subscriptions end with it; nothing is retried. The next call that needs the engine starts a
 * new worker, and a transaction value built before then is refused with `MidnightStaleTxError`.
 */
export class MidnightWorkerStoppedError extends Error {
  public readonly code: MidnightErrorCode = 'midnight-worker-stopped';

  public constructor(accountId: AccountId, options?: ErrorOptions) {
    super(
      `The Midnight worker running the engine of account "${accountId}" stopped: the next call starts it again`,
      options,
    );
    this.name = 'MidnightWorkerStoppedError';
  }
}

/**
 * Another page of the app already runs the account's engine in the worker with other settings: other endpoints,
 * another proof server or another storage kind. Pass `worker: { adopt: true }` to use the running engine's
 * settings instead.
 */
export class MidnightWorkerSettingsConflictError extends Error {
  public readonly code: MidnightErrorCode = 'midnight-settings-conflict';

  public constructor(accountId: AccountId, options?: ErrorOptions) {
    super(
      `The Midnight engine of account "${accountId}" runs with other settings: pass worker.adopt to use them`,
      options,
    );
    this.name = 'MidnightWorkerSettingsConflictError';
  }
}

/**
 * The account's engine was reset or replaced while the call ran, or a reset of the account waits for its
 * submissions to settle and refuses new ones meanwhile. Build the transaction again once the reset has run.
 */
export class MidnightEngineResetError extends Error {
  public readonly code: MidnightErrorCode = 'midnight-engine-reset';

  public constructor(accountId: AccountId, options?: ErrorOptions) {
    super(
      `The Midnight engine of account "${accountId}" was reset or replaced: build the transaction again once the reset has run`,
      options,
    );
    this.name = 'MidnightEngineResetError';
  }
}

/**
 * `createAttestedProver` cannot be combined with `worker`: an attested prover is an application function, which
 * cannot run in the SDK's worker. Worker mode proves through a proof server given by URL.
 */
export class MidnightAttestedProverUnsupportedError extends Error {
  public readonly code: MidnightErrorCode =
    'midnight-attested-prover-unsupported';

  public constructor(options?: ErrorOptions) {
    super(
      'An attested prover cannot prove in the Midnight worker: Worker mode proves through a proof server given by URL',
      options,
    );
    this.name = 'MidnightAttestedProverUnsupportedError';
  }
}

/**
 * The Midnight worker ended after `submitMidnightTx` handed it the transaction and before it reported the outcome.
 * The transaction may still reach the chain: its Pending activity stays, and the SDK never submits it again. Look for
 * `activityHash` in the account's activities before submitting again.
 */
export class MidnightSubmitInterruptedError extends Error {
  public readonly code: MidnightErrorCode = 'midnight-submit-interrupted';
  /** The transaction's hash, which is the `activityId` of its activity. */
  public readonly activityHash: string;

  public constructor(activityHash: string, options?: ErrorOptions) {
    super(
      `The Midnight worker ended before it reported the outcome of transaction ${activityHash}, which may still reach the chain`,
      options,
    );
    this.name = 'MidnightSubmitInterruptedError';
    this.activityHash = activityHash;
  }
}

/** What an engine failure is mapped with: the account it concerns, and the transaction a submission carried. */
type MidnightErrorContext = {
  readonly accountId: AccountId;
  readonly activityHash?: string;
};

const reasonOf = (error: unknown): string | undefined =>
  error instanceof MidnightEngineClientError ||
  error instanceof MidnightWorkerError
    ? error.reason
    : undefined;

/**
 * The SDK error for an engine failure. Refusals of the engine pipelines (in a worker or on the page) become the named
 * errors above; a refusal without a named error becomes a plain `Error` with its message, and any other error is
 * returned as it is.
 */
export const toMidnightSdkError = (
  error: unknown,
  { accountId: contextAccountId, activityHash }: MidnightErrorContext,
): Error => {
  const reason = reasonOf(error);
  if (reason === undefined)
    return error instanceof Error ? error : new Error(String(error));
  const cause = { cause: error };
  const accountId =
    error instanceof MidnightEngineClientError
      ? error.accountId
      : contextAccountId;
  switch (reason) {
    case 'not-supported':
      return new MidnightWorkerUnsupportedError(cause);
    case 'startup-failed':
      return new MidnightWorkerStartupError(accountId, cause);
    case 'runtime-stopped':
      return new MidnightWorkerStoppedError(accountId, cause);
    case 'settings-conflict':
      return new MidnightWorkerSettingsConflictError(accountId, cause);
    case 'attested-prover':
      return new MidnightAttestedProverUnsupportedError(cause);
    case 'reset-pending':
    case 'engine-replaced':
    case 'not-running':
      return new MidnightEngineResetError(accountId, cause);
    case 'stale-value':
      return new MidnightStaleTxError(accountId);
    case 'nothing-to-register':
      return new MidnightNothingToRegisterError(accountId);
    case 'start-timeout':
      return new MidnightWalletNotReadyError(
        accountId,
        MIDNIGHT_ENGINE_START_BOUND_MS,
      );
    // The error every proving helper returns when its `proveTimeout` elapses, in either mode.
    case 'prove-timeout':
      return new TimeoutError();
    case 'submit-interrupted':
      return activityHash === undefined
        ? new Error((error as Error).message, cause)
        : new MidnightSubmitInterruptedError(activityHash, cause);
    default:
      return new Error((error as Error).message, cause);
  }
};
