import {
  buildConnectorTransaction,
  buildTransaction,
  checkCircuitThroughPort,
  discardRecipe,
  estimateFee,
  preparePendingActivity,
  proveCircuitThroughPort,
  proveRecipe,
  signRecipe,
  submitTransaction,
} from '@lace-module/midnight-sync/sdk-engine';
import { defer } from 'rxjs';

import type { MidnightWallet } from '@lace-contract/midnight-context';

// Page mode's engine operations: the engine-side functions on this page's engine. Only `midnightOperationsOf`
// imports this module, lazily.

/**
 * The operations of an engine that runs on this page, each the engine-side function applied to that engine. The
 * same shape as the worker client's operations, plus the two steps of a page-side submission.
 *
 * @param engine - An engine running in this JavaScript context.
 */
export const pageOperationsOf = (engine: MidnightWallet) => ({
  build: (tx: Parameters<typeof buildTransaction>[1]) =>
    buildTransaction(engine, tx),
  estimate: (tx: Parameters<typeof estimateFee>[1]) => estimateFee(engine, tx),
  sign: (recipe: Parameters<typeof signRecipe>[1]) =>
    signRecipe(engine, recipe),
  prove: (
    recipe: Parameters<typeof proveRecipe>[1],
    onProgress?: Parameters<typeof proveRecipe>[2],
  ) => proveRecipe(engine, recipe, onProgress),
  discard: (recipe: Parameters<typeof discardRecipe>[1]) =>
    discardRecipe(engine, recipe),
  buildConnectorTransaction: (
    request: Parameters<typeof buildConnectorTransaction>[1],
  ) => buildConnectorTransaction(engine, request),
  checkCircuit: (request: Parameters<typeof checkCircuitThroughPort>[1]) =>
    defer(async () =>
      checkCircuitThroughPort(engine.proofCircuitProvider, request),
    ),
  proveCircuit: (request: Parameters<typeof proveCircuitThroughPort>[1]) =>
    defer(async () =>
      proveCircuitThroughPort(engine.proofCircuitProvider, request),
    ),
  preparePendingActivity: (
    transaction: Parameters<typeof preparePendingActivity>[1],
    derive: Parameters<typeof preparePendingActivity>[2],
  ) => preparePendingActivity(engine, transaction, derive),
  submitTransaction: (transaction: Parameters<typeof submitTransaction>[1]) =>
    submitTransaction(engine, transaction),
});

/** The operations of an engine that runs on this page. */
export type MidnightPageOperations = ReturnType<typeof pageOperationsOf>;
