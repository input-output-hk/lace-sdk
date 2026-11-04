import { defer } from 'rxjs';

import { midnightOperationsOf } from './midnight-engine-operations';
import { withMidnightWallet } from './midnight-wallet';
import { resolveProveTimeout } from './prove-midnight-tx';

import type {
  MidnightAccountProps,
  WalletWithMidnight,
} from './midnight-wallet';
import type { MidnightFinalizedTx } from './prove-midnight-tx';
import type { MidnightEngine } from '@lace-contract/midnight-context';
import type { Result } from '@lace-lib/util';
import type { MidnightConnectorRequest } from '@lace-module/midnight-sync/sdk';
import type {
  DesiredInput,
  DesiredOutput,
} from '@midnight-ntwrk/dapp-connector-api';
import type { Observable } from 'rxjs';

type ProveTimeoutProps = {
  /**
   * How long the proof server may take, in milliseconds; 10 minutes by default.
   * At most 2^31 - 1 (about 24.8 days); any other value, including `Infinity`, is
   * refused with a `RangeError`. A timeout stops waiting; it does not cancel the
   * proving under way.
   */
  proveTimeout?: number;
};

/** Connector balancing accepts hexadecimal ledger transactions. Obtain consent before invoking. */
export type MidnightBalanceProps = MidnightAccountProps &
  ProveTimeoutProps & {
    tx: string;
    options?: { payFees?: boolean };
  };

/** Connector outputs use raw ledger token types, not SDK token-state identifiers. */
export type MidnightMakeTransferProps = MidnightAccountProps &
  ProveTimeoutProps & {
    desiredOutputs: DesiredOutput[];
    options?: { payFees?: boolean };
  };

/** Inputs are aggregated by kind and raw ledger token type. */
export type MidnightMakeIntentProps = MidnightAccountProps &
  ProveTimeoutProps & {
    desiredInputs: DesiredInput[];
    desiredOutputs: DesiredOutput[];
    options: {
      /** Accepted but ignored, matching the connector; does not control intent ordering. */
      intentId: number | 'random';
      payFees: boolean;
    };
  };

const validateOptions = (options: MidnightBalanceProps['options']) => {
  if (
    options !== undefined &&
    (!options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      (options.payFees !== undefined && typeof options.payFees !== 'boolean'))
  ) {
    throw new Error('Invalid Midnight fee options');
  }
};

const validateTokens = (tokens: DesiredInput[]) => {
  if (!Array.isArray(tokens)) throw new Error('Expected Midnight token array');
  for (const token of tokens) {
    if (!token || (token.kind !== 'shielded' && token.kind !== 'unshielded')) {
      throw new Error('Unsupported Midnight token kind');
    }
    if (typeof token.type !== 'string' || !/^[\da-f]{64}$/i.test(token.type)) {
      throw new Error('Expected a raw Midnight ledger token type');
    }
    if (typeof token.value !== 'bigint' || token.value < 0n) {
      throw new Error('Expected a non-negative Midnight token value');
    }
  }
};

const validateBalance = ({ tx, options }: MidnightBalanceProps) => {
  validateOptions(options);
  if (typeof tx !== 'string' || !/^(?:[\da-f]{2})+$/i.test(tx)) {
    throw new Error('Expected a hexadecimal Midnight transaction');
  }
};

// The engine-side build times proving itself, in the worker or on this page, so balancing and signing stay unbounded.
const buildWithin = (
  engine: MidnightEngine,
  request: MidnightConnectorRequest,
  proveTimeout: number,
): Observable<MidnightFinalizedTx> =>
  midnightOperationsOf(engine).buildConnectorTransaction({
    ...request,
    proveTimeout,
  });

/**
 * Balances, signs and proves a binding transaction; never submits it.
 * Obtain consumer consent for the transaction, account and prover disclosure before calling.
 */
export const balanceMidnightSealedTransaction = async (
  wallet: WalletWithMidnight,
  props: MidnightBalanceProps,
): Promise<Result<MidnightFinalizedTx, Error>> =>
  withMidnightWallet(wallet, props, engine =>
    defer(() => {
      const proveTimeout = resolveProveTimeout(props.proveTimeout);
      validateBalance(props);
      return buildWithin(
        engine,
        {
          kind: 'balance-sealed',
          tx: props.tx,
          payFees: props.options?.payFees,
        },
        proveTimeout,
      );
    }),
  );

/**
 * Balances, signs and proves a pre-binding transaction; never submits it.
 * Obtain consumer consent for the transaction, account and prover disclosure before calling.
 */
export const balanceMidnightUnsealedTransaction = async (
  wallet: WalletWithMidnight,
  props: MidnightBalanceProps,
): Promise<Result<MidnightFinalizedTx, Error>> =>
  withMidnightWallet(wallet, props, engine =>
    defer(() => {
      const proveTimeout = resolveProveTimeout(props.proveTimeout);
      validateBalance(props);
      return buildWithin(
        engine,
        {
          kind: 'balance-unsealed',
          tx: props.tx,
          payFees: props.options?.payFees,
        },
        proveTimeout,
      );
    }),
  );

/**
 * Builds and proves connector transfers, including mixed token kinds; signs when unshielded outputs exist.
 * Obtain consumer consent before calling. Returns the proved transaction without submitting.
 * Fees default to enabled; use `buildMidnightTransfers` for separate homogeneous build/sign/prove stages.
 */
export const makeMidnightTransfer = async (
  wallet: WalletWithMidnight,
  props: MidnightMakeTransferProps,
): Promise<Result<MidnightFinalizedTx, Error>> =>
  withMidnightWallet(wallet, props, engine =>
    defer(() => {
      const proveTimeout = resolveProveTimeout(props.proveTimeout);
      validateOptions(props.options);
      validateTokens(props.desiredOutputs);
      return buildWithin(
        engine,
        {
          kind: 'transfer',
          desiredOutputs: props.desiredOutputs,
          payFees: props.options?.payFees,
        },
        proveTimeout,
      );
    }),
  );

/**
 * Builds and proves an intent, signing when inputs or outputs include unshielded tokens.
 * Obtain consumer consent before calling. Never submits. `intentId` is accepted but ignored,
 * matching the existing connector; no intent ordering is guaranteed. Every output kind
 * needs an input of the same kind: the wallet library builds a leg from its inputs and
 * drops the outputs of a kind without any, so such a request is refused before anything
 * is reserved or signed. When the fee cannot be paid, the inputs the build reserved are
 * released and the balancing error is returned; if that release fails too, the error is
 * an `AggregateError` of both failures and the coins stay reserved until a sync reset.
 */
export const makeMidnightIntent = async (
  wallet: WalletWithMidnight,
  props: MidnightMakeIntentProps,
): Promise<Result<MidnightFinalizedTx, Error>> =>
  withMidnightWallet(wallet, props, engine =>
    defer(() => {
      const proveTimeout = resolveProveTimeout(props.proveTimeout);
      validateOptions(props.options);
      if (
        !props.options ||
        typeof props.options.payFees !== 'boolean' ||
        (props.options.intentId !== 'random' &&
          typeof props.options.intentId !== 'number')
      ) {
        throw new Error('Invalid Midnight intent options');
      }
      validateTokens(props.desiredInputs);
      validateTokens(props.desiredOutputs);
      return buildWithin(
        engine,
        {
          kind: 'intent',
          desiredInputs: props.desiredInputs,
          desiredOutputs: props.desiredOutputs,
          payFees: props.options.payFees,
        },
        proveTimeout,
      );
    }),
  );
