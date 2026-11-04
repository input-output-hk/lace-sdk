import { isRemoteMidnightEngine } from '@lace-contract/midnight-context';
import {
  buildConnectorTransaction,
  buildTransaction,
  checkCircuitThroughPort,
  discardRecipe,
  estimateFee,
  proveCircuitThroughPort,
  proveRecipe,
  remoteEngineClientOf,
  signRecipe,
} from '@lace-module/midnight-sync/sdk';
import { defer } from 'rxjs';

import type { MidnightEngine } from '@lace-contract/midnight-context';
import type { MidnightRemoteEngineClient } from '@lace-module/midnight-sync/sdk';

/**
 * The engine operations behind the SDK's Midnight helpers, the same pipelines in both modes: in Worker mode each runs
 * in the worker, and in page mode the helper runs the same engine-side function on this page's engine.
 */
export type MidnightEngineOperations = Pick<
  MidnightRemoteEngineClient,
  | 'build'
  | 'buildConnectorTransaction'
  | 'checkCircuit'
  | 'discard'
  | 'estimate'
  | 'prove'
  | 'proveCircuit'
  | 'sign'
>;

/**
 * The operations of an account's engine, wherever it runs.
 *
 * @param engine - The engine from the shared lookup.
 */
export const midnightOperationsOf = (
  engine: MidnightEngine,
): MidnightEngineOperations =>
  isRemoteMidnightEngine(engine)
    ? remoteEngineClientOf(engine)
    : {
        build: tx => buildTransaction(engine, tx),
        estimate: tx => estimateFee(engine, tx),
        sign: recipe => signRecipe(engine, recipe),
        prove: (recipe, onProgress) => proveRecipe(engine, recipe, onProgress),
        discard: recipe => discardRecipe(engine, recipe),
        buildConnectorTransaction: request =>
          buildConnectorTransaction(engine, request),
        checkCircuit: request =>
          defer(async () =>
            checkCircuitThroughPort(engine.proofCircuitProvider, request),
          ),
        proveCircuit: request =>
          defer(async () =>
            proveCircuitThroughPort(engine.proofCircuitProvider, request),
          ),
      };
