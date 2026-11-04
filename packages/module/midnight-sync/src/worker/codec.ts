import { HexBytes } from '@lace-lib/util';
import { Transaction } from '@midnight-ntwrk/ledger-v8';

import type { MidnightAccountId } from '@lace-contract/midnight-context';
import type {
  Binding,
  FinalizedTransaction,
  PreBinding,
  PreProof,
  Proof,
  SignatureEnabled,
  UnprovenTransaction,
} from '@midnight-ntwrk/ledger-v8';
import type { BalancingRecipe } from '@midnightntwrk/wallet-sdk/facade';
import type { Tagged } from 'type-fest';

/** Where an opaque Midnight value comes from: the account and the engine instance that built it. */
export type MidnightValueOrigin = {
  /** The account whose engine built the value. */
  readonly accountId: MidnightAccountId;
  /**
   * The account-engine instance that built the value. It changes whenever the account's engine is replaced
   * (a restart or a sync reset), so a value from an earlier engine can be told apart and refused.
   */
  readonly engineGeneration: string;
};

/**
 * A balancing recipe as serialized ledger transactions: the engine's recipe variants, each transaction in the
 * ledger's own binary format. It holds no ledger object, so it survives `structuredClone` and `postMessage`, which
 * silently strip a ledger object of its methods.
 */
export type OpaqueMidnightRecipe = Tagged<
  MidnightValueOrigin &
    (
      | {
          readonly type: 'FINALIZED_TRANSACTION';
          readonly originalTransaction: Uint8Array;
          readonly balancingTransaction: Uint8Array;
        }
      | {
          readonly type: 'UNBOUND_TRANSACTION';
          readonly baseTransaction: Uint8Array;
          readonly balancingTransaction?: Uint8Array;
        }
      | {
          readonly type: 'UNPROVEN_TRANSACTION';
          readonly transaction: Uint8Array;
        }
    ),
  'MidnightTxRecipe'
>;

/** A proved, signed and bound transaction as serialized ledger bytes, with its activity hash. */
export type OpaqueMidnightFinalizedTx = Tagged<
  MidnightValueOrigin & {
    readonly transaction: Uint8Array;
    /** The transaction's hash, which is the `activityId` of its activity. */
    readonly activityHash: string;
  },
  'MidnightFinalizedTx'
>;

const generations = new WeakMap<object, string>();

/**
 * The generation of an account-engine instance: a random identifier assigned the first time the engine object is
 * seen and kept for its lifetime. Random rather than counted, so a value kept across a page reload never matches
 * the engine that replaced its own.
 */
export const midnightEngineGeneration = (engine: object): string => {
  let generation = generations.get(engine);
  if (!generation) {
    generation = HexBytes.fromByteArray(
      crypto.getRandomValues(new Uint8Array(16)),
    );
    generations.set(engine, generation);
  }
  return generation;
};

type Markers = readonly [
  SignatureEnabled['instance'],
  PreProof['instance'] | Proof['instance'],
  Binding['instance'] | PreBinding['instance'],
];

const UNPROVEN: Markers = ['signature', 'pre-proof', 'pre-binding'];
const UNBOUND: Markers = ['signature', 'proof', 'pre-binding'];
const FINALIZED: Markers = ['signature', 'proof', 'binding'];

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// The markers are the ledger's own check of the transaction kind: bytes of another kind fail to deserialize.
const deserialize = (markers: Markers, raw: unknown, field: string) => {
  if (!(raw instanceof Uint8Array))
    throw new TypeError(
      `Expected the Midnight transaction value's ${field} as bytes`,
    );
  try {
    return Transaction.deserialize(...markers, raw);
  } catch (error) {
    throw new Error(
      `The Midnight transaction value's ${field} is not a (${markers.join(
        ', ',
      )}) transaction: ${messageOf(error)}`,
    );
  }
};

const assertOrigin = (value: unknown): void => {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as Partial<MidnightValueOrigin>).accountId !== 'string' ||
    typeof (value as Partial<MidnightValueOrigin>).engineGeneration !== 'string'
  )
    throw new TypeError(
      'Expected a Midnight transaction value returned by the SDK',
    );
};

/**
 * Where an opaque value says it comes from, read without decoding its transaction bytes. Throws when the value is
 * not one the SDK returned.
 */
export const midnightValueOriginOf = (value: unknown): MidnightValueOrigin => {
  assertOrigin(value);
  const { accountId, engineGeneration } = value as MidnightValueOrigin;
  return { accountId, engineGeneration };
};

/** Serializes a recipe the engine built, recording where it comes from. */
export const encodeMidnightRecipe = (
  recipe: BalancingRecipe,
  { accountId, engineGeneration }: MidnightValueOrigin,
): OpaqueMidnightRecipe => {
  const origin = { accountId, engineGeneration };
  switch (recipe.type) {
    case 'UNPROVEN_TRANSACTION':
      return {
        ...origin,
        type: recipe.type,
        transaction: recipe.transaction.serialize(),
      } as OpaqueMidnightRecipe;
    case 'UNBOUND_TRANSACTION':
      return {
        ...origin,
        type: recipe.type,
        baseTransaction: recipe.baseTransaction.serialize(),
        ...(recipe.balancingTransaction && {
          balancingTransaction: recipe.balancingTransaction.serialize(),
        }),
      } as OpaqueMidnightRecipe;
    case 'FINALIZED_TRANSACTION':
      return {
        ...origin,
        type: recipe.type,
        originalTransaction: recipe.originalTransaction.serialize(),
        balancingTransaction: recipe.balancingTransaction.serialize(),
      } as OpaqueMidnightRecipe;
    default:
      throw new TypeError(
        `Unknown Midnight recipe type ${String(
          (recipe as { type?: unknown }).type,
        )}`,
      );
  }
};

/**
 * Rebuilds the engine's recipe from its opaque value. Throws when the value is not one the SDK returned, or when
 * its bytes are not of the kind its recipe variant holds. It does not check the value's origin.
 */
export const decodeMidnightRecipe = (
  value: OpaqueMidnightRecipe,
): BalancingRecipe => {
  assertOrigin(value);
  const fields = value as Partial<
    Record<
      | 'balancingTransaction'
      | 'baseTransaction'
      | 'originalTransaction'
      | 'transaction',
      unknown
    >
  >;
  switch (value.type) {
    case 'UNPROVEN_TRANSACTION':
      return {
        type: value.type,
        transaction: deserialize(
          UNPROVEN,
          fields.transaction,
          'transaction',
        ) as UnprovenTransaction,
      };
    case 'UNBOUND_TRANSACTION':
      return {
        type: value.type,
        baseTransaction: deserialize(
          UNBOUND,
          fields.baseTransaction,
          'baseTransaction',
        ) as Transaction<SignatureEnabled, Proof, PreBinding>,
        balancingTransaction:
          fields.balancingTransaction === undefined
            ? undefined
            : (deserialize(
                UNPROVEN,
                fields.balancingTransaction,
                'balancingTransaction',
              ) as UnprovenTransaction),
      };
    case 'FINALIZED_TRANSACTION':
      return {
        type: value.type,
        originalTransaction: deserialize(
          FINALIZED,
          fields.originalTransaction,
          'originalTransaction',
        ) as FinalizedTransaction,
        balancingTransaction: deserialize(
          UNPROVEN,
          fields.balancingTransaction,
          'balancingTransaction',
        ) as UnprovenTransaction,
      };
    default:
      throw new TypeError(
        `Expected a Midnight recipe value returned by the SDK; got recipe type ${String(
          (value as { type?: unknown }).type,
        )}`,
      );
  }
};

/** Serializes a proved transaction, recording where it comes from and its activity hash. */
export const encodeMidnightFinalizedTx = (
  transaction: FinalizedTransaction,
  { accountId, engineGeneration }: MidnightValueOrigin,
): OpaqueMidnightFinalizedTx =>
  ({
    accountId,
    engineGeneration,
    transaction: transaction.serialize(),
    activityHash: transaction.transactionHash(),
  } as OpaqueMidnightFinalizedTx);

/**
 * Rebuilds a proved transaction from its opaque value. Throws when the value is not one the SDK returned, when its
 * bytes are not a proved, signed and bound transaction, or when its activity hash is not that transaction's. It does
 * not check the value's origin.
 */
export const decodeMidnightFinalizedTx = (
  value: OpaqueMidnightFinalizedTx,
): FinalizedTransaction => {
  assertOrigin(value);
  const transaction = deserialize(
    FINALIZED,
    (value as { transaction?: unknown }).transaction,
    'transaction',
  ) as FinalizedTransaction;
  if (transaction.transactionHash() !== value.activityHash)
    throw new Error(
      `The Midnight transaction value's activity hash ${String(
        value.activityHash,
      )} is not its transaction's`,
    );
  return transaction;
};
