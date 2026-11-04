import type { OpaqueMidnightFinalizedTx, OpaqueMidnightRecipe } from './codec';
import type { MidnightStateView } from './state-view';
import type { MidnightSyncBatchUpdates } from '../store/dependencies';
import type { Activity } from '@lace-contract/activities';
import type {
  AttestationProgressEvent,
  MidnightAccountId,
  MidnightAccountProps,
  MidnightNetworkConfig,
  MidnightSDKNetworkId,
  MidnightSignRequest,
  MidnightSignResult,
  MidnightWallet,
} from '@lace-contract/midnight-context';
import type {
  AccountId,
  InMemoryWalletAccount,
  WalletId,
} from '@lace-contract/wallet-repo';
import type {
  groupMidnightConnectorInputs,
  groupMidnightConnectorOutputs,
} from '@lace-lib/vendor/midnight-connector-transaction';
import type { WalletEntry } from '@midnightntwrk/wallet-sdk';
import type { Observable } from 'rxjs';

// Everything here crosses the SharedWorker boundary, so it is plain data: primitives, bigints, dates, byte arrays,
// hex strings and the codec's opaque values. A ledger object or a function never appears.

/** Where a Worker-mode engine keeps its checkpoints. */
export type MidnightWorkerStorageKind = 'indexeddb' | 'memory';

/**
 * The settings that change how an account's engine behaves. A client attaching to a running engine with other
 * settings is refused unless it adopts the running ones.
 */
export type MidnightEngineSettings = {
  /** The network endpoints and the proof server. */
  readonly config: MidnightNetworkConfig;
  /** Whether the client was given an attested prover; Worker mode refuses one. */
  readonly attestedProver: boolean;
  readonly storage: MidnightWorkerStorageKind;
};

/** A page-side client and the account whose engine serves its call. */
export type MidnightWorkerCaller = {
  /** The client's own random identifier, chosen once per tab. */
  readonly clientId: string;
  readonly accountId: AccountId;
};

/** Starts the account's engine, or attaches the client to the engine already running for it. */
export type MidnightAttachRequest = {
  readonly clientId: string;
  readonly account: InMemoryWalletAccount<MidnightAccountProps>;
  /**
   * The password that opens the account's keys; the worker keeps a copy for the engine's lifetime. The page zeroes
   * the typed array it sends, and the host the one it receives, once the attach settles; the serialized form that
   * crosses the port is left to garbage collection.
   */
  readonly password: Uint8Array;
  readonly settings: MidnightEngineSettings;
  /** Attach with the running engine's settings when they differ from `settings`. */
  readonly adopt?: boolean;
  /** Applies only when this request starts the engine. */
  readonly batchUpdates?: MidnightSyncBatchUpdates;
};

/** The engine a client attached to. */
export type MidnightAttachResult = {
  readonly accountId: MidnightAccountId;
  readonly walletId: WalletId;
  readonly networkId: MidnightSDKNetworkId;
  readonly nightVerifyingKey: string;
  /** The account-engine generation that every opaque value of this engine carries. */
  readonly engineGeneration: string;
  /** How many times the account's checkpoint has been reset in this worker. */
  readonly resets: number;
  /** The running engine's settings, which differ from the request's only when it adopted them. */
  readonly settings: MidnightEngineSettings;
};

/**
 * The account's engine as its clients see it. A new `engineGeneration` means the engine was replaced; a higher
 * `resets` means its checkpoint was wiped, so each client clears the caches it derived from the old state.
 */
export type MidnightSessionStatus = {
  /** Absent while no engine runs for the account. */
  readonly engineGeneration?: string;
  readonly resets: number;
  /**
   * Why the current engine stopped serving or could not wipe the checkpoint for a held reset, or why no engine could
   * start; the next attach replaces or starts it, unless `replacePending` is set.
   */
  readonly failure?: string;
  /**
   * Present while a reset of the account waits for its unsettled submissions; new submissions are refused with
   * `reset-pending` meanwhile. It goes only with the reset's outcome: `resets` has risen, or `failure` is set.
   */
  readonly resetPending?: true;
  /**
   * Present while the engine has failed and a submission of it is unsettled. The engine keeps serving its clients and
   * refuses new submissions with `not-running`; once the last submission settles, the worker replaces it in place for
   * the clients still attached, and the status names the new `engineGeneration`. An attach meanwhile joins the failed
   * engine.
   */
  readonly replacePending?: true;
};

/**
 * A proving progress event of one call. Only the client that made the call receives it, and tells its calls apart by
 * the `operationId` it chose.
 */
export type MidnightProvingProgress = {
  readonly operationId: string;
  readonly event: AttestationProgressEvent;
};

/**
 * A value of one engine instance, with the `engineGeneration` that `MidnightSessionStatus` reports for it. A
 * transport that replays a stream's last value can deliver one from an engine a reset replaced, after the status that
 * announced the replacement; a client drops a value whose generation is not the current one.
 */
export type MidnightEngineValue<T> = {
  readonly engineGeneration: string;
  readonly value: T;
};

type EngineValueStreams<Streams> = {
  readonly [Key in keyof Streams]: Streams[Key] extends Observable<infer T>
    ? Observable<MidnightEngineValue<T>>
    : never;
};

/**
 * The account's streams. They follow the account's engine across replacements and emit only while the client
 * that asked for them is attached. Each stream of the engine's values tags them with the engine they came from.
 */
export type MidnightSessionStreams = EngineValueStreams<
  Pick<
    MidnightWallet,
    | 'address$'
    | 'areKeysAvailable$'
    | 'coinsByTokenType$'
    | 'syncProgress$'
    | 'transactionHistory$'
  > & { readonly stateView$: Observable<MidnightStateView> }
> & {
  readonly progress$: Observable<MidnightProvingProgress>;
  readonly status$: Observable<MidnightSessionStatus>;
};

/** A homogeneous transfer batch, with token IDs from the account's token state. */
export type MidnightWorkerTransfer = {
  readonly kind: 'shielded' | 'unshielded';
  readonly outputs: readonly {
    readonly to: string;
    readonly tokenId: string;
    readonly amount: bigint;
  }[];
  /** One hour from building by default. */
  readonly ttl?: Date;
};

/** What to build, or to estimate the fee of. */
export type MidnightWorkerTxRequest =
  | { readonly kind: 'dust-registration'; readonly dustAddress?: string }
  | { readonly kind: 'transfer'; readonly transfer: MidnightWorkerTransfer };

type ConnectorInputs = Parameters<typeof groupMidnightConnectorInputs>[0];
type ConnectorOutputs = Parameters<typeof groupMidnightConnectorOutputs>[0];

/** A dApp connector build: the transaction comes back balanced, signed where needed and proved, never submitted. */
export type MidnightConnectorRequest = {
  /**
   * How long proving may take, in milliseconds, counted from when proving starts; balancing and signing are not
   * bounded. Without it, nothing is. A timeout ends the build with a `prove-timeout` refusal; it does not cancel the
   * proving under way.
   */
  readonly proveTimeout?: number;
} & (
  | {
      readonly kind: 'balance-sealed' | 'balance-unsealed';
      /** The ledger transaction, hex encoded. */
      readonly tx: string;
      readonly payFees?: boolean;
    }
  | {
      readonly kind: 'intent';
      readonly desiredInputs: ConnectorInputs;
      readonly desiredOutputs: ConnectorOutputs;
      readonly payFees: boolean;
    }
  | {
      readonly kind: 'transfer';
      readonly desiredOutputs: ConnectorOutputs;
      readonly payFees?: boolean;
    }
);

/** A circuit's key material, which the page resolves from the app's key material provider. */
export type MidnightCircuitKeyMaterial = {
  readonly proverKey: Uint8Array;
  readonly verifierKey: Uint8Array;
  readonly ir: Uint8Array;
};

/** A dApp circuit to check or prove through the account's proof server. */
export type MidnightCircuitRequest = {
  readonly serializedPreimage: Uint8Array;
  readonly keyLocation: string;
  /** Absent when the proof server holds the circuit's material, as for the ledger's built-in circuits. */
  readonly keyMaterial?: MidnightCircuitKeyMaterial;
};

/**
 * The engine host's operations, one per SDK helper and addon. Each takes and returns plain data; an operation on
 * an account's engine runs only for a client attached to it.
 */
export type MidnightEngineHost = {
  attach: (request: MidnightAttachRequest) => Promise<MidnightAttachResult>;
  /** Detaches the client from the account's engine, which stops once no client and no submission remain. */
  detach: (caller: MidnightWorkerCaller) => Promise<void>;
  /** Detaches the client from every engine, as when its tab closes. */
  detachClient: (clientId: string) => Promise<void>;
  streams: (caller: MidnightWorkerCaller) => MidnightSessionStreams;
  /** Builds an unsigned, unproven recipe that reserves its inputs. */
  build: (
    request: MidnightWorkerCaller & { readonly tx: MidnightWorkerTxRequest },
  ) => Promise<OpaqueMidnightRecipe>;
  estimate: (
    request: MidnightWorkerCaller & { readonly tx: MidnightWorkerTxRequest },
  ) => Promise<{ dustFee: bigint; availableDust: bigint }>;
  sign: (
    request: MidnightWorkerCaller & { readonly recipe: OpaqueMidnightRecipe },
  ) => Promise<OpaqueMidnightRecipe>;
  /** Proves a recipe; with an `operationId`, its progress events reach the caller's `progress$` of the account. */
  prove: (
    request: MidnightWorkerCaller & {
      readonly recipe: OpaqueMidnightRecipe;
      readonly operationId?: string;
    },
  ) => Promise<OpaqueMidnightFinalizedTx>;
  /** Releases the coins a recipe reserved. */
  discard: (
    request: MidnightWorkerCaller & { readonly recipe: OpaqueMidnightRecipe },
  ) => Promise<void>;
  /** The Pending activity a submission of the transaction would record, if it can be derived. */
  preparePendingActivity: (
    request: MidnightWorkerCaller & {
      readonly transaction: OpaqueMidnightFinalizedTx;
    },
  ) => Promise<Activity | undefined>;
  /**
   * Submits a proved transaction and settles at finality. The engine keeps running until it settles. Refused with
   * `reset-pending`, before anything is broadcast, while a reset of the account waits; the reset replaces the engine,
   * which then refuses the same transaction as `stale-value`, so build and prove it again once the reset has run.
   * Refused with `not-running`, also before anything is broadcast, while no engine runs or the engine has failed.
   */
  submit: (
    request: MidnightWorkerCaller & {
      readonly transaction: OpaqueMidnightFinalizedTx;
    },
  ) => Promise<{ txId: string }>;
  signData: (
    request: MidnightWorkerCaller & { readonly data: Uint8Array },
  ) => Promise<{ signature: string; verifyingKey: string }>;
  buildConnectorTransaction: (
    request: MidnightWorkerCaller & {
      readonly transaction: MidnightConnectorRequest;
    },
  ) => Promise<OpaqueMidnightFinalizedTx>;
  checkCircuit: (
    request: MidnightCircuitRequest & MidnightWorkerCaller,
  ) => Promise<(bigint | undefined)[]>;
  proveCircuit: (
    request: MidnightCircuitRequest &
      MidnightWorkerCaller & { readonly overwriteBindingInput?: bigint },
  ) => Promise<Uint8Array>;
  transactionHistoryEntry: (
    request: MidnightWorkerCaller & { readonly hash: string },
  ) => Promise<WalletEntry | undefined>;
  /** The signer's whole pipeline: build, sign where needed and prove; with an `operationId`, progress as in `prove`. */
  signTransaction: (
    request: MidnightWorkerCaller & {
      readonly request: MidnightSignRequest;
      readonly operationId?: string;
    },
  ) => Promise<MidnightSignResult>;
  /**
   * Wipes the account's checkpoint and, while its engine runs, restarts it for every attached client. Needs
   * authority over the account (see {@link MidnightStorageAuthority}). A reset never cuts off a submission that is
   * still settling: it waits for it, and refuses new submissions on that account meanwhile (status `resetPending`).
   * Resolves once the reset is scheduled; the status shows its outcome (see `resetPending`).
   */
  resetAccount: (
    request: MidnightWorkerCaller & {
      readonly storage: MidnightWorkerStorageKind;
      readonly authority?: MidnightStorageAuthority;
    },
  ) => Promise<void>;
  /**
   * Wipes every checkpoint of the worker and restarts each engine that has attached clients. Needs authority over
   * one running account, or over any account while none runs: one module password opens every account its page
   * runs. Like a reset, it never cuts off a submission that is still settling: that account's reset waits for it,
   * and new submissions on the account are refused meanwhile. Resolves once every other engine has restarted. When
   * a storage kind fails to clear, the engines of its accounts restart from their checkpoints and count no reset, as
   * after a failed reset wipe, and the call rejects with the clear's error once every other engine has restarted.
   */
  resyncAll: (request: {
    readonly clientId: string;
    readonly storage: MidnightWorkerStorageKind;
    readonly authority?: MidnightStorageAuthority;
  }) => Promise<void>;
  /**
   * Detaches the client from the wallet's engines. When no other client uses them, stops them and wipes the
   * wallet's checkpoints. Needs authority over an account of the wallet. An engine that runs only for an unsettled
   * submission is not stopped: its own checkpoint is wiped once the submission settles, unless a client attaches to
   * the wallet first, and stays if the worker ends first. The wallet's other checkpoints are wiped at once.
   */
  deleteWallet: (request: {
    readonly clientId: string;
    readonly walletId: WalletId;
    readonly storage: MidnightWorkerStorageKind;
    readonly authority?: MidnightStorageAuthority;
  }) => Promise<void>;
};

/**
 * What a client attached to none of the engines a storage operation affects presents as its authority. While an
 * affected engine runs, the password must open the keys of that engine's own account data; while none runs, it
 * must open the presented account, as at a first attach.
 */
export type MidnightStorageAuthority = {
  readonly account: InMemoryWalletAccount<MidnightAccountProps>;
  /** Zeroed as the password of a {@link MidnightAttachRequest} is, once the operation settles. */
  readonly password: Uint8Array;
};

/**
 * Why the engine host refused a call, or stopped waiting for it. `engine-replaced` means the engine was stopped or
 * replaced while the call ran; `not-running` means no engine took the call at all: none ran for the account, as
 * between a stop and the next start, or, for a submission, the engine had failed.
 */
export type MidnightWorkerErrorReason =
  | 'attested-prover'
  | 'engine-replaced'
  | 'not-attached'
  | 'not-running'
  | 'nothing-to-register'
  | 'prove-timeout'
  | 'reset-pending'
  | 'settings-conflict'
  | 'stale-value'
  | 'start-timeout'
  | 'wrong-password';

/**
 * A refusal the page maps to a named SDK error. Its `name` and `reason` are own properties, so they survive the
 * Messenger's error serialization.
 */
export class MidnightWorkerError extends Error {
  public readonly reason: MidnightWorkerErrorReason;

  public constructor(reason: MidnightWorkerErrorReason, message: string) {
    super(message);
    this.name = 'MidnightWorkerError';
    this.reason = reason;
  }
}
