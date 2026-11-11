import { isRemoteMidnightEngine } from '@lace-contract/midnight-context';
import { remoteEngineClientOf } from '@lace-module/midnight-sync/sdk';
import { defer, from, map, switchMap } from 'rxjs';

import type { MidnightPageOperations } from './midnight-page-operations';
import type {
  MidnightEngine,
  MidnightWallet,
} from '@lace-contract/midnight-context';
import type { MidnightRemoteEngineClient } from '@lace-module/midnight-sync/sdk';
import type { Observable } from 'rxjs';

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

// Page mode's operations carry the engine's code: they load on the first operation of an in-process engine.
const loadPageOperations = async () => import('./midnight-page-operations');

/**
 * The operations of an engine that runs on this page, once their module has loaded.
 *
 * @param engine - An engine running in this JavaScript context.
 */
export const pageOperationsFor = (
  engine: MidnightWallet,
): Observable<MidnightPageOperations> =>
  defer(() => from(loadPageOperations())).pipe(
    map(({ pageOperationsOf }) => pageOperationsOf(engine)),
  );

// Each operation loads the page operations first, so the helpers keep calling them synchronously in both modes.
const lazily =
  <Arguments extends unknown[], Value>(
    engine: MidnightWallet,
    select: (
      operations: MidnightPageOperations,
    ) => (...args: Arguments) => Observable<Value>,
  ) =>
  (...args: Arguments): Observable<Value> =>
    pageOperationsFor(engine).pipe(
      switchMap(operations => select(operations)(...args)),
    );

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
        build: lazily(engine, operations => operations.build),
        estimate: lazily(engine, operations => operations.estimate),
        sign: lazily(engine, operations => operations.sign),
        prove: lazily(engine, operations => operations.prove),
        discard: lazily(engine, operations => operations.discard),
        buildConnectorTransaction: lazily(
          engine,
          operations => operations.buildConnectorTransaction,
        ),
        checkCircuit: lazily(engine, operations => operations.checkCircuit),
        proveCircuit: lazily(engine, operations => operations.proveCircuit),
      };
