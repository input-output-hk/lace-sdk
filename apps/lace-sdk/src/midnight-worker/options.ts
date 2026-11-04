import { MidnightAttestedProverUnsupportedError } from '../midnight-errors';

import { connectMidnightEngineWorker } from './connect-engine-worker';

import type {
  CreateAttestedProver,
  MidnightSyncWorkerOptions,
  MidnightWorkerStorageKind,
} from '@lace-module/midnight-sync/sdk';

/**
 * Worker mode's settings, the object form of `createMidnightModule`'s `worker`. Each account's engine then runs in
 * one worker that the app's pages share, off every page's main thread.
 */
export type MidnightWorkerOptions = {
  /**
   * Where the worker keeps the engines' synced state: `'memory'` (the default) for as long as the worker runs,
   * `'indexeddb'` in the origin's IndexedDB, across sessions. The pages of the app that share an account's engine
   * must agree on it, as on the endpoints and the proof server.
   */
  storage?: MidnightWorkerStorageKind;
  /**
   * Attach to an engine that another page of the app already runs with other settings, using its settings,
   * instead of failing with `MidnightWorkerSettingsConflictError`.
   */
  adopt?: boolean;
};

const STORAGE_KINDS: readonly unknown[] = [
  'memory',
  'indexeddb',
] satisfies MidnightWorkerStorageKind[];

/**
 * The engine module's Worker-mode options for `createMidnightModule`'s `worker`; `undefined` runs the engine on the
 * page.
 *
 * @param worker - The `worker` option.
 * @param createAttestedProver - The `createAttestedProver` option, which Worker mode refuses.
 * @throws {@link MidnightAttestedProverUnsupportedError} With an attested prover.
 * @throws `TypeError` For a value that is neither a boolean nor {@link MidnightWorkerOptions}.
 */
export const midnightWorkerOptionsOf = (
  worker: MidnightWorkerOptions | boolean | undefined,
  createAttestedProver: CreateAttestedProver | undefined,
): MidnightSyncWorkerOptions | undefined => {
  if (worker === undefined || worker === false) return undefined;
  const { storage = 'memory', adopt: shouldAdopt = false } =
    worker === true
      ? {}
      : (worker as Partial<MidnightWorkerOptions> | null) ?? {};
  if (
    (worker !== true && (typeof worker !== 'object' || worker === null)) ||
    !STORAGE_KINDS.includes(storage) ||
    typeof shouldAdopt !== 'boolean'
  )
    throw new TypeError(
      "worker must be true, false or { storage?: 'memory' | 'indexeddb', adopt?: boolean }",
    );
  if (createAttestedProver) throw new MidnightAttestedProverUnsupportedError();
  return {
    connect: connectMidnightEngineWorker(),
    storage,
    adopt: shouldAdopt,
  };
};
